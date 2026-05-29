#!/usr/bin/env bash
# One-shot deploy: install deps → apply D1 schema → deploy Cloudflare Worker
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Bible Videos for Kids — Deploy         ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Install Wrangler ──────────────────────────────────────────────────────
echo "──► Installing Wrangler..."
npm install --prefix "$ROOT/cloudflare" --silent
echo "    $(cd "$ROOT/cloudflare" && npx wrangler --version 2>/dev/null) ✓"

# ── 2. Apply D1 schema (idempotent — CREATE IF NOT EXISTS + INSERT OR IGNORE) ─
echo "──► Applying D1 schema..."
cd "$ROOT/cloudflare" && npx wrangler d1 execute bible-videos-series-memory \
  --file schema.sql --remote
echo "    Schema applied ✓"

# ── 3. Deploy Worker ─────────────────────────────────────────────────────────
echo "──► Deploying Cloudflare Worker..."
cd "$ROOT/cloudflare" && npx wrangler deploy
echo "    Worker deployed ✓"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ✅  Deploy complete!                    ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. bash scripts/secrets.sh   — set all API keys"
echo "  2. bash scripts/monitor.sh   — check episode status"
echo "  3. POST /run                 — trigger a manual episode"
echo ""
