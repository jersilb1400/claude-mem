#!/usr/bin/env bash
# One-shot setup for a fresh Hetzner Ubuntu 22.04/24.04 server.
# Run as root: bash render-service/setup.sh
set -euo pipefail

echo "=== Bible Render Service — Hetzner Setup ==="

# ── 1. System packages ───────────────────────────────────────────────────
apt-get update -qq
apt-get install -y ffmpeg fonts-dejavu-core curl git
echo "ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}') ✓"
echo "DejaVu fonts ✓"

# ── 2. Bun runtime ───────────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc
fi
echo "Bun $(bun --version) ✓"

# ── 3. PM2 process manager ───────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  bun install -g pm2
fi
echo "PM2 $(pm2 --version) ✓"

# ── 4. Install render service dependencies ───────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
bun install
echo "Dependencies installed ✓"

# ── 5. Create .env if missing ─────────────────────────────────────────────
mkdir -p logs
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "  !! Edit render-service/.env with your secrets, then run:"
  echo "     pm2 start ecosystem.config.cjs"
  echo "     pm2 save && pm2 startup"
else
  echo ".env already exists ✓"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Checklist:"
echo "  1. Fill in render-service/.env  (RENDER_TOKEN, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)"
echo "  2. Set Wrangler secrets on Cloudflare:"
echo "       npx wrangler secret put RENDER_TOKEN    (same value as above)"
echo "       npx wrangler secret put RENDER_ENDPOINT  (e.g. https://YOUR-SERVER-IP:3001)"
echo "  3. Start the service:"
echo "       pm2 start render-service/ecosystem.config.cjs"
echo "       pm2 save && pm2 startup"
echo "  4. Test: curl http://YOUR-SERVER-IP:3001/health"
