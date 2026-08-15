#!/usr/bin/env python3
"""
Display a unique number on each sensor's LCD screen.

Sends command 0x22 (CMD_ID_EXTDATA) to each sensor, showing its index
number (1-10) on the big LCD digits. This lets you physically walk
around and identify which sensors are alive and connectable.

The display stays until:
  - The sensor reboots
  - You run this script with --restore (sends vtime=0)

Usage:
  uv run python display_numbers.py              # show numbers on all sensors
  uv run python display_numbers.py --restore     # restore normal display
  uv run python display_numbers.py --mac A4:C1:38:7E:0D:90  # single sensor
  uv run python display_numbers.py --duration 60  # show for 60 seconds then auto-restore
"""

import argparse
import asyncio
import logging
import sys

from bleak import BleakClient

from bt_reset import reset_bluetooth

# ── BLE protocol constants ──────────────────────────────────────────────────
NOTIFY_UUID = "00001f10-0000-1000-8000-00805f9b34fb"
CHARACTERISTIC_UUID = "00001f1f-0000-1000-8000-00805f9b34fb"
CMD_ID_EXTDATA = 0x22  # Get/Set show ext. data (firmware handles LCD encoding)
BC_TIMEOUT = 40.0

# ── Sensor list (same as configure_sensors.py) ─────────────────────────────
SENSORS = [
    {"mac": "A4:C1:38:7E:0D:90", "name": "FLB Bedchamber"},
    {"mac": "A4:C1:38:FD:16:3F", "name": "FLB Gallery"},
    {"mac": "A4:C1:38:40:52:36", "name": "FLB Kitchen"},
    {"mac": "A4:C1:38:86:84:D3", "name": "FLB Terrace"},
    {"mac": "A4:C1:38:A2:E2:24", "name": "FLB Gallery (not found in scan)"},
    {"mac": "A4:C1:38:71:5D:96", "name": "FLB Vestibule"},
    {"mac": "A4:C1:38:C9:82:B0", "name": "FLB Study"},
    {"mac": "A4:C1:38:D5:E5:44", "name": "FLB Parlour"},
    {"mac": "A4:C1:38:88:E9:A4", "name": "FLB Drawing room"},
    {"mac": "A4:C1:38:1E:4A:5E", "name": "FLB Corridor"},
]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


def build_extdata_payload(number: int, vtime_sec: int) -> bytes:
    """Build the 8-byte command 0x22 payload for MJWSD06MMC.

    Firmware struct (external_data_t for non-MJWSD05MMC devices):
      s16 big_number    # value × 10 (e.g. 10 = "1.0", 100 = "10.0")
      s16 small_number  # not used (set to 0)
      u16 vtime_sec     # display duration in seconds (0xFFFF = forever)
      u8  cfg           # flags: smiley(3) | percent(1) | battery(1) | temp_sym(3)

    The firmware's show_big_number_x10() handles LCD segment encoding.
    """
    big_number = number * 10  # ×0.1 encoding: 1 → 10, 10 → 100
    small_number = 0
    cfg = 0  # no smiley, no battery, no percent, no temp symbol

    return bytes(
        [
            CMD_ID_EXTDATA,
            big_number & 0xFF,
            (big_number >> 8) & 0xFF,
            small_number & 0xFF,
            (small_number >> 8) & 0xFF,
            vtime_sec & 0xFF,
            (vtime_sec >> 8) & 0xFF,
            cfg,
        ]
    )


async def send_display_command(
    mac: str,
    name: str,
    number: int,
    vtime_sec: int,
    semaphore: asyncio.Semaphore | None = None,
) -> bool:
    """Connect to sensor and send the ext data display command.

    If *semaphore* is provided, the connection phase is throttled to respect
    the Windows BLE stack's concurrent-connection limit (~5). The semaphore is
    acquired before connecting and released after disconnecting.
    """
    payload = build_extdata_payload(number, vtime_sec)

    # Throttle concurrent connections (Windows limit ≈ 5)
    if semaphore is not None:
        async with semaphore:
            return await _send_display_command_inner(
                mac, name, number, vtime_sec, payload
            )
    return await _send_display_command_inner(mac, name, number, vtime_sec, payload)


