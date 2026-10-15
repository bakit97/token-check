#!/bin/bash
# Запускается при каждом старте VM: ставит Node 20 и запускает сборщик как службу.
set -e
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
mkdir -p /opt/solscan /var/solscan
cat > /opt/solscan/run.sh <<'EOF'
#!/bin/bash
# скачать свежий код из бакета и запустить; номер версии передаётся в CODE_GEN
TK=$(curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
GEN=$(curl -s -H "Authorization: Bearer $TK" "https://storage.googleapis.com/storage/v1/b/sol-scan-511718-data/o/code%2Fcollector.js?fields=generation" | tr -d "\n " | sed -E "s/.*generation\":\"([0-9]+)\".*/\1/")
curl -s -H "Authorization: Bearer $TK" -o /opt/solscan/collector.js "https://storage.googleapis.com/storage/v1/b/sol-scan-511718-data/o/code%2Fcollector.js?alt=media"
export CODE_GEN=$GEN
exec node --max-old-space-size=600 /opt/solscan/collector.js
EOF
chmod +x /opt/solscan/run.sh
cat > /etc/systemd/system/solscan.service <<'EOF'
[Unit]
Description=SOL-SCAN collector
After=network-online.target
[Service]
ExecStart=/opt/solscan/run.sh
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
# e2-micro: 1 ГБ памяти — добавим подкачку
if [ ! -f /swapfile ]; then fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
systemctl daemon-reload
systemctl enable --now solscan
