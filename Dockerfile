FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    "dlt[filesystem]" \
    huggingface_hub \
    paho-mqtt

COPY .dlt/ /app/.dlt/
COPY scripts/mqtt2hf_dlt.py /app/mqtt2hf_dlt.py

CMD ["python", "-u", "/app/mqtt2hf_dlt.py"]
