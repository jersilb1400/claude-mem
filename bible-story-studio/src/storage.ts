import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";

/**
 * Local filesystem storage for a single production run.
 *
 * In production swap this for Cloudflare R2 (S3-compatible) — keep the same
 * `dir(name)` / `path(...)` shape and write through `@aws-sdk/client-s3` or the
 * Workers R2 binding. Stage code never needs to change.
 */
export class Storage {
  readonly root: string;

  constructor(readonly productionId: string) {
    this.root = resolve(process.cwd(), config.outputDir, productionId);
    mkdirSync(this.root, { recursive: true });
  }

  dir(name: string): string {
    const d = resolve(this.root, name);
    mkdirSync(d, { recursive: true });
    return d;
  }

  path(...parts: string[]): string {
    return resolve(this.root, ...parts);
  }
}
