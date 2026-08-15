#!/usr/bin/env python3
"""
Batch configuration script for PVVX ATC_MiThermometer sensors.

Applies battery-saving settings to all 10 sensors:
  1. advertising_interval: 2.5s  (raw 40) — ~20-25 µA, ~2.5-3 years battery
  2. measure_interval:     4  -> 8    (multiplier)
  3. min_step_time_update_lcd: 2.45s -> 4.95s  (raw 49 -> 99)

Requirements:
  pip install atc-mi-interface

Usage:
  python3 configure_sensors.py                # apply config to all sensors
  python3 configure_sensors.py --dry-run      # show what would be changed without writing
  python3 configure_sensors.py --mac A4:C1:38:7E:0D:90  # apply to single sensor
  python3 configure_sensors.py --read-only    # just read and display current config
"""

import argparse
import asyncio
import logging
import sys

from atc_mi_interface import cfg
from bleak import BleakClient

from bt_reset import reset_bluetooth

# ── BLE protocol constants (from atc_mi_config.py) ──────────────────────────
NOTIFY_UUID = "00001f10-0000-1000-8000-00805f9b34fb"  # Service 0x1F10
CHARACTERISTIC_UUID = "00001f1f-0000-1000-8000-00805f9b34fb"  # Char 0x1F1F
CMD_ID_CFG = 0x55  # Get/Set device config
CMD_ID_REBOOT = 0x72  # Reboot on disconnect
BC_TIMEOUT = 40.0

# ── Sensor list ─────────────────────────────────────────────────────────────
SENSORS = [
    {"mac": "A4:C1:38:7E:0D:90", "name": "FLB Bedchamber"},
    {"mac": "A4:C1:38:FD:16:3F", "name": "FLB Gallery"},
    {"mac": "A4:C1:38:40:52:36", "name": "FLB Kitchen"},
    {"mac": "A4:C1:38:86:84:D3", "name": "FLB Terrace"},
    {"mac": "A4:C1:38:A2:E2:24", "name": "FLB Lavatory"},
    {"mac": "A4:C1:38:71:5D:96", "name": "FLB Vestibule"},
    {"mac": "A4:C1:38:C9:82:B0", "name": "FLB Study"},
    {"mac": "A4:C1:38:D5:E5:44", "name": "FLB Parlour"},
    {"mac": "A4:C1:38:88:E9:A4", "name": "FLB Drawing room"},
    {"mac": "A4:C1:38:1E:4A:5E", "name": "FLB Corridor"},
]

