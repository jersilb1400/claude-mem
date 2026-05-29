import { Hono } from "hono";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assembleEpisode } from "./assemble.js";
import type { AssembleRequest } from "./types.js";

const app = new Hono();
const PORT = Number(process.env.PORT ?? 3001);
const RENDER_TOKEN = process.env.RENDER_TOKEN ?? "";

if (!RENDER_TOKEN) {
  console.warn("WARNING: RENDER_TOKEN is not set — all /assemble requests will be rejected");
}

// ── Auth middleware ────────────────────────────────────────────────────────
app.use("/assemble", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (!RENDER_TOKEN || auth !== `Bearer ${RENDER_TOKEN}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

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

console.log(`Bible Render Service listening on :${PORT}`);
export default { port: PORT, fetch: app.fetch };
