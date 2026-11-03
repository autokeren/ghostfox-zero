FROM ghcr.io/autokeren/ghostfox:latest

# Fix text rendering: install proper font packages for headless Firefox
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation \
    fonts-liberation2 \
    fonts-noto-core \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-roboto \
    fonts-open-sans \
    fontconfig \
  && fc-cache -f \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
