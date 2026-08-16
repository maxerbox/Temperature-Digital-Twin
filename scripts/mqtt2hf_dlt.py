#!/usr/bin/env python3
"""
MQTT → Hugging Face Hub bridge using dlt.

Subscribes to TheengsGateway PVVX sensor data on MQTT, buffers
messages, and periodically pushes them to a HF dataset repository
using dlt's filesystem destination (hf:// protocol with Parquet,
page index, and content-defined chunking enabled by default).

Configuration is resolved by dlt in priority order:
  1. Environment variables (highest — use for Docker/CapRover)
  2. .dlt/secrets.toml  (sensitive values, git-ignored)
  3. .dlt/config.toml   (non-sensitive defaults, committed)

Env-var override naming: TOML dots become double underscores, all uppercase.
  sources.mqtt2hf.mqtt_host               → SOURCES__MQTT2HF__MQTT_HOST
  destination.filesystem.credentials.token → DESTINATION__FILESYSTEM__CREDENTIALS__TOKEN

Runtime env vars (not in TOML):
  DRY_RUN          If "1", log messages only  (default: "")
  LOG_LEVEL        Logging level             (default: INFO)
"""

import json
import logging
import os
import signal
import socket
import sys
import time
from datetime import UTC, datetime
from queue import Empty, Queue

import dlt
import paho.mqtt.client as mqtt

# ── Logging ──────────────────────────────────────────────────────────────────
# force=True: dlt configures the root logger on import, which makes a plain
# basicConfig() a no-op.  force=True strips dlt's handlers and applies ours.
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    force=True,
)
log = logging.getLogger("mqtt2hf")
# Re-assert level after dlt may have reset it during config resolution.
log.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())

# ── Monkey-patch: dlt HF create_repo bug ─────────────────────────────────────
# dlt's HfFilesystemClient.create_dataset() calls huggingface_hub.create_repo()
# WITHOUT exist_ok=True.  With a fine-grained HF token that lacks the global
# "Create repos" permission, this raises 401 Unauthorized even when the dataset
# repo already exists.  Patching to exist_ok=True makes create_repo fall back to
# repo_info() on 401/402/403, which succeeds for pre-existing repos.
from dlt.destinations.impl.filesystem.filesystem import HfFilesystemClient


def _patched_create_dataset(self) -> None:
    self.hf_api.create_repo(
        repo_id=self.repo_id,
        repo_type="dataset",
        exist_ok=True,
    )


HfFilesystemClient.create_dataset = _patched_create_dataset
log.info("Patched HfFilesystemClient.create_dataset with exist_ok=True")

# ── Configuration via dlt ────────────────────────────────────────────────────
# dlt resolves values in priority order: (1) env vars, (2) secrets.toml,
# (3) config.toml.  Env-var names use double-underscore, uppercase convention:
#   sources.mqtt2hf.mqtt_host                 → SOURCES__MQTT2HF__MQTT_HOST
#   destination.filesystem.credentials.hf_token → DESTINATION__FILESYSTEM__CREDENTIALS__HF_TOKEN
MQTT_HOST = dlt.secrets.get("sources.mqtt2hf.mqtt_host", str) or ""
MQTT_PORT = dlt.secrets.get("sources.mqtt2hf.mqtt_port", int) or 1883
MQTT_USER = dlt.secrets.get("sources.mqtt2hf.mqtt_user", str) or ""
MQTT_PASSWORD = dlt.secrets.get("sources.mqtt2hf.mqtt_password", str) or ""
MQTT_TOPIC = dlt.config.get("sources.mqtt2hf.mqtt_topic", str) or "theengs/#"
HF_NAMESPACE = dlt.config.get("sources.mqtt2hf.hf_namespace", str) or ""
HF_DATASET = (
    dlt.config.get("sources.mqtt2hf.hf_dataset", str) or "temperature-digital-twin"
)
FLUSH_INTERVAL = dlt.config.get("sources.mqtt2hf.flush_interval", int) or 60
# Minimum seconds between logged messages from the same sensor.
# TheengsGateway can publish every few seconds; this throttle drops
# intermediate messages, keeping at most one per sensor per interval.
THROTTLE_INTERVAL = dlt.config.get("sources.mqtt2hf.throttle_interval", int) or 20
HF_TOKEN = dlt.secrets.get("destination.filesystem.credentials.hf_token", str) or ""
DRY_RUN = os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes")


