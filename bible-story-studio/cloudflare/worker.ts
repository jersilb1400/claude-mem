/**
 * Production control plane — Cloudflare Workflows orchestrator.
 *
 * This is the recommended way to run the studio autonomously at scale. It uses
 * Cloudflare for the durable, observable control plane and offloads the two
 * GPU/CPU-heavy steps (model inference + ffmpeg assembly) to specialized
 * compute:
 *
 *   Cron Trigger ─▶ Workflow (durable steps, auto-retry, R2 artifacts)
 *        │
 *        ├─ step: story/metadata   → OpenRouter (Nous Hermes)
 *        ├─ step: keyframes         → fal.ai Flux 2  (or your Hetzner ComfyUI)
 *        ├─ step: animate           → fal.ai PixVerse/Kling (or Hetzner Wan 2.7)
 *        ├─ step: voiceover         → ElevenLabs / self-hosted Kokoro
 *        ├─ step: assemble (ffmpeg) → Hetzner render box / Cloudflare Container
 *        └─ step: publish           → YouTube Data API v3
 *
 * Each `step.do(...)` is checkpointed: if a later step fails, the Workflow
 * resumes from the last success instead of re-paying for earlier model calls.
 *
 * NOTE: This file is a deployable reference. The CPU-bound ffmpeg compositing
 * does not run inside a Worker — `assemble` calls out to your render service
 * (the same code in ../src/stages/assemble.ts, wrapped in a tiny HTTP server on
 * your Hetzner GPU/CPU box, or a Cloudflare Container). Everything else runs in
 * the Worker. Install deps and types before deploying:
 *   npm i -D wrangler @cloudflare/workers-types
 */
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export interface Env {
  STUDIO_WORKFLOW: Workflow;
  ARTIFACTS: R2Bucket;
  OPENROUTER_API_KEY: string;
  FAL_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  RENDER_ENDPOINT: string; // e.g. https://render.your-hetzner-box.example
  RENDER_TOKEN: string;
  YOUTUBE_CLIENT_ID: string;
  YOUTUBE_CLIENT_SECRET: string;
  YOUTUBE_REFRESH_TOKEN: string;
}

interface Params {
  topic: string;
}

export class StudioWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown> {
    const topic = event.payload.topic;
    const id = event.instanceId;

    // 1. Story + safety + metadata (cheap, LLM). Checkpointed as JSON.
    const story = await step.do("story", async () => {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "nousresearch/hermes-4-405b",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Children's Bible storyteller. Return strict JSON." },
            { role: "user", content: `Write a 5-7 scene cartoon episode about: ${topic}` },
          ],
        }),
      });
      if (!res.ok) throw new Error(`story ${res.status}`);
      return res.json();
    });

    // 2. Keyframes via fal (Flux 2 multi-ref). Returns R2 keys.
    const images = await step.do(
      "keyframes",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => this.renderKeyframes(id, story),
    );

    // 3. Animate each keyframe (fal PixVerse/Kling). Returns R2 keys.
    const clips = await step.do(
      "animate",
      { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
      async () => this.animate(id, images),
    );

    // 4. Voiceover (ElevenLabs / Kokoro) → R2 keys.
    const audio = await step.do("voiceover", async () => this.voiceover(id, story));

    // 5. Final compositing on the render box (ffmpeg). Returns the R2 key.
    const finalKey = await step.do(
      "assemble",
      { timeout: "15 minutes", retries: { limit: 2, delay: "20 seconds", backoff: "exponential" } },
      async () => {
        const res = await fetch(`${this.env.RENDER_ENDPOINT}/assemble`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.RENDER_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ id, story, clips, audio }),
        });
        if (!res.ok) throw new Error(`assemble ${res.status}`);
        return ((await res.json()) as { key: string }).key;
      },
    );

    // 6. Optional human-review hold for kids content, then publish.
    // await step.waitForEvent("approval", { timeout: "24 hours" }); // uncomment to gate
    const published = await step.do("publish", async () => this.publish(finalKey, story));

    return { id, finalKey, published };
  }

  // --- helpers (call out to providers; bodies elided for brevity) ----------
  private async renderKeyframes(_id: string, _story: unknown): Promise<string[]> {
    // POST scene prompts to https://fal.run/fal-ai/flux-2, stream results to R2.
    throw new Error("wire up fal.ai Flux 2 here");
  }
  private async animate(_id: string, _images: string[]): Promise<string[]> {
    // POST each keyframe to fal-ai/pixverse/v4.5/image-to-video, store to R2.
    throw new Error("wire up fal.ai PixVerse/Kling here");
  }
  private async voiceover(_id: string, _story: unknown): Promise<string[]> {
    // POST narration to ElevenLabs / Kokoro, store mp3s to R2.
    throw new Error("wire up TTS here");
  }
  private async publish(_finalKey: string, _story: unknown): Promise<unknown> {
    // Stream the R2 object into the YouTube resumable upload (see ../src/providers/youtube.ts).
    throw new Error("wire up YouTube upload here");
  }
}

export default {
  // Daily cron trigger kicks off one autonomous episode.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const topics = [
      "Noah's Ark",
      "David and Goliath",
      "Jonah and the Big Fish",
      "The Good Samaritan",
      "Daniel and the Lions' Den",
    ];
    const topic = topics[Math.floor(Math.random() * topics.length)]!;
    await env.STUDIO_WORKFLOW.create({ params: { topic } });
  },

  // Manual trigger: POST /run {"topic": "..."}
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return new Response("POST /run", { status: 405 });
    const { topic } = (await req.json()) as { topic?: string };
    const instance = await env.STUDIO_WORKFLOW.create({
      params: { topic: topic ?? "Noah's Ark" },
    });
    return Response.json({ id: instance.id });
  },
};
