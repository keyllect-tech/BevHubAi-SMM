FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    DATABASE_FILE=/app/.bevhub-volume/data/bevhub.db \
    UPLOADS_DIR=/app/.bevhub-volume/uploads \
    TMP_DIR=/app/.bevhub-volume/uploads/tmp \
    BACKUP_DIR=/app/.bevhub-volume/data/backups \
    STORAGE_ALLOWED_ROOTS=/app/.bevhub-volume \
    EDGE_TTS_PYTHON=/opt/edge-tts/bin/python

RUN node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error('Node.js >=22.13 is required'); process.exit(1); }"

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        fonts-dejavu-core \
        python3 \
        python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/edge-tts \
    && /opt/edge-tts/bin/python -m pip install --no-cache-dir edge-tts \
    && chown node:node /app

COPY --chown=node:node package.json package-lock.json ./
USER node
RUN npm ci --omit=dev

COPY --chown=node:node server.js ./server.js
COPY --chown=node:node server/ ./server/

EXPOSE 3001
CMD ["npm", "run", "start-server"]
