#!/bin/sh
# One-time server setup for cepheus.codes (Debian/Ubuntu, run as root).
# Installs Node.js and Caddy as standalone binaries, creates the service user, firewall and services.
# The NVIDIA key is read from /etc/cepheus/proxy.env, which this script creates only if missing.
set -eu

NODE_VERSION=v20.18.1
CADDY_VERSION=2.8.4

apt-get update -y || true
apt-get install -y --no-install-recommends ca-certificates curl xz-utils ufw fail2ban || true

# Node.js (official binary; works on older Debian too)
if ! /usr/local/bin/node --version 2>/dev/null | grep -q "$NODE_VERSION"; then
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi

# Caddy (official static binary)
if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" -o /tmp/caddy.tgz
  tar -xzf /tmp/caddy.tgz -C /usr/local/bin caddy
  rm -f /tmp/caddy.tgz
  setcap cap_net_bind_service=+ep /usr/local/bin/caddy || true
fi
id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
mkdir -p /etc/caddy
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# App user and folders
id cepheus >/dev/null 2>&1 || useradd --system --home /srv/cepheus --shell /usr/sbin/nologin cepheus
mkdir -p /srv/cepheus/site /srv/cepheus/proxy /etc/cepheus
if [ ! -f /etc/cepheus/proxy.env ]; then
  umask 077
  printf 'NVIDIA_API_KEY=\nPORT=8787\nHOST=127.0.0.1\nRPM=20\nRPD=400\n' > /etc/cepheus/proxy.env
fi
chmod 600 /etc/cepheus/proxy.env
chown root:root /etc/cepheus/proxy.env

# Firewall: SSH, HTTP, HTTPS only
ufw allow OpenSSH || ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl daemon-reload
echo "Setup done. Next: put the NVIDIA key in /etc/cepheus/proxy.env, upload files, then run deploy steps."
