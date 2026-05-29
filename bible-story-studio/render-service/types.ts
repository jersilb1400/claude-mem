export interface StoryScene {
  narration: string;
  visual: string;
  characters: string[];
  setting: string;
}

export interface StoryCharacter {
  name: string;
  description: string;
  palette: { skin: string; hair: string; robe: string };
}

export interface StoryOutput {
  title: string;
  source: string;
  lesson: string;
  characters: StoryCharacter[];
  scenes: StoryScene[];
}

export interface AssembleRequest {
  id: string;
  story: StoryOutput;
  /** R2 keys for animated .mp4 clips, one per scene */
  clipKeys: string[];
  /** R2 keys for narration audio files, one per scene */
  audioKeys: string[];
  /** R2 key for the music bed */
  musicKey: string;
  /** R2 keys for keyframe PNG images (thumbnail uses index 0) */
  imageKeys: string[];
  /** R2 bucket name */
  r2Bucket: string;
}

export interface AssembleResult {
  /** R2 key for the finished episode.mp4 */
  episodeKey: string;
  /** R2 key for thumbnail.jpg */
  thumbnailKey: string;
}
