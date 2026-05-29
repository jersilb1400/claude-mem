import { useState, useEffect } from "react";
import Episodes from "./pages/Episodes.js";
import Queue from "./pages/Queue.js";
import Monitor from "./pages/Monitor.js";
import Characters from "./pages/Characters.js";

type Tab = "episodes" | "queue" | "monitor" | "characters";

interface Settings {
  workerUrl: string;
  token: string;
}

function SettingsModal({ onSave }: { onSave: (s: Settings) => void }) {
  const [workerUrl, setWorkerUrl] = useState(localStorage.getItem("WORKER_URL") ?? "");
  const [token, setToken] = useState(localStorage.getItem("RENDER_TOKEN") ?? "");

  function save() {
    if (!workerUrl.trim()) return;
    localStorage.setItem("WORKER_URL", workerUrl.trim());
    localStorage.setItem("RENDER_TOKEN", token.trim());
    onSave({ workerUrl: workerUrl.trim(), token: token.trim() });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-surface-800 p-6 shadow-2xl">
        <h2 className="mb-1 text-xl font-bold">Connect to Worker</h2>
        <p className="mb-5 text-sm text-gray-400">Enter your Cloudflare Worker URL and token.</p>

        <label className="mb-4 block">
          <span className="mb-1 block text-sm font-medium text-gray-300">Worker URL</span>
          <input
            className="w-full rounded-lg bg-surface-700 px-3 py-2 text-sm placeholder-gray-500 outline-none ring-1 ring-surface-600 focus:ring-indigo-500"
            type="url"
            placeholder="https://bible-story-studio.xxx.workers.dev"
            value={workerUrl}
            onChange={(e) => setWorkerUrl(e.target.value)}
          />
        </label>

        <label className="mb-6 block">
          <span className="mb-1 block text-sm font-medium text-gray-300">Render Token</span>
          <input
            className="w-full rounded-lg bg-surface-700 px-3 py-2 text-sm placeholder-gray-500 outline-none ring-1 ring-surface-600 focus:ring-indigo-500"
            type="password"
            placeholder="your-secret-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>

        <button
          className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-40"
          disabled={!workerUrl.trim()}
          onClick={save}
        >
          Save & Connect
        </button>
      </div>
    </div>
  );
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "episodes", label: "Episodes", icon: "🎬" },
  { id: "queue", label: "Queue", icon: "📋" },
  { id: "monitor", label: "Monitor", icon: "📊" },
  { id: "characters", label: "Characters", icon: "👥" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("episodes");
  const [showSettings, setShowSettings] = useState(false);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    const hasUrl = !!localStorage.getItem("WORKER_URL");
    setConfigured(hasUrl);
    if (!hasUrl) setShowSettings(true);
  }, []);

  function handleSave(s: Settings) {
    setConfigured(!!s.workerUrl);
    setShowSettings(false);
  }

  return (
    <div className="flex min-h-screen flex-col">
      {showSettings && <SettingsModal onSave={handleSave} />}

      {/* Header */}
      <header className="flex items-center justify-between bg-surface-800 px-4 py-3 shadow">
        <h1 className="text-base font-bold tracking-tight">Bible Videos ✝</h1>
        <button
          className="rounded-lg bg-surface-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-surface-600"
          onClick={() => setShowSettings(true)}
        >
          Settings
        </button>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto pb-20">
        {!configured ? (
          <div className="flex h-48 items-center justify-center text-gray-500 text-sm">
            Configure your Worker URL to get started
          </div>
        ) : (
          <>
            {tab === "episodes" && <Episodes />}
            {tab === "queue" && <Queue />}
            {tab === "monitor" && <Monitor />}
            {tab === "characters" && <Characters />}
          </>
        )}
      </main>

      {/* Bottom tab bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-surface-700 bg-surface-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs transition-colors ${
              tab === t.id ? "text-indigo-400" : "text-gray-500 hover:text-gray-300"
            }`}
            onClick={() => setTab(t.id)}
          >
            <span className="text-lg leading-none">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
