import { z } from "zod";

/**
 * A single beat of the story. One scene == one cartoon keyframe that gets
 * animated into a short clip with its own narration line.
 */
export const SceneSchema = z.object({
  /** Narration spoken over this scene (kept short and child-friendly). */
  narration: z.string().min(1),
  /** Visual prompt for the image/animation model. */
  visual: z.string().min(1),
  /** Which named characters appear, for reference-sheet consistency. */
  characters: z.array(z.string()).default([]),
  /** Background mood, used by the local renderer and as a model hint. */
  setting: z.enum(["day", "night", "sunrise", "indoor", "water", "desert"]).default("day"),
});
export type Scene = z.infer<typeof SceneSchema>;

export const CharacterSchema = z.object({
  name: z.string(),
  /** Stable visual description reused on every scene for consistency. */
  description: z.string(),
  /** Hex palette the local renderer uses; also fed to image models. */
  palette: z.object({ skin: z.string(), hair: z.string(), robe: z.string() }),
});
export type Character = z.infer<typeof CharacterSchema>;

export const StorySchema = z.object({
  title: z.string(),
  /** The Bible passage / theme this episode is based on. */
  source: z.string(),
  /** One-line moral for the parents in the description. */
  lesson: z.string(),
  characters: z.array(CharacterSchema).min(1),
  scenes: z.array(SceneSchema).min(3),
});
export type Story = z.infer<typeof StorySchema>;

export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
}

/** Artifact bundle threaded through the pipeline stages. */
export interface Production {
  id: string;
  story: Story;
  /** Absolute paths to per-scene rendered images. */
  sceneImages: string[];
  /** Absolute paths to per-scene animated clips. */
  sceneClips: string[];
  narrationAudio?: string;
  musicAudio?: string;
  finalVideo?: string;
  thumbnail?: string;
  metadata?: VideoMetadata;
  /** Estimated seconds per scene, used to size animation + audio. */
  sceneDurations: number[];
  publishResult?: { id: string; url: string; status: string };
}
