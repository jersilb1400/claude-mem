#!/usr/bin/env bash
# One-shot local dev setup — creates a local D1 database and applies schema.
# Usage: cd cloudflare && bash dev-setup.sh
set -euo pipefail
cd "$(dirname "$0")"
npm install --silent
npx wrangler d1 create bible-videos-series-memory-dev 2>/dev/null || true
npx wrangler d1 execute bible-videos-series-memory-dev --file schema.sql --local
echo "✓ Local D1 ready. Run: npx wrangler dev --config wrangler.dev.jsonc"
