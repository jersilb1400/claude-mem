export interface Episode {
  id: string;
  title: string;
  source: string | null;
  lesson: string | null;
  topic: string | null;
  status: "assembled" | "awaiting_approval" | "published" | "failed";
  youtube_id: string | null;
  youtube_url: string | null;
  youtube_privacy: "unlisted" | "public" | null;
  episode_mp4_key: string | null;
  thumbnail_key: string | null;
  created_at: number;
  published_at: number | null;
}

export interface Topic {
  topic: string;
  priority: number;
  used: number;
  used_at: number | null;
}

export interface CostEntry {
  id: number;
  episode_id: string;
  stage: string;
  provider: string;
  units: number;
  unit_type: string;
  rate_usd: number;
  total_usd: number;
  recorded_at: number;
}

export interface CostSummary {
  total: number;
  month: string;
}

export interface QueueStats {
  remaining: number;
  total: number;
}

export interface HealthStatus {
  status: string;
  service: string;
  ts: string;
}

export interface Character {
  id: string;
  name: string;
  description: string;
  palette_skin: string;
  palette_hair: string;
  palette_robe: string;
  reference_sheet_key: string | null;
  created_at: number;
}

export interface AnalyticsRow {
  episode_id: string;
  youtube_id: string;
  title: string;
  views: number;
  likes: number;
  comments: number;
  fetched_at: number;
}
