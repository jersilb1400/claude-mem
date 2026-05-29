.PHONY: help deploy secrets monitor run topics youtube-oauth tunnel typecheck cost-report dashboard

# Set WORKER_URL to your deployed worker URL:
#   export WORKER_URL=https://bible-story-studio.<subdomain>.workers.dev
WORKER_URL ?=

help:
	@echo ""
	@echo "╔══════════════════════════════════════════════════════════╗"
	@echo "║         Bible Videos for Kids — Make Targets            ║"
	@echo "╚══════════════════════════════════════════════════════════╝"
	@echo ""
	@echo "  make deploy         One-shot deploy (D1 schema + Worker)"
	@echo "  make secrets        Interactive API keys setup"
	@echo "  make monitor        Episode status + queue + health"
	@echo "  make topics         Preview + insert 60 Bible story topics"
	@echo "  make run            Trigger one episode (manual)"
	@echo "  make youtube-oauth  Get YouTube OAuth2 refresh token"
	@echo "  make tunnel         Set up Cloudflare Tunnel (run on Hetzner)"
	@echo "  make typecheck      TypeScript type check (worker + render)"
	@echo "  make cost-report    Print cost breakdown by episode/month/provider"
	@echo "  make dashboard      Build + deploy admin dashboard to Cloudflare Pages"
	@echo ""

deploy:
	bash scripts/deploy.sh

secrets:
	bash scripts/secrets.sh

monitor:
	bash scripts/monitor.sh

run:
	@if [ -z "$(WORKER_URL)" ]; then \
	  echo "Set WORKER_URL first: export WORKER_URL=https://bible-story-studio.xxx.workers.dev"; \
	  exit 1; \
	fi
	@echo "Triggering episode..."
	@curl -sf -X POST "$(WORKER_URL)/run" | python3 -m json.tool

run-topic:
	@if [ -z "$(WORKER_URL)" ] || [ -z "$(TOPIC)" ]; then \
	  echo "Usage: make run-topic WORKER_URL=https://... TOPIC='Noah and the Ark'"; \
	  exit 1; \
	fi
	@curl -sf -X POST "$(WORKER_URL)/run" \
	  -H "Content-Type: application/json" \
	  -d "{\"topic\":\"$(TOPIC)\"}" | python3 -m json.tool

topics:
	@bun run scripts/add-topics.ts --preview
	@echo ""
	@read -rp "Insert these $(shell bun run scripts/add-topics.ts --preview 2>/dev/null | grep -c '^\s\+\[') topics into D1? [y/N] " confirm; \
	  [ "$$confirm" = "y" ] && bun run scripts/add-topics.ts || echo "Cancelled."

youtube-oauth:
	@if [ -z "$(YOUTUBE_CLIENT_ID)" ] || [ -z "$(YOUTUBE_CLIENT_SECRET)" ]; then \
	  echo "Usage: make youtube-oauth YOUTUBE_CLIENT_ID=xxx YOUTUBE_CLIENT_SECRET=yyy"; \
	  exit 1; \
	fi
	@YOUTUBE_CLIENT_ID="$(YOUTUBE_CLIENT_ID)" YOUTUBE_CLIENT_SECRET="$(YOUTUBE_CLIENT_SECRET)" \
	  bun run scripts/youtube-oauth.ts

tunnel:
	@bash scripts/setup-tunnel.sh

typecheck:
	@echo "── Worker (cloudflare/) ──────────────────────────────"
	@cd cloudflare && npm install --silent && npx tsc --noEmit
	@echo "   ✓ Worker types OK"
	@echo ""
	@echo "── Render service (render-service/) ─────────────────"
	@cd render-service && bun run tsc --noEmit
	@echo "   ✓ Render service types OK"

cost-report:
	@bun run scripts/cost-report.ts

dashboard:
	@echo "Building dashboard..."
	@cd dashboard && npm install --silent && npm run build
	@echo "Deploying to Cloudflare Pages..."
	@cd cloudflare && npx wrangler pages deploy ../dashboard/dist --project-name bible-story-dashboard
	@echo "   ✓ Dashboard deployed"
