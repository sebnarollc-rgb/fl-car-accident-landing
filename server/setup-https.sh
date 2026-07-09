#!/usr/bin/env bash
# =====================================================================
# Adds an HTTPS reverse proxy for the lead API, ALONGSIDE CampusSublet.
# Safe + additive: only creates ONE new nginx server block and validates
# with `nginx -t` before reloading. Does NOT touch CampusSublet config.
#
# Run on the VPS as root, AFTER you have a domain pointed at this server:
#   1) Create a DNS A record:  api.YOURDOMAIN.com  ->  5.78.194.199
#   2) Edit the two variables below.
#   3) sudo bash setup-https.sh
# =====================================================================
set -euo pipefail

# ---- EDIT THESE TWO ----
API_DOMAIN="api.sealaccidentgroup.com"     # subdomain for the lead backend
LE_EMAIL="admin@sealaccidentgroup.com"         # email for Let's Encrypt renewal notices
# ------------------------

APP_PORT=3001
SITE_FILE="/etc/nginx/sites-available/lead-api.conf"

echo "==> Checking prerequisites..."
command -v nginx >/dev/null || { echo "nginx not found — aborting."; exit 1; }
systemctl is-active --quiet pocketbase && echo "   (CampusSublet/pocketbase is running — good, we won't touch it)"

echo "==> Installing certbot (nginx plugin) if missing..."
if ! command -v certbot >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y certbot python3-certbot-nginx
fi

echo "==> Writing nginx server block for ${API_DOMAIN}..."
cat > "$SITE_FILE" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${API_DOMAIN};

    # Lead intake API -> Node app on localhost
    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX

# Enable the site (Ubuntu nginx uses sites-enabled). If your setup uses
# conf.d instead, move SITE_FILE there and skip this symlink.
if [ -d /etc/nginx/sites-enabled ]; then
  ln -sf "$SITE_FILE" /etc/nginx/sites-enabled/lead-api.conf
fi

echo "==> Validating nginx config (will NOT reload if this fails)..."
nginx -t

echo "==> Reloading nginx..."
systemctl reload nginx

echo "==> Requesting HTTPS certificate via Let's Encrypt..."
certbot --nginx -d "${API_DOMAIN}" --non-interactive --agree-tos -m "${LE_EMAIL}" --redirect

echo "==> Final validation + reload..."
nginx -t && systemctl reload nginx

echo
echo "==> Test:"
curl -s "https://${API_DOMAIN}/health" && echo "  <- lead API is live over HTTPS" || echo "  (no response yet — check: pm2 logs lead-server)"

echo
echo "============================================================"
echo " DONE. Lead API is reachable at: https://${API_DOMAIN}/api/lead"
echo " Next:"
echo "  1) In index-v3.html, set the form action to:"
echo "       https://${API_DOMAIN}/api/lead"
echo "  2) In /opt/lead-server/.env set ALLOWED_ORIGINS to your"
echo "     landing-page domain(s), then: pm2 restart lead-server"
echo "  3) Certbot auto-renews; CampusSublet was left untouched."
echo "============================================================"