# ── dlt resource & pipeline ──────────────────────────────────────────────────


@dlt.resource(name="pvvx_sensors", write_disposition="append")
def sensor_data(messages: list[dict]):
    """Yield buffered sensor messages as a single batch."""
    yield messages


_pipeline: "dlt.Pipeline | None" = None

# README.md content with YAML frontmatter that tells the HF dataset viewer to
# only load pvvx_sensors/*.parquet, ignoring dlt's internal JSONL metadata
# tables (_dlt_loads, _dlt_pipeline_state, _dlt_version) which have different
# schemas and would cause a CastError in the viewer.
_HF_README = """\
---
configs:
- config_name: default
  data_files:
  - split: train
    path: "pvvx_sensors/*.parquet"
---

# Temperature Digital Twin

PVVX BLE sensor readings (temperature, humidity, battery) collected via
TheengsGateway → MQTT → dlt pipeline.
"""


def _ensure_hf_readme() -> None:
    """Upload README.md to the HF dataset repo if it doesn't exist yet.

    The README's YAML frontmatter restricts the dataset viewer to
    pvvx_sensors/*.parquet, preventing CastError from dlt's internal
    metadata tables (_dlt_loads, _dlt_pipeline_state) that use JSONL
    with different schemas.
    """
    from huggingface_hub import HfApi, hf_hub_download

    api = HfApi(token=HF_TOKEN)
    repo_id = f"{HF_NAMESPACE}/{HF_DATASET}"
    try:
        hf_hub_download(repo_id, "README.md", repo_type="dataset")
        log.debug("README.md already present in HF dataset")
    except Exception:
        try:
            api.upload_file(
                path_or_fileobj=_HF_README.encode("utf-8"),
                path_in_repo="README.md",
                repo_id=repo_id,
                repo_type="dataset",
            )
            log.info("Uploaded README.md to %s", repo_id)
        except Exception as e:
            log.warning("Could not upload README.md to HF dataset: %s", e)


def get_pipeline() -> "dlt.Pipeline":
    """Lazily initialise the dlt pipeline targeting hf://datasets/<ns>/<ds>."""
    global _pipeline
    if _pipeline is None:
        _pipeline = dlt.pipeline(
            pipeline_name="mqtt_to_hf",
            destination=dlt.destinations.filesystem(
                bucket_url=f"hf://datasets/{HF_NAMESPACE}",
            ),
            dataset_name=HF_DATASET,
        )
        log.info(
            "dlt pipeline → hf://datasets/%s/%s",
            HF_NAMESPACE,
            HF_DATASET,
        )
        _ensure_hf_readme()
    return _pipeline


# ── MQTT → queue bridge ──────────────────────────────────────────────────────
msg_queue: Queue = Queue()
_running = True
# Per-sensor throttle state: mac → monotonic timestamp of last enqueued message.
_last_seen: dict[str, float] = {}


def on_connect(client, userdata, flags, reason_code, properties=None):
    """Called when the MQTT client connects to the broker."""
    if reason_code == 0:
        log.info("Connected to MQTT %s:%d", MQTT_HOST, MQTT_PORT)
        result = client.subscribe(MQTT_TOPIC)
        log.info(
            "Subscribe requested: %s (mid=%s, qos=%s)",
            MQTT_TOPIC,
            result[1],
            result[0],
        )
    else:
        log.error("MQTT connect failed: rc=%s", reason_code)


def on_subscribe(client, userdata, mid, reason_codes, properties=None):
    """Called when the broker acknowledges a subscription."""
    log.info("Subscription acknowledged: mid=%s reason_codes=%s", mid, reason_codes)


def on_disconnect(client, userdata, disconnect_flags, reason_code, properties=None):
    """Called when the MQTT client disconnects."""
    log.warning("MQTT disconnected: %s (will auto-reconnect)", reason_code)


