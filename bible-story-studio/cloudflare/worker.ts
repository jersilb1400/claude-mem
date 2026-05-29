/**
 * Bible Story Studio — Cloudflare Workflows control plane.
 *
 * Cron schedule:
 *   0 15 * * *  — daily episode
 *   0 16 * * *  — daily Shorts
 *   0 20 * * *  — auto-promote unlisted → public
 *   0 10 * * *  — YouTube analytics fetch
 *   0  9 * * 0  — weekly email digest (Sunday)
 */
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Env {
  STUDIO_WORKFLOW: Workflow;
  SHORTS_WORKFLOW: Workflow;
  COMPILATION_WORKFLOW: Workflow;
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
  // Optional env vars
  REQUIRE_APPROVAL?: string;
  PROMOTE_AFTER_HOURS?: string;
  DISCORD_WEBHOOK?: string;
  YOUTUBE_API_KEY?: string;
  PUBLISH_WEBHOOK?: string;       // Feature 6: outgoing webhook URL after publish
  RESEND_API_KEY?: string;        // Feature 7: weekly digest email
  DIGEST_EMAIL?: string;          // Feature 7: recipient address
  QUALITY_GATE_ENABLED?: string;  // Feature 8: "true" to LLM-score before publish
}

interface Params {
  topic?: string;
}

interface ShortsParams {
  episodeId?: string;
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
  sceneDurations?: number[];
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
  quality_score: number | null;
  quality_reason: string | null;
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

async function getYouTubeAccessToken(env: Env): Promise<string> {
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
  return access_token;
}

async function publishToYouTube(
  env: Env,
  episodeKey: string,
  meta: SEOMeta,
  privacyStatus = "unlisted",
): Promise<{ youtubeId: string; url: string; accessToken: string }> {
  const access_token = await getYouTubeAccessToken(env);

  const episodeObj = await env.ARTIFACTS.get(episodeKey);
  if (!episodeObj) throw new Error("Episode MP4 not found in R2");
  const videoBytes = await episodeObj.arrayBuffer();
  const size = videoBytes.byteLength;

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
          categoryId: "27",
        },
        status: { privacyStatus, selfDeclaredMadeForKids: true },
      }),
    },
  );
  if (!initRes.ok) throw new Error(`YouTube init ${initRes.status}: ${await initRes.text()}`);
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("No resumable upload URL from YouTube");

  const upRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(size) },
    body: videoBytes,
  });
  if (!upRes.ok) throw new Error(`YouTube upload ${upRes.status}: ${await upRes.text()}`);
  const video = (await upRes.json()) as { id: string };

  return { youtubeId: video.id, url: `https://youtu.be/${video.id}`, accessToken: access_token };
}

/** Feature 3: Discord notifications */
async function notify(env: Env, message: string, color = 0x5865f2): Promise<void> {
  if (!env.DISCORD_WEBHOOK) return;
  await fetch(env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [{ description: message, color }] }),
  }).catch(() => {});
}

/** Feature 6: Cost ledger */
async function logCost(
  env: Env,
  episodeId: string,
  stage: string,
  provider: string,
  units: number,
  unitType: string,
  rateUsd: number,
): Promise<void> {
  const totalUsd = units * rateUsd;
  await env.SERIES_MEMORY
    .prepare("INSERT INTO costs (episode_id, stage, provider, units, unit_type, rate_usd, total_usd) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(episodeId, stage, provider, units, unitType, rateUsd, totalUsd)
    .run()
    .catch(() => {});
}

/** Feature 4: Auto-generate topics */
async function autoGenerateTopics(env: Env): Promise<string[]> {
  const raw = await openrouterChat(
    env.OPENROUTER_API_KEY,
    "meta-llama/llama-3.3-70b-instruct",
    "You are a children's Bible curriculum expert. Return strict JSON only.",
    "Generate 15 unique Bible story topics suitable for children aged 3-8. Return JSON: {\"topics\": [\"...\", ...]}",
    true,
  );
  const parsed = parseJson<{ topics: string[] }>(raw);
  const topics = parsed.topics ?? [];
  for (const topic of topics) {
    await env.SERIES_MEMORY
      .prepare("INSERT OR IGNORE INTO topics_queue (topic, priority) VALUES (?, 5)")
      .bind(topic)
      .run()
      .catch(() => {});
  }
  return topics;
}

/** Feature 2: Auto-promote unlisted → public */
async function autoPromote(env: Env): Promise<void> {
  const promoteAfterHours = parseInt(env.PROMOTE_AFTER_HOURS ?? "24", 10);
  const cutoff = Math.floor(Date.now() / 1000) - promoteAfterHours * 3600;

  const rows = await env.SERIES_MEMORY
    .prepare("SELECT id, youtube_id, title FROM episodes WHERE status='published' AND youtube_privacy='unlisted' AND published_at < ?")
    .bind(cutoff)
    .all<{ id: string; youtube_id: string; title: string }>();

  for (const row of rows.results) {
    try {
      const access_token = await getYouTubeAccessToken(env);
      const updateRes = await fetch("https://www.googleapis.com/youtube/v3/videos?part=status", {
        method: "PUT",
        headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.youtube_id, status: { privacyStatus: "public" } }),
      });
      if (!updateRes.ok) throw new Error(`YouTube update ${updateRes.status}: ${await updateRes.text()}`);

      await env.SERIES_MEMORY
        .prepare("UPDATE episodes SET youtube_privacy = 'public' WHERE id = ?")
        .bind(row.id)
        .run();

      await notify(env, `📢 Auto-promoted to public: **${row.title}**\nhttps://youtu.be/${row.youtube_id}`, 0x57f287);
    } catch (err) {
      await notify(env, `❌ Failed to promote episode ${row.id}: ${String(err)}`, 0xed4245);
    }
  }
}

