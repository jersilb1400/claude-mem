# CLAUDE.md — Bible Videos for Kids

This file gives Claude Code (and other AI agents) everything needed to work in this repo without reading every source file first.

---

## What this project is

**Bible Videos for Kids** is a fully autonomous pipeline that:
1. Writes a children's Bible story (via LLM)
2. Renders it as a cute cartoon animated video — consistent characters, narration, music, burned captions
3. Publishes it to YouTube — on a schedule, unattended

The defining design choice: **every stage has an offline fallback**. The whole pipeline runs end-to-end with **zero API keys** and produces a real `episode.mp4`. Flip stages to production providers one env var at a time.

Target audience: children ages 3–8. Content must be gentle, joyful, and safe for kids.

---

## Quick-start (Cloudflare + Hetzner production)

```bash
make deploy          # install Wrangler + apply D1 schema + deploy Worker
make secrets         # interactive: set all API keys via wrangler secret put
make topics          # insert 60 Bible story topics into D1
make monitor         # view episode status, queue, render service health
make run             # trigger one episode manually (set WORKER_URL first)
make typecheck       # TypeScript check (worker + render service)
```

**Prerequisites:** Node ≥ 20, Bun, `wrangler` (installed by `make deploy`).

### Local offline pipeline (no keys needed)

```bash
npm install
npm run run -- --topic "Noah's Ark"          # full offline run → episode.mp4
npm run typecheck && npm test
```

**Hard requirements:** Node ≥ 20 and `ffmpeg`/`ffprobe` on `PATH`. No build step — runs via `tsx`.

---

## Environment configuration

Copy `.env.example` to `.env`. Every key is optional — missing keys silently fall back to the offline implementation.

| Variable | Stage | Default |
|----------|-------|---------|
| `OPENROUTER_API_KEY` | story, metadata, safety | offline built-in story |
| `OPENROUTER_MODEL` | story | `nousresearch/hermes-4-405b` |
| `OPENROUTER_UTILITY_MODEL` | metadata, safety | `meta-llama/llama-3.3-70b-instruct` |
| `IMAGE_PROVIDER` | keyframes | `local` (SVG renderer) |
| `FAL_API_KEY` | keyframes, animation | — |
| `FAL_IMAGE_MODEL` | keyframes | `fal-ai/flux-2` |
| `FAL_VIDEO_MODEL` | animation | `fal-ai/pixverse/v4.5/image-to-video` |
| `VIDEO_PROVIDER` | animation | `local` (Ken-Burns ffmpeg) |
| `TTS_PROVIDER` | voiceover | `local` (silent placeholder) |
| `ELEVENLABS_API_KEY` | voiceover | — |
| `ELEVENLABS_VOICE_ID` | voiceover | — |
| `KOKORO_ENDPOINT` | voiceover | — |
| `MUSIC_PROVIDER` | music | `local` (ffmpeg C-major pad) |
| `SUNO_API_KEY` | music | — |
| `PUBLISH_PROVIDER` | publish | `mock` (writes manifest, no upload) |
| `YOUTUBE_CLIENT_ID` | publish | — |
| `YOUTUBE_CLIENT_SECRET` | publish | — |
| `YOUTUBE_REFRESH_TOKEN` | publish | — |
| `YOUTUBE_PRIVACY` | publish | `unlisted` |
| `REQUIRE_APPROVAL` | publish gate | `false` |
| `OUTPUT_DIR` | all | `./out` |
| `VIDEO_WIDTH` / `VIDEO_HEIGHT` | all | `1920` / `1080` |

---

## Pipeline — 9 stages in order

```
1. story      →  2. safety  →  3. voiceover  →  4. images  →  5. animate
→  6. music   →  7. assemble →  8. thumbnail  →  9. metadata  →  publish
```

**Critical ordering invariant:** voiceover runs *before* animation. Real TTS clip lengths are probed with `ffprobe` and become each scene's duration, so animation and captions line up exactly with narration. Do not reorder these two stages.

