import { writeFileSync } from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";
import { ffmpeg } from "../providers/ffmpeg.js";
import type { Storage } from "../storage.js";
import type { Story } from "../types.js";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf";

/** Wrap caption text into lines (raw — written to a textfile, no escaping). */
function wrap(text: string, max = 48): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) {
      if (cur) lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

/**
 * Composites the final episode:
 *   per scene → burn captions + attach narration → concat → mix music bed.
 */
export async function assembleVideo(
  story: Story,
  clips: string[],
  narration: string[],
  durations: number[],
  music: string,
  storage: Storage,
): Promise<string> {
  log.stage("7/9  Assembly  (captions + audio mux, ffmpeg)");
  const segDir = storage.dir("segments");
  const capDir = storage.dir("captions");
  const fontSize = Math.round(config.height * 0.042);
  const segments: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const dur = (durations[i] ?? 5).toFixed(2);
    const capFile = `${capDir}/scene-${String(i).padStart(2, "0")}.txt`;
    writeFileSync(capFile, wrap(story.scenes[i]!.narration));
    const drawtext =
      `drawtext=fontfile=${FONT}:textfile=${capFile}:expansion=none:` +
      `fontcolor=white:fontsize=${fontSize}:line_spacing=10:` +
      `box=1:boxcolor=0x000000A0:boxborderw=26:` +
      `x=(w-text_w)/2:y=h-text_h-(h*0.07)`;
    const seg = `${segDir}/seg-${String(i).padStart(2, "0")}.mp4`;
    await ffmpeg([
      "-i", clips[i]!,
      "-i", narration[i]!,
      "-filter_complex", `[0:v]${drawtext}[v];[1:a]apad[a]`,
      "-map", "[v]", "-map", "[a]",
      "-t", dur,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-r", String(config.fps),
      "-c:a", "aac", "-ar", "44100", "-ac", "2",
      seg,
    ]);
    segments.push(seg);
  }

  const listFile = storage.path("concat.txt");
  writeFileSync(listFile, segments.map((s) => `file '${s}'`).join("\n"));
  const joined = storage.path("joined.mp4");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", joined]);

  const final = storage.path("episode.mp4");
  await ffmpeg([
    "-i", joined,
    "-i", music,
    "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]",
    "-map", "0:v", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    final,
  ]);
  log.ok(`Final episode: ${final}`);
  return final;
}
