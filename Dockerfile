FROM python:3.12-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client autossh \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY panel/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY panel/ ./panel/

ENV PYTHONPATH=/app
EXPOSE 8080
CMD ["uvicorn", "panel.app.main:app", "--host", "0.0.0.0", "--port", "8080"]
