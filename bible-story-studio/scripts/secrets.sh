#!/usr/bin/env bash
# Interactive Wrangler secrets setup — prompts for each key and calls
# `wrangler secret put` so nothing is ever written to disk.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Bible Videos for Kids — Secrets Setup  ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Each value is piped directly to 'wrangler secret put'."
echo "Leave any entry blank to skip it."
echo ""

set_secret() {
  local name="$1" label="${2:-required}"
  printf "  %-32s [%s]\n  > " "$name" "$label"
  read -rs VALUE
  echo ""
  if [ -n "$VALUE" ]; then
    echo "$VALUE" | (cd "$ROOT/cloudflare" && npx wrangler secret put "$name")
    echo "    ✓ $name saved"
  else
    echo "    - $name skipped"
  fi
  echo ""
}

echo "── API Keys ──────────────────────────────────────────────"
echo ""

set_secret "OPENROUTER_API_KEY"    "required — story + safety + metadata LLMs"
set_secret "FAL_API_KEY"           "required — Flux 2 keyframes + PixVerse animation"
set_secret "ELEVENLABS_API_KEY"    "required — Rachel voice narration"
set_secret "SUNO_API_KEY"          "required — instrumental music bed"

echo "── Render Service ────────────────────────────────────────"
echo ""
set_secret "RENDER_TOKEN"          "required — shared secret, same value as render-service/.env"
set_secret "RENDER_ENDPOINT"       "required — https://your-tunnel-hostname (no trailing slash)"

echo "── YouTube OAuth2 ────────────────────────────────────────"
echo ""
echo "  Run 'make youtube-oauth' to generate YOUTUBE_REFRESH_TOKEN."
echo ""
set_secret "YOUTUBE_CLIENT_ID"      "required — Google Cloud Console Desktop app"
set_secret "YOUTUBE_CLIENT_SECRET"  "required"
set_secret "YOUTUBE_REFRESH_TOKEN"  "required — run 'make youtube-oauth' to obtain"

echo "── Optional ──────────────────────────────────────────────"
echo ""
set_secret "REQUIRE_APPROVAL"       "optional — set to 'true' to hold episodes before publishing"

echo "╔══════════════════════════════════════════╗"
echo "║  ✅  Secrets setup complete!             ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Run 'make deploy' to deploy the Worker."
echo ""
