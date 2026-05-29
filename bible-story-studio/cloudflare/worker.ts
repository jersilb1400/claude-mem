/**
 * Bible Story Studio — Cloudflare Workflows control plane.
 *
 * Architecture:
 *   Cron Trigger (daily) → StudioWorkflow (durable, checkpointed)
 *     step 0  pick topic             → D1 topics_queue
 *     step 1  story + safety         → OpenRouter (Nous Hermes 4 / Llama 3.3)
 *     step 2  keyframes              → fal.ai Flux 2  (character-consistent)
 *     step 3  animation              → fal.ai PixVerse V4.5  (cartoon specialist)
 *     step 4  voiceover              → ElevenLabs  (warm kids narration)
 *     step 5  music                  → Suno API
 *     step 6  assemble + thumbnail   → Hetzner render box HTTP service
 *     step 7  SEO metadata           → OpenRouter Llama 3.3
 *     step 8  record to D1           → series memory
 *     step 9  publish to YouTube     → YouTube Data API v3  (skipped if REQUIRE_APPROVAL=true)
 *
 * Each step.do() is checkpointed: a failure at step 6 does not re-pay for
 * the story, keyframes, or animation from earlier steps.
 *
 * Approval mode (set REQUIRE_APPROVAL=true):
 *   Episodes stop at status "awaiting_approval".
 *   POST /approve/:id with Bearer RENDER_TOKEN to publish.
 *
 * Deploy:
 *   cd cloudflare && npm i && npx wrangler secret put OPENROUTER_API_KEY  # etc.
 *   npx wrangler deploy
 */
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Env {
  STUDIO_WORKFLOW: Workflow;
  ARTIFACTS: R2Bucket;
  SERIES_MEMORY: D1Database;
  // Secrets (set via `wrangler secret put`)
  OPENROUTER_API_KEY: string;
  FAL_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  SUNO_API_KEY: string;
  RENDER_ENDPOINT: string;
  RENDER_TOKEN: string;
  YOUTUBE_CLIENT_ID: string;
  YOUTUBE_CLIENT_SECRET: string;
  YOUTUBE_REFRESH_TOKEN: string;
  // Optional: set to "true" to hold episodes before YouTube publish
  REQUIRE_APPROVAL?: string;
}

interface Params {
  topic?: string;
}

interface StoryOutput {
  title: string;
  source: string;
  lesson: string;
  characters: Array<{
    name: string;
    description: string;
    palette: { skin: string; hair: string; robe: string };
  }>;
  scenes: Array<{
    narration: string;
    visual: string;
    characters: string[];
    setting: string;
  }>;
}

interface SEOMeta {
  title: string;
  description: string;
  tags: string[];
}

interface RenderResult {
  episodeKey: string;
  thumbnailKey: string;
}

