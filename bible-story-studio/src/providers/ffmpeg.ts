import { spawn } from "node:child_process";

/** Run a command, rejecting on non-zero exit. Captures stderr for errors. */
export function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveP();
      else reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-1500)}`));
    });
  });
}

export const ffmpeg = (args: string[]) => run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);

/** Return media duration in seconds via ffprobe. */
export function probeDuration(file: string): Promise<number> {
  return new Promise((resolveP, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", () => {
      const v = parseFloat(out.trim());
      resolveP(Number.isFinite(v) ? v : 0);
    });
  });
}

/** Escape text for ffmpeg drawtext filter. */
export function drawtextEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "’")
    .replace(/%/g, "\\%")
    .replace(/\n/g, " ");
}

/** Wrap a caption into lines of at most `max` chars, escaped for drawtext. */
export function wrapCaption(text: string, max = 52): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines.map(drawtextEscape).join("\n");
}
