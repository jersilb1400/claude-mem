# CLAUDE.md — Bible Story Studio

Context for Claude Code (and other AI agents) working in this repository. Read
this first; it captures the architecture, conventions, and gotchas that aren't
obvious from a single file.

## What this is

A **fully autonomous pipeline** that writes a children's Bible story, renders it
as a cute cartoon **animated video** (consistent characters, narration, music,
burned captions), and **publishes it to YouTube** — unattended, on a schedule,
with an optional human review gate.

The defining design choice: **every stage has an offline fallback**, so the
whole pipeline runs end-to-end with **zero API keys** and still produces a real
`episode.mp4`. Production providers are enabled one env var at a time.

## Commands

```bash
npm install           # deps: zod, @resvg/resvg-js (+ tsx, typescript)
npm run typecheck     # tsc --noEmit — run after any type/signature change
npm test              # tsx --test test/*.test.ts (unit + full offline run -> mp4)
npm run run -- --topic "Daniel and the Lions' Den"   # generate (+ publish) 1 episode
npm run run -- --no-publish                            # generate, skip publish
```

**Runtime requirements:** Node ≥ 20 and **ffmpeg** on `PATH` (ffmpeg/ffprobe are
used by the assembly + animation + music + voiceover-duration steps). There is no
build step — everything runs through `tsx` (ESM, `"type": "module"`).

## Architecture (read `ARCHITECTURE.md` for the full version)

A run is a single `Production` object (see `src/types.ts`) threaded through 9
stages in `src/pipeline.ts`:

```
story ─▶ safety ─▶ voiceover ─▶ keyframes ─▶ animate ─▶ music ─▶ assemble ─▶ thumbnail ─▶ metadata ─▶ publish
```

Key ordering invariant: **voiceover runs before animation on purpose.** Real TTS
clip lengths are probed with `ffprobe` and become each scene's duration, so the
animation length and burned captions line up exactly with the spoken narration.
If you reorder stages, preserve this dependency (`durations` flows voiceover →
animate/assemble).

### Data model (`src/types.ts`, all zod schemas)
- `Story` = `{ title, source, lesson, characters[], scenes[] }`.
- `Character` carries a **stable description + hex palette**. This is the
  character-consistency mechanism: the palette/description is appended to every
  scene prompt (and the offline renderer locks each character's colors).
- `Scene` = `{ narration, visual, characters[], setting }`. One scene == one
  keyframe == one animated clip == one caption line.
- `Production` is the mutable artifact bundle (image/clip/audio paths, durations,
  final video, metadata, publish result).

### Provider abstraction (the important pattern)
Each stage in `src/stages/*` branches on a `*_PROVIDER` env var and **always
keeps an offline (`local`/`mock`) fallback**. Concrete provider integrations live
in `src/providers/*`. When a key is missing the stage silently degrades to
offline, so a half-configured `.env` still yields a complete video.

| Stage | env switch | offline default | production option(s) |
|-------|------------|-----------------|----------------------|
| story / metadata / safety | `OPENROUTER_API_KEY` | built-in story + keyword gate | OpenRouter (Hermes + Llama) |
| images (keyframes) | `IMAGE_PROVIDER` | `local` SVG renderer | `fal` (Flux 2), self-host ComfyUI |
| animate (img→video) | `VIDEO_PROVIDER` | `local` ffmpeg Ken-Burns | `fal` (PixVerse/Kling), self-host |
| voiceover (TTS) | `TTS_PROVIDER` | `local` silent placeholder | `elevenlabs`, `kokoro` |
| music | `MUSIC_PROVIDER` | `local` ffmpeg pad | `suno` |
| publish | `PUBLISH_PROVIDER` | `mock` manifest | `youtube` (Data API v3) |

## File map

```
src/
  index.ts            CLI entry: `run --topic "..." [--no-publish]`
  pipeline.ts         orchestrator; defines the 9-stage order + approval gate
  config.ts           env config + tiny .env loader (no dotenv dep)
  storage.ts          local FS storage rooted at out/<id>/ (swap for R2 in prod)
  moderation.ts       kids-safety gate (runs before any render spend)
  logger.ts           tiny structured console logger (log.stage/info/ok/warn)
  types.ts            zod schemas: Scene / Character / Story + Production type
  stages/             story, voiceover, images, animate, music,
                      assemble, thumbnail, metadata, publish
  providers/          openrouter, svgScene, ffmpeg, youtube
cloudflare/           production Workflow control plane + wrangler.jsonc (stubs)
test/                 unit tests + a full offline pipeline run asserting an mp4
```

Config is centralized in `src/config.ts` (the `config` object). Don't read
`process.env` directly in stages — add a field to `config` and consume that.

## Conventions

- **ESM + NodeNext:** imports use explicit `.js` extensions even for `.ts`
  source (e.g. `import { config } from "./config.js"`). Match this or `tsc`/`tsx`
  will break.
- **TypeScript strict.** Run `npm run typecheck` before claiming done.
- **Validate external/model output with zod** (`*Schema.parse(...)`) — never
  trust raw LLM JSON.
- **Spend money late:** cheap text stages (story, safety) run before expensive
  media stages; the safety gate can abort before any render cost.
- **Every new provider keeps an offline fallback.** This keeps tests and demos
  free and deterministic.
- Comments explain *why* (intent/constraints), not *what*. Keep them sparse.

## Extending

- **New stage:** add `src/stages/<name>.ts` exporting an async fn that takes the
  relevant `Production` fields + `Storage`, and wire it into `pipeline.ts` in the
  right order (mind the voiceover→animate duration dependency).
- **New provider:** add to `src/providers/`, branch on the stage's `*_PROVIDER`
  env, and **keep the existing offline path** as the fallback.
- **Series memory (future):** persist character sheets + a "stories already told"
  list in R2/D1 so the cron picks fresh topics and reuses characters.

## Safety / compliance (kids channel — don't regress these)

- The safety gate runs **before** any paid render; keep it that way.
- Uploads default to `unlisted` + `selfDeclaredMadeForKids: true`.
- `REQUIRE_APPROVAL=true` stops the pipeline before publish for human review.
- Prefer original, gentle retellings (avoids Bible-translation copyright).

## Output

A run writes to `out/<YYYY-MM-DD>-<shortid>/`:
- `episode.mp4` — finished 1080p video (narration + captions + music)
- `thumbnail.jpg`
- `images/`, `clips/`, `audio/`, `segments/` — intermediates
- `upload-manifest.json` — exactly what would be sent to YouTube

`out/`, `.env`, `node_modules/`, and `*.log` are gitignored — never commit them.

## Gotchas

- ffmpeg/ffprobe must be installed; absence breaks media stages even in offline
  mode.
- The `cloudflare/worker.ts` provider call bodies are **stubbed with TODOs** —
  it's a deployable skeleton, not a finished worker.
- ffmpeg cannot run inside a Cloudflare Worker; in production the assembly step
  (`src/stages/assemble.ts`) runs as a small HTTP service on a Hetzner box (or a
  Cloudflare Container).