interface EpisodeRow {
  id: string;
  title: string;
  source: string;
  lesson: string;
  topic: string;
  status: string;
  youtube_id: string | null;
  youtube_url: string | null;
  youtube_privacy: string | null;
  episode_mp4_key: string;
  thumbnail_key: string;
  created_at: number;
  published_at: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function openrouterChat(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  json = false,
): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://bible-videos-for-kids.pages.dev",
      "X-Title": "Bible Videos for Kids",
    },
    body: JSON.stringify({
      model,
      temperature: 0.8,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned empty content");
  return content;
}

function parseJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in model output");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

async function r2Put(bucket: R2Bucket, key: string, data: ArrayBuffer, contentType: string): Promise<void> {
  await bucket.put(key, data, { httpMetadata: { contentType } });
}

async function buildSEOMeta(apiKey: string, story: Pick<StoryOutput, "title" | "source" | "lesson">): Promise<SEOMeta> {
  const raw = await openrouterChat(
    apiKey,
    "meta-llama/llama-3.3-70b-instruct",
    "YouTube SEO expert for a wholesome preschool Bible-stories channel. Return strict JSON.",
    `Story: "${story.title}" (${story.source}). Lesson: ${story.lesson}.\nReturn JSON {"title":"<=100 chars","description":"3 paragraphs + hashtags","tags":["8-12 tags"]}.`,
    true,
  );
  return parseJson<SEOMeta>(raw);
}

async function publishToYouTube(
  env: Env,
  episodeKey: string,
  meta: SEOMeta,
): Promise<{ youtubeId: string; url: string }> {
  // Refresh OAuth access token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      refresh_token: env.YOUTUBE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!tokenRes.ok) throw new Error(`Token refresh ${tokenRes.status}`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  // Load episode.mp4 from R2
  const episodeObj = await env.ARTIFACTS.get(episodeKey);
  if (!episodeObj) throw new Error("Episode MP4 not found in R2");
  const videoBytes = await episodeObj.arrayBuffer();
  const size = videoBytes.byteLength;

  // Initiate resumable upload
  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Length": String(size),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: {
          title: meta.title.slice(0, 100),
          description: meta.description.slice(0, 4900),
          tags: meta.tags.slice(0, 30),
          categoryId: "27", // Education
        },
        status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: true },
      }),
    },
  );
  if (!initRes.ok) throw new Error(`YouTube init ${initRes.status}: ${await initRes.text()}`);
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("No resumable upload URL from YouTube");

  // Upload the video bytes
  const upRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(size) },
    body: videoBytes,
  });
  if (!upRes.ok) throw new Error(`YouTube upload ${upRes.status}: ${await upRes.text()}`);
  const video = (await upRes.json()) as { id: string };

  return { youtubeId: video.id, url: `https://youtu.be/${video.id}` };
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

export class StudioWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown> {
    const id = event.instanceId;

    // ── 0. Pick topic from D1 queue (or use override) ────────────────────────
    const topic = await step.do("pick-topic", async () => {
      if (event.payload.topic) return event.payload.topic;
      const row = await this.env.SERIES_MEMORY
        .prepare("SELECT topic FROM topics_queue WHERE used = 0 ORDER BY priority DESC, id ASC LIMIT 1")
        .first<{ topic: string }>();
      if (!row) throw new Error("Topic queue is empty — run 'make topics' to add more");
      return row.topic;
    });

    // ── 1. Story generation (Nous Hermes 4 — best creative writing) ──────────
    const story = await step.do("story", async () => {
      const raw = await openrouterChat(
        this.env.OPENROUTER_API_KEY,
        "nousresearch/hermes-4-405b",
        "You are a warm, gentle children's Bible storyteller for ages 3-8. Return STRICT JSON only.",
        `Write a 5-7 scene animated episode about: "${topic}".\n\nReturn JSON:\n{\n  "title": "catchy kid-friendly title (max 70 chars)",\n  "source": "Bible book/passage",\n  "lesson": "one gentle sentence moral",\n  "characters": [{"name":"...","description":"stable look","palette":{"skin":"#hex","hair":"#hex","robe":"#hex"}}],\n  "scenes": [{"narration":"1-2 short sentences","visual":"cartoon description","characters":["names"],"setting":"day|night|sunrise|indoor|water|desert"}]\n}`,
        true,
      );
      return parseJson<StoryOutput>(raw);
    });

    // ── 2. Safety gate ────────────────────────────────────────────────────────
    await step.do("safety", async () => {
      const text = story.scenes.map((s) => s.narration).join(" ").toLowerCase();
      const banned = ["kill", "blood", "gore", "hell", "demon", "sexy", "violence", "weapon", "gun", "drug"];
      const hit = banned.find((w) => text.includes(w));
      if (hit) throw new Error(`Safety blocked: contains "${hit}"`);
      const raw = await openrouterChat(
        this.env.OPENROUTER_API_KEY,
        "meta-llama/llama-3.3-70b-instruct",
        "Strict content-safety reviewer for a preschool Bible channel.",
        `Is this narration safe for ages 3-8? Reply JSON {"safe":bool,"reason":string}.\n\n${text}`,
        true,
      );
      const v = parseJson<{ safe: boolean; reason: string }>(raw);
      if (!v.safe) throw new Error(`Safety blocked: ${v.reason}`);
    });

