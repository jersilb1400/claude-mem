import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg, probeDuration, wrap } from "./ffmpeg.js";
import { r2Download, r2Upload } from "./r2.js";
import type { AssembleRequest, AssembleResult } from "./types.js";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf";

export async function assembleEpisode(
  params: AssembleRequest & { tmpDir: string },
): Promise<AssembleResult> {
  const { id, story, clipKeys, audioKeys, musicKey, imageKeys, r2Bucket, tmpDir } = params;

  // ── 1. Download all R2 assets in parallel ────────────────────────────────
  const [clipFiles, audioFiles] = await Promise.all([
    Promise.all(
      clipKeys.map(async (key, i) => {
        const dest = join(tmpDir, `clip-${String(i).padStart(2, "0")}.mp4`);
        await r2Download(r2Bucket, key, dest);
        return dest;
      }),
    ),
    Promise.all(
      audioKeys.map(async (key, i) => {
        const dest = join(tmpDir, `audio-${String(i).padStart(2, "0")}.mp3`);
        await r2Download(r2Bucket, key, dest);
        return dest;
      }),
    ),
  ]);

  const musicFile = join(tmpDir, "music.mp3");
  await r2Download(r2Bucket, musicKey, musicFile);

  // ── 2. Per-scene: burn captions + mux narration ──────────────────────────
  const segDir = join(tmpDir, "segments");
  const capDir = join(tmpDir, "captions");
  mkdirSync(segDir, { recursive: true });
  mkdirSync(capDir, { recursive: true });

  const fontSize = Math.round(1080 * 0.042);
  const segments: string[] = [];

  for (let i = 0; i < clipFiles.length; i++) {
    const dur = await probeDuration(audioFiles[i]!);
    const capFile = join(capDir, `scene-${String(i).padStart(2, "0")}.txt`);
    writeFileSync(capFile, wrap(story.scenes[i]!.narration));

    const drawtext =
      `drawtext=fontfile=${FONT}:textfile=${capFile}:expansion=none:` +
      `fontcolor=white:fontsize=${fontSize}:line_spacing=10:` +
      `box=1:boxcolor=0x000000A0:boxborderw=26:` +
      `x=(w-text_w)/2:y=h-text_h-(h*0.07)`;

    const seg = join(segDir, `seg-${String(i).padStart(2, "0")}.mp4`);
    await ffmpeg([
      "-i", clipFiles[i]!,
      "-i", audioFiles[i]!,
      "-filter_complex", `[0:v]${drawtext}[v];[1:a]apad[a]`,
      "-map", "[v]", "-map", "[a]",
      "-t", dur.toFixed(2),
      "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-r", "30",
      "-c:a", "aac", "-ar", "44100", "-ac", "2",
      seg,
    ]);
    segments.push(seg);
  }

  // ── 3. Concatenate all segments ───────────────────────────────────────────
  const listFile = join(tmpDir, "concat.txt");
  writeFileSync(listFile, segments.map((s) => `file '${s}'`).join("\n"));
  const joinedFile = join(tmpDir, "joined.mp4");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", joinedFile]);

  // ── 4. Mix music bed under narration ─────────────────────────────────────
  const episodeFile = join(tmpDir, "episode.mp4");
  await ffmpeg([
    "-i", joinedFile,
    "-i", musicFile,
    "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]",
    "-map", "0:v", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    episodeFile,
  ]);

  // ── 5. Thumbnail — first keyframe + title overlay ────────────────────────
  const imageFile = join(tmpDir, "keyframe-0.png");
  await r2Download(r2Bucket, imageKeys[0]!, imageFile);

  const titleFile = join(tmpDir, "title.txt");
  const title =
    story.title.length > 28 ? story.title.replace(/\s+(\S+)$/, "\n$1") : story.title;
  writeFileSync(titleFile, title);

  const thumbnailFile = join(tmpDir, "thumbnail.jpg");
  await ffmpeg([
    "-i", imageFile,
    "-vf",
    `scale=1280:720,drawtext=fontfile=${FONT}:textfile=${titleFile}:expansion=none:` +
      `fontcolor=white:fontsize=96:line_spacing=8:borderw=8:bordercolor=0x3a2f5b:` +
      `box=1:boxcolor=0xff7eb6AA:boxborderw=24:x=(w-text_w)/2:y=h*0.62`,
    "-frames:v", "1", "-q:v", "2",
    thumbnailFile,
  ]);

  // ── 6. Upload finished artifacts back to R2 ───────────────────────────────
  const episodeKey = `${id}/episode.mp4`;
  const thumbnailKey = `${id}/thumbnail.jpg`;
  await Promise.all([
    r2Upload(r2Bucket, episodeKey, episodeFile, "video/mp4"),
    r2Upload(r2Bucket, thumbnailKey, thumbnailFile, "image/jpeg"),
  ]);

  return { episodeKey, thumbnailKey };
}