async def _send_display_command_inner(
    mac: str, name: str, number: int, vtime_sec: int, payload: bytes
) -> bool:
    """Inner connection logic — called with semaphore already held (if any).

    Uses ``use_cached_services=False`` to avoid stale GATT cache issues that
    cause WinError -2147023673 (ERROR_CANCELLED) when connecting to multiple
    devices in rapid succession (bleak issue #1387).
    """
    log.info(f"[{name}] Connecting to {mac} ...")
    # use_cached_services=False forces Windows to re-read services from the
    # device instead of using a stale cache. When caching causes problems,
    # failures become "Unreachable" (recoverable via retry) instead of
    # "operation canceled" (fatal).
    client = BleakClient(mac, timeout=BC_TIMEOUT, winrt={"use_cached_services": False})
    try:
        await client.connect()
        if not client.is_connected:
            log.error(f"[{name}] Failed to connect")
            return False

        ble_name = client.name or "(unknown)"
        log.info(f"[{name}] Connected. BLE name: '{ble_name}'. Pairing ...")
        try:
            await client.pair(protection_level=2)
        except Exception:
            log.warning(f"[{name}] Pairing skipped (may not be needed)")

        # Small settling delay: let the GATT session stabilise before writing.
        # Concurrent connections can cause the WinRT async write to be
        # cancelled if it fires immediately after service discovery.
        await asyncio.sleep(0.5)

        log.info(
            f"[{name}] Sending display command: "
            f"show '{number}' (big_number={number * 10}, "
            f"vtime={'forever' if vtime_sec == 0xFFFF else vtime_sec}s) "
            f"[{payload.hex(' ')}]"
        )
        await client.write_gatt_char(CHARACTERISTIC_UUID, payload, response=True)
        log.info(f"[{name}] ✓ Display shows '{number}.0'")
        return True

    except Exception as e:
        log.error(f"[{name}] BLE error: {e}")
        return False

    finally:
        # Explicitly disconnect and wait for BLE stack to release.
        # On Windows (WinRT), the async context manager's __aexit__ doesn't
        # always fully release the GATT connection before the next connect,
        # causing "device already connected" or stale connection errors.
        # We disconnect manually and add a delay.
        try:
            if client.is_connected:
                log.info(f"[{name}] Disconnecting ...")
                await client.disconnect()
                log.info(f"[{name}] Disconnected.")
        except Exception as e:
            log.warning(f"[{name}] Disconnect error (non-fatal): {e}")
        # Give the Windows BLE stack time to fully release the handle
        await asyncio.sleep(2)


async def send_display_command_with_retry(
    mac: str,
    name: str,
    number: int,
    vtime_sec: int,
    semaphore: asyncio.Semaphore | None = None,
    max_retries: int = 2,
) -> bool:
    """Retry wrapper: attempts the display command up to ``max_retries + 1`` times.

    Uses exponential backoff (2s, 4s, ...) between retries to let the Windows
    BT stack recover from congestion that causes ERROR_CANCELLED.
    """
    payload = build_extdata_payload(number, vtime_sec)
    last_ok = False

    for attempt in range(1, max_retries + 2):
        if attempt > 1:
            backoff = 2 ** (attempt - 1)  # 2s, 4s, ...
            log.info(
                f"[{name}] Retry {attempt}/{max_retries + 1} "
                f"after {backoff}s backoff ..."
            )
            await asyncio.sleep(backoff)

        if semaphore is not None:
            async with semaphore:
                last_ok = await _send_display_command_inner(
                    mac, name, number, vtime_sec, payload
                )
        else:
            last_ok = await _send_display_command_inner(
                mac, name, number, vtime_sec, payload
            )

        if last_ok:
            return True

    return False


