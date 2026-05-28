import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { log } from "./logger.js";
import { moderate } from "./moderation.js";
import { Storage } from "./storage.js";
import { animateScenes } from "./stages/animate.js";
import { assembleVideo } from "./stages/assemble.js";
import { generateImages } from "./stages/images.js";
import { generateMetadata } from "./stages/metadata.js";
import { generateMusic } from "./stages/music.js";
import { publish } from "./stages/publish.js";
import { generateStory } from "./stages/story.js";
import { generateThumbnail } from "./stages/thumbnail.js";
import { generateVoiceover } from "./stages/voiceover.js";
import type { Production } from "./types.js";

export interface PipelineOptions {
  topic: string;
  /** Skip the publish stage (still produces the final mp4 + manifest inputs). */
  noPublish?: boolean;
}

/**
 * The full autonomous episode pipeline. Every stage degrades to an offline
 * implementation when its provider key is absent, so this always runs.
 */
export async function runPipeline(opts: PipelineOptions): Promise<Production> {
  const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const storage = new Storage(id);
  log.info(`Production ${id} → ${storage.root}`);

  const story = await generateStory(opts.topic);

  const safety = await moderate(story);
  if (!safety.safe) throw new Error(`Content blocked by safety gate: ${safety.reason}`);

  const { files: narration, durations } = await generateVoiceover(story, storage);
  const images = await generateImages(story, storage);
  const clips = await animateScenes(story, images, durations, storage);
  const total = durations.reduce((a, b) => a + b, 0);
  const music = await generateMusic(total, storage);
  const finalVideo = await assembleVideo(story, clips, narration, durations, music, storage);
  const thumbnail = await generateThumbnail(story, images, storage);
  const metadata = await generateMetadata(story);

  const production: Production = {
    id, story, sceneImages: images, sceneClips: clips, narrationAudio: narration[0],
    musicAudio: music, finalVideo, thumbnail, metadata, sceneDurations: durations,
  };

  if (opts.noPublish) {
    log.warn("Publishing skipped (--no-publish).");
    return production;
  }
  if (config.requireApproval) {
    log.warn("REQUIRE_APPROVAL=true — stopping before publish for human review.");
    log.info(`Review the episode at: ${finalVideo}`);
    return production;
  }

  production.publishResult = await publish(finalVideo, thumbnail, metadata, storage);
  log.stage("Done");
  log.ok(`Episode "${metadata.title}"`);
  log.ok(`Video: ${finalVideo}`);
  log.ok(`Result: ${production.publishResult.url}`);
  return production;
}
