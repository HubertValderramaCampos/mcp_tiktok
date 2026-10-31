FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
        https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" \
        > /etc/apt/sources.list.d/brave-browser-release.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        brave-browser fonts-liberation fonts-noto-color-emoji \
        novnc websockify x11vnc xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /data /videos \
    && chown node:node /data

ENV TIKTOK_BROWSER=brave \
    BROWSER_PATH=/usr/bin/brave-browser \
    TIKTOK_MCP_DIR=/data \
    TIKTOK_NO_SANDBOX=1 \
    DISPLAY=:99

USER node
VOLUME ["/data"]
EXPOSE 6080

ENTRYPOINT ["entrypoint.sh"]
