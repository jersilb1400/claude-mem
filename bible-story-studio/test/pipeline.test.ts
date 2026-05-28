import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { test } from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { moderate } from "../src/moderation.js";
import { runPipeline } from "../src/pipeline.js";
import { renderSceneSvg } from "../src/providers/svgScene.js";
import { StorySchema, type Story } from "../src/types.js";

const SAMPLE: Story = {
  title: "Test",
  source: "Test 1",
  lesson: "be kind",
  characters: [{ name: "A", description: "kid", palette: { skin: "#eab", hair: "#321", robe: "#39f" } }],
  scenes: [
    { narration: "a happy day", visual: "a field", characters: ["A"], setting: "day" },
    { narration: "the sun set", visual: "sunset", characters: ["A"], setting: "sunrise" },
    { narration: "stars came out", visual: "night", characters: ["A"], setting: "night" },
  ],
};

test("story schema validates a well-formed story", () => {
  assert.doesNotThrow(() => StorySchema.parse(SAMPLE));
});

test("svg renderer emits valid rasterizable SVG with the title", () => {
  const svg = renderSceneSvg(SAMPLE.scenes[0]!, SAMPLE.characters, "My Title", 640, 360);
  assert.match(svg, /<svg/);
  assert.match(svg, /My Title/);
  const png = new Resvg(svg).render().asPng();
  assert.ok(png.length > 1000, "rasterized PNG should be non-trivial");
});

test("moderation blocks unsafe narration via keyword backstop", async () => {
  const bad: Story = { ...SAMPLE, scenes: [{ ...SAMPLE.scenes[0]!, narration: "he picked up a gun" }, SAMPLE.scenes[1]!, SAMPLE.scenes[2]!] };
  const r = await moderate(bad);
  assert.equal(r.safe, false);
});

test("full pipeline produces a playable mp4 offline (no keys)", async () => {
  const prod = await runPipeline({ topic: "Daniel and the Lions' Den", noPublish: true });
  assert.ok(prod.finalVideo && existsSync(prod.finalVideo), "episode.mp4 exists");
  assert.ok(prod.sceneClips.length >= 3, "has scene clips");
  assert.ok(prod.thumbnail && existsSync(prod.thumbnail), "thumbnail exists");
  rmSync(prod.finalVideo.replace(/\/episode\.mp4$/, ""), { recursive: true, force: true });
});
