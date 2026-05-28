import { readFileSync, writeFileSync } from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";
import { ffmpeg } from "../providers/ffmpeg.js";
import type { Storage } from "../storage.js";
import type { Story } from "../types.js";

/**
 * Local "animation": a smooth Ken-Burns pan/zoom over each keyframe, alternating
 * direction per scene. This stands in for a real image-to-video model (PixVerse
 * V4.5 for cartoon style, Kling 3.0, or self-hosted Wan 2.7) and produces a
 * genuine animated clip per scene with no API key.
 */
async function animateLocal(image: string, seconds: number, idx: number, out: string): Promise<void> {
  const { width: w, height: h, fps } = config;
  const frames = Math.max(1, Math.ceil(seconds * fps));
  const zoom = `min(zoom+0.0012,1.18)`;
  // Alternate slow pan direction for visual variety across scenes.
  const x = idx % 2 === 0 ? `iw/2-(iw/zoom/2)+(iw*0.04*on/${frames})` : `iw/2-(iw/zoom/2)-(iw*0.04*on/${frames})`;
  const y = idx % 3 === 0 ? `ih/2-(ih/zoom/2)+(ih*0.03*on/${frames})` : `ih/2-(ih/zoom/2)`;
  const filter = [
    `scale=${w * 2}:${h * 2}`,
    `zoompan=z='${zoom}':d=${frames}:x='${x}':y='${y}':s=${w}x${h}:fps=${fps}`,
    "format=yuv420p",
  ].join(",");
  await ffmpeg([
    "-loop", "1", "-i", image,
    "-t", seconds.toFixed(2),
    "-vf", filter,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p", "-r", String(fps),
    out,
  ]);
}

async function animateFal(image: string, seconds: number, out: string): Promise<void> {
  const dataUri = `data:image/png;base64,${readFileSync(image).toString("base64")}`;
  const res = await fetch(`https://fal.run/${config.video.falModel}`, {
    method: "POST",
    headers: { Authorization: `Key ${config.video.falKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      image_url: dataUri,
      prompt: "gentle cute cartoon motion, subtle camera move, friendly",
      duration: Math.min(8, Math.round(seconds)),
    }),
  });
  if (!res.ok) throw new Error(`fal video ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { video?: { url: string } };
  const url = data.video?.url;
  if (!url) throw new Error("fal returned no video");
  writeFileSync(out, Buffer.from(await (await fetch(url)).arrayBuffer()));
}

export async function animateScenes(
  story: Story,
  images: string[],
  durations: number[],
  storage: Storage,
): Promise<string[]> {
  log.stage(`5/9  Animation  (image→video: ${config.video.provider})`);
  const dir = storage.dir("clips");
  const clips: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const out = `${dir}/scene-${String(i).padStart(2, "0")}.mp4`;
    const dur = durations[i] ?? 5;
    if (config.video.provider === "fal" && config.video.falKey) {
      try {
        await animateFal(images[i]!, dur, out);
      } catch (e) {
        log.warn(`fal animation failed (${(e as Error).message}); using local Ken-Burns.`);
        await animateLocal(images[i]!, dur, i, out);
      }
    } else {
      await animateLocal(images[i]!, dur, i, out);
    }
    clips.push(out);
    log.info(`scene ${i + 1}/${images.length} → ${dur.toFixed(1)}s clip`);
  }
  log.ok(`Animated ${clips.length} scenes.`);
  return clips;
}
