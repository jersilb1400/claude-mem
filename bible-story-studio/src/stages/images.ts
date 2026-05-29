import { writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { renderSceneSvg } from "../providers/svgScene.js";
import type { Storage } from "../storage.js";
import type { Story } from "../types.js";

/** Local: deterministic cute-cartoon SVG rasterised to PNG (no API key). */
function renderLocal(story: Story, storage: Storage): string[] {
  const dir = storage.dir("images");
  const out: string[] = [];
  for (let i = 0; i < story.scenes.length; i++) {
    const svg = renderSceneSvg(story.scenes[i]!, story.characters, story.title, config.width, config.height);
    const png = new Resvg(svg, { fitTo: { mode: "width", value: config.width } }).render().asPng();
    const file = `${dir}/scene-${String(i).padStart(2, "0")}.png`;
    writeFileSync(file, png);
    out.push(file);
  }
  return out;
}

/**
 * Build a consistency-locked prompt: the character's stable description is
 * appended to every scene so models (Flux 2 multi-ref / Nano Banana / PixVerse)
 * keep the same look across the whole episode.
 */
function scenePrompt(story: Story, idx: number): string {
  const scene = story.scenes[idx]!;
  const cast = story.characters
    .filter((c) => scene.characters.includes(c.name))
    .map((c) => `${c.name}: ${c.description}`)
    .join("; ");
  return `Cute flat-vector cartoon for preschoolers, soft pastel colors, friendly faces. ${scene.visual}. Characters — ${cast}. Setting: ${scene.setting}. No text.`;
}

async function renderFal(story: Story, storage: Storage): Promise<string[]> {
  const dir = storage.dir("images");
  const out: string[] = [];
  for (let i = 0; i < story.scenes.length; i++) {
    const res = await fetch(`https://fal.run/${config.image.falModel}`, {
      method: "POST",
      headers: { Authorization: `Key ${config.image.falKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: scenePrompt(story, i),
        image_size: { width: config.width, height: config.height },
      }),
    });
    if (!res.ok) throw new Error(`fal ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { images?: { url: string }[] };
    const url = data.images?.[0]?.url;
    if (!url) throw new Error("fal returned no image");
    const file = `${dir}/scene-${String(i).padStart(2, "0")}.png`;
    writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
    out.push(file);
  }
  return out;
}

export async function generateImages(story: Story, storage: Storage): Promise<string[]> {
  log.stage(`4/9  Keyframes  (image: ${config.image.provider})`);
  let files: string[];
  if (config.image.provider === "fal" && config.image.falKey) {
    try {
      files = await renderFal(story, storage);
    } catch (e) {
      log.warn(`fal image gen failed (${(e as Error).message}); using local renderer.`);
      files = renderLocal(story, storage);
    }
  } else {
    files = renderLocal(story, storage);
  }
  log.ok(`Rendered ${files.length} scene keyframes.`);
  return files;
}
