import { config } from "./config.js";
import { log } from "./logger.js";
import { chat } from "./providers/openrouter.js";
import type { Story } from "./types.js";

const BANNED = ["kill", "blood", "gore", "hell", "demon", "sexy", "violence", "weapon", "gun", "drug"];

/**
 * Child-safety gate. Kids content is held to a high bar (and YouTube's "Made
 * for Kids" rules), so we check the full narration before spending money on
 * rendering. Uses an LLM classifier when available, with a keyword backstop.
 */
export async function moderate(story: Story): Promise<{ safe: boolean; reason: string }> {
  log.stage("2/9  Safety check  (kids content gate)");
  const text = story.scenes.map((s) => s.narration).join(" ").toLowerCase();

  const hit = BANNED.find((w) => text.includes(w));
  if (hit) {
    log.warn(`Keyword backstop flagged: "${hit}"`);
    return { safe: false, reason: `Contains sensitive word: ${hit}` };
  }

  if (config.llm.apiKey) {
    try {
      const raw = await chat({
        model: config.llm.utilityModel,
        temperature: 0,
        json: true,
        system: "You are a strict content-safety reviewer for a preschool Bible channel.",
        user: `Is the following narration safe and appropriate for ages 3-8? Reply JSON {"safe":bool,"reason":string}.\n\n${text}`,
      });
      const v = JSON.parse(raw) as { safe: boolean; reason: string };
      log.ok(v.safe ? "Passed LLM safety review." : `Blocked: ${v.reason}`);
      return v;
    } catch (e) {
      log.warn(`LLM moderation unavailable (${(e as Error).message}); keyword check passed.`);
    }
  }
  log.ok("Passed keyword safety check (offline).");
  return { safe: true, reason: "ok" };
}
