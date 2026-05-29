import { runPipeline } from "./pipeline.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd !== "run") {
    console.log(`Bible Story Studio

Usage:
  npm run run -- --topic "Noah's Ark"     Generate (and publish) one episode
  npm run run -- --no-publish             Generate but skip publishing

Env: copy .env.example to .env. With no keys it runs fully offline and
produces out/<id>/episode.mp4 plus an upload manifest.`);
    process.exit(cmd ? 1 : 0);
  }

  const topic = arg("topic") ?? "Daniel and the Lions' Den";
  const noPublish = process.argv.includes("--no-publish");
  try {
    await runPipeline({ topic, noPublish });
  } catch (e) {
    console.error(`\n✗ Pipeline failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
