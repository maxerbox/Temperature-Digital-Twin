#!/usr/bin/env python3
"""
Reset the Windows Bluetooth stack before BLE operations.

Clears stale GATT handles and cached connection state that accumulate
when doing many back-to-back BleakClient connections on Windows.

Three strategies (tried in order):
  1. Kill lingering Python processes that may hold BLE handles
  2. Restart the Bluetooth Support Service (bthserv)  [needs admin]
  3. Toggle the Bluetooth radio off/on via WinRT       [needs winrt pkg]

Usage from other scripts:
    from bt_reset import reset_bluetooth
    await reset_bluetooth()          # full reset (service + radio)
    await reset_bluetooth(kill=False) # skip killing processes

CLI standalone:
    python bt_reset.py
    python bt_reset.py --no-kill
    python bt_reset.py --no-radio
"""

import asyncio
import logging
import os
import subprocess
import sys
import time

log = logging.getLogger(__name__)

# ── 1. Kill lingering processes ────────────────────────────────────────────


def kill_lingering_python(exclude_pid: int | None = None) -> int:
    """Kill other Python processes running our BLE scripts that may hold GATT handles.

    Only kills python.exe processes whose command line contains
    'configure_sensors', 'display_numbers', or 'bleak' — not arbitrary
    Python processes (VS Code, uv, etc.).

    Returns the number of processes killed.
    """
    if sys.platform != "win32":
        return 0

    # Use PowerShell to get PID + CommandLine for all python.exe processes
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
                "Select-Object ProcessId, CommandLine | "
                'ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }',
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception as e:
        log.warning(f"Could not enumerate Python processes: {e}")
        return 0

    my_pid = exclude_pid or os.getpid()
    # Collect all PIDs so we can exclude ancestors (parent chain)
    all_pids: set[int] = set()

    lines = result.stdout.strip().splitlines()
    proc_map: list[tuple[int, str]] = []
    for line in lines:
        line = line.strip()
        if not line or "|" not in line:
            continue
        pid_str, _, cmdline = line.partition("|")
        try:
            pid = int(pid_str)
        except ValueError:
            continue
        all_pids.add(pid)
        proc_map.append((pid, cmdline))

    # Exclude parent PID chain to avoid killing our own launcher (uv, etc.)
    parent_pid = os.getppid()
    exclude_pids = {my_pid, parent_pid}

    # Walk up the process tree a few levels
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.windll.kernel32

        class PROCESSENTRY32(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_char * 260),
            ]

        snap = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
        entry = PROCESSENTRY32()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32)

        parent_map: dict[int, int] = {}
        if kernel32.Process32First(snap, ctypes.byref(entry)):
            while True:
                parent_map[entry.th32ProcessID] = entry.th32ParentProcessID
                if not kernel32.Process32Next(snap, ctypes.byref(entry)):
                    break
        kernel32.CloseHandle(snap)

        # Walk up from parent_pid
        current = parent_pid
        for _ in range(10):  # max 10 levels
            ppid = parent_map.get(current)
            if ppid is None or ppid == 0 or ppid == current:
                break
            exclude_pids.add(ppid)
            current = ppid
    except Exception:
        pass  # If process-tree walking fails, just exclude self + immediate parent

    # Only kill processes running our BLE scripts
    ble_keywords = ("configure_sensors", "display_numbers", "bleak", "bt_reset")
    killed = 0

    for pid, cmdline in proc_map:
        if pid in exclude_pids:
            continue
        if not any(kw in cmdline.lower() for kw in ble_keywords):
            continue

        log.info(f"Killing lingering BLE script process (PID {pid}): {cmdline[:80]}")
        try:
            subprocess.run(
                ["taskkill", "/F", "/PID", str(pid)],
                capture_output=True,
                timeout=10,
            )
            killed += 1
        except Exception as e:
            log.warning(f"  Could not kill PID {pid}: {e}")

    if killed:
        log.info(f"Killed {killed} lingering BLE script process(es).")
        time.sleep(2)  # let OS reclaim handles
    else:
        log.info("No lingering BLE script processes found.")

    return killed


# ── 2. Restart bthserv ─────────────────────────────────────────────────────