    // ── 3. Character-consistent keyframes (Flux 2 via fal.ai) ─────────────────
    const imageKeys = await step.do(
      "keyframes",
      { retries: { limit: 3, delay: "15 seconds", backoff: "exponential" } },
      async () => {
        const keys: string[] = [];
        for (let i = 0; i < story.scenes.length; i++) {
          const scene = story.scenes[i]!;
          const cast = story.characters
            .filter((c) => scene.characters.includes(c.name))
            .map((c) => `${c.name}: ${c.description}, palette ${JSON.stringify(c.palette)}`)
            .join("; ");
          const prompt = `Cute flat-vector cartoon for preschoolers, soft pastel colors, friendly rounded shapes, big eyes. ${scene.visual}. Characters — ${cast}. Setting: ${scene.setting}. No text overlays.`;
          const res = await fetch("https://fal.run/fal-ai/flux-2", {
            method: "POST",
            headers: { Authorization: `Key ${this.env.FAL_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ prompt, image_size: { width: 1920, height: 1080 } }),
          });
          if (!res.ok) throw new Error(`Flux2 ${res.status}: ${await res.text()}`);
          const data = (await res.json()) as { images?: { url: string }[] };
          const url = data.images?.[0]?.url;
          if (!url) throw new Error("Flux2 returned no image");
          const img = await (await fetch(url)).arrayBuffer();
          const key = `${id}/images/scene-${String(i).padStart(2, "0")}.png`;
          await r2Put(this.env.ARTIFACTS, key, img, "image/png");
          keys.push(key);
        }
        return keys;
      },
    );

    // ── 4. Animation — PixVerse V4.5 (cartoon/anime specialist) ──────────────
    const clipKeys = await step.do(
      "animate",
      { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
      async () => {
        const keys: string[] = [];
        for (let i = 0; i < imageKeys.length; i++) {
          const imgObj = await this.env.ARTIFACTS.get(imageKeys[i]!);
          if (!imgObj) throw new Error(`R2 image missing: ${imageKeys[i]}`);
          const dataUri = `data:image/png;base64,${btoa(
            String.fromCharCode(...new Uint8Array(await imgObj.arrayBuffer())),
          )}`;
          const res = await fetch("https://fal.run/fal-ai/pixverse/v4.5/image-to-video", {
            method: "POST",
            headers: { Authorization: `Key ${this.env.FAL_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              image_url: dataUri,
              prompt: "gentle cute cartoon motion, soft parallax, child-friendly, no camera shake",
              duration: 6,
              style: "cartoon",
            }),
          });
          if (!res.ok) throw new Error(`PixVerse ${res.status}: ${await res.text()}`);
          const data = (await res.json()) as { video?: { url: string } };
          const url = data.video?.url;
          if (!url) throw new Error("PixVerse returned no video");
          const clip = await (await fetch(url)).arrayBuffer();
          const key = `${id}/clips/scene-${String(i).padStart(2, "0")}.mp4`;
          await r2Put(this.env.ARTIFACTS, key, clip, "video/mp4");
          keys.push(key);
        }
        return keys;
      },
    );

    // ── 5. Voiceover — ElevenLabs Rachel (warm, natural for children) ─────────
    const audioKeys = await step.do(
      "voiceover",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => {
        const keys: string[] = [];
        const voiceId = "21m00Tcm4TlvDq8ikWAM"; // Rachel
        for (let i = 0; i < story.scenes.length; i++) {
          const text = story.scenes[i]!.narration;
          const res = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
            {
              method: "POST",
              headers: { "xi-api-key": this.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
              body: JSON.stringify({
                text,
                model_id: "eleven_multilingual_v2",
                voice_settings: { stability: 0.75, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true },
              }),
            },
          );
          if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
          const key = `${id}/audio/scene-${String(i).padStart(2, "0")}.mp3`;
          await r2Put(this.env.ARTIFACTS, key, await res.arrayBuffer(), "audio/mpeg");
          keys.push(key);
        }
        return keys;
      },
    );