/** YouTube analytics snapshot */
async function fetchAnalytics(env: Env): Promise<void> {
  if (!env.YOUTUBE_API_KEY) return;
  const rows = await env.SERIES_MEMORY
    .prepare("SELECT id, youtube_id FROM episodes WHERE status='published' AND youtube_id IS NOT NULL")
    .all<{ id: string; youtube_id: string }>();
  for (const row of rows.results) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(row.youtube_id)}&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`,
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { items?: Array<{ statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }> };
      const stats = data.items?.[0]?.statistics;
      if (!stats) continue;
      await env.SERIES_MEMORY
        .prepare("INSERT INTO analytics (episode_id, youtube_id, views, likes, comments) VALUES (?, ?, ?, ?, ?)")
        .bind(row.id, row.youtube_id, parseInt(stats.viewCount ?? "0", 10), parseInt(stats.likeCount ?? "0", 10), parseInt(stats.commentCount ?? "0", 10))
        .run()
        .catch(() => {});
    } catch { /* never fail the cron */ }
  }
}

// ─── Feature 1: Playlist Manager ─────────────────────────────────────────────

/**
 * Finds or creates a YouTube playlist for the story's category, adds the video,
 * and stores the playlist_id in D1. Called after each successful publish.
 */
async function managePlaylists(
  env: Env,
  story: Pick<StoryOutput, "title" | "source">,
  youtubeId: string,
  accessToken: string,
): Promise<void> {
  const isNT = ["matthew", "mark", "luke", "john", "acts", "revelation", "corinthians", "romans", "galatians", "ephesians", "philippians"].some(
    (b) => story.source.toLowerCase().includes(b),
  );
  const playlistTitle = isNT ? "New Testament Stories for Kids" : "Old Testament Stories for Kids";

  try {
    // Check if playlist already stored in D1
    let row = await env.SERIES_MEMORY
      .prepare("SELECT youtube_playlist_id FROM playlists WHERE title = ?")
      .bind(playlistTitle)
      .first<{ youtube_playlist_id: string | null }>();

    let playlistId = row?.youtube_playlist_id;

    if (!playlistId) {
      // Create new playlist
      const createRes = await fetch("https://www.googleapis.com/youtube/v3/playlists?part=snippet,status", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          snippet: {
            title: playlistTitle,
            description: `Gentle animated ${isNT ? "New" : "Old"} Testament Bible stories for children ages 3-8`,
          },
          status: { privacyStatus: "public" },
        }),
      });
      if (!createRes.ok) throw new Error(`Create playlist ${createRes.status}: ${await createRes.text()}`);
      const pl = (await createRes.json()) as { id: string };
      playlistId = pl.id;

      // Store in D1
      await env.SERIES_MEMORY
        .prepare("INSERT INTO playlists (id, youtube_playlist_id, title) VALUES (?, ?, ?)")
        .bind(crypto.randomUUID(), playlistId, playlistTitle)
        .run()
        .catch(() => {});
    }

    // Add video to playlist
    await fetch("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        snippet: {
          playlistId,
          resourceId: { kind: "youtube#video", videoId: youtubeId },
        },
      }),
    });
  } catch (err) {
    // playlist failure never blocks the pipeline
    console.error("[playlists]", err);
  }
}

// ─── Feature 2: Captions ─────────────────────────────────────────────────────

function toSRTTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function generateSRT(scenes: StoryOutput["scenes"], durations?: number[]): string {
  let srt = "";
  let startSec = 0;
  for (let i = 0; i < scenes.length; i++) {
    const dur = durations?.[i] ?? Math.max(4, scenes[i]!.narration.length / 12);
    const end = startSec + dur;
    srt += `${i + 1}\n${toSRTTime(startSec)} --> ${toSRTTime(end)}\n${scenes[i]!.narration}\n\n`;
    startSec = end;
  }
  return srt;
}

async function uploadCaptions(
  env: Env,
  youtubeId: string,
  story: StoryOutput,
  accessToken: string,
  sceneDurations?: number[],
): Promise<void> {
  try {
    const srt = generateSRT(story.scenes, sceneDurations);
    const srtBytes = new TextEncoder().encode(srt);

    // Insert caption track
    const insertRes = await fetch("https://www.googleapis.com/youtube/v3/captions?part=snippet", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        snippet: { videoId: youtubeId, language: "en", name: "English", isDraft: false },
      }),
    });
    if (!insertRes.ok) throw new Error(`Captions insert ${insertRes.status}`);
    const caption = (await insertRes.json()) as { id: string };

    // Upload SRT bytes
    await fetch(
      `https://www.googleapis.com/upload/youtube/v3/captions?uploadType=media&part=snippet&id=${caption.id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "text/plain; charset=UTF-8",
          "Content-Length": String(srtBytes.byteLength),
        },
        body: srtBytes,
      },
    );
  } catch (err) {
    console.error("[captions]", err);
  }
}

// ─── Feature 8: Quality Gate ──────────────────────────────────────────────────

async function scoreEpisodeQuality(
  env: Env,
  story: StoryOutput,
  meta: SEOMeta,
): Promise<{ score: number; reason: string }> {
  const raw = await openrouterChat(
    env.OPENROUTER_API_KEY,
    "meta-llama/llama-3.3-70b-instruct",
    "You are a quality reviewer for a children's Bible YouTube channel. Return strict JSON.",
    `Rate this episode 1-10 for quality and child-appropriateness.\nTitle: ${meta.title}\nLesson: ${story.lesson}\nScenes: ${story.scenes.map((s) => s.narration).join(" | ")}\n\nReturn JSON: {"score": 8, "reason": "short explanation"}`,
    true,
  );
  return parseJson<{ score: number; reason: string }>(raw);
}

// ─── Feature 6: Outgoing webhook ─────────────────────────────────────────────

async function fireWebhook(env: Env, payload: Record<string, unknown>): Promise<void> {
  if (!env.PUBLISH_WEBHOOK) return;
  await fetch(env.PUBLISH_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "episode.published", ts: Date.now(), ...payload }),
  }).catch(() => {});
}

// ─── Feature 7: Weekly email digest ──────────────────────────────────────────

