import { readFileSync, statSync } from "node:fs";
import { config } from "../config.js";
import type { VideoMetadata } from "../types.js";

/**
 * YouTube Data API v3 resumable upload using only fetch + an OAuth refresh
 * token. No googleapis SDK so this also runs unchanged inside a Worker.
 *
 * One-time setup to obtain a refresh token:
 *   1. Create OAuth credentials (Desktop app) in Google Cloud Console.
 *   2. Enable the "YouTube Data API v3".
 *   3. Run the consent flow with scope
 *      https://www.googleapis.com/auth/youtube.upload and exchange the code
 *      for a refresh token (store it as YOUTUBE_REFRESH_TOKEN).
 */
async function accessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.publish.clientId,
      client_secret: config.publish.clientSecret,
      refresh_token: config.publish.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Token refresh ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export async function uploadToYouTube(
  videoPath: string,
  meta: VideoMetadata,
  privacy: string,
): Promise<{ id: string; url: string; status: string }> {
  const token = await accessToken();
  const size = statSync(videoPath).size;

  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Length": String(size),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: {
          title: meta.title.slice(0, 100),
          description: meta.description.slice(0, 4900),
          tags: meta.tags.slice(0, 30),
          categoryId: "24", // Entertainment
        },
        status: {
          privacyStatus: privacy,
          selfDeclaredMadeForKids: true,
        },
      }),
    },
  );
  if (!initRes.ok) throw new Error(`Init upload ${initRes.status}: ${await initRes.text()}`);
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("No resumable upload URL returned");

  const bytes = readFileSync(videoPath);
  const upRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(size) },
    body: bytes,
  });
  if (!upRes.ok) throw new Error(`Upload ${upRes.status}: ${await upRes.text()}`);
  const video = (await upRes.json()) as { id: string; status?: { uploadStatus?: string } };
  return {
    id: video.id,
    url: `https://youtu.be/${video.id}`,
    status: video.status?.uploadStatus ?? "uploaded",
  };
}
