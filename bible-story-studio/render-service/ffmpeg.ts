import { spawn } from "node:child_process";

/** Run a command, rejecting on non-zero exit. */
export function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

export const ffmpeg = (args: string[]) =>
  run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);

/** Return media duration in seconds via ffprobe. */
export function probeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", () => {
      const v = parseFloat(out.trim());
      resolve(Number.isFinite(v) ? v : 4);
    });
  });
}

/** Wrap caption into lines of at most `max` chars for ffmpeg textfile. */
export function wrap(text: string, max = 48): string {
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
