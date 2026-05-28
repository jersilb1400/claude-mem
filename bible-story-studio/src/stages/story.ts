import { config } from "../config.js";
import { log } from "../logger.js";
import { chat, parseJson } from "../providers/openrouter.js";
import { StorySchema, type Story } from "../types.js";

const SYSTEM = `You are a warm, gentle children's Bible storyteller writing for kids aged 3-8.
You write faithful, age-appropriate retellings that are joyful, never scary, and end with a kind lesson.
You always return STRICT JSON matching the requested schema and nothing else.`;

function userPrompt(topic: string): string {
  return `Write a short animated episode based on this Bible story/topic: "${topic}".

Return a JSON object with EXACTLY this shape:
{
  "title": "catchy kid-friendly title (max 70 chars)",
  "source": "the Bible book/passage, e.g. 'Daniel 6'",
  "lesson": "one gentle sentence moral for parents",
  "characters": [
    { "name": "Name", "description": "stable look used in every scene",
      "palette": { "skin": "#hex", "hair": "#hex", "robe": "#hex" } }
  ],
  "scenes": [
    { "narration": "1-2 short sentences, simple words",
      "visual": "what we see, cartoon style",
      "characters": ["names present"],
      "setting": "one of: day|night|sunrise|indoor|water|desert" }
  ]
}

Rules: 5 to 7 scenes. 1-3 named characters reused across scenes. Keep narration short (a young child listens).`;
}

/** Deterministic offline story so the pipeline runs with no API key. */
function fallbackStory(topic: string): Story {
  return {
    title: "Daniel and the Lions' Den",
    source: "Daniel 6",
    lesson: "When we trust God and keep praying, He stays close and keeps us brave.",
    characters: [
      { name: "Daniel", description: "kind young man with a blue robe and tidy dark hair", palette: { skin: "#e8b48a", hair: "#3b2a20", robe: "#3f6fb5" } },
      { name: "King Darius", description: "gentle king with a golden crown and purple robe", palette: { skin: "#e0a878", hair: "#6b6b6b", robe: "#7b4fa0" } },
    ],
    scenes: [
      { narration: "Daniel loved God, and every day he prayed by his window.", visual: "Daniel kneeling by an open window, praying happily", characters: ["Daniel"], setting: "day" },
      { narration: "But some men made a tricky rule: pray only to the king!", visual: "King Darius on his throne signing a scroll", characters: ["King Darius"], setting: "indoor" },
      { narration: "Daniel still prayed to God, just like always.", visual: "Daniel praying calmly while others peek through the door", characters: ["Daniel"], setting: "indoor" },
      { narration: "So Daniel was put into a den of lions for the night.", visual: "Daniel standing peacefully among friendly-looking lions in the dark", characters: ["Daniel"], setting: "night" },
      { narration: "But God sent an angel, and the lions did not hurt him.", visual: "A soft glowing light over Daniel as the lions sleep", characters: ["Daniel"], setting: "night" },
      { narration: "In the morning the king was so happy Daniel was safe!", visual: "King Darius helping Daniel out as the sun rises", characters: ["Daniel", "King Darius"], setting: "sunrise" },
      { narration: "And everyone learned to love and trust God too.", visual: "Daniel and the king smiling together under a bright sky", characters: ["Daniel", "King Darius"], setting: "day" },
    ],
  };
}

export async function generateStory(topic: string): Promise<Story> {
  log.stage("1/9  Story  (LLM via OpenRouter)");
  if (!config.llm.apiKey) {
    log.warn("OPENROUTER_API_KEY missing — using built-in offline story.");
    const s = fallbackStory(topic);
    log.ok(`Story: "${s.title}" (${s.scenes.length} scenes, offline)`);
    return s;
  }
  log.info(`Model: ${config.llm.model}`);
  const raw = await chat({ system: SYSTEM, user: userPrompt(topic), json: true });
  const story = StorySchema.parse(parseJson(raw));
  log.ok(`Story: "${story.title}" (${story.scenes.length} scenes)`);
  return story;
}
