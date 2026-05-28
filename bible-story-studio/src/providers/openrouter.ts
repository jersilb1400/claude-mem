import { config } from "../config.js";

interface ChatOpts {
  system: string;
  user: string;
  model?: string;
  /** Ask the model for a JSON object response. */
  json?: boolean;
  temperature?: number;
}

/**
 * Minimal OpenRouter chat client (OpenAI-compatible). No SDK dependency so the
 * project stays lean and easy to port into a Cloudflare Worker.
 */
export async function chat(opts: ChatOpts): Promise<string> {
  if (!config.llm.apiKey) throw new Error("OPENROUTER_API_KEY not set");
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.llm.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://bible-story-studio.local",
      "X-Title": "Bible Story Studio",
    },
    body: JSON.stringify({
      model: opts.model ?? config.llm.model,
      temperature: opts.temperature ?? 0.8,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned empty content");
  return content;
}

/** Pull the first JSON object out of a model response, tolerating fences. */
export function parseJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in model output");
  return JSON.parse(body.slice(start, end + 1)) as T;
}