| # | Stage | File | Offline | Production |
|---|-------|------|---------|------------|
| 1 | Story + script | `src/stages/story.ts` | built-in Daniel story | OpenRouter Hermes |
| 2 | Kids-safety gate | `src/moderation.ts` | keyword blocklist | OpenRouter utility model |
| 3 | Voiceover (TTS) | `src/stages/voiceover.ts` | silent `.m4a` | ElevenLabs or Kokoro |
| 4 | Keyframes (images) | `src/stages/images.ts` | SVG → PNG via resvg | fal Flux 2 / ComfyUI |
| 5 | Animation (img→video) | `src/stages/animate.ts` | ffmpeg Ken-Burns | fal PixVerse V4.5 / Kling 3 |
| 6 | Music bed | `src/stages/music.ts` | ffmpeg sine-wave pad | Suno |
| 7 | Assembly | `src/stages/assemble.ts` | ffmpeg (captions + mux) | same ffmpeg on Hetzner |
| 8 | Thumbnail | `src/stages/thumbnail.ts` | ffmpeg title card | — |
| 9 | SEO Metadata | `src/stages/metadata.ts` | template | OpenRouter utility model |
| — | Publish | `src/stages/publish.ts` | writes manifest JSON | YouTube Data API v3 |

---

## Data model (`src/types.ts`)

All schemas are validated with **zod** — never trust raw LLM JSON.

```
Story
  title       string
  source      string        (Bible passage, e.g. "Daniel 6")
  lesson      string        (one-line moral for parents)
  characters  Character[]   (min 1, reused across scenes)
  scenes      Scene[]       (min 3, recommended 5–7)

Character
  name        string
  description string        (stable look — appended to every scene prompt)
  palette     { skin, hair, robe }  (hex — locks color across offline renders)

Scene
  narration   string        (1–2 short sentences, simple words)
  visual      string        (image/animation prompt)
  characters  string[]      (names present in this scene)
  setting     day|night|sunrise|indoor|water|desert

Production   (artifact bundle threaded through all stages)
  id, story, sceneImages[], sceneClips[],
  narrationAudio, musicAudio, finalVideo, thumbnail,
  metadata, sceneDurations[], publishResult
```

**Character consistency mechanism:** each character's `description` and `palette` are injected into every scene prompt. The offline SVG renderer locks colors by palette. Production image models (Flux 2 multi-ref) use the description for identity lock-in across the episode.

---

## File structure

```
bible-story-studio/          ← repo root when deployed to Bible-Videos-for-Kids
├── src/
│   ├── index.ts             CLI entry (run, --topic, --no-publish)
│   ├── pipeline.ts          Orchestrator — 9-stage order + approval gate
│   ├── config.ts            Centralised env config + .env loader (no dotenv dep)
│   ├── storage.ts           Local FS storage; swap body for Cloudflare R2 in prod
│   ├── moderation.ts        Kids-safety gate (keyword + optional LLM classifier)
│   ├── logger.ts            Structured console logger (log.stage/info/ok/warn)
│   ├── types.ts             Zod schemas: Scene / Character / Story / Production
│   ├── stages/
│   │   ├── story.ts         LLM story generation (offline: built-in Daniel story)
│   │   ├── voiceover.ts     TTS per scene + ffprobe duration measurement
│   │   ├── images.ts        Keyframe rendering (offline: SVG via resvg)
│   │   ├── animate.ts       Image → video clip (offline: Ken-Burns ffmpeg)
│   │   ├── music.ts         Background music bed (offline: ffmpeg sine pad)
│   │   ├── assemble.ts      Final mux: captions + audio concat + music mix
│   │   ├── thumbnail.ts     1280×720 thumbnail from first keyframe
│   │   ├── metadata.ts      YouTube SEO title/description/tags
│   │   └── publish.ts       YouTube upload or mock manifest
│   └── providers/
│       ├── openrouter.ts    Minimal OpenRouter/OpenAI-compatible chat client
│       ├── svgScene.ts      Deterministic flat-vector cartoon SVG renderer
│       ├── ffmpeg.ts        ffmpeg/ffprobe helpers + caption escaping utilities
│       └── youtube.ts       YouTube Data API v3 resumable upload (fetch-only)
├── cloudflare/
│   ├── worker.ts            Full Workflows control plane (all 11 steps, approval gate)
│   ├── wrangler.jsonc       Wrangler config: Workflow, R2, D1, Cron Trigger
│   ├── schema.sql           D1 schema + 20 seed topics (idempotent, safe to re-run)
│   ├── package.json         Wrangler + @cloudflare/workers-types
│   └── tsconfig.json        Worker TypeScript config
├── render-service/
│   ├── server.ts            Hono HTTP server (port 3001, graceful SIGTERM)
│   ├── assemble.ts          Core ffmpeg assembly: captions + mux + music + thumbnail
│   ├── r2.ts                S3-compatible R2 download/upload helpers
│   ├── ffmpeg.ts            ffmpeg/ffprobe spawn helpers + caption wrap
│   ├── types.ts             AssembleRequest / AssembleResult interfaces
│   ├── package.json         hono + @aws-sdk/client-s3
│   ├── tsconfig.json        Bun-compatible TypeScript config
│   ├── ecosystem.config.cjs PM2 config (name: bible-render)
│   ├── .env.example         Port, RENDER_TOKEN, R2 credentials
│   └── setup.sh             One-shot Hetzner Ubuntu setup (ffmpeg, Bun, PM2)
├── scripts/
│   ├── deploy.sh            One-shot deploy (schema + worker)
│   ├── secrets.sh           Interactive wrangler secret put for all keys
│   ├── youtube-oauth.ts     OAuth2 refresh token helper (Bun)
│   ├── setup-tunnel.sh      Cloudflare Tunnel setup for Hetzner
│   ├── monitor.sh           Episode status + queue + render health
│   └── add-topics.ts        Bulk topic insertion (60 curated stories)
├── .github/
│   └── workflows/deploy.yml Auto-deploy Worker on push to main
├── Makefile                 Developer shortcuts (deploy, secrets, monitor, run, topics)
├── test/
│   └── pipeline.test.ts     Unit tests + full offline end-to-end run → mp4
├── .env.example             All env vars with explanations
├── package.json
├── tsconfig.json
├── ARCHITECTURE.md          Full design doc, cost notes, tool selection rationale
└── CLAUDE.md                ← this file
```