    // ── 6. Music bed — Suno API ───────────────────────────────────────────────
    const musicKey = await step.do(
      "music",
      { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" } },
      async () => {
        const initRes = await fetch("https://api.suno.ai/api/generate", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.env.SUNO_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: `Gentle, uplifting instrumental children's background music for a Bible story about ${story.title}. Soft orchestral, warm, peaceful, no lyrics. 60 seconds.`,
            make_instrumental: true,
            wait_audio: true,
          }),
        });
        if (!initRes.ok) throw new Error(`Suno ${initRes.status}: ${await initRes.text()}`);
        const data = (await initRes.json()) as Array<{ audio_url?: string }>;
        const url = data[0]?.audio_url;
        if (!url) throw new Error("Suno returned no audio URL");
        const music = await (await fetch(url)).arrayBuffer();
        const key = `${id}/audio/music.mp3`;
        await r2Put(this.env.ARTIFACTS, key, music, "audio/mpeg");
        return key;
      },
    );

    // ── 7. Assembly + thumbnail — Hetzner render box (ffmpeg) ─────────────────
    const rendered = await step.do(
      "assemble",
      { timeout: "20 minutes", retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } },
      async () => {
        const res = await fetch(`${this.env.RENDER_ENDPOINT}/assemble`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.RENDER_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id,
            story,
            clipKeys,
            audioKeys,
            musicKey,
            imageKeys,
            r2Bucket: "bible-story-artifacts",
          }),
        });
        if (!res.ok) throw new Error(`Render service ${res.status}: ${await res.text()}`);
        return (await res.json()) as RenderResult;
      },
    );

    // ── 8. SEO metadata (Llama 3.3 — fast + structured) ──────────────────────
    const metadata = await step.do("metadata", () => buildSEOMeta(this.env.OPENROUTER_API_KEY, story));

    // ── 9. Record to D1 series memory ─────────────────────────────────────────
    const initialStatus = this.env.REQUIRE_APPROVAL === "true" ? "awaiting_approval" : "assembled";

    await step.do("record-episode", async () => {
      await this.env.SERIES_MEMORY
        .prepare("INSERT INTO episodes (id, title, source, lesson, topic, status, episode_mp4_key, thumbnail_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, story.title, story.source, story.lesson, topic, initialStatus, rendered.episodeKey, rendered.thumbnailKey)
        .run();
      await this.env.SERIES_MEMORY
        .prepare("UPDATE topics_queue SET used = 1, used_at = unixepoch() WHERE topic = ?")
        .bind(topic)
        .run();
      for (const c of story.characters) {
        await this.env.SERIES_MEMORY
          .prepare("INSERT OR IGNORE INTO characters (id, name, description, palette_skin, palette_hair, palette_robe) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(crypto.randomUUID(), c.name, c.description, c.palette.skin, c.palette.hair, c.palette.robe)
          .run();
      }
    });

    // ── 10. Publish to YouTube — or hold for approval ─────────────────────────
    if (this.env.REQUIRE_APPROVAL === "true") {
      return {
        id,
        topic,
        title: story.title,
        status: "awaiting_approval",
        note: `POST /approve/${id}  (Bearer RENDER_TOKEN) to publish to YouTube`,
      };
    }

    const published = await step.do(
      "publish",
      { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } },
      () => publishToYouTube(this.env, rendered.episodeKey, metadata),
    );

    // ── 11. Update D1 with YouTube info ──────────────────────────────────────
    await step.do("update-episode-record", async () => {
      await this.env.SERIES_MEMORY
        .prepare("UPDATE episodes SET status = 'published', youtube_id = ?, youtube_url = ?, youtube_privacy = 'unlisted', published_at = unixepoch() WHERE id = ?")
        .bind(published.youtubeId, published.url, id)
        .run();
    });

    return { id, topic, title: story.title, ...published };
  }
}

