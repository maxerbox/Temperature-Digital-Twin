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

Each Parquet file in `pvvx_sensors/` contains a batch of sensor messages
appended by the pipeline. Internal `_dlt_*` directories hold pipeline
metadata and are excluded from the dataset viewer.