**Output** (written to `out/<YYYY-MM-DD>-<shortid>/`, gitignored):
```
episode.mp4          finished 1080p video
thumbnail.jpg        YouTube thumbnail
images/              per-scene PNG keyframes
clips/               per-scene animated .mp4 clips
audio/               per-scene narration + music bed
segments/            captioned+narrated segment clips
upload-manifest.json what would be sent to YouTube (mock mode)
```

---

## Conventions — must follow

- **ESM + NodeNext:** all imports use explicit `.js` extensions on `.ts` source files (e.g. `import { config } from "./config.js"`). This is required for `tsx` and `tsc` to work correctly.
- **TypeScript strict** — `npm run typecheck` must pass before claiming done.
- **Validate all LLM/external output with zod** — `StorySchema.parse(...)`, never trust raw JSON from a model.
- **Read env via `config` object only** — never call `process.env` directly in stage files; add a field to `src/config.ts` and consume it there.
- **Spend money late** — text stages (story, safety) always run before media stages. The safety gate aborts the pipeline before any render cost.
- **Every new provider keeps an offline fallback** — tests and demos must run free and deterministically with no keys.
- **No comments explaining what** — only add a comment when the *why* is non-obvious (a constraint, a workaround, an invariant).

---

## Extending the pipeline

**New stage:**
1. Create `src/stages/<name>.ts` exporting `async function <name>(... Production fields ..., storage: Storage): Promise<...>`
2. Import and call it from `src/pipeline.ts` in the correct position (mind the voiceover → animate duration dependency)

**New provider:**
1. Add `src/providers/<name>.ts`
2. Branch on `config.<stage>.provider` inside the relevant stage file
3. Keep the existing `local`/`mock` path as the default fallback

**Series memory (planned):** persist character sheets + "stories already told" list in R2/D1 so the cron picks fresh topics and reuses characters across episodes.

---

## Cloudflare + Hetzner production deployment

```
Cloudflare Cron (0 15 * * *) → StudioWorkflow (durable, checkpointed)
  step 0:  pick topic         → D1 topics_queue
  step 1:  story              → OpenRouter Nous Hermes 4 405B
  step 2:  safety gate        → keyword blocklist + Llama 3.3 70B
  step 3:  keyframes          → fal.ai Flux 2  (character-consistent)
  step 4:  animate            → fal.ai PixVerse V4.5  (cartoon style)
  step 5:  voiceover          → ElevenLabs Rachel  (11_multilingual_v2)
  step 6:  music              → Suno API  (instrumental)
  step 7:  assemble           → Hetzner render service  (ffmpeg, can't run in Worker)
  step 8:  SEO metadata       → Llama 3.3 70B
  step 9:  record to D1       → series memory + character library
  step 10: publish            → YouTube Data API v3  (or hold if REQUIRE_APPROVAL=true)
```

