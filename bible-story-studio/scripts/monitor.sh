#!/usr/bin/env bash
# Live status dashboard for the Bible Videos for Kids pipeline.
# Shows recent episodes, queue stats, and render service health.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║        Bible Videos for Kids — Pipeline Monitor         ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Recent episodes ───────────────────────────────────────────────────────────
echo "── Recent Episodes ──────────────────────────────────────────"
cd "$ROOT/cloudflare" && npx wrangler d1 execute bible-videos-series-memory \
  --command "SELECT substr(id,1,8) as id, title, status, youtube_url, datetime(created_at,'unixepoch') as created FROM episodes ORDER BY created_at DESC LIMIT 10" \
  --remote 2>/dev/null || echo "  (none yet)"

echo ""

# ── Queue status ──────────────────────────────────────────────────────────────
echo "── Topic Queue ──────────────────────────────────────────────"
cd "$ROOT/cloudflare" && npx wrangler d1 execute bible-videos-series-memory \
  --command "SELECT COUNT(*) as total, CAST(SUM(used) AS INTEGER) as used, COUNT(*)-CAST(SUM(used) AS INTEGER) as remaining FROM topics_queue" \
  --remote 2>/dev/null

echo ""
echo "── Next Up ──────────────────────────────────────────────────"
cd "$ROOT/cloudflare" && npx wrangler d1 execute bible-videos-series-memory \
  --command "SELECT topic, priority FROM topics_queue WHERE used=0 ORDER BY priority DESC, id ASC LIMIT 5" \
  --remote 2>/dev/null

echo ""

# ── Render service health ─────────────────────────────────────────────────────
echo "── Render Service Health ─────────────────────────────────────"
if [ -n "${RENDER_ENDPOINT:-}" ]; then
  curl -sf "${RENDER_ENDPOINT}/health" 2>/dev/null | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  status={d[\"status\"]}  ts={d[\"ts\"]}')" \
    2>/dev/null || echo "  ✗ service unreachable at ${RENDER_ENDPOINT}"
else
  echo "  Set RENDER_ENDPOINT env var to check (export RENDER_ENDPOINT=https://...)"
fi

echo ""
echo "── Awaiting Approval ─────────────────────────────────────────"
cd "$ROOT/cloudflare" && npx wrangler d1 execute bible-videos-series-memory \
  --command "SELECT substr(id,1,8) as id, title, datetime(created_at,'unixepoch') as assembled_at FROM episodes WHERE status='awaiting_approval' ORDER BY created_at DESC" \
  --remote 2>/dev/null || echo "  (none)"

echo ""
