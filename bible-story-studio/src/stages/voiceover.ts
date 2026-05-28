import { writeFileSync } from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";
import { ffmpeg, probeDuration } from "../providers/ffmpeg.js";
import type { Storage } from "../storage.js";
import type { Story } from "../types.js";

/** Estimate narration seconds from word count (kid-friendly slow pace). */
function estimate(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.min(9, Math.max(3.5, words / 2.1 + 1.2));
}

async function elevenLabs(text: string, out: string): Promise<void> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${config.tts.elevenVoice}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": config.tts.elevenKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

async function kokoro(text: string, out: string): Promise<void> {
  const res = await fetch(`${config.tts.kokoroEndpoint}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "kokoro", voice: "af_bella", input: text, response_format: "mp3" }),
  });
  if (!res.ok) throw new Error(`Kokoro ${res.status}: ${await res.text()}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

/** Offline: silent track sized to the estimate so timing/captions still work. */
async function silent(seconds: number, out: string): Promise<void> {
  await ffmpeg([
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-t", seconds.toFixed(2), "-c:a", "aac", out,
  ]);
}

/**
 * Produces one narration audio file per scene and returns the real per-scene
 * durations (probed from the audio) so animation + captions line up exactly.
 */
export async function generateVoiceover(
  story: Story,
  storage: Storage,
): Promise<{ files: string[]; durations: number[] }> {
  log.stage(`3/9  Voiceover  (TTS: ${config.tts.provider})`);
  const dir = storage.dir("audio");
  const files: string[] = [];
  const durations: number[] = [];

  for (let i = 0; i < story.scenes.length; i++) {
    const text = story.scenes[i]!.narration;
    const out = `${dir}/scene-${String(i).padStart(2, "0")}.${config.tts.provider === "local" ? "m4a" : "mp3"}`;
    const est = estimate(text);
    try {
      if (config.tts.provider === "elevenlabs" && config.tts.elevenKey) await elevenLabs(text, out);
      else if (config.tts.provider === "kokoro" && config.tts.kokoroEndpoint) await kokoro(text, out);
      else await silent(est, out);
    } catch (e) {
      log.warn(`TTS failed (${(e as Error).message}); using silent placeholder.`);
      await silent(est, out);
    }
    const dur = (await probeDuration(out)) || est;
    files.push(out);
    durations.push(Math.max(2.5, dur));
  }
  log.ok(`Rendered ${files.length} narration clips (${durations.reduce((a, b) => a + b, 0).toFixed(1)}s total).`);
  return { files, durations };
}