async function sendWeeklyDigest(env: Env): Promise<void> {
  if (!env.RESEND_API_KEY || !env.DIGEST_EMAIL) return;

  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
  const episodes = await env.SERIES_MEMORY
    .prepare("SELECT title, youtube_url, lesson FROM episodes WHERE status='published' AND published_at > ? ORDER BY published_at DESC")
    .bind(cutoff)
    .all<{ title: string; youtube_url: string; lesson: string }>();

  if (episodes.results.length === 0) return;

  const analyticsRows = await env.SERIES_MEMORY
    .prepare("SELECT SUM(views) as total_views, SUM(likes) as total_likes FROM analytics WHERE fetched_at > ?")
    .bind(cutoff)
    .first<{ total_views: number; total_likes: number }>();

  const epList = episodes.results
    .map((e) => `<li><a href="${e.youtube_url}">${e.title}</a> — ${e.lesson}</li>`)
    .join("");

  const html = `
<h2>Bible Videos for Kids — Weekly Digest</h2>
<p><strong>${episodes.results.length} episode(s)</strong> published this week:</p>
<ul>${epList}</ul>
<hr />
<p>📊 This week: <strong>${analyticsRows?.total_views ?? 0}</strong> views &nbsp;|&nbsp; <strong>${analyticsRows?.total_likes ?? 0}</strong> likes</p>
<p><em>Bible Videos for Kids — automated digest</em></p>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Bible Videos for Kids <digest@bible-videos-for-kids.com>",
      to: [env.DIGEST_EMAIL],
      subject: `📺 Weekly Digest — ${episodes.results.length} new episode(s)`,
      html,
    }),
  }).catch(() => {});
}

// ─── CORS helper ─────────────────────────────────────────────────────────────

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ─── Feature 9: Rate limiter (D1-backed, per-hour) ───────────────────────────

async function checkRateLimit(env: Env, limitPerHour = 10): Promise<boolean> {
  const cutoff = Math.floor(Date.now() / 1000) - 3600;
  const row = await env.SERIES_MEMORY
    .prepare("SELECT COUNT(*) as n FROM episodes WHERE created_at > ?")
    .bind(cutoff)
    .first<{ n: number }>();
  return (row?.n ?? 0) < limitPerHour;
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

export class StudioWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown> {
    const id = event.instanceId;

    try {
      // ── 0. Pick topic ────────────────────────────────────────────────────────
      const topic = await step.do("pick-topic", async () => {
        if (event.payload.topic) return event.payload.topic;
        const row = await this.env.SERIES_MEMORY
          .prepare("SELECT topic FROM topics_queue WHERE used = 0 ORDER BY priority DESC, id ASC LIMIT 1")
          .first<{ topic: string }>();
        if (!row) throw new Error("Topic queue is empty — run 'make topics' to add more");

        const recent = await this.env.SERIES_MEMORY
          .prepare("SELECT COUNT(*) as n FROM episodes WHERE topic = ? AND created_at > (unixepoch() - 7776000)")
          .bind(row.topic)
          .first<{ n: number }>();
        if (recent && recent.n > 0) {
          await this.env.SERIES_MEMORY
            .prepare("UPDATE topics_queue SET used = 1, used_at = unixepoch() WHERE topic = ?")
            .bind(row.topic)
            .run();
          const next = await this.env.SERIES_MEMORY
            .prepare("SELECT topic FROM topics_queue WHERE used = 0 ORDER BY priority DESC, id ASC LIMIT 1")
            .first<{ topic: string }>();
          if (!next) throw new Error("Topic queue exhausted after duplicate skip");
          return next.topic;
        }
        return row.topic;
      });

      // ── 1. Story generation ──────────────────────────────────────────────────
      const story = await step.do("story", async () => {
        const raw = await openrouterChat(
          this.env.OPENROUTER_API_KEY,
          "nousresearch/hermes-4-405b",
          "You are a warm, gentle children's Bible storyteller for ages 3-8. Return STRICT JSON only.",
          `Write a 15-20 scene animated episode about: "${topic}". Target 8-12 minutes when narrated at a calm storytelling pace.\n\nReturn JSON:\n{\n  "title": "catchy kid-friendly title (max 70 chars)",\n  "source": "Bible book/passage",\n  "lesson": "one gentle sentence moral",\n  "characters": [{"name":"...","description":"stable look","palette":{"skin":"#hex","hair":"#hex","robe":"#hex"}}],\n  "scenes": [{"narration":"2-3 warm storytelling sentences (about 20-25 seconds when spoken aloud at a gentle pace)","visual":"cartoon description","characters":["names"],"setting":"day|night|sunrise|indoor|water|desert"}]\n}`,
          true,
        );
        return parseJson<StoryOutput>(raw);
      });

      await logCost(this.env, id, "story", "openrouter", story.scenes.reduce((n, s) => n + s.narration.length + s.visual.length, 0), "chars", 0.000008);

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

      // ── 3. Keyframes (Flux 2) ────────────────────────────────────────────────
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

      await logCost(this.env, id, "keyframes", "fal-flux2", imageKeys.length, "images", 0.05);

      // ── 4. Animation (PixVerse V4.5) ─────────────────────────────────────────
      const clipKeys = await step.do(
        "animate",
        { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
        async () => {
          const keys: string[] = [];
          for (let i = 0; i < imageKeys.length; i++) {
            const imgObj = await this.env.ARTIFACTS.get(imageKeys[i]!);
            if (!imgObj) throw new Error(`R2 image missing: ${imageKeys[i]}`);
            const dataUri = `data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(await imgObj.arrayBuffer())))}`;
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

      await logCost(this.env, id, "animate", "fal-pixverse", clipKeys.length, "clips", 0.15);

      // ── 5. Voiceover (ElevenLabs Rachel) ────────────────────────────────────
      const audioKeys = await step.do(
        "voiceover",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          const keys: string[] = [];
          const voiceId = "21m00Tcm4TlvDq8ikWAM";
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

      const totalNarrationChars = story.scenes.reduce((n, s) => n + s.narration.length, 0);
      await logCost(this.env, id, "voiceover", "elevenlabs", totalNarrationChars, "chars", 0.00003);

      // ── 6. Music bed (Suno) ──────────────────────────────────────────────────
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

      await logCost(this.env, id, "music", "suno", 1, "generations", 0.01);

      // ── 7. Assembly + thumbnail (Hetzner render box) ──────────────────────────
      const rendered = await step.do(
        "assemble",
        { timeout: "20 minutes", retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } },
        async () => {
          const res = await fetch(`${this.env.RENDER_ENDPOINT}/assemble`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.env.RENDER_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ id, story, clipKeys, audioKeys, musicKey, imageKeys, r2Bucket: "bible-story-artifacts" }),
          });
          if (!res.ok) throw new Error(`Render service ${res.status}: ${await res.text()}`);
          return (await res.json()) as RenderResult;
        },
      );

      // ── 8. SEO metadata ──────────────────────────────────────────────────────
      const metadata = await step.do("metadata", () => buildSEOMeta(this.env.OPENROUTER_API_KEY, story));

      // ── 8b. Feature 8: Quality gate ─────────────────────────────────────────
      const quality = await step.do("quality-gate", async () => {
        if (this.env.QUALITY_GATE_ENABLED !== "true") return { score: 10, reason: "gate disabled" };
        return scoreEpisodeQuality(this.env, story, metadata);
      });

      // ── 9. Record to D1 ──────────────────────────────────────────────────────
      const initialStatus =
        this.env.REQUIRE_APPROVAL === "true"
          ? "awaiting_approval"
          : quality.score < 7
          ? "quality_failed"
          : "assembled";

      await step.do("record-episode", async () => {
        await this.env.SERIES_MEMORY
          .prepare("INSERT INTO episodes (id, title, source, lesson, topic, status, episode_mp4_key, thumbnail_key, quality_score, quality_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(id, story.title, story.source, story.lesson, topic, initialStatus, rendered.episodeKey, rendered.thumbnailKey, quality.score, quality.reason)
          .run();
        await this.env.SERIES_MEMORY
          .prepare("UPDATE topics_queue SET used = 1, used_at = unixepoch() WHERE topic = ?")
          .bind(topic)
          .run();

        // Feature 3: Series continuity — upsert characters with last appearance
        for (const c of story.characters) {
          await this.env.SERIES_MEMORY
            .prepare(`INSERT INTO characters (id, name, description, palette_skin, palette_hair, palette_robe, last_episode_id, last_seen_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
                      ON CONFLICT(name) DO UPDATE SET
                        last_episode_id = excluded.last_episode_id,
                        last_seen_at    = excluded.last_seen_at`)
            .bind(crypto.randomUUID(), c.name, c.description, c.palette.skin, c.palette.hair, c.palette.robe, id)
            .run()
            .catch(() => {});
          const charRow = await this.env.SERIES_MEMORY
            .prepare("SELECT id FROM characters WHERE name = ?")
            .bind(c.name)
            .first<{ id: string }>();
          if (charRow) {
            await this.env.SERIES_MEMORY
              .prepare("INSERT OR IGNORE INTO episode_characters (episode_id, character_id) VALUES (?, ?)")
              .bind(id, charRow.id)
              .run()
              .catch(() => {});
          }
        }
      });

      if (initialStatus === "quality_failed") {
        await notify(this.env, `⚠️ Quality gate failed (score ${quality.score}/10): **${story.title}**\n${quality.reason}`, 0xfaa61a);
        return { id, topic, title: story.title, status: "quality_failed", quality };
      }

      if (initialStatus === "awaiting_approval") {
        await notify(this.env, `🎬 Episode assembled: **${story.title}** — awaiting approval\nPOST /approve/${id}`, 0xfaa61a);
        return { id, topic, title: story.title, status: "awaiting_approval", note: `POST /approve/${id} to publish` };
      }

      // ── 10. Publish to YouTube ────────────────────────────────────────────────
      const published = await step.do(
        "publish",
        { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } },
        () => publishToYouTube(this.env, rendered.episodeKey, metadata),
      );

      // ── 11. Post-publish steps ────────────────────────────────────────────────
      await step.do("post-publish", async () => {
        await this.env.SERIES_MEMORY
          .prepare("UPDATE episodes SET status = 'published', youtube_id = ?, youtube_url = ?, youtube_privacy = 'unlisted', published_at = unixepoch() WHERE id = ?")
          .bind(published.youtubeId, published.url, id)
          .run();

        // Feature 1: Playlists
        await managePlaylists(this.env, story, published.youtubeId, published.accessToken);

        // Feature 2: Captions
        await uploadCaptions(this.env, published.youtubeId, story, published.accessToken, rendered.sceneDurations);

        // Feature 6: Outgoing webhook
        await fireWebhook(this.env, {
          id,
          title: story.title,
          youtubeId: published.youtubeId,
          url: published.url,
          topic,
          quality,
        });
      });

      await notify(this.env, `✅ Published: **${story.title}**\n${published.url}`, 0x57f287);

      return { id, topic, title: story.title, quality, youtubeId: published.youtubeId, url: published.url };
    } catch (err) {
      await notify(this.env, `❌ Workflow failed: ${id}\n${String(err)}`, 0xed4245);
      throw err;
    }
  }
}

// ─── Shorts Workflow ──────────────────────────────────────────────────────────

export class ShortsWorkflow extends WorkflowEntrypoint<Env, ShortsParams> {
  async run(event: WorkflowEvent<ShortsParams>, step: WorkflowStep): Promise<unknown> {
    const id = event.instanceId;

    try {
      let story: StoryOutput;
      let audioKeys: string[];
      let topic: string;

      if (event.payload.episodeId) {
        const episodeId = event.payload.episodeId;
        const existing = await step.do("load-episode", async () => {
          const row = await this.env.SERIES_MEMORY
            .prepare("SELECT * FROM episodes WHERE id = ?")
            .bind(episodeId)
            .first<EpisodeRow>();
          if (!row) throw new Error(`Episode not found: ${episodeId}`);
          return row;
        });
        topic = existing.topic;
        story = await step.do("story", async () => {
          const raw = await openrouterChat(
            this.env.OPENROUTER_API_KEY,
            "nousresearch/hermes-4-405b",
            "You are a warm, gentle children's Bible storyteller for ages 3-8. Return STRICT JSON only.",
            `Write a 3-scene SHORT animated episode (under 60 seconds) about: "${existing.topic}".\n\nReturn JSON:\n{\n  "title": "catchy kid-friendly title (max 70 chars)",\n  "source": "Bible book/passage",\n  "lesson": "one gentle sentence moral",\n  "characters": [{"name":"...","description":"stable look","palette":{"skin":"#hex","hair":"#hex","robe":"#hex"}}],\n  "scenes": [{"narration":"1 short sentence","visual":"cartoon description","characters":["names"],"setting":"day|night|sunrise|indoor|water|desert"}]\n}`,
            true,
          );
          return parseJson<StoryOutput>(raw);
        });
        audioKeys = [];
        for (let i = 0; i < Math.min(3, story.scenes.length); i++) {
          audioKeys.push(`${episodeId}/audio/scene-${String(i).padStart(2, "0")}.mp3`);
        }
      } else {
        topic = await step.do("pick-topic", async () => {
          if (event.payload.topic) return event.payload.topic;
          const row = await this.env.SERIES_MEMORY
            .prepare("SELECT topic FROM topics_queue WHERE used = 0 ORDER BY priority DESC, id ASC LIMIT 1")
            .first<{ topic: string }>();
          if (!row) throw new Error("Topic queue is empty");
          return row.topic;
        });
        story = await step.do("story", async () => {
          const raw = await openrouterChat(
            this.env.OPENROUTER_API_KEY,
            "nousresearch/hermes-4-405b",
            "You are a warm, gentle children's Bible storyteller for ages 3-8. Return STRICT JSON only.",
            `Write a 3-scene SHORT animated episode (under 60 seconds total) about: "${topic}".\n\nReturn JSON:\n{\n  "title": "catchy kid-friendly title (max 70 chars)",\n  "source": "Bible book/passage",\n  "lesson": "one gentle sentence moral",\n  "characters": [{"name":"...","description":"stable look","palette":{"skin":"#hex","hair":"#hex","robe":"#hex"}}],\n  "scenes": [{"narration":"1 short sentence","visual":"cartoon description","characters":["names"],"setting":"day|night|sunrise|indoor|water|desert"}]\n}`,
            true,
          );
          return parseJson<StoryOutput>(raw);
        });
        audioKeys = await step.do(
          "voiceover",
          { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
          async () => {
            const keys: string[] = [];
            const voiceId = "21m00Tcm4TlvDq8ikWAM";
            for (let i = 0; i < Math.min(3, story.scenes.length); i++) {
              const text = story.scenes[i]!.narration;
              const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
                method: "POST",
                headers: { "xi-api-key": this.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
                body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.75, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true } }),
              });
              if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
              const key = `${id}/audio/scene-${String(i).padStart(2, "0")}.mp3`;
              await r2Put(this.env.ARTIFACTS, key, await res.arrayBuffer(), "audio/mpeg");
              keys.push(key);
            }
            return keys;
          },
        );
      }

      const shortScenes = story.scenes.slice(0, 3);
      const shortStory: StoryOutput = { ...story, scenes: shortScenes };

      const imageKeys = await step.do(
        "keyframes",
        { retries: { limit: 3, delay: "15 seconds", backoff: "exponential" } },
        async () => {
          const keys: string[] = [];
          for (let i = 0; i < shortScenes.length; i++) {
            const scene = shortScenes[i]!;
            const cast = shortStory.characters
              .filter((c) => scene.characters.includes(c.name))
              .map((c) => `${c.name}: ${c.description}, palette ${JSON.stringify(c.palette)}`)
              .join("; ");
            const prompt = `Cute flat-vector cartoon for preschoolers, soft pastel colors, PORTRAIT orientation for YouTube Shorts. ${scene.visual}. Characters — ${cast}. Setting: ${scene.setting}. No text overlays.`;
            const res = await fetch("https://fal.run/fal-ai/flux-2", {
              method: "POST",
              headers: { Authorization: `Key ${this.env.FAL_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ prompt, image_size: { width: 1080, height: 1920 } }),
            });
            if (!res.ok) throw new Error(`Flux2 ${res.status}: ${await res.text()}`);
            const data = (await res.json()) as { images?: { url: string }[] };
            const url = data.images?.[0]?.url;
            if (!url) throw new Error("Flux2 returned no image");
            const img = await (await fetch(url)).arrayBuffer();
            const key = `${id}/shorts/images/scene-${String(i).padStart(2, "0")}.png`;
            await r2Put(this.env.ARTIFACTS, key, img, "image/png");
            keys.push(key);
          }
          return keys;
        },
      );

      const clipKeys = await step.do(
        "animate",
        { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
        async () => {
          const keys: string[] = [];
          for (let i = 0; i < imageKeys.length; i++) {
            const imgObj = await this.env.ARTIFACTS.get(imageKeys[i]!);
            if (!imgObj) throw new Error(`R2 image missing: ${imageKeys[i]}`);
            const dataUri = `data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(await imgObj.arrayBuffer())))}`;
            const res = await fetch("https://fal.run/fal-ai/pixverse/v4.5/image-to-video", {
              method: "POST",
              headers: { Authorization: `Key ${this.env.FAL_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ image_url: dataUri, prompt: "gentle cute cartoon motion, soft parallax, child-friendly, no camera shake", duration: 6, style: "cartoon", aspect_ratio: "9:16" }),
            });
            if (!res.ok) throw new Error(`PixVerse ${res.status}: ${await res.text()}`);
            const data = (await res.json()) as { video?: { url: string } };
            const url = data.video?.url;
            if (!url) throw new Error("PixVerse returned no video");
            const clip = await (await fetch(url)).arrayBuffer();
            const key = `${id}/shorts/clips/scene-${String(i).padStart(2, "0")}.mp4`;
            await r2Put(this.env.ARTIFACTS, key, clip, "video/mp4");
            keys.push(key);
          }
          return keys;
        },
      );

      const musicKey = await step.do(
        "music",
        { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" } },
        async () => {
          const initRes = await fetch("https://api.suno.ai/api/generate", {
            method: "POST",
            headers: { Authorization: `Bearer ${this.env.SUNO_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: `Gentle instrumental children's music for a Bible story about ${shortStory.title}. 30 seconds.`, make_instrumental: true, wait_audio: true }),
          });
          if (!initRes.ok) throw new Error(`Suno ${initRes.status}: ${await initRes.text()}`);
          const data = (await initRes.json()) as Array<{ audio_url?: string }>;
          const url = data[0]?.audio_url;
          if (!url) throw new Error("Suno returned no audio URL");
          const music = await (await fetch(url)).arrayBuffer();
          const key = `${id}/shorts/audio/music.mp3`;
          await r2Put(this.env.ARTIFACTS, key, music, "audio/mpeg");
          return key;
        },
      );

      const rendered = await step.do(
        "assemble",
        { timeout: "20 minutes", retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } },
        async () => {
          const res = await fetch(`${this.env.RENDER_ENDPOINT}/assemble-short`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.env.RENDER_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ id, story: shortStory, clipKeys, audioKeys: audioKeys.slice(0, 3), musicKey, imageKeys, r2Bucket: "bible-story-artifacts", format: "short" }),
          });
          if (!res.ok) throw new Error(`Render service ${res.status}: ${await res.text()}`);
          return (await res.json()) as RenderResult;
        },
      );

      const metadata = await step.do("metadata", async () => {
        const meta = await buildSEOMeta(this.env.OPENROUTER_API_KEY, shortStory);
        return { ...meta, title: `${meta.title.slice(0, 93)} #Shorts` };
      });

      await step.do("record-episode", async () => {
        await this.env.SERIES_MEMORY
          .prepare("INSERT INTO episodes (id, title, source, lesson, topic, status, episode_mp4_key, thumbnail_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(id, metadata.title, shortStory.source, shortStory.lesson, topic, "assembled", rendered.episodeKey, rendered.thumbnailKey)
          .run();
      });

      const published = await step.do(
        "publish",
        { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } },
        () => publishToYouTube(this.env, rendered.episodeKey, metadata),
      );

      await step.do("post-publish", async () => {
        await this.env.SERIES_MEMORY
          .prepare("UPDATE episodes SET status = 'published', youtube_id = ?, youtube_url = ?, youtube_privacy = 'unlisted', published_at = unixepoch() WHERE id = ?")
          .bind(published.youtubeId, published.url, id)
          .run();
        await uploadCaptions(this.env, published.youtubeId, shortStory, published.accessToken, rendered.sceneDurations);
        await fireWebhook(this.env, { id, title: metadata.title, youtubeId: published.youtubeId, url: published.url, format: "short" });
      });

      await notify(this.env, `🩳 Short published: **${metadata.title}**\n${published.url}`, 0x57f287);
      return { id, topic, title: metadata.title, format: "short", youtubeId: published.youtubeId, url: published.url };
    } catch (err) {
      await notify(this.env, `❌ Shorts workflow failed: ${id}\n${String(err)}`, 0xed4245);
      throw err;
    }
  }
}

