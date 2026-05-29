import { useState, useEffect, useCallback } from "react";
import { fetchQueue, generateTopics, triggerRun } from "../api.js";
import type { Topic } from "../types.js";

function TopicRow({ topic }: { topic: Topic }) {
  const used = topic.used === 1;
  return (
    <div
      className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-sm ${
        used ? "bg-surface-700 opacity-50" : "bg-surface-800"
      }`}
    >
      <span className={`flex-1 truncate ${used ? "line-through text-gray-500" : "text-white"}`}>
        {topic.topic}
      </span>
      <div className="ml-3 flex shrink-0 items-center gap-2">
        <span className="rounded-full bg-surface-600 px-2 py-0.5 text-xs text-gray-400">
          p{topic.priority}
        </span>
        {used && (
          <span className="rounded-full bg-green-900 px-2 py-0.5 text-xs text-green-300">
            used
          </span>
        )}
      </div>
    </div>
  );
}

export default function Queue() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [customTopic, setCustomTopic] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchQueue();
      setTopics(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleGenerate() {
    setGenerating(true);
    setMessage(null);
    setError(null);
    try {
      const result = await generateTopics();
      setMessage(`Generated ${result.topics.length} new topics`);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function handleTrigger() {
    setTriggering(true);
    setMessage(null);
    setError(null);
    try {
      const result = await triggerRun(customTopic.trim() || undefined);
      setMessage(`Workflow started: ${result.instanceId.slice(0, 8)}…`);
      setCustomTopic("");
    } catch (e) {
      setError(String(e));
    } finally {
      setTriggering(false);
    }
  }

  const unused = topics.filter((t) => t.used === 0).length;
  const total = topics.length;

  return (
    <div className="p-4">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Topic Queue</h2>
          <p className="text-xs text-gray-400">
            {unused} unused / {total} total
          </p>
        </div>
        <button
          className="rounded-lg bg-surface-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-surface-600"
          onClick={load}
        >
          Refresh
        </button>
      </div>

      {/* Trigger section */}
      <div className="mb-4 rounded-xl bg-surface-800 p-4">
        <p className="mb-3 text-sm font-semibold text-gray-300">Trigger Episode</p>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-lg bg-surface-700 px-3 py-2 text-sm placeholder-gray-500 outline-none ring-1 ring-surface-600 focus:ring-indigo-500"
            type="text"
            placeholder="Optional custom topic…"
            value={customTopic}
            onChange={(e) => setCustomTopic(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleTrigger();
            }}
          />
          <button
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-40"
            onClick={handleTrigger}
            disabled={triggering}
          >
            {triggering ? "…" : "Run"}
          </button>
        </div>
      </div>

      {/* Auto-generate button */}
      <div className="mb-4">
        <button
          className="w-full rounded-xl bg-surface-800 py-3 text-sm font-semibold text-indigo-400 hover:bg-surface-700 disabled:opacity-40"
          onClick={handleGenerate}
          disabled={generating}
        >
          {generating ? "Generating…" : "Generate more topics (AI)"}
        </button>
      </div>

      {/* Status messages */}
      {message && (
        <div className="mb-3 rounded-lg bg-green-900/40 p-3 text-sm text-green-300">{message}</div>
      )}
      {error && (
        <div className="mb-3 rounded-lg bg-red-900/40 p-3 text-sm text-red-300">{error}</div>
      )}

      {/* Topic list */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        </div>
      ) : (
        <div className="space-y-1.5">
          {topics.map((t) => (
            <TopicRow key={t.topic} topic={t} />
          ))}
          {topics.length === 0 && (
            <p className="py-12 text-center text-sm text-gray-500">
              No topics yet. Click "Generate more topics" to add some.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
