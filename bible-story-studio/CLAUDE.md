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

## Quick-start

```bash
npm install
npm run run -- --topic "Noah's Ark"          # full run (offline, no keys needed)
npm run run -- --topic "David and Goliath" --no-publish  # skip YouTube upload
npm run typecheck                              # must pass before any PR
npm test                                       # unit tests + full offline pipeline → episode.mp4
```

**Hard requirements:** Node ≥ 20 and `ffmpeg`/`ffprobe` on `PATH`. No build step — everything runs via `tsx`.

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
│   ├── worker.ts            Cloudflare Workflows control plane (deployable skeleton)
│   └── wrangler.jsonc       Wrangler config: Workflow, R2, Cron Trigger
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

## Cloudflare production deployment

See `cloudflare/worker.ts` and `ARCHITECTURE.md` for the full setup. High-level:

```
Cloudflare Cron (daily) → Workflow (durable, checkpointed, R2 artifacts)
  step: story/safety/metadata  → OpenRouter (Nous Hermes + Llama 3.3 70B)
  step: keyframes              → fal.ai Flux 2  (or Hetzner ComfyUI)
  step: animate                → fal.ai PixVerse V4.5  (or Hetzner Wan 2.7)
  step: voiceover              → ElevenLabs  (or self-hosted Kokoro)
  step: assemble (ffmpeg)      → Hetzner render box  ← can't run in Worker
  step: publish                → YouTube Data API v3
```

Secrets set via `npx wrangler secret put <NAME>`:
`OPENROUTER_API_KEY`, `FAL_API_KEY`, `ELEVENLABS_API_KEY`,
`RENDER_ENDPOINT`, `RENDER_TOKEN`,
`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`

---

## Safety & compliance — never regress

- **Safety gate runs before any paid render.** Keep it that way.
- **Uploads default to `unlisted` + `selfDeclaredMadeForKids: true`.** Only flip to `public` after human review.
- **`REQUIRE_APPROVAL=true`** halts the pipeline before publish for manual sign-off.
- **Keyword blocklist** in `src/moderation.ts` is a hard backstop — the LLM classifier is an additional layer, not a replacement.
- Use original, gentle retellings — verbatim Bible verse quotes may trigger copyright issues.
- Review the channel against YouTube's COPPA / "Made for Kids" requirements before going public at scale.

---

## Gotchas

- `ffmpeg` and `ffprobe` must be installed and on `PATH`. Their absence breaks media stages even in offline mode — install them first.
- `cloudflare/worker.ts` provider bodies are **stubbed with `throw new Error("wire up ... here")`** — it is a deployable skeleton, not a finished worker.
- `ffmpeg` cannot run inside a Cloudflare Worker. In production `assemble` calls out to a small HTTP service on Hetzner (or a Cloudflare Container) running the same code from `src/stages/assemble.ts`.
- Imports must end in `.js` even though the source files are `.ts`. This is an ESM/NodeNext requirement — do not remove the extensions.
- `out/`, `.env`, `node_modules/`, and `*.log` are gitignored. Never commit them.
