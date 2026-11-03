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

# Locale: en-US (server Tokyo, international judges)
RUN mkdir -p /opt/ghostfox/engine/defaults/pref && \
    echo 'pref("intl.accept_languages", "en-US, en");' \
      > /opt/ghostfox/engine/defaults/pref/ghostfox-zero-locale.js && \
    echo 'pref("general.useragent.locale", "en-US");' \
      >> /opt/ghostfox/engine/defaults/pref/ghostfox-zero-locale.js

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8
