import { config } from "../config.js";
import { log } from "../logger.js";
import { chat, parseJson } from "../providers/openrouter.js";
import type { Story, VideoMetadata } from "../types.js";

function fallback(story: Story): VideoMetadata {
  const base = `${story.title} | Bible Stories for Kids`;
  return {
    title: base.slice(0, 100),
    description:
      `${story.title} — a gentle animated Bible story for children, based on ${story.source}.\n\n` +
      `${story.lesson}\n\n` +
      `Perfect for preschool, Sunday school, and bedtime. New stories every week!\n\n` +
      `#BibleStories #KidsBible #SundaySchool #ChristianKids`,
    tags: ["bible stories for kids", "children's bible", story.source.toLowerCase(), "sunday school", "christian kids", "bedtime bible stories", "animated bible"],
  };
}

/** SEO title/description/tags. Uses the cheaper utility model when available. */
export async function generateMetadata(story: Story): Promise<VideoMetadata> {
  log.stage("9/9  Metadata  (SEO)");
  if (!config.llm.apiKey) {
    log.warn("No OPENROUTER_API_KEY — using template metadata.");
    return fallback(story);
  }
  try {
    const raw = await chat({
      model: config.llm.utilityModel,
      temperature: 0.6,
      json: true,
      system: "You write YouTube SEO for a wholesome preschool Bible-stories channel. Return strict JSON.",
      user:
        `Story: "${story.title}" (based on ${story.source}). Lesson: ${story.lesson}.\n` +
        `Return JSON {"title": "<=100 chars, catchy, kid+parent friendly", "description":"3 short paragraphs + hashtags", "tags":["8-12 search tags"]}.`,
    });
    const m = parseJson<VideoMetadata>(raw);
    log.ok(`Metadata: "${m.title}"`);
    return m;
  } catch (e) {
    log.warn(`Metadata LLM failed (${(e as Error).message}); using template.`);
    return fallback(story);
  }
}