### First-time setup

```bash
# 1. Deploy the Worker
make deploy

# 2. Set all secrets
make secrets

# 3. Seed Bible story topics
make topics

# 4. Provision Hetzner server (CX21 or higher)
#    SSH into the box, clone this repo, then:
bash render-service/setup.sh
# Fill in render-service/.env, then:
pm2 start render-service/ecosystem.config.cjs && pm2 save && pm2 startup

# 5. Expose render service via Cloudflare Tunnel
bash scripts/setup-tunnel.sh  # run on Hetzner box

# 6. Get YouTube refresh token (run on your laptop)
make youtube-oauth YOUTUBE_CLIENT_ID=xxx YOUTUBE_CLIENT_SECRET=yyy

# 7. Monitor
make monitor
```

### Wrangler secrets reference

| Secret | Source |
|--------|--------|
| `OPENROUTER_API_KEY` | openrouter.ai → Keys |
| `FAL_API_KEY` | fal.ai → API Keys |
| `ELEVENLABS_API_KEY` | elevenlabs.io → Profile → API Keys |
| `SUNO_API_KEY` | suno.ai → Settings |
| `RENDER_TOKEN` | any strong random string (same in render-service/.env) |
| `RENDER_ENDPOINT` | your tunnel hostname, e.g. `https://render.yourdomain.com` |
| `YOUTUBE_CLIENT_ID` | Google Cloud Console → Desktop app credential |
| `YOUTUBE_CLIENT_SECRET` | same credential |
| `YOUTUBE_REFRESH_TOKEN` | run `make youtube-oauth` |
| `REQUIRE_APPROVAL` | optional — set `true` to hold before publish |

### R2 API token (for render service)

Cloudflare Dashboard → R2 → Manage R2 API Tokens → Create Token (read + write on `bible-story-artifacts`). Put values in `render-service/.env`.

### CI/CD — auto-deploy on push

`.github/workflows/deploy.yml` deploys the Worker whenever `cloudflare/` changes on `main`.  
Add `CLOUDFLARE_API_TOKEN` as a GitHub repository secret (Cloudflare Dashboard → User API Tokens → "Edit Cloudflare Workers" template).

---

## Safety & compliance — never regress

- **Safety gate runs before any paid render.** Keep it that way.
- **Uploads default to `unlisted` + `selfDeclaredMadeForKids: true`.** Only flip to `public` after human review.
- **`REQUIRE_APPROVAL=true`** halts the pipeline before publish for manual sign-off.
- **Keyword blocklist** in `src/moderation.ts` is a hard backstop — the LLM classifier is an additional layer, not a replacement.
- Use original, gentle retellings — verbatim Bible verse quotes may trigger copyright issues.
- Review the channel against YouTube's COPPA / "Made for Kids" requirements before going public at scale.

---

## Scripts reference

| Script | What it does |
|--------|-------------|
| `scripts/deploy.sh` | `npm install` → `wrangler d1 execute schema.sql` → `wrangler deploy` |
| `scripts/secrets.sh` | Interactive prompts → `wrangler secret put` for each key |
| `scripts/youtube-oauth.ts` | Local OAuth2 server → exchanges code → prints refresh token |
| `scripts/setup-tunnel.sh` | Installs cloudflared + registers as system service on Hetzner |
| `scripts/monitor.sh` | D1 recent episodes + queue stats + render service health |
| `scripts/add-topics.ts` | Inserts 60 curated Bible topics into D1 (`--preview` to list first) |

---

## Gotchas

- `ffmpeg` and `ffprobe` must be on `PATH` on the Hetzner box. `render-service/setup.sh` installs them via apt.
- `ffmpeg` cannot run inside a Cloudflare Worker — that is why `render-service/` exists as a separate Hetzner HTTP service.
- Approval mode: set `REQUIRE_APPROVAL=true` as a Wrangler secret. Episodes stop at status `awaiting_approval`. Publish with `POST /approve/:id` (Bearer `RENDER_TOKEN`).
- Imports in `src/` must end in `.js` even though source files are `.ts`. ESM/NodeNext requirement — do not remove extensions.
- `out/`, `.env`, `node_modules/`, and `*.log` are gitignored. Never commit them.
- The Cloudflare Tunnel must be running on Hetzner before the daily cron fires, otherwise step 7 (assemble) will fail and retry.
