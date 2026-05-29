#!/usr/bin/env bun
/**
 * YouTube OAuth2 Refresh Token Helper
 *
 * Runs a local HTTP server, opens the OAuth2 consent screen, captures the
 * authorization code on redirect, exchanges it for tokens, and prints the
 * refresh_token to copy into Wrangler secrets.
 *
 * Prerequisites:
 *   1. Google Cloud Console → APIs & Services → Credentials
 *   2. Create OAuth 2.0 Client ID  →  Desktop app
 *   3. Enable "YouTube Data API v3" in the project
 *
 * Usage:
 *   YOUTUBE_CLIENT_ID=xxx YOUTUBE_CLIENT_SECRET=yyy bun run scripts/youtube-oauth.ts
 *   — or —
 *   make youtube-oauth  (sets vars from env)
 */

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("\nSet YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET before running.\n");
  process.exit(1);
}

const PORT = 8085;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
].join(" ");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPE);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");  // force refresh_token every time

console.log("\n══════════════════════════════════════════════════");
console.log("   YouTube OAuth2 — Refresh Token Generator     ");
console.log("══════════════════════════════════════════════════\n");
console.log("Open this URL in your browser:\n");
console.log(authUrl.toString());
console.log(`\nThis script is listening on http://localhost:${PORT}/callback`);
console.log("Waiting for authorization...\n");

const code = await new Promise<string>((resolve, reject) => {
  const server = Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          reject(new Error(`OAuth error: ${error}`));
          server.stop();
          return new Response(
            `<h2 style="font-family:sans-serif;color:red">Error: ${error}</h2>`,
            { headers: { "Content-Type": "text/html" } },
          );
        }

        if (code) {
          resolve(code);
          server.stop();
          return new Response(
            `<h2 style="font-family:sans-serif;color:green">✓ Authorized! You can close this tab.</h2>`,
            { headers: { "Content-Type": "text/html" } },
          );
        }
      }

      return new Response("Waiting for OAuth callback...");
    },
  });
});

// Exchange authorization code for tokens
const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  }),
});

const tokens = (await tokenRes.json()) as {
  refresh_token?: string;
  access_token?: string;
  error?: string;
  error_description?: string;
};

if (tokens.error || !tokens.refresh_token) {
  console.error("Token exchange failed:", tokens.error, tokens.error_description);
  process.exit(1);
}

console.log("\n══════════════════════════════════════════════════");
console.log("✅  Success! Your YouTube refresh token:\n");
console.log(tokens.refresh_token);
console.log("\nSave it with:");
console.log("  cd cloudflare && npx wrangler secret put YOUTUBE_REFRESH_TOKEN");
console.log("══════════════════════════════════════════════════\n");
