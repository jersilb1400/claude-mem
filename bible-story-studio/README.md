# Bible Story Studio

A **fully autonomous pipeline** that writes a children's Bible story, renders it
as a cute cartoon **animated video** with consistent characters, narration, music
and captions, then **publishes it to YouTube** — on a schedule, with no human in
the loop (an optional review gate is built in for peace of mind).

It is designed to drop straight onto the stack you already run: **Cloudflare**
(control plane + storage), **Hetzner** GPU/CPU boxes (heavy rendering), and
**OpenRouter / Nous Hermes** (writing).

> The repo ships with **fully offline fallbacks for every stage**, so you can run
> the entire pipeline end-to-end *right now with zero API keys* and get a real
> `episode.mp4`. Then flip stages over to production providers one env var at a
> time.

---

## What it does (9 stages)

| # | Stage | Offline (default) | Recommended production provider |
|---|-------|-------------------|---------------------------------|
| 1 | **Story + script** | built-in story | OpenRouter → **Nous Hermes** (you already use it) |
| 2 | **Kids-safety gate** | keyword check | OpenRouter utility model (Llama Guard / Llama 3.3) |
| 3 | **Voiceover (TTS)** | silent placeholder | **ElevenLabs** (emotion) or self-hosted **Kokoro** (cheap) |
| 4 | **Keyframes (images)** | cartoon SVG renderer | **Flux 2** (multi-ref char consistency) or **Nano Banana Pro** |
| 5 | **Animation (img→video)** | ffmpeg Ken-Burns | **PixVerse V4.5** (cartoon specialist) / **Kling 3.0** / self-host **Wan 2.7** |
| 6 | **Music** | ffmpeg gentle pad | **Suno** or a licensed royalty-free library |
| 7 | **Assembly** | ffmpeg (captions+mux) | same ffmpeg code on a Hetzner render box |
| 8 | **Thumbnail** | ffmpeg title card | Flux/Nano Banana + text overlay |
| 9 | **Publish** | mock manifest | **YouTube Data API v3** (resumable upload) |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design, the Cloudflare
control plane, cost notes, and the reasoning behind each tool choice.

---

## Quickstart (runs offline, no keys)

```bash
cd bible-story-studio
npm install
npm run run -- --topic "Daniel and the Lions' Den"
```

Output lands in `out/<date-id>/`:

- `episode.mp4` — the finished 1080p video (narration + captions + music)
- `thumbnail.jpg` — YouTube thumbnail
- `images/`, `clips/`, `audio/`, `segments/` — intermediate artifacts
- `upload-manifest.json` — exactly what *would* be sent to YouTube

Requirements: **Node ≥ 20** and **ffmpeg** on `PATH`. Nothing else.

### Go live, one stage at a time

```bash
cp .env.example .env
# add OPENROUTER_API_KEY            -> real AI-written stories + metadata
# set IMAGE_PROVIDER=fal + FAL_API_KEY  -> real Flux 2 cartoon keyframes
# set VIDEO_PROVIDER=fal                -> real PixVerse/Kling animation
# set TTS_PROVIDER=elevenlabs + key     -> real narration
# set PUBLISH_PROVIDER=youtube + OAuth  -> real upload
```

Every provider falls back to its offline implementation if the key is missing,
so a half-configured `.env` still produces a complete video.

---

## Recommended autonomous architecture (your stack)

```
Cloudflare Cron ─▶ Cloudflare Workflow (durable, retried, R2 artifacts)
                      │
   OpenRouter/Hermes ─┤ story + safety + SEO metadata
        fal.ai Flux 2 ┤ character-consistent keyframes
   fal PixVerse/Kling ┤ image → short animated clips   (or self-host Wan 2.7 on Hetzner GPU)
  ElevenLabs / Kokoro ┤ narration
       Hetzner render ┤ ffmpeg assembly (this repo's code as a tiny HTTP service)
       YouTube API v3 ┘ resumable upload (start unlisted → review → publish)
```

- **Control plane: Cloudflare Workflows** — durable, checkpointed steps with
  automatic retries and backoff. If animation fails you don't re-pay for the
  story/keyframes. Cron Triggers schedule one episode/day. R2 holds artifacts.
  Reference implementation in [`cloudflare/`](./cloudflare).
- **Heavy compute: Hetzner** — run open models (Wan 2.7, Flux 2 via ComfyUI,
  Kokoro) on your GPU box, and run the ffmpeg assembly (the code in
  `src/stages/assemble.ts`) as a small HTTP service. Cloudflare can't run ffmpeg,
  so this is the one piece that lives on your servers (or a Cloudflare Container).
- **Cost lever** — use cheap/free open models on Hetzner for volume, and reserve
  premium APIs (Veo 3.1, Kling O3, ElevenLabs) for "hero" episodes.

---

## Why these tools (mid-2026)

- **Image→video, cartoon style:** **PixVerse V4.5** is the stylized/cartoon/anime
  specialist; **Kling 3.0** is the best all-round value and can do A/V in one
  pass; **Wan 2.7** is the open self-host standard with first/last-frame control.
- **Character consistency** (the hardest part of a series): **Flux 2** with
  multi-reference (up to 10 ref images) or LoRA, or **Nano Banana Pro** for
  reasoning-based identity preservation. Generate a character sheet once, reuse it
  on every scene — the local renderer demonstrates the same idea by locking each
  character's palette across all scenes.
- **TTS:** **ElevenLabs** for the warmest kid narration; **Kokoro** (Apache-2.0,
  CPU-viable, ~$0–20/1M chars) when cost matters at volume.
- **Writing:** **Nous Hermes via OpenRouter** for the creative story, a cheaper
  model (e.g. Llama 3.3 70B) for structured metadata + the safety classifier.

These are pluggable — every provider sits behind a small interface in
`src/providers` and `src/stages`, so swapping models is a one-file change.

---

## Project layout

```
src/
  index.ts            CLI entry
  pipeline.ts         orchestrator (9 stages)
  config.ts           env config (+ .env loader)
  storage.ts          local FS storage (swap for R2)
  moderation.ts       kids-safety gate
  types.ts            zod schemas (Story/Scene/Character)
  stages/             story, voiceover, images, animate, music,
                      assemble, thumbnail, metadata, publish
  providers/          openrouter, svgScene, ffmpeg, youtube
cloudflare/           production Workflow control plane + wrangler config
test/                 unit + offline end-to-end tests
```

## Tests

```bash
npm run typecheck
npm test          # unit tests + a full offline pipeline run producing an mp4
```

## Safety & compliance notes for a kids channel

- Stories pass a **safety gate** before any money is spent on rendering.
- Uploads default to **`unlisted`** and set **`selfDeclaredMadeForKids: true`**;
  set `REQUIRE_APPROVAL=true` to hold every episode for human review before publish.
- Keep retellings faithful and gentle; review your channel against YouTube's
  "Made for Kids" / COPPA requirements before going public.
