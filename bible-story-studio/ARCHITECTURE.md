# Architecture & Tooling Guide

This document explains how Bible Story Studio is put together, the recommended
production deployment on your stack (Cloudflare + Hetzner + OpenRouter), and the
reasoning behind each tool choice as of mid-2026.

## 1. Design principles

1. **Stage-isolated & pluggable.** Each of the 9 stages has a single
   responsibility and sits behind a tiny interface. Swapping ElevenLabs for
   Kokoro, or Flux for Nano Banana, is a one-file change.
2. **Always runnable.** Every stage has an offline implementation, so the whole
   pipeline works with zero credentials. This makes development, testing, and
   demos cheap and deterministic.
3. **Spend money late.** Cheap text stages (story, safety) run before expensive
   media stages, and a safety gate can abort before any render cost is incurred.
4. **Durable & idempotent.** In production each stage is a checkpointed Workflow
   step; a failure resumes from the last success instead of restarting.

## 2. Data model

A run is a single `Production` (see `src/types.ts`) threaded through the stages:

- `Story` → `{ title, source, lesson, characters[], scenes[] }`
- `Character` carries a **stable description + palette** that is appended to
  every scene's prompt — this is the mechanism for **character consistency**
  across the episode.
- `Scene` → `{ narration, visual, characters[], setting }`. One scene == one
  keyframe == one animated clip == one caption.

## 3. Stage pipeline

```
story ─▶ safety ─▶ voiceover ─▶ keyframes ─▶ animate ─▶ music ─▶ assemble ─▶ thumbnail ─▶ metadata ─▶ publish
```

Voiceover runs **before** animation on purpose: real TTS clip lengths are probed
with `ffprobe` and used to set each scene's duration, so the animation and burned
captions line up exactly with the spoken narration.

### Assembly (the one CPU-heavy local step)

`src/stages/assemble.ts` uses ffmpeg to: burn per-scene captions from text files
(robust against punctuation), attach each scene's narration, concat the segments,
then mix a low-volume music bed under the whole thing with `amix`. This is the
only piece that cannot run inside a Cloudflare Worker, so in production it runs as
a small HTTP service on a Hetzner box (or a Cloudflare Container).

## 4. Recommended production deployment

```
┌─────────────────────── Cloudflare ───────────────────────┐
│ Cron Trigger ─▶ Workflow (StudioWorkflow)                 │
│                  │  durable steps, retries, R2 artifacts  │
│                  ├─ story/metadata  → OpenRouter (Hermes)  │
│                  ├─ keyframes       → fal.ai Flux 2        │
│                  ├─ animate         → fal.ai PixVerse/Kling│
│                  ├─ voiceover       → ElevenLabs/Kokoro    │
│                  ├─ assemble  ──────┼──▶ Hetzner render box│ (ffmpeg HTTP svc)
│                  └─ publish         → YouTube Data API v3  │
│ R2: episode.mp4, thumbnail, intermediates                 │
└───────────────────────────────────────────────────────────┘
```

- **Cloudflare Workflows** = the control plane. Durable execution means a flaky
  video API doesn't lose the (already paid-for) story and keyframes.
- **R2** = artifact storage (S3-compatible; mirrors `src/storage.ts`).
- **Cron Triggers** = the scheduler (`0 15 * * *` → one episode/day).
- **Hetzner GPU** = optional self-hosting for open models (Wan 2.7, Flux 2 via
  ComfyUI, Kokoro) to cut per-episode cost, plus the ffmpeg assembly service.

See `cloudflare/worker.ts` and `cloudflare/wrangler.jsonc` for a deployable
skeleton (provider call bodies are stubbed with clear TODOs).

## 5. Tool selection (mid-2026)

### Story / script / metadata — OpenRouter
You already use Nous Hermes; keep it for the creative writing (warm, narrative).
Use a cheaper instruct model (e.g. Llama 3.3 70B) for structured JSON metadata
and the safety classifier. OpenRouter gives one API + easy model swaps.

### Image keyframes — character consistency is everything for a series
- **Flux 2** — open-weight, multi-reference (up to ~10 images) → strong identity
  lock-in across poses/scenes; self-hostable via ComfyUI on Hetzner, or via fal.
- **Nano Banana Pro (Gemini image)** — best conversational/iterative editing and
  reasoning-based identity preservation; great when you refine a sheet by chat.
Workflow: generate a **character reference sheet once**, then condition every
scene on it. (The offline renderer mimics this by fixing each character's palette.)

### Animation (image → video) — pick by *output shape*
- **PixVerse V4.5** — the stylized/cartoon/anime specialist; ideal for cute kids
  content; fast cycles.
- **Kling 3.0** — best all-round value, long clips, single-pass audio+video.
- **Veo 3.1** — premium cinematic + native audio; reserve for hero content.
- **Wan 2.7** (open, Apache-2.0) — self-host on Hetzner GPU; first/last-frame
  control and multi-image input; best cost at volume.

### Voiceover — ElevenLabs vs Kokoro
- **ElevenLabs** — most natural/emotional; best for young-kid narration polish.
- **Kokoro** (Apache-2.0, 82M) — CPU-viable, ~free self-hosted or ~$0.02/1k
  chars; excellent clear narration when cost dominates. Self-host on Hetzner with
  an OpenAI-compatible `/v1/audio/speech` endpoint (already wired in voiceover.ts).

### Music — Suno or licensed library
Generate a gentle bed per episode (Suno) or pull from a royalty-free library you
have rights to. The offline pad shows the integration shape.

### Publishing — YouTube Data API v3
Resumable upload via OAuth refresh token (no SDK needed — see
`src/providers/youtube.ts`). Set `selfDeclaredMadeForKids: true`. Start episodes
`unlisted`, optionally gate on human approval, then flip to `public`.

## 6. Cost & scaling levers

- Self-host open models (Wan 2.7, Flux 2, Kokoro) on Hetzner GPU for the bulk of
  volume; call premium APIs only for special episodes.
- Cache/reuse character sheets and intro/outro assets across episodes.
- Batch a week of episodes per GPU spin-up; Workflows make this safe to retry.
- The text stages are cents; the video model is the dominant cost — choose
  resolution/duration deliberately (8s clips × 6 scenes is plenty for this format).

## 7. Compliance for a kids channel

- Safety gate before spend; faithful, gentle retellings.
- YouTube "Made for Kids" / COPPA: declare made-for-kids, disable inappropriate
  features, review before publishing. Keep a human approval gate on until you
  trust the output (`REQUIRE_APPROVAL=true`).
- Respect Bible translation copyright if you quote verses verbatim; original
  retellings avoid this.

## 8. Extending

- **New stage** → add `src/stages/<name>.ts`, call it from `pipeline.ts`.
- **New provider** → add to `src/providers`, branch on the relevant `*_PROVIDER`
  env in the stage, keep the offline fallback.
- **Series memory** → persist character sheets + a "stories already told" list in
  R2/D1 so the cron picks fresh topics and reuses characters across episodes.
