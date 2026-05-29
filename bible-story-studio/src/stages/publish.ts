import { writeFileSync } from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";
import { uploadToYouTube } from "../providers/youtube.js";
import type { Storage } from "../storage.js";
import type { VideoMetadata } from "../types.js";

/**
 * Publishes the finished episode. Defaults to "mock" which writes an upload
 * manifest so you can verify the whole pipeline without touching YouTube.
 * Set PUBLISH_PROVIDER=youtube (+ OAuth env) to upload for real.
 */
export async function publish(
  videoPath: string,
  thumbnail: string,
  meta: VideoMetadata,
  storage: Storage,
): Promise<{ id: string; url: string; status: string }> {
  log.stage(`Publish  (provider: ${config.publish.provider}, privacy: ${config.publish.privacy})`);

  if (config.publish.provider === "youtube" && config.publish.refreshToken) {
    const result = await uploadToYouTube(videoPath, meta, config.publish.privacy);
    log.ok(`Uploaded to YouTube: ${result.url} (${result.status})`);
    log.info("Thumbnail set step: call thumbnails.set with the returned video id.");
    return result;
  }

  const manifest = {
    provider: "mock",
    note: "Set PUBLISH_PROVIDER=youtube with OAuth env vars to upload for real.",
    video: videoPath,
    thumbnail,
    privacy: config.publish.privacy,
    metadata: meta,
    createdAt: new Date().toISOString(),
  };
  const file = storage.path("upload-manifest.json");
  writeFileSync(file, JSON.stringify(manifest, null, 2));
  log.ok(`Mock publish — manifest written: ${file}`);
  return { id: "mock", url: file, status: "mock" };
}