# ── Target battery-saving values ────────────────────────────────────────────
# The cfg construct converts raw bytes to human-readable units:
#   advertising_interval: raw_byte * 0.0625 = seconds  (80 -> 5.0s, 160 -> 10.0s)
#   measure_interval: raw byte as-is                   (4 -> 4, 8 -> 8)
#   min_step_time_update_lcd: raw_byte * 0.05 = seconds (49 -> 2.45s, 99 -> 4.95s)
TARGET_CONFIG = {
    "advertising_interval": 2.5,  # seconds (raw 40) — ~20-25 µA, ~2.5-3 years
    "measure_interval": 8,  # multiplier (raw 8)
    "min_step_time_update_lcd": 4.95,  # seconds (raw 99)
    "flg.advertising_type": "adv_type_custom",  # use custom (pvvx) adv format
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


class SensorConfigurator:
    """Connects to a PVVX sensor, reads/writes its configuration via BLE."""

    def __init__(self, mac: str, name: str, ble_device=None):
        self.mac = mac
        self.name = name
        self._ble_device = (
            ble_device  # BLEDevice from scanner (more reliable on Windows)
        )
        self._binary: bytearray = bytearray()
        self._event = asyncio.Event()

    def _notification_handler(self, _sender, data: bytearray):
        """Collects config bytes from BLE notifications.

        The first byte of each notification is the command echo (0x55);
        the rest is the config payload.
        """
        if data and data[0] == CMD_ID_CFG:
            self._binary.extend(data[1:])
            self._event.set()
        else:
            # Multi-fragment response: append continuation
            self._binary.extend(data)
            self._event.set()

    async def read_config(self, dry_run: bool = False) -> dict | None:
        """Connect, read current config, return parsed config dict."""
        self._binary = bytearray()
        self._event.clear()

        connect_target = self._ble_device or self.mac
        log.info(f"[{self.name}] Connecting to {self.mac} ...")
        try:
            async with BleakClient(
                connect_target, timeout=BC_TIMEOUT, winrt={"use_cached_services": False}
            ) as client:
                # Read the actual BLE advertised device name
                ble_name = client.name or "(unknown)"
                log.info(
                    f"[{self.name}] Connected. BLE name: '{ble_name}'. Pairing ..."
                )
                try:
                    await client.pair(protection_level=2)
                except Exception:
                    log.warning(f"[{self.name}] Pairing skipped (may not be needed)")

                # Settling delay — avoids WinError -2147023673 (ERROR_CANCELLED)
                # that occurs when writing immediately after pairing on Windows.
                await asyncio.sleep(0.5)

                await client.start_notify(
                    CHARACTERISTIC_UUID, self._notification_handler
                )

                # Request current config
                log.info(f"[{self.name}] Reading config ...")
                await client.write_gatt_char(
                    CHARACTERISTIC_UUID, bytes([CMD_ID_CFG]), response=True
                )

                # Wait for notification with config data
                try:
                    await asyncio.wait_for(self._event.wait(), timeout=10.0)
                except TimeoutError:
                    log.error(f"[{self.name}] Timeout waiting for config response")
                    return None

                # Small delay to ensure all fragments arrived
                await asyncio.sleep(0.5)

                await client.stop_notify(CHARACTERISTIC_UUID)

                if not self._binary:
                    log.error(f"[{self.name}] No config data received")
                    return None

                # Parse the binary config
                # The config payload starts with firmware_version byte;
                # cfg.parse expects the full struct including version computed field
                config_bytes = bytes(self._binary)
                log.info(f"[{self.name}] Raw config: {config_bytes.hex(' ')}")

                try:
                    parsed = cfg.parse(config_bytes)
                except Exception as e:
                    log.error(f"[{self.name}] Failed to parse config: {e}")
                    return None

                current = {
                    "ble_name": ble_name,
                    "advertising_interval": parsed.advertising_interval,
                    "measure_interval": parsed.measure_interval,
                    "min_step_time_update_lcd": parsed.min_step_time_update_lcd,
                    "rf_tx_power": str(parsed.rf_tx_power),
                    "connect_latency": parsed.connect_latency,
                    "averaging_measurements": parsed.averaging_measurements,
                    "flg": {
                        "lp_measures": parsed.flg.lp_measures,
                        "tx_measures": parsed.flg.tx_measures,
                        "comfort_smiley": parsed.flg.comfort_smiley,
                        "advertising_type": str(parsed.flg.advertising_type),
                    },
                }

                log.info(f"[{self.name}] Current config:")
                for k, v in current.items():
                    if k == "flg":
                        for fk, fv in v.items():
                            log.info(f"  flg.{fk} = {fv}")
                    elif k == "ble_name":
                        log.info(f"  {k} = '{v}'")
                    else:
                        log.info(f"  {k} = {v}")

                if not dry_run:
                    await self._write_and_reboot(client, parsed)

                return current

        except Exception as e:
            log.error(f"[{self.name}] BLE error: {e}")
            return None

    async def _write_and_reboot(self, client: BleakClient, parsed):
        """Modify config fields, build new binary, write back, reboot."""
        # Check which fields actually need changing
        changes = []
        for field, target_val in TARGET_CONFIG.items():
            # Support nested fields like "flg.advertising_type"
            obj = parsed
            parts = field.split(".")
            for p in parts[:-1]:
                obj = getattr(obj, p)
            current_val = getattr(obj, parts[-1])
            # Compare as string for enum types
            if str(current_val) != str(target_val):
                changes.append((field, current_val, target_val))
                setattr(obj, parts[-1], target_val)
            else:
                log.info(f"[{self.name}] {field} already at target ({target_val})")

        if not changes:
            log.info(f"[{self.name}] No changes needed, skipping write")
            return

        for field, old, new in changes:
            log.info(f"[{self.name}] Changing {field}: {old} -> {new}")

        # Build new config binary
        try:
            new_bytes = cfg.build(parsed)
        except Exception as e:
            log.error(f"[{self.name}] Failed to build config: {e}")
            return

        log.info(f"[{self.name}] New config bytes: {new_bytes.hex(' ')}")

        # Write config: CMD_ID_CFG byte + payload (skip byte 0 = version computed)
        # The write payload is: [0x55] + config_bytes[1:]
        # (version/firmware_version byte at index 0 is read-only / computed)
        write_payload = bytes([CMD_ID_CFG]) + new_bytes[1:]

        log.info(f"[{self.name}] Writing new config ...")
        await client.write_gatt_char(CHARACTERISTIC_UUID, write_payload, response=True)

        # Reboot to apply
        log.info(f"[{self.name}] Sending reboot command ...")
        await client.write_gatt_char(
            CHARACTERISTIC_UUID, bytes([CMD_ID_REBOOT]), response=True
        )
        log.info(f"[{self.name}] ✓ Config applied, sensor rebooting")


async def main():
    parser = argparse.ArgumentParser(
        description="Batch-configure PVVX ATC_MiThermometer sensors"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read and display config without writing changes",
    )
    parser.add_argument(
        "--read-only",
        action="store_true",
        help="Only read current config (alias for --dry-run)",
    )
    parser.add_argument(
        "--mac",
        type=str,
        help="Configure only this single MAC address",
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
    args = parser.parse_args()

    dry_run = args.dry_run or args.read_only

    # Filter sensor list
    sensors = SENSORS
    if args.mac:
        sensors = [s for s in SENSORS if s["mac"].upper() == args.mac.upper()]
        if not sensors:
            log.error(f"MAC {args.mac} not found in sensor list")
            sys.exit(1)

    log.info("=" * 60)
    log.info("PVVX Sensor Batch Configuration")
    log.info("=" * 60)
    log.info(f"Mode: {'DRY RUN (read-only)' if dry_run else 'WRITE + REBOOT'}")
    log.info("Target settings:")
    for k, v in TARGET_CONFIG.items():
        log.info(f"  {k} = {v}")
    log.info(f"Sensors: {len(sensors)}")
    log.info("=" * 60)

    # Reset Windows Bluetooth stack to clear stale GATT handles
    if args.reset_bt:
        await reset_bluetooth()
        log.info("")

    success = 0
    failed = 0
    results: list[dict] = []

    for sensor in sensors:
        log.info("")
        log.info(f"--- {sensor['name']} ({sensor['mac']}) ---")
        configurator = SensorConfigurator(sensor["mac"], sensor["name"])
        result = await configurator.read_config(dry_run=dry_run)
        if result is not None:
            success += 1
            results.append(
                {
                    "script_name": sensor["name"],
                    "mac": sensor["mac"],
                    "ble_name": result.get("ble_name", "?"),
                    "adv_interval": result.get("advertising_interval", "?"),
                    "measure_interval": result.get("measure_interval", "?"),
                    "lcd_refresh": result.get("min_step_time_update_lcd", "?"),
                }
            )
        else:
            failed += 1
            results.append(
                {
                    "script_name": sensor["name"],
                    "mac": sensor["mac"],
                    "ble_name": "FAILED",
                    "adv_interval": "-",
                    "measure_interval": "-",
                    "lcd_refresh": "-",
                }
            )
        # Delay between sensors to let BLE stack settle
        if sensor != sensors[-1]:
            log.info("Waiting 3s before next sensor ...")
            await asyncio.sleep(3)

    # Print summary table
    log.info("")
    log.info("=" * 60)
    log.info(f"Done. Success: {success}, Failed: {failed}")
    log.info("=" * 60)
    log.info("")
    log.info("Summary Table:")
    header = f"{'Script Name':<30} {'MAC':<20} {'BLE Name':<30} {'Adv(s)':<8} {'Meas':<6} {'LCD(s)':<8}"
    log.info(header)
    log.info("-" * len(header))
    for r in results:
        log.info(
            f"{r['script_name']:<30} {r['mac']:<20} {r['ble_name']:<30} "
            f"{r['adv_interval']!s:<8} {r['measure_interval']!s:<6} {r['lcd_refresh']!s:<8}"
        )


if __name__ == "__main__":
    asyncio.run(main())
