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
    locales \
  && fc-cache -f \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Set locale to Indonesian + install language pack
RUN sed -i 's/# id_ID.UTF-8/id_ID.UTF-8/' /etc/locale.gen 2>/dev/null; \
    locale-gen 2>/dev/null; \
    echo "LANG=id_ID.UTF-8" >> /etc/environment

# Firefox locale preference: accept Indonesian first
RUN mkdir -p /opt/ghostfox/engine/defaults/pref && \
    echo 'pref("intl.accept_languages", "id-ID, id, en-US, en");' \
      > /opt/ghostfox/engine/defaults/pref/ghostfox-zero-locale.js && \
    echo 'pref("general.useragent.locale", "id-ID");' \
      >> /opt/ghostfox/engine/defaults/pref/ghostfox-zero-locale.js

ENV LANG=id_ID.UTF-8 \
    LC_ALL=id_ID.UTF-8
