#!/usr/bin/env bash
# Set up Genesis on a fresh Ubuntu 24.04 VM (Vultr). Run as root, after the domain's DNS points here:
#   DOMAIN=genesis.example.com bash setup.sh
# Safe to run again: it updates the code and restarts the services.
set -euo pipefail

: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=genesis.example.com bash setup.sh}"
REPO="${REPO:-https://github.com/Akhilesh0013/HackUTA.git}"
APP=/opt/genesis
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -q
apt-get install -y -q git curl ufw debian-keyring debian-archive-keyring apt-transport-https gnupg openssl
if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

echo "== app"
id genesis >/dev/null 2>&1 || useradd --system --home-dir "$APP" --no-create-home --shell /usr/sbin/nologin genesis
if [ ! -d "$APP/.git" ]; then git clone "$REPO" "$APP"; fi
chown -R genesis:genesis "$APP"
sudo -u genesis git -C "$APP" pull --ff-only
sudo -u genesis HOME="$APP" npm --prefix "$APP" ci --no-audit --no-fund
sudo -u genesis mkdir -p "$APP/data"

echo "== secrets"
if [ ! -f "$APP/.env" ]; then
  cp "$APP/.env.example" "$APP/.env"
  printf '\nDASHBOARD_TOKEN=%s\n' "$(openssl rand -hex 16)" >> "$APP/.env"
  NEW_ENV=1
fi
chown genesis:genesis "$APP/.env"
chmod 600 "$APP/.env"

echo "== services"
install -m 644 "$APP/deploy/genesis-web.service" /etc/systemd/system/genesis-web.service
install -m 644 "$APP/deploy/genesis-bridge.service" /etc/systemd/system/genesis-bridge.service
systemctl daemon-reload
systemctl enable genesis-web >/dev/null
systemctl restart genesis-web
if grep -qE '^LIVEKIT_URL=.+' "$APP/.env" "$APP/.env.local" 2>/dev/null; then
  systemctl enable genesis-bridge >/dev/null
  systemctl restart genesis-bridge
  BRIDGE=on
else
  BRIDGE="off (add LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET to $APP/.env, then run this again)"
fi

echo "== https"
sed "s/GENESIS_DOMAIN/$DOMAIN/" "$APP/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "== firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

TOKEN="$(grep -E '^DASHBOARD_TOKEN=' "$APP/.env" | tail -1 | cut -d= -f2-)"
echo
echo "Done."
echo "  Call page:  https://$DOMAIN/call.html"
echo "  Dashboard:  https://$DOMAIN/dashboard.html?token=$TOKEN"
echo "  Bridge:     $BRIDGE"
if [ "${NEW_ENV:-}" = 1 ]; then
  echo "  Next: put GEMINI_API_KEY (and MONGODB_URI if used) in $APP/.env, then: systemctl restart genesis-web"
fi
echo "  Logs: journalctl -u genesis-web -f"