// ─── Scheduled + HTTP handlers ───────────────────────────────────────────────

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ─── Feature: Market Intelligence ────────────────────────────────────────────

/** Parses ISO 8601 duration (PT1H30M45S) to total seconds. */
function parseIso8601Duration(dur: string): number {
  const m = dur.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return (parseInt(m[1] ?? "0", 10) * 3600) + (parseInt(m[2] ?? "0", 10) * 60) + parseInt(m[3] ?? "0", 10);
}

interface StrategyReport {
  generatedAt: number;
  sampleSize: number;
  avgDurationSec: number;
  medianDurationSec: number;
  pctOver8Min: number;
  topVideoLengths: number[];
  recommendations: string[];
}

/**
 * Fetches real competitor data from YouTube Data API v3, then asks Llama 3.3
 * for 3 data-backed content strategy recommendations.
 * Stores result in D1 strategy_reports table.
 */
async function generateStrategyReport(env: Env): Promise<void> {
  if (!env.YOUTUBE_API_KEY) return;

  try {
    // Step 1: Search for top Bible-story kids videos
    const searchRes = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent("Bible stories for kids animated")}&type=video&maxResults=20&order=viewCount&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`,
    );
    if (!searchRes.ok) throw new Error(`YouTube search ${searchRes.status}`);
    const searchData = (await searchRes.json()) as { items?: Array<{ id?: { videoId?: string } }> };
    const videoIds = (searchData.items ?? []).map((i) => i.id?.videoId).filter(Boolean) as string[];
    if (videoIds.length === 0) throw new Error("No videos returned from search");

    // Step 2: Fetch contentDetails + statistics for those videos
    const detailsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${encodeURIComponent(videoIds.join(","))}&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`,
    );
    if (!detailsRes.ok) throw new Error(`YouTube videos ${detailsRes.status}`);
    const detailsData = (await detailsRes.json()) as {
      items?: Array<{
        contentDetails?: { duration?: string };
        statistics?: { viewCount?: string; likeCount?: string };
      }>;
    };

    const durations = (detailsData.items ?? [])
      .map((v) => parseIso8601Duration(v.contentDetails?.duration ?? ""))
      .filter((d) => d > 0)
      .sort((a, b) => a - b);

    if (durations.length === 0) throw new Error("No valid durations parsed");

    const avg = Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
    const median = durations[Math.floor(durations.length / 2)]!;
    const pctOver8Min = Math.round((durations.filter((d) => d > 480).length / durations.length) * 100);

    // Step 3: LLM strategy recommendations based on real data
    const statsText = `Top ${durations.length} "Bible stories for kids animated" YouTube videos (sorted by view count):
- Average duration: ${Math.floor(avg / 60)}m ${avg % 60}s
- Median duration: ${Math.floor(median / 60)}m ${median % 60}s
- % over 8 minutes: ${pctOver8Min}%
- Duration spread: ${Math.floor(durations[0]! / 60)}m–${Math.floor(durations[durations.length - 1]! / 60)}m`;

    const raw = await openrouterChat(
      env.OPENROUTER_API_KEY,
      "meta-llama/llama-3.3-70b-instruct",
      "You are a data-driven YouTube content strategist for a children's Bible story channel. Base every recommendation on the provided statistics. Return strict JSON.",
      `${statsText}\n\nOur channel: animated Bible stories, ages 3-8, "Made for Kids" (no comments/notifications). We publish daily.\n\nReturn JSON: {"recommendations": ["bullet 1", "bullet 2", "bullet 3"]} — each bullet must cite a specific number from the stats above.`,
      true,
    );
    const parsed = parseJson<{ recommendations: string[] }>(raw);

    const report: StrategyReport = {
      generatedAt: Math.floor(Date.now() / 1000),
      sampleSize: durations.length,
      avgDurationSec: avg,
      medianDurationSec: median,
      pctOver8Min,
      topVideoLengths: durations,
      recommendations: parsed.recommendations ?? [],
    };

    await env.SERIES_MEMORY
      .prepare("INSERT INTO strategy_reports (report_json) VALUES (?)")
      .bind(JSON.stringify(report))
      .run()
      .catch(() => {});
  } catch (err) {
    console.error("[strategy-report]", err);
  }
}

