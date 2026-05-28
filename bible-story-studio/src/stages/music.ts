import { config } from "../config.js";
import { log } from "../logger.js";
import { ffmpeg } from "../providers/ffmpeg.js";
import type { Storage } from "../storage.js";

/**
 * Local: a soft, gentle C-major pad bed generated with ffmpeg oscillators —
 * pleasant under narration and requires no API. Swap for Suno (or a licensed
 * royalty-free library) in production via MUSIC_PROVIDER=suno.
 */
async function padBed(seconds: number, out: string): Promise<void> {
  const d = seconds.toFixed(2);
  const notes = [261.63, 329.63, 392.0, 523.25]; // C4 E4 G4 C5
  const inputs = notes.flatMap((f) => ["-f", "lavfi", "-i", `sine=frequency=${f}:duration=${d}`]);
  const mix = `${notes.map((_, i) => `[${i}]`).join("")}amix=inputs=${notes.length}:normalize=0,` +
    `tremolo=f=0.25:d=0.4,highpass=f=120,lowpass=f=2200,volume=0.10,` +
    `afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, seconds - 2.5).toFixed(2)}:d=2.5`;
  await ffmpeg([...inputs, "-filter_complex", mix, "-c:a", "aac", "-b:a", "128k", out]);
}

export async function generateMusic(totalSeconds: number, storage: Storage): Promise<string> {
  log.stage(`6/9  Music  (provider: ${config.music.provider})`);
  const out = `${storage.dir("audio")}/music.m4a`;
  // Suno integration point: poll its async API, then download to `out`.
  await padBed(totalSeconds + 1, out);
  log.ok(`Music bed: ${(totalSeconds).toFixed(1)}s.`);
  return out;
}
