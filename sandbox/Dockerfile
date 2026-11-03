FROM node:22-slim

# Playwright system deps + Chromium (headless only)
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g playwright@1.49 && playwright install chromium --with-deps || playwright install chromium

WORKDIR /app
COPY runner.js /app/runner.js

# Run as non-root, no shell for runtime
RUN useradd -m fox
USER fox

ENTRYPOINT ["node", "/app/runner.js"]