// ─── Compilation Workflow ────────────────────────────────────────────────────

interface CompilationParams {
  /** If provided, compile exactly these episode IDs in order */
  episodeIds?: string[];
}

interface CompilationEpisodeRow {
  id: string;
  title: string;
  episode_mp4_key: string;
  thumbnail_key: string;
}

export class CompilationWorkflow extends WorkflowEntrypoint<Env, CompilationParams> {
  async run(event: WorkflowEvent<CompilationParams>, step: WorkflowStep): Promise<unknown> {
    const id = event.instanceId;

    try {
      // ── 1. Resolve episodes ────────────────────────────────────────────────
      const episodes = await step.do("resolve-episodes", async () => {
        if (event.payload.episodeIds && event.payload.episodeIds.length >= 3) {
          const placeholders = event.payload.episodeIds.map(() => "?").join(",");
          const rows = await this.env.SERIES_MEMORY
            .prepare(`SELECT id, title, episode_mp4_key, thumbnail_key FROM episodes WHERE id IN (${placeholders}) AND status = 'published'`)
            .bind(...event.payload.episodeIds)
            .all<CompilationEpisodeRow>();
          return rows.results;
        }
        // Default: last 3-4 published episodes from the past 7 days
        const rows = await this.env.SERIES_MEMORY
          .prepare("SELECT id, title, episode_mp4_key, thumbnail_key FROM episodes WHERE status = 'published' AND is_compilation = 0 AND published_at > (unixepoch() - 604800) ORDER BY published_at ASC LIMIT 4")
          .all<CompilationEpisodeRow>();
        return rows.results;
      });

      if (episodes.length < 3) {
        await notify(this.env, `⏭️ Compilation skipped — only ${episodes.length} episode(s) this week (need ≥ 3)`, 0x5865f2);
        return { skipped: true, reason: "fewer than 3 episodes this week" };
      }

      // ── 2. Build title and meta ────────────────────────────────────────────
      const titles = episodes.map((e) => e.title);
      const n = episodes.length;
      const titlePreview = titles.slice(0, 2).join(", ");
      const compilationTitle = `Bible Stories for Kids — ${n} Stories | ${titlePreview} & More`;
      const compilationDesc = [
        `🎬 ${n} full Bible stories for children in one video! Perfect for bedtime, Sunday school, or quiet time.`,
        "",
        titles.map((t, i) => `${i + 1}. ${t}`).join("\n"),
        "",
        "📖 Gentle animated stories for ages 3-8 | Safe for all kids | Made for families",
        "#BibleStoriesForKids #KidsBibleStories #AnimatedBible #ChildrensBible #BibleForKids",
      ].join("\n");

      const compilationMeta = {
        title: compilationTitle.slice(0, 100),
        description: compilationDesc.slice(0, 4900),
        tags: ["bible stories for kids", "animated bible", "children bible", "kids bible stories", "bible cartoon", "christian kids", "sunday school", "bible compilation"],
      };

      // ── 3. Assemble via render service ─────────────────────────────────────
      const rendered = await step.do(
        "assemble-compilation",
        { timeout: "20 minutes", retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } },
        async () => {
          const res = await fetch(`${this.env.RENDER_ENDPOINT}/assemble-compilation`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.env.RENDER_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              id,
              episodeKeys: episodes.map((e) => e.episode_mp4_key),
              thumbnailKey: episodes[0]!.thumbnail_key,
              r2Bucket: "bible-story-artifacts",
            }),
          });
          if (!res.ok) throw new Error(`Render service ${res.status}: ${await res.text()}`);
          return (await res.json()) as { episodeKey: string; thumbnailKey: string };
        },
      );

      // ── 4. Publish to YouTube ──────────────────────────────────────────────
      const published = await step.do(
        "publish",
        { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } },
        () => publishToYouTube(this.env, rendered.episodeKey, compilationMeta),
      );

      // ── 5. Record in D1 ───────────────────────────────────────────────────
      await step.do("record", async () => {
        await this.env.SERIES_MEMORY
          .prepare("INSERT INTO episodes (id, title, source, lesson, topic, status, episode_mp4_key, thumbnail_key, is_compilation, youtube_id, youtube_url, youtube_privacy, published_at) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, 1, ?, ?, 'unlisted', unixepoch())")
          .bind(id, compilationMeta.title, "Compilation", `${n} Bible stories in one video`, "compilation", rendered.episodeKey, rendered.thumbnailKey, published.youtubeId, published.url)
          .run();
      });

      await notify(this.env, `🎞️ Compilation published (${n} episodes, ~${Math.round(n * 10)} min): **${compilationMeta.title}**\n${published.url}`, 0x57f287);
      await fireWebhook(this.env, { id, type: "compilation", episodeCount: n, url: published.url });

      return { id, episodeCount: n, url: published.url };
    } catch (err) {
      await notify(this.env, `❌ Compilation workflow failed: ${id}\n${String(err)}`, 0xed4245);
      throw err;
    }
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === "0 20 * * *") { await autoPromote(env); return; }
    if (controller.cron === "0 16 * * *") { await env.SHORTS_WORKFLOW.create({ params: {} }); return; }
    if (controller.cron === "0 10 * * *") { await fetchAnalytics(env); return; }
    if (controller.cron === "0 7 * * 0")  { await generateStrategyReport(env); return; }
    if (controller.cron === "0 9 * * 0")  { await sendWeeklyDigest(env); return; }
    if (controller.cron === "0 18 * * 0") { await env.COMPILATION_WORKFLOW.create({ params: {} }); return; }

    // 0 15 * * * — daily episode
    await env.STUDIO_WORKFLOW.create({ params: {} });
    const remaining = await env.SERIES_MEMORY
      .prepare("SELECT COUNT(*) as n FROM topics_queue WHERE used = 0")
      .first<{ n: number }>();
    if (remaining && remaining.n < 10) await autoGenerateTopics(env).catch(() => {});
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    // POST /run
    if (req.method === "POST" && url.pathname === "/run") {
      const allowed = await checkRateLimit(env);
      if (!allowed) return jsonResponse({ error: "Rate limit: max 10 manual triggers per hour" }, 429);
      const body = (await req.json().catch(() => ({}))) as { topic?: string };
      const instance = await env.STUDIO_WORKFLOW.create({ params: { topic: body.topic } });
      return jsonResponse({ instanceId: instance.id, topic: body.topic ?? "(auto from queue)" });
    }

    // POST /run-short
    if (req.method === "POST" && url.pathname === "/run-short") {
      const auth = req.headers.get("Authorization");
      if (!auth || auth !== `Bearer ${env.RENDER_TOKEN}`) return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
      const body = (await req.json().catch(() => ({}))) as ShortsParams;
      const instance = await env.SHORTS_WORKFLOW.create({ params: body });
      return jsonResponse({ instanceId: instance.id });
    }

    // GET /queue
    if (req.method === "GET" && url.pathname === "/queue") {
      const rows = await env.SERIES_MEMORY.prepare("SELECT topic, priority, used, used_at FROM topics_queue ORDER BY used ASC, priority DESC").all();
      return jsonResponse(rows.results);
    }

    // DELETE /queue/:topic
    if (req.method === "DELETE" && url.pathname.startsWith("/queue/")) {
      const auth = req.headers.get("Authorization");
      if (!auth || auth !== `Bearer ${env.RENDER_TOKEN}`) return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
      const topic = decodeURIComponent(url.pathname.slice("/queue/".length));
      await env.SERIES_MEMORY.prepare("DELETE FROM topics_queue WHERE topic = ?").bind(topic).run();
      return jsonResponse({ deleted: topic });
    }

    // GET /episodes
    if (req.method === "GET" && url.pathname === "/episodes") {
      const rows = await env.SERIES_MEMORY
        .prepare("SELECT id, title, source, status, youtube_url, youtube_privacy, quality_score, datetime(created_at,'unixepoch') as created FROM episodes ORDER BY created_at DESC LIMIT 50")
        .all();
      return jsonResponse(rows.results);
    }

    // GET /status/:id
    if (req.method === "GET" && url.pathname.startsWith("/status/")) {
      const epId = url.pathname.slice("/status/".length);
      const row = await env.SERIES_MEMORY.prepare("SELECT * FROM episodes WHERE id = ?").bind(epId).first<EpisodeRow>();
      if (!row) return new Response("Episode not found", { status: 404, headers: corsHeaders() });
      return jsonResponse(row);
    }

    // Feature 4: GET /preview/:id — HTML preview with OG tags
    if (req.method === "GET" && url.pathname.startsWith("/preview/")) {
      const epId = url.pathname.slice("/preview/".length);
      const row = await env.SERIES_MEMORY.prepare("SELECT * FROM episodes WHERE id = ?").bind(epId).first<EpisodeRow>();
      if (!row) return new Response("Episode not found", { status: 404, headers: corsHeaders() });

      const thumbUrl = `${url.origin}/thumbnail/${epId}`;
      const canonical = row.youtube_url ?? `${url.origin}/preview/${epId}`;

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeXml(row.title)} — Bible Videos for Kids</title>
  <meta name="description" content="${escapeXml(row.lesson ?? "")}" />
  <!-- Open Graph -->
  <meta property="og:type" content="video.other" />
  <meta property="og:title" content="${escapeXml(row.title)}" />
  <meta property="og:description" content="${escapeXml(row.lesson ?? "")}" />
  <meta property="og:image" content="${thumbUrl}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:site_name" content="Bible Videos for Kids" />
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeXml(row.title)}" />
  <meta name="twitter:description" content="${escapeXml(row.lesson ?? "")}" />
  <meta name="twitter:image" content="${thumbUrl}" />
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; background: #faf8f4; color: #222; }
    img { width: 100%; border-radius: 12px; }
    h1 { font-size: 1.5rem; margin: 16px 0 4px; }
    .meta { color: #666; font-size: 0.9rem; margin-bottom: 12px; }
    a.btn { display: inline-block; margin-top: 16px; padding: 10px 24px; background: #ff0000; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 0.8rem; background: #e8f5e9; color: #2e7d32; }
  </style>
</head>
<body>
  <img src="${thumbUrl}" alt="${escapeXml(row.title)}" />
  <h1>${escapeXml(row.title)}</h1>
  <div class="meta">${escapeXml(row.source ?? "")} &nbsp;·&nbsp; <span class="badge">${escapeXml(row.status)}</span></div>
  <p>${escapeXml(row.lesson ?? "")}</p>
  ${row.youtube_url ? `<a class="btn" href="${row.youtube_url}" target="_blank">▶ Watch on YouTube</a>` : ""}
</body>
</html>`;

      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
      });
    }

    // POST /approve/:id
    if (req.method === "POST" && url.pathname.startsWith("/approve/")) {
      const auth = req.headers.get("Authorization");
      if (!auth || auth !== `Bearer ${env.RENDER_TOKEN}`) return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
      const epId = url.pathname.slice("/approve/".length);
      const row = await env.SERIES_MEMORY
        .prepare("SELECT id, title, source, lesson, episode_mp4_key, thumbnail_key FROM episodes WHERE id = ? AND status = 'awaiting_approval'")
        .bind(epId)
        .first<Pick<EpisodeRow, "id" | "title" | "source" | "lesson" | "episode_mp4_key" | "thumbnail_key">>();
      if (!row) return new Response("Episode not found or not awaiting approval", { status: 404, headers: corsHeaders() });

      const meta = await buildSEOMeta(env.OPENROUTER_API_KEY, row);
      const published = await publishToYouTube(env, row.episode_mp4_key, meta);
      await env.SERIES_MEMORY
        .prepare("UPDATE episodes SET status = 'published', youtube_id = ?, youtube_url = ?, youtube_privacy = 'unlisted', published_at = unixepoch() WHERE id = ?")
        .bind(published.youtubeId, published.url, epId)
        .run();
      await fireWebhook(env, { id: epId, title: row.title, youtubeId: published.youtubeId, url: published.url });
      await notify(env, `✅ Manually approved & published: **${row.title}**\n${published.url}`, 0x57f287);
      return jsonResponse({ id: epId, title: row.title, youtubeId: published.youtubeId, url: published.url });
    }

    // POST /topics/generate
    if (req.method === "POST" && url.pathname === "/topics/generate") {
      const auth = req.headers.get("Authorization");
      if (!auth || auth !== `Bearer ${env.RENDER_TOKEN}`) return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
      try {
        const topics = await autoGenerateTopics(env);
        return jsonResponse({ topics, count: topics.length });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // GET /thumbnail/:id
    if (req.method === "GET" && url.pathname.startsWith("/thumbnail/")) {
      const epId = url.pathname.slice("/thumbnail/".length);
      const key = `${epId}/thumbnail.jpg`;
      const obj = await env.ARTIFACTS.get(key);
      if (!obj) return new Response("Not found", { status: 404, headers: corsHeaders() });
      return new Response(obj.body, {
        status: 200,
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400", ...corsHeaders() },
      });
    }

    // GET /characters
    if (req.method === "GET" && url.pathname === "/characters") {
      const rows = await env.SERIES_MEMORY
        .prepare("SELECT id, name, description, palette_skin, palette_hair, palette_robe, last_episode_id, last_seen_at, created_at FROM characters ORDER BY name ASC")
        .all();
      return jsonResponse(rows.results);
    }

    // GET /analytics
    if (req.method === "GET" && url.pathname === "/analytics") {
      const rows = await env.SERIES_MEMORY
        .prepare(`SELECT a.episode_id, a.youtube_id, e.title, a.views, a.likes, a.comments, a.fetched_at
           FROM analytics a JOIN episodes e ON e.id = a.episode_id
           WHERE a.id IN (SELECT MAX(id) FROM analytics GROUP BY episode_id)
           ORDER BY a.views DESC LIMIT 50`)
        .all();
      return jsonResponse(rows.results);
    }

    // GET /analytics/:id
    if (req.method === "GET" && url.pathname.startsWith("/analytics/")) {
      const epId = url.pathname.slice("/analytics/".length);
      const rows = await env.SERIES_MEMORY
        .prepare("SELECT id, episode_id, youtube_id, views, likes, comments, fetched_at FROM analytics WHERE episode_id = ? ORDER BY fetched_at ASC")
        .bind(epId)
        .all();
      return jsonResponse(rows.results);
    }

    // POST /retry/:id
    if (req.method === "POST" && url.pathname.startsWith("/retry/")) {
      const auth = req.headers.get("Authorization");
      if (!auth || auth !== `Bearer ${env.RENDER_TOKEN}`) return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
      const epId = url.pathname.slice("/retry/".length);
      const row = await env.SERIES_MEMORY.prepare("SELECT topic, status FROM episodes WHERE id = ?").bind(epId).first<{ topic: string; status: string }>();
      if (!row) return new Response("Episode not found", { status: 404, headers: corsHeaders() });
      const instance = await env.STUDIO_WORKFLOW.create({ params: { topic: row.topic } });
      return jsonResponse({ newInstanceId: instance.id, topic: row.topic, originalId: epId });
    }

    // GET /strategy — latest competitor market intelligence report
    if (req.method === "GET" && url.pathname === "/strategy") {
      const row = await env.SERIES_MEMORY
        .prepare("SELECT report_json, generated_at FROM strategy_reports ORDER BY generated_at DESC LIMIT 1")
        .first<{ report_json: string; generated_at: number }>();
      if (!row) return jsonResponse({ message: "No strategy report yet. Runs every Sunday at 7am UTC." }, 404);
      try {
        return jsonResponse({ generatedAt: row.generated_at, ...JSON.parse(row.report_json) });
      } catch {
        return jsonResponse({ raw: row.report_json, generatedAt: row.generated_at });
      }
    }

    // POST /run-compilation — manually trigger compilation workflow [Bearer]
    if (req.method === "POST" && url.pathname === "/run-compilation") {
      const auth = req.headers.get("Authorization");
      if (!auth || auth !== `Bearer ${env.RENDER_TOKEN}`) return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
      const body = (await req.json().catch(() => ({}))) as { episodeIds?: string[] };
      const instance = await env.COMPILATION_WORKFLOW.create({ params: { episodeIds: body.episodeIds } });
      return jsonResponse({ instanceId: instance.id });
    }

    // Feature 1: GET /playlists
    if (req.method === "GET" && url.pathname === "/playlists") {
      const rows = await env.SERIES_MEMORY.prepare("SELECT id, youtube_playlist_id, title, description, created_at FROM playlists ORDER BY created_at DESC").all();
      return jsonResponse(rows.results);
    }

    // Feature 10: POST /episodes/bulk
    if (req.method === "POST" && url.pathname === "/episodes/bulk") {
      const auth = req.headers.get("Authorization");
      if (!auth || auth !== `Bearer ${env.RENDER_TOKEN}`) return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
      const body = (await req.json().catch(() => ({}))) as { action?: string; ids?: string[] };
      if (!body.action || !Array.isArray(body.ids) || body.ids.length === 0) {
        return jsonResponse({ error: "body must have action (approve|retry|delete) and ids[]" }, 400);
      }
      const results: Array<{ id: string; ok: boolean; detail?: string }> = [];

      for (const epId of body.ids.slice(0, 50)) {
        try {
          if (body.action === "delete") {
            await env.SERIES_MEMORY.prepare("DELETE FROM episodes WHERE id = ?").bind(epId).run();
            results.push({ id: epId, ok: true });
          } else if (body.action === "retry") {
            const row = await env.SERIES_MEMORY.prepare("SELECT topic FROM episodes WHERE id = ?").bind(epId).first<{ topic: string }>();
            if (!row) throw new Error("Not found");
            const inst = await env.STUDIO_WORKFLOW.create({ params: { topic: row.topic } });
            results.push({ id: epId, ok: true, detail: inst.id });
          } else if (body.action === "approve") {
            const row = await env.SERIES_MEMORY
              .prepare("SELECT id, title, source, lesson, episode_mp4_key FROM episodes WHERE id = ? AND status = 'awaiting_approval'")
              .bind(epId)
              .first<Pick<EpisodeRow, "id" | "title" | "source" | "lesson" | "episode_mp4_key">>();
            if (!row) throw new Error("Not awaiting approval");
            const meta = await buildSEOMeta(env.OPENROUTER_API_KEY, row);
            const published = await publishToYouTube(env, row.episode_mp4_key, meta);
            await env.SERIES_MEMORY
              .prepare("UPDATE episodes SET status = 'published', youtube_id = ?, youtube_url = ?, youtube_privacy = 'unlisted', published_at = unixepoch() WHERE id = ?")
              .bind(published.youtubeId, published.url, epId)
              .run();
            results.push({ id: epId, ok: true, detail: published.url });
          } else {
            results.push({ id: epId, ok: false, detail: "unknown action" });
          }
        } catch (err) {
          results.push({ id: epId, ok: false, detail: String(err) });
        }
      }
      return jsonResponse({ action: body.action, results });
    }

    // GET /costs/:episodeId
    if (req.method === "GET" && url.pathname.startsWith("/costs/") && url.pathname !== "/costs/summary") {
      const epId = url.pathname.slice("/costs/".length);
      const rows = await env.SERIES_MEMORY.prepare("SELECT * FROM costs WHERE episode_id = ? ORDER BY stage").bind(epId).all();
      return jsonResponse(rows.results);
    }

    // GET /costs/summary
    if (req.method === "GET" && url.pathname === "/costs/summary") {
      const rows = await env.SERIES_MEMORY
        .prepare("SELECT SUM(total_usd) as total, strftime('%Y-%m', datetime(recorded_at,'unixepoch')) as month FROM costs GROUP BY month ORDER BY month DESC LIMIT 12")
        .all();
      return jsonResponse(rows.results);
    }

    // GET /feed.xml
    if (req.method === "GET" && url.pathname === "/feed.xml") {
      const rows = await env.SERIES_MEMORY
        .prepare("SELECT title, lesson, youtube_url, published_at FROM episodes WHERE status='published' AND youtube_url IS NOT NULL ORDER BY published_at DESC LIMIT 50")
        .all<{ title: string; lesson: string | null; youtube_url: string; published_at: number | null }>();

      function toRfc822(ts: number | null): string {
        return new Date((ts ?? 0) * 1000).toUTCString();
      }

      const items = rows.results.map((ep) =>
        `    <item>\n      <title>${escapeXml(ep.title)}</title>\n      <link>${escapeXml(ep.youtube_url)}</link>\n      <guid isPermaLink="true">${escapeXml(ep.youtube_url)}</guid>\n      <description>${escapeXml(ep.lesson ?? "")}</description>\n      <pubDate>${toRfc822(ep.published_at)}</pubDate>\n      <itunes:duration>180</itunes:duration>\n    </item>`,
      ).join("\n");

      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">\n  <channel>\n    <title>Bible Videos for Kids</title>\n    <link>https://www.youtube.com/@BibleVideosForKids</link>\n    <description>Gentle animated Bible stories for children ages 3-8</description>\n    <language>en-us</language>\n    <itunes:category text="Kids &amp; Family" />\n    <itunes:explicit>false</itunes:explicit>\n    <itunes:author>Bible Videos for Kids</itunes:author>\n${items}\n  </channel>\n</rss>`;

      return new Response(xml, { status: 200, headers: { "Content-Type": "application/rss+xml; charset=utf-8", ...corsHeaders() } });
    }

    return withCors(
      new Response(
        [
          "Bible Videos for Kids — Worker API",
          "",
          "POST  /run                    trigger episode (body: {topic?}) [rate limited]",
          "POST  /run-short              trigger short (body: {topic?, episodeId?}) [Bearer]",
          "POST  /run-compilation        trigger weekly compilation [Bearer]",
          "GET   /strategy               latest market intelligence report (YouTube competitor data)",
          "GET   /queue                  topic queue",
          "DELETE /queue/:topic          remove topic [Bearer]",
          "GET   /episodes               recent episodes (includes quality_score)",
          "GET   /status/:id             episode details",
          "GET   /preview/:id            HTML preview with OG / Twitter Card meta",
          "POST  /approve/:id            publish held episode [Bearer]",
          "POST  /retry/:id              re-trigger workflow [Bearer]",
          "POST  /episodes/bulk          bulk approve|retry|delete (body: {action,ids[]}) [Bearer]",
          "POST  /topics/generate        auto-generate topics [Bearer]",
          "GET   /playlists              YouTube playlist index",
          "GET   /costs/:episodeId       cost breakdown for episode",
          "GET   /costs/summary          monthly cost summary",
          "GET   /thumbnail/:id          episode thumbnail (image/jpeg)",
          "GET   /characters             character library (with last appearance)",
          "GET   /analytics              latest YouTube analytics per episode",
          "GET   /analytics/:id          analytics history for one episode",
          "GET   /feed.xml               RSS 2.0 feed of published episodes",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/plain" } },
      ),
    );
  },
};