// ─── Scheduled + HTTP handlers ───────────────────────────────────────────────

export default {
  // Daily cron: picks next topic from D1 queue automatically.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await env.STUDIO_WORKFLOW.create({ params: {} });
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // POST /run  {"topic": "..."} — manual trigger (topic optional)
    if (req.method === "POST" && url.pathname === "/run") {
      const body = (await req.json().catch(() => ({}))) as { topic?: string };
      const instance = await env.STUDIO_WORKFLOW.create({ params: { topic: body.topic } });
      return Response.json({ instanceId: instance.id, topic: body.topic ?? "(auto from queue)" });
    }

    // GET /queue — list topic queue
    if (req.method === "GET" && url.pathname === "/queue") {
      const rows = await env.SERIES_MEMORY
        .prepare("SELECT topic, priority, used, used_at FROM topics_queue ORDER BY used ASC, priority DESC")
        .all();
      return Response.json(rows.results);
    }

    // GET /episodes — recent episode list
    if (req.method === "GET" && url.pathname === "/episodes") {
      const rows = await env.SERIES_MEMORY
        .prepare("SELECT id, title, source, status, youtube_url, datetime(created_at,'unixepoch') as created FROM episodes ORDER BY created_at DESC LIMIT 50")
        .all();
      return Response.json(rows.results);
    }

    // GET /status/:id — full episode record
    if (req.method === "GET" && url.pathname.startsWith("/status/")) {
      const epId = url.pathname.slice("/status/".length);
      const row = await env.SERIES_MEMORY
        .prepare("SELECT * FROM episodes WHERE id = ?")
        .bind(epId)
        .first<EpisodeRow>();
      if (!row) return new Response("Episode not found", { status: 404 });
      return Response.json(row);
    }

    // POST /approve/:id — publish a held episode to YouTube (requires Bearer RENDER_TOKEN)
    if (req.method === "POST" && url.pathname.startsWith("/approve/")) {
      const auth = req.headers.get("Authorization");
      if (!auth || auth !== `Bearer ${env.RENDER_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const epId = url.pathname.slice("/approve/".length);
      const row = await env.SERIES_MEMORY
        .prepare("SELECT id, title, source, lesson, episode_mp4_key FROM episodes WHERE id = ? AND status = 'awaiting_approval'")
        .bind(epId)
        .first<Pick<EpisodeRow, "id" | "title" | "source" | "lesson" | "episode_mp4_key">>();
      if (!row) return new Response("Episode not found or not awaiting approval", { status: 404 });

      const meta = await buildSEOMeta(env.OPENROUTER_API_KEY, row);
      const published = await publishToYouTube(env, row.episode_mp4_key, meta);

      await env.SERIES_MEMORY
        .prepare("UPDATE episodes SET status = 'published', youtube_id = ?, youtube_url = ?, youtube_privacy = 'unlisted', published_at = unixepoch() WHERE id = ?")
        .bind(published.youtubeId, published.url, epId)
        .run();

      return Response.json({ id: epId, title: row.title, ...published });
    }

    return new Response(
      [
        "Bible Videos for Kids",
        "",
        "POST  /run              trigger episode (body: {topic?})",
        "GET   /queue            topic queue",
        "GET   /episodes         recent episodes",
        "GET   /status/:id       episode details",
        "POST  /approve/:id      publish held episode (Bearer RENDER_TOKEN)",
      ].join("\n"),
      { status: 200, headers: { "Content-Type": "text/plain" } },
    );
  },
};