async def main():
    parser = argparse.ArgumentParser(
        description="Display unique numbers on PVVX sensor LCD screens"
    )
    parser.add_argument(
        "--restore",
        action="store_true",
        help="Restore normal display (send vtime=0 to all sensors)",
    )
    parser.add_argument(
        "--mac",
        type=str,
        help="Target only this single MAC address",
    )
    parser.add_argument(
        "--duration",
        type=int,
        default=None,
        help="Auto-restore after N seconds (otherwise stays until reboot)",
    )
    parser.add_argument(
        "--reset-bt",
        action="store_true",
        default=True,
        help="Reset Windows BT stack before starting (default: on)",
    )
    parser.add_argument(
        "--no-reset-bt",
        action="store_false",
        dest="reset_bt",
        help="Skip Bluetooth stack reset",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=2,
        help=(
            "Number of sensors to connect to simultaneously (default: 2). "
            "Windows BLE stack supports ~5 concurrent connections but "
            "values >2 can trigger WinError -2147023673 (ERROR_CANCELLED) "
            "due to BT stack congestion. Use 1 for sequential mode."
        ),
    )
    args = parser.parse_args()

    if args.concurrency < 1:
        log.error("--concurrency must be >= 1")
        sys.exit(1)

    # Filter sensor list
    sensors = SENSORS
    if args.mac:
        sensors = [s for s in SENSORS if s["mac"].upper() == args.mac.upper()]
        if not sensors:
            log.error(f"MAC {args.mac} not found in sensor list")
            sys.exit(1)

    if args.restore:
        vtime_sec = 0  # expires immediately → normal display resumes
        mode = "RESTORE"
    elif args.duration:
        vtime_sec = args.duration
        mode = f"DISPLAY ({args.duration}s timeout)"
    else:
        vtime_sec = 0xFFFF  # never expires
        mode = "DISPLAY (until reboot)"

    log.info("=" * 60)
    log.info("PVVX Sensor LCD Number Display")
    log.info("=" * 60)
    log.info(f"Mode: {mode}")
    log.info(f"Sensors: {len(sensors)}")
    if args.concurrency == 1:
        log.info("Connection mode: sequential")
    else:
        log.info(f"Connection mode: parallel (concurrency={args.concurrency})")
    log.info("=" * 60)

    # Reset Windows Bluetooth stack to clear stale GATT handles
    if args.reset_bt:
        await reset_bluetooth()
        log.info("")

    success = 0
    failed = 0
    results: list[dict] = []

    if args.concurrency == 1:
        # ── Sequential mode ────────────────────────────────────────────
        for idx, sensor in enumerate(sensors, start=1):
            name = sensor["name"]
            mac = sensor["mac"]
            log.info("")
            log.info(f"--- #{idx}: {name} ({mac}) ---")

            if args.restore:
                number = 0  # doesn't matter, vtime=0 clears it
                ok = await send_display_command_with_retry(mac, name, number, vtime_sec)
            else:
                ok = await send_display_command_with_retry(mac, name, idx, vtime_sec)

            if ok:
                success += 1
                results.append(
                    {
                        "num": idx if not args.restore else "-",
                        "name": name,
                        "mac": mac,
                        "status": "✓ OK",
                    }
                )
            else:
                failed += 1
                results.append(
                    {
                        "num": idx if not args.restore else "-",
                        "name": name,
                        "mac": mac,
                        "status": "✗ FAILED",
                    }
                )

            # Delay between sensors to let Windows BLE stack fully release
            if sensor != sensors[-1]:
                log.info("Waiting 5s before next sensor ...")
                await asyncio.sleep(5)
    else:
        # ── Parallel mode ──────────────────────────────────────────────
        # Windows BLE stack supports ~5 concurrent connections.
        # We use a semaphore to stay safely under that limit.
        semaphore = asyncio.Semaphore(args.concurrency)

        async def _task(idx: int, sensor: dict) -> tuple[int, dict, bool]:
            name = sensor["name"]
            mac = sensor["mac"]
            number = 0 if args.restore else idx
            ok = await send_display_command_with_retry(
                mac, name, number, vtime_sec, semaphore=semaphore
            )
            result_entry = {
                "num": idx if not args.restore else "-",
                "name": name,
                "mac": mac,
                "status": "✓ OK" if ok else "✗ FAILED",
            }
            return idx, result_entry, ok

        log.info(
            f"Launching {len(sensors)} sensor tasks "
            f"(max {args.concurrency} concurrent, "
            f"with retry) ..."
        )
        log.info("")
        task_results = await asyncio.gather(
            *(_task(idx, s) for idx, s in enumerate(sensors, start=1))
        )

        # Second pass: retry any sensors that failed all attempts in the
        # first batch, this time sequentially (concurrency=1) to minimise
        # BT stack pressure.
        failed_indices = [idx for idx, _, ok in task_results if not ok]
        if failed_indices and not args.restore:
            log.info("")
            log.info(
                f"{len(failed_indices)} sensor(s) failed in batch. "
                f"Running sequential retry pass ..."
            )
            log.info("")
            for idx in failed_indices:
                sensor = sensors[idx - 1]
                name = sensor["name"]
                mac = sensor["mac"]
                log.info(f"--- Retry #{idx}: {name} ({mac}) ---")
                ok = await send_display_command_with_retry(
                    mac, name, idx, vtime_sec, max_retries=3
                )
                # Update results
                for i, (ridx, rentry, _) in enumerate(task_results):
                    if ridx == idx:
                        task_results[i] = (
                            ridx,
                            {**rentry, "status": "✓ OK" if ok else "✗ FAILED"},
                            ok,
                        )
                        break

        # Sort results by index to keep display order stable
        for idx, result_entry, ok in sorted(task_results, key=lambda t: t[0]):
            results.append(result_entry)
            if ok:
                success += 1
            else:
                failed += 1

    # Print summary table
    log.info("")
    log.info("=" * 60)
    log.info(f"Done. Success: {success}, Failed: {failed}")
    log.info("=" * 60)
    log.info("")
    if args.restore:
        log.info("All displays restored to normal mode.")
    else:
        log.info("Display Mapping Table:")
        header = f"{'#':<4} {'Sensor Name':<35} {'MAC':<20} {'Status':<10}"
        log.info(header)
        log.info("-" * len(header))
        for r in results:
            log.info(
                f"{r['num']!s:<4} {r['name']:<35} {r['mac']:<20} {r['status']:<10}"
            )
        log.info("")
        log.info("Walk around and check each sensor's LCD screen.")
        log.info("The number shown (e.g. '1.0') matches the # column above.")
        if args.duration:
            log.info(f"Displays will auto-restore in {args.duration} seconds.")
        else:
            log.info("To restore normal display, run:")
            log.info("  uv run python display_numbers.py --restore")


if __name__ == "__main__":
    asyncio.run(main())
