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
HF_TOKEN = dlt.secrets.get("destination.filesystem.credentials.hf_token", str) or ""
DRY_RUN = os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes")


# ── dlt resource & pipeline ──────────────────────────────────────────────────


@dlt.resource(name="pvvx_sensors", write_disposition="append")
def sensor_data(messages: list[dict]):
    """Yield buffered sensor messages as a single batch."""
    yield messages


_pipeline: "dlt.Pipeline | None" = None


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
    return _pipeline


# ── MQTT → queue bridge ──────────────────────────────────────────────────────
msg_queue: Queue = Queue()
_running = True


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
    """Called for each MQTT message — parse JSON and enqueue."""
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
        # Enrich with reception metadata
        payload["_ts"] = datetime.now(UTC)
        payload["_topic"] = msg.topic
        msg_queue.put(payload)
        log.debug("Received: %s", payload)
    except json.JSONDecodeError as e:
        log.error("JSON decode error on %s: %s", msg.topic, e)
    except Exception as e:
        log.error("Error processing message on %s: %s", msg.topic, e)


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
