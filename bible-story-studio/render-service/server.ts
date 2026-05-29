import { Hono } from "hono";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assembleEpisode, assembleShort, assembleCompilation } from "./assemble.js";
import type { AssembleRequest, CompilationRequest } from "./types.js";

const app = new Hono();
const PORT = Number(process.env.PORT ?? 3001);
const RENDER_TOKEN = process.env.RENDER_TOKEN ?? "";

if (!RENDER_TOKEN) {
  console.warn("WARNING: RENDER_TOKEN is not set — all /assemble requests will be rejected");
}

// ── Auth middleware ────────────────────────────────────────────────────────
const authMiddleware = async (c: Parameters<Parameters<typeof app.use>[1]>[0], next: () => Promise<void>) => {
  const auth = c.req.header("Authorization");
  if (!RENDER_TOKEN || auth !== `Bearer ${RENDER_TOKEN}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

app.use("/assemble", authMiddleware);
app.use("/assemble-short", authMiddleware);
app.use("/assemble-compilation", authMiddleware);

// ── Routes ─────────────────────────────────────────────────────────────────
app.get("/health", (c) =>
  c.json({ status: "ok", service: "bible-render", ts: new Date().toISOString() }),
);

app.post("/assemble", async (c) => {
  const body = (await c.req.json()) as AssembleRequest;
  const { id } = body;
  const tmpDir = join("/tmp", `render-${id}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const tag = `[${new Date().toISOString()}] episode=${id}`;
  console.log(`${tag} start  title="${body.story.title}"`);
  const t0 = Date.now();

  try {
    const result = await assembleEpisode({ ...body, tmpDir });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${tag} done   elapsed=${elapsed}s  key=${result.episodeKey}`);
    return c.json(result);
  } catch (err) {
    console.error(`${tag} error`, err);
    return c.json({ error: String(err) }, 500);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

app.post("/assemble-short", async (c) => {
  const body = (await c.req.json()) as AssembleRequest;
  const { id } = body;
  const tmpDir = join("/tmp", `render-short-${id}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const tag = `[${new Date().toISOString()}] short=${id}`;
  console.log(`${tag} start  title="${body.story.title}"`);
  const t0 = Date.now();

  try {
    const result = await assembleShort({ ...body, tmpDir });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${tag} done   elapsed=${elapsed}s  key=${result.episodeKey}`);
    return c.json(result);
  } catch (err) {
    console.error(`${tag} error`, err);
    return c.json({ error: String(err) }, 500);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Compilation assembly — concatenates finished episode MP4s into one long video
app.post("/assemble-compilation", async (c) => {
  const body = (await c.req.json()) as CompilationRequest;
  const { id } = body;
  const tmpDir = join("/tmp", `render-comp-${id}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const tag = `[${new Date().toISOString()}] compilation=${id}`;
  console.log(`${tag} start  episodes=${body.episodeKeys.length}`);
  const t0 = Date.now();

  try {
    const result = await assembleCompilation({ ...body, tmpDir });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${tag} done   elapsed=${elapsed}s  key=${result.episodeKey}`);
    return c.json(result);
  } catch (err) {
    console.error(`${tag} error`, err);
    return c.json({ error: String(err) }, 500);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`Bible Render Service listening on :${PORT}`);

const server = Bun.serve({ port: PORT, fetch: app.fetch });

// Graceful shutdown for PM2 SIGTERM
process.on("SIGTERM", () => {
  console.log("SIGTERM received — draining connections...");
  server.stop(true);
});
