#!/usr/bin/env bun
// Pre-deploy health check — verifies all external APIs are reachable
// Usage: bun run scripts/health-check.ts

const TIMEOUT_MS = 8000;

interface CheckResult {
  provider: string;
  status: "ok" | "no-key" | "no-url" | "fail";
  latency: number | null;
  note?: string;
}

async function checkUrl(url: string, init?: RequestInit): Promise<{ ok: boolean; latency: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    // Accept anything that isn't a 5xx server error
    return { ok: res.status < 500, latency: Date.now() - start };
  } catch {
    return { ok: false, latency: Date.now() - start };
  }
}

async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. OpenRouter — no auth needed for model list
  {
    const { ok, latency } = await checkUrl("https://openrouter.ai/api/v1/models");
    results.push({ provider: "OpenRouter", status: ok ? "ok" : "fail", latency: ok ? latency : null });
  }

  // 2. fal.ai — GET / (200 or 404 both acceptable, anything below 500)
  {
    const { ok, latency } = await checkUrl("https://fal.run/");
    results.push({ provider: "fal.ai", status: ok ? "ok" : "fail", latency: ok ? latency : null });
  }

  // 3. ElevenLabs — GET /v1/voices with xi-api-key header
  {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      results.push({ provider: "ElevenLabs", status: "no-key", latency: null });
    } else {
      const { ok, latency } = await checkUrl("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": apiKey },
      });
      results.push({ provider: "ElevenLabs", status: ok ? "ok" : "fail", latency: ok ? latency : null });
    }
  }

  // 4. Suno — connectivity check
  {
    const { ok, latency } = await checkUrl("https://api.suno.ai/");
    results.push({ provider: "Suno", status: ok ? "ok" : "fail", latency: ok ? latency : null });
  }

  // 5. YouTube Data API v3 — optional, requires key
  {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      results.push({ provider: "YouTube API", status: "no-key", latency: null });
    } else {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=${encodeURIComponent(apiKey)}`;
      const { ok, latency } = await checkUrl(url);
      results.push({ provider: "YouTube API", status: ok ? "ok" : "fail", latency: ok ? latency : null });
    }
  }

  // 6. Cloudflare Worker URL — optional
  {
    const workerUrl = process.env.WORKER_URL;
    if (!workerUrl) {
      results.push({ provider: "Worker", status: "no-url", latency: null });
    } else {
      const { ok, latency } = await checkUrl(`${workerUrl.replace(/\/$/, "")}/`);
      results.push({ provider: "Worker", status: ok ? "ok" : "fail", latency: ok ? latency : null });
    }
  }

  return results;
}

function formatTable(results: CheckResult[]): void {
  const COL_PROVIDER = 18;
  const COL_STATUS = 10;

  console.log("");
  console.log(
    "Provider".padEnd(COL_PROVIDER) +
    "Status".padEnd(COL_STATUS) +
    "Latency",
  );
  console.log("─".repeat(COL_PROVIDER + COL_STATUS + 10));

  for (const r of results) {
    let statusStr: string;
    if (r.status === "ok") statusStr = "✓ OK";
    else if (r.status === "fail") statusStr = "✗ FAIL";
    else if (r.status === "no-key") statusStr = "✗ No key";
    else statusStr = "✗ No URL";

    const latencyStr = r.latency != null ? `${r.latency}ms` : "—";
    console.log(
      r.provider.padEnd(COL_PROVIDER) +
      statusStr.padEnd(COL_STATUS) +
      latencyStr,
    );
  }
  console.log("");
}

const results = await runChecks();
formatTable(results);

// Required services: OpenRouter and fal.ai
const requiredFailed = results.filter(
  (r) => (r.provider === "OpenRouter" || r.provider === "fal.ai") && r.status === "fail",
);

if (requiredFailed.length > 0) {
  console.error(
    `Health check failed: required services unreachable: ${requiredFailed.map((r) => r.provider).join(", ")}`,
  );
  process.exit(1);
}

console.log("All required services reachable. Ready to deploy.");
