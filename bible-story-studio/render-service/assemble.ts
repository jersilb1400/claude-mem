import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg, probeDuration, wrap } from "./ffmpeg.js";
import { r2Download, r2Upload } from "./r2.js";
import type { AssembleRequest, AssembleResult, CompilationRequest, CompilationResult } from "./types.js";

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

/**
 * Compilation Assembly — concatenates finished episode.mp4 files into one long video.
 * Used for weekly 30–40 min compilations targeting toddler/watch-time algorithm.
 */
export async function assembleCompilation(
  params: CompilationRequest & { tmpDir: string },
): Promise<CompilationResult> {
  const { id, episodeKeys, thumbnailKey, r2Bucket, tmpDir } = params;

  // ── 1. Download all episode MP4s in parallel ─────────────────────────────
  const episodeFiles = await Promise.all(
    episodeKeys.map(async (key, i) => {
      const dest = join(tmpDir, `ep-${String(i).padStart(2, "0")}.mp4`);
      await r2Download(r2Bucket, key, dest);
      return dest;
    }),
  );

  // ── 2. Concat all episodes ────────────────────────────────────────────────
  const listFile = join(tmpDir, "concat.txt");
  writeFileSync(listFile, episodeFiles.map((f: string) => `file '${f}'`).join("\n"));
  const compilationFile = join(tmpDir, "compilation.mp4");
  await ffmpeg([
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-c", "copy",
    "-movflags", "+faststart",
    compilationFile,
  ]);

  // ── 3. Upload to R2 ───────────────────────────────────────────────────────
  const episodeKey = `compilations/${id}/compilation.mp4`;
  await r2Upload(r2Bucket, episodeKey, compilationFile, "video/mp4");

  return { episodeKey, thumbnailKey };
}

/**
 * Feature 5: Shorts Assembly
 * Assembles a portrait (9:16, 1080×1920) video from up to 3 scenes.
 * Max output duration: 60s.
 */
export async function assembleShort(
  params: AssembleRequest & { tmpDir: string },
): Promise<AssembleResult> {
  const { id, story, clipKeys, audioKeys, musicKey, imageKeys, r2Bucket, tmpDir } = params;

  // Limit to first 3 scenes to stay under 60s
  const sceneCount = Math.min(3, clipKeys.length, audioKeys.length, story.scenes.length);
  const shortClipKeys = clipKeys.slice(0, sceneCount);
  const shortAudioKeys = audioKeys.slice(0, sceneCount);
  const shortScenes = story.scenes.slice(0, sceneCount);

  // ── 1. Download all R2 assets in parallel ────────────────────────────────
  const [clipFiles, audioFiles] = await Promise.all([
    Promise.all(
      shortClipKeys.map(async (key, i) => {
        const dest = join(tmpDir, `clip-${String(i).padStart(2, "0")}.mp4`);
        await r2Download(r2Bucket, key, dest);
        return dest;
      }),
    ),
    Promise.all(
      shortAudioKeys.map(async (key, i) => {
        const dest = join(tmpDir, `audio-${String(i).padStart(2, "0")}.mp3`);
        await r2Download(r2Bucket, key, dest);
        return dest;
      }),
    ),
  ]);

  const musicFile = join(tmpDir, "music.mp3");
  await r2Download(r2Bucket, musicKey, musicFile);

  // ── 2. Per-scene: scale to portrait, burn captions + mux narration ───────
  const segDir = join(tmpDir, "segments");
  const capDir = join(tmpDir, "captions");
  mkdirSync(segDir, { recursive: true });
  mkdirSync(capDir, { recursive: true });

  // Slightly smaller font for portrait (width is 1080, height 1920)
  const fontSize = Math.round(1080 * 0.038);
  const segments: string[] = [];

  for (let i = 0; i < clipFiles.length; i++) {
    const dur = await probeDuration(audioFiles[i]!);
    const capFile = join(capDir, `scene-${String(i).padStart(2, "0")}.txt`);
    writeFileSync(capFile, wrap(shortScenes[i]!.narration));

    // Portrait scale + crop filter
    const scaleFilter = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
    const drawtext =
      `drawtext=fontfile=${FONT}:textfile=${capFile}:expansion=none:` +
      `fontcolor=white:fontsize=${fontSize}:line_spacing=10:` +
      `box=1:boxcolor=0x000000A0:boxborderw=22:` +
      `x=(w-text_w)/2:y=h-text_h-(h*0.07)`;

    const seg = join(segDir, `seg-${String(i).padStart(2, "0")}.mp4`);
    await ffmpeg([
      "-i", clipFiles[i]!,
      "-i", audioFiles[i]!,
      "-filter_complex", `[0:v]${scaleFilter},${drawtext}[v];[1:a]apad[a]`,
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

  // ── 4. Mix music bed; cap at 60s ─────────────────────────────────────────
  const shortFile = join(tmpDir, "short.mp4");
  await ffmpeg([
    "-i", joinedFile,
    "-i", musicFile,
    "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]",
    "-map", "0:v", "-map", "[a]",
    "-t", "60",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    shortFile,
  ]);

  // ── 5. Portrait thumbnail (1080×1920) ─────────────────────────────────────
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
    `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
      `drawtext=fontfile=${FONT}:textfile=${titleFile}:expansion=none:` +
      `fontcolor=white:fontsize=72:line_spacing=8:borderw=6:bordercolor=0x3a2f5b:` +
      `box=1:boxcolor=0xff7eb6AA:boxborderw=20:x=(w-text_w)/2:y=h*0.7`,
    "-frames:v", "1", "-q:v", "2",
    thumbnailFile,
  ]);

  // ── 6. Upload finished artifacts back to R2 ───────────────────────────────
  const episodeKey = `${id}/short.mp4`;
  const thumbnailKey = `${id}/short-thumbnail.jpg`;
  await Promise.all([
    r2Upload(r2Bucket, episodeKey, shortFile, "video/mp4"),
    r2Upload(r2Bucket, thumbnailKey, thumbnailFile, "image/jpeg"),
  ]);

  return { episodeKey, thumbnailKey };
}