def restart_bthserv() -> bool:
    """Restart the Bluetooth Support Service (bthserv).

    Requires administrator privileges.
    Returns True on success.
    """
    if sys.platform != "win32":
        log.info("Not Windows — skipping bthserv restart.")
        return False

    log.info("Restarting Bluetooth Support Service (bthserv) ...")
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Restart-Service -Name bthserv -Force -ErrorAction Stop; "
                "(Get-Service bthserv).Status",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0 and "Running" in result.stdout:
            log.info("bthserv restarted successfully (Running).")
            time.sleep(3)  # let the service fully initialize
            return True
        else:
            stderr = result.stderr.strip()
            if "access" in stderr.lower() or "administrator" in stderr.lower():
                log.warning("bthserv restart needs admin privileges — skipped.")
            else:
                log.warning(f"bthserv restart failed: {stderr or 'unknown'}")
            return False
    except Exception as e:
        log.warning(f"bthserv restart error: {e}")
        return False


# ── 3. Toggle Bluetooth radio via WinRT ────────────────────────────────────


async def toggle_bluetooth_radio() -> bool:
    """Toggle the Bluetooth radio off then on via WinRT.

    This power-cycles the BT adapter, clearing all GATT caches.
    Requires the 'winrt' package (pip install winrt-windows-devices-radios).
    Returns True on success.
    """
    if sys.platform != "win32":
        log.info("Not Windows — skipping radio toggle.")
        return False

    try:
        # winrt is the modern package; winsdk is the older fork
        try:
            from winrt.windows.devices.radios import Radio, RadioKind, RadioState
            from winrt.windows.foundation import TypedEventHandler
        except ImportError:
            try:
                from winsdk.windows.devices.radios import Radio, RadioKind, RadioState
            except ImportError:
                log.info(
                    "winrt/winsdk not installed — skipping radio toggle. "
                    "(pip install winrt-windows-devices-radios)"
                )
                return False

    except Exception as e:
        log.info(f"Cannot import WinRT radio module: {e}")
        return False

    log.info("Toggling Bluetooth radio off/on via WinRT ...")

    try:
        # Request access (may show a one-time system prompt)
        access = await Radio.request_access_async()
        # RadioAccessStatus enum: 0=Unspecified, 1=Allowed, 2=DeniedByUser, 3=DeniedBySystem
        if int(access) != 1:
            log.warning(
                f"Radio access denied (status={int(access)}). Skipping radio toggle."
            )
            return False

        radios = await Radio.get_radios_async()
        bt_radios = [r for r in radios if r.kind == RadioKind.BLUETOOTH]

        if not bt_radios:
            log.warning("No Bluetooth radio found.")
            return False

        for radio in bt_radios:
            name = radio.name
            log.info(f"  Turning OFF radio: {name}")
            await radio.set_state_async(RadioState.OFF)

        await asyncio.sleep(3)  # let adapter fully power down

        for radio in bt_radios:
            name = radio.name
            log.info(f"  Turning ON radio: {name}")
            await radio.set_state_async(RadioState.ON)

        await asyncio.sleep(5)  # let adapter re-initialize and be ready
        log.info("Bluetooth radio toggle complete.")
        return True

    except Exception as e:
        log.warning(f"Radio toggle failed: {e}")
        return False


# ── Combined reset ─────────────────────────────────────────────────────────


async def reset_bluetooth(
    kill: bool = True,
    service: bool = True,
    radio: bool = True,
) -> None:
    """Full Bluetooth stack reset.

    Args:
        kill:    Kill lingering Python processes that may hold BLE handles.
        service: Restart the bthserv Windows service (needs admin).
        radio:   Toggle the BT radio off/on via WinRT (needs winrt pkg).
    """
    log.info("=" * 50)
    log.info("Resetting Windows Bluetooth stack")
    log.info("=" * 50)

    if kill:
        kill_lingering_python()

    if service:
        restart_bthserv()

    if radio:
        await toggle_bluetooth_radio()

    log.info("Bluetooth stack reset complete.")
    log.info("=" * 50)


# ── CLI ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser(description="Reset the Windows Bluetooth stack")
    parser.add_argument(
        "--no-kill", action="store_true", help="Skip killing lingering Python processes"
    )
    parser.add_argument(
        "--no-service", action="store_true", help="Skip restarting bthserv"
    )
    parser.add_argument(
        "--no-radio", action="store_true", help="Skip toggling the BT radio"
    )
    args = parser.parse_args()

    asyncio.run(
        reset_bluetooth(
            kill=not args.no_kill,
            service=not args.no_service,
            radio=not args.no_radio,
        )
    )
