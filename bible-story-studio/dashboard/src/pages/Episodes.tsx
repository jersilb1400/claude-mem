import { useState, useEffect, useCallback } from "react";
import { fetchEpisodes, approveEpisode, retryEpisode, thumbnailUrl } from "../api.js";
import type { Episode } from "../types.js";

const STATUS_COLORS: Record<string, string> = {
  published: "bg-green-700 text-green-100",
  awaiting_approval: "bg-yellow-600 text-yellow-100",
  assembled: "bg-blue-700 text-blue-100",
  failed: "bg-red-700 text-red-100",
};

const STATUS_LABELS: Record<string, string> = {
  published: "Published",
  awaiting_approval: "Awaiting Approval",
  assembled: "Assembled",
  failed: "Failed",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? "bg-gray-700 text-gray-100";
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {label}
    </span>
  );
}

function EpisodeCard({ episode, onApproved }: { episode: Episode; onApproved: () => void }) {
  const [approving, setApproving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workerUrl = localStorage.getItem("WORKER_URL") ?? "";
  const token = localStorage.getItem("RENDER_TOKEN") ?? "";
  const thumbSrc = thumbnailUrl(workerUrl, episode.id);

  async function handleApprove() {
    setApproving(true);
    setError(null);
    try {
      await approveEpisode(episode.id);
      onApproved();
    } catch (e) {
      setError(String(e));
    } finally {
      setApproving(false);
    }
  }

  async function handleRetry() {
    setRetrying(true);
    setError(null);
    try {
      await retryEpisode(workerUrl, token, episode.id);
      onApproved(); // refresh list
    } catch (e) {
      setError(String(e));
    } finally {
      setRetrying(false);
    }
  }

  const created = new Date(episode.created_at * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="rounded-xl bg-surface-800 shadow overflow-hidden">
      {/* Thumbnail */}
      <div className="relative w-full h-36 bg-surface-700">
        {!imgLoaded && (
          <div className="absolute inset-0 animate-pulse bg-surface-700 rounded-t-xl" />
        )}
        <img
          src={thumbSrc}
          alt={episode.title}
          loading="lazy"
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgLoaded(true)}
          className={`w-full h-full object-cover transition-opacity duration-300 ${imgLoaded ? "opacity-100" : "opacity-0"}`}
        />
      </div>

      <div className="p-4">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="truncate font-semibold text-sm">{episode.title}</p>
            {episode.source && (
              <p className="text-xs text-gray-400 mt-0.5">{episode.source}</p>
            )}
          </div>
          <StatusBadge status={episode.status} />
        </div>

        {episode.lesson && (
          <p className="mb-3 text-xs text-gray-400 line-clamp-2">{episode.lesson}</p>
        )}

        <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
          <span>{created}</span>

          <div className="flex gap-2">
            {episode.youtube_url && (
              <a
                href={episode.youtube_url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg bg-red-700 px-3 py-1 text-white hover:bg-red-600 font-medium"
              >
                YouTube ↗
              </a>
            )}
            {episode.status === "awaiting_approval" && (
              <button
                className="rounded-lg bg-indigo-600 px-3 py-1 text-white hover:bg-indigo-500 font-medium disabled:opacity-50"
                onClick={handleApprove}
                disabled={approving}
              >
                {approving ? "Publishing…" : "Approve"}
              </button>
            )}
            <button
              className="rounded-lg bg-surface-600 px-3 py-1 text-gray-300 hover:bg-surface-500 font-medium disabled:opacity-50"
              onClick={handleRetry}
              disabled={retrying}
              title="Re-trigger workflow for this episode"
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        </div>

        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}

export default function Episodes() {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchEpisodes();
      setEpisodes(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold">Episodes</h2>
        <button
          className="rounded-lg bg-surface-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-surface-600"
          onClick={load}
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        </div>
      )}

      {error && (
        <div className="rounded-xl bg-red-900/40 p-4 text-sm text-red-300">{error}</div>
      )}

      {!loading && !error && episodes.length === 0 && (
        <p className="py-12 text-center text-sm text-gray-500">No episodes yet.</p>
      )}

      <div className="space-y-3">
        {episodes.map((ep) => (
          <EpisodeCard key={ep.id} episode={ep} onApproved={load} />
        ))}
      </div>
    </div>
  );
}
