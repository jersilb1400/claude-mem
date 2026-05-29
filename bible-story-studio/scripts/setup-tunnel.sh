#!/usr/bin/env bash
# Set up a Cloudflare Tunnel on your Hetzner server.
# This securely exposes the render service to the Cloudflare Worker without
# opening firewall ports. Run as root AFTER render-service/setup.sh.
#
# Steps before running:
#   1. Cloudflare Dashboard → Zero Trust → Networks → Tunnels → Create Tunnel
#   2. Choose "Cloudflared" → give it a name (e.g. "bible-render")
#   3. Copy the token from the install command shown in the dashboard
#   4. Run: bash scripts/setup-tunnel.sh
set -euo pipefail

echo ""
echo "=== Cloudflare Tunnel Setup for Bible Render Service ==="
echo ""

# ── 1. Install cloudflared ────────────────────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
  echo "──► Installing cloudflared..."
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
    -o /tmp/cloudflared.deb
  dpkg -i /tmp/cloudflared.deb
  rm /tmp/cloudflared.deb
fi
echo "cloudflared $(cloudflared --version 2>&1 | head -1) ✓"

# ── 2. Collect tunnel token ───────────────────────────────────────────────────
echo ""
echo "Get your tunnel token from Cloudflare Dashboard:"
echo "  Zero Trust → Networks → Tunnels → Create a Tunnel"
echo "  → Choose Cloudflared → Set up: your tunnel will appear in the list"
echo "  → Install & run connector — copy the TOKEN from the cloudflared command"
echo ""
read -rp "Paste tunnel token (starts with ey...): " TUNNEL_TOKEN
echo ""

# ── 3. Configure ingress: point tunnel → render service localhost ─────────────
# The tunnel token already encodes the routing. With Zero Trust, you configure
# the public hostname in the dashboard pointing to http://localhost:3001
echo "──► Installing cloudflared as system service..."
cloudflared service install "$TUNNEL_TOKEN"

echo "──► Starting cloudflared service..."
systemctl start cloudflared
systemctl enable cloudflared

echo ""
echo "──► Service status:"
systemctl status cloudflared --no-pager -l | tail -5

echo ""
echo "==================================================================="
echo "✅  Tunnel is running!"
echo ""
echo "Configure the public hostname in Cloudflare Dashboard:"
echo "  Zero Trust → Networks → Tunnels → [your tunnel] → Public Hostnames"
echo "  → Add a hostname:"
echo "       Subdomain : render"
echo "       Domain    : yourdomain.com"
echo "       Service   : http://localhost:3001"
echo ""
echo "Then set your Wrangler secret:"
echo "  cd cloudflare && npx wrangler secret put RENDER_ENDPOINT"
echo "  (enter: https://render.yourdomain.com)"
echo "==================================================================="
echo ""
