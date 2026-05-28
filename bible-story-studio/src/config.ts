import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // No .env file — rely on real env vars / defaults.
  }
}
loadDotEnv();

const env = (k: string, d = ""): string => process.env[k]?.trim() || d;
const bool = (k: string, d = false): boolean => {
  const v = process.env[k]?.trim().toLowerCase();
  return v === undefined || v === "" ? d : v === "true" || v === "1" || v === "yes";
};
const num = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const config = {
  llm: {
    apiKey: env("OPENROUTER_API_KEY"),
    model: env("OPENROUTER_MODEL", "nousresearch/hermes-4-405b"),
    utilityModel: env("OPENROUTER_UTILITY_MODEL", "meta-llama/llama-3.3-70b-instruct"),
    baseUrl: "https://openrouter.ai/api/v1",
  },
  image: {
    provider: env("IMAGE_PROVIDER", "local"),
    falKey: env("FAL_API_KEY"),
    falModel: env("FAL_IMAGE_MODEL", "fal-ai/flux-2"),
    comfyEndpoint: env("COMFYUI_ENDPOINT"),
  },
  video: {
    provider: env("VIDEO_PROVIDER", "local"),
    falKey: env("FAL_API_KEY"),
    falModel: env("FAL_VIDEO_MODEL", "fal-ai/pixverse/v4.5/image-to-video"),
  },
  tts: {
    provider: env("TTS_PROVIDER", "local"),
    elevenKey: env("ELEVENLABS_API_KEY"),
    elevenVoice: env("ELEVENLABS_VOICE_ID"),
    kokoroEndpoint: env("KOKORO_ENDPOINT"),
  },
  music: {
    provider: env("MUSIC_PROVIDER", "local"),
    sunoKey: env("SUNO_API_KEY"),
  },
  publish: {
    provider: env("PUBLISH_PROVIDER", "mock"),
    clientId: env("YOUTUBE_CLIENT_ID"),
    clientSecret: env("YOUTUBE_CLIENT_SECRET"),
    refreshToken: env("YOUTUBE_REFRESH_TOKEN"),
    privacy: env("YOUTUBE_PRIVACY", "unlisted"),
  },
  requireApproval: bool("REQUIRE_APPROVAL", false),
  outputDir: env("OUTPUT_DIR", "./out"),
  width: num("VIDEO_WIDTH", 1920),
  height: num("VIDEO_HEIGHT", 1080),
  fps: 30,
};

export type Config = typeof config;