def on_message(client, userdata, msg):
    """Called for each MQTT message — parse JSON, filter, throttle, enqueue."""
    try:
        payload = json.loads(msg.payload.decode("utf-8"))

        # Filter: only accept devices whose name starts with FLB.
        # TheengsGateway also picks up Samsung BLE beacons and other
        # non-sensor devices that have no decoded name — skip those.
        name = payload.get("name") or ""
        if not name.startswith("FLB"):
            log.debug("Filtered non-FLB device: name=%r id=%s", name, payload.get("id"))
            return

        # Identify the sensor — prefer mac, fall back to id, then topic.
        sensor_id = payload.get("mac") or payload.get("id") or msg.topic

        # Throttle: drop messages from the same sensor within THROTTLE_INTERVAL.
        now = time.monotonic()
        last = _last_seen.get(sensor_id)
        if last is not None and (now - last) < THROTTLE_INTERVAL:
            log.debug(
                "Throttled %s (%.1fs < %ds)",
                sensor_id,
                now - last,
                THROTTLE_INTERVAL,
            )
            return
        _last_seen[sensor_id] = now

        # Enrich with reception metadata
        payload["_ts"] = datetime.now(UTC)
        payload["_topic"] = msg.topic
        msg_queue.put(payload)
        log.debug("Received: %s", payload)
    except json.JSONDecodeError as e:
        log.error("JSON decode error on %s: %s", msg.topic, e)
    except Exception as e:
        log.error("Error processing message on %s: %s", msg.topic, e)


def _dedup_per_sensor(messages: list[dict]) -> list[dict]:
    """Keep only the latest message per sensor (mac → id → topic)."""
    seen: dict[str, dict] = {}
    for m in messages:
        key = m.get("mac") or m.get("id") or m.get("_topic", "")
        seen[key] = m  # last one wins
    if len(seen) < len(messages):
        log.info(
            "Deduplicated %d → %d messages (per-sensor latest)",
            len(messages),
            len(seen),
        )
    return list(seen.values())


def flush_buffer():
    """Drain the queue and push buffered messages to HF via dlt."""
    messages: list[dict] = []
    while True:
        try:
            messages.append(msg_queue.get_nowait())
        except Empty:
            break

    if not messages:
        log.debug("No messages to flush")
        return

    # Safety-net dedup: if messages slipped through the throttle (e.g. clock
    # skew, restart), keep only the latest per sensor.
    messages = _dedup_per_sensor(messages)

    log.info("Flushing %d messages to Hugging Face", len(messages))

    if DRY_RUN:
        for m in messages:
            log.info("DRY RUN: %s", json.dumps(m, default=str))
        return

    if not HF_TOKEN or not HF_NAMESPACE:
        log.error("HF_TOKEN and HF_NAMESPACE are required for upload")
        # Re-queue messages for next cycle
        for m in messages:
            msg_queue.put(m)
        return

    try:
        load_info = get_pipeline().run(sensor_data(messages))
        log.info("Upload complete: %s", load_info)
    except Exception as e:
        log.error("dlt pipeline error: %s", e)
        # Re-queue messages for retry on next cycle
        for m in messages:
            msg_queue.put(m)
        log.warning("Re-queued %d messages for retry", len(messages))


# ── Shutdown handling ────────────────────────────────────────────────────────


def _shutdown(signum, frame):
    """Signal handler for graceful shutdown."""
    global _running
    log.info("Signal %d received, shutting down...", signum)
    _running = False


# ── Main loop ────────────────────────────────────────────────────────────────


def main():
    if not MQTT_USER or not MQTT_PASSWORD:
        log.error("MQTT_USER and MQTT_PASSWORD are required")
        sys.exit(1)

    if not DRY_RUN and (not HF_TOKEN or not HF_NAMESPACE):
        log.error("HF_TOKEN and HF_NAMESPACE are required (or set DRY_RUN=1)")
        sys.exit(1)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    # Unique client_id: prevents broker disconnecting the new container when
    # the old one's session hasn't fully closed yet (CapRover rolling restart).
    client_id = f"mqtt2hf-{socket.gethostname()}-{os.getpid()}"

    # Create MQTT client (paho-mqtt 2.x API)
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=client_id,
    )
    client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    client.on_connect = on_connect
    client.on_subscribe = on_subscribe
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=5, max_delay=60)

    log.info("Connecting to MQTT %s:%d ...", MQTT_HOST, MQTT_PORT)
    if DRY_RUN:
        log.info("DRY RUN mode - messages will be logged but not uploaded")

    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_start()

    # Main flush loop
    while _running:
        time.sleep(FLUSH_INTERVAL)
        flush_buffer()

    # Graceful shutdown: stop MQTT and do a final flush
    log.info("Performing final flush...")
    client.loop_stop()
    client.disconnect()
    flush_buffer()
    log.info("Shutdown complete.")


if __name__ == "__main__":
    main()
