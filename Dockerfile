FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=10000
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 bot

COPY --chown=bot:bot main.py storage.py miniapp.py miniapp.html ./
USER bot
EXPOSE 10000
CMD ["python", "main.py"]
