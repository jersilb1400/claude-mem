import { useState, useEffect, useCallback } from "react";
import { fetchQueue, fetchCostSummary } from "../api.js";
import type { CostSummary } from "../types.js";

interface HealthStatus {
  status: string;
  service: string;
  ts: string;
}

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl bg-surface-800 p-4">
      <p className="mb-1 text-xs text-gray-400">{label}</p>
      <p className={`text-2xl font-bold ${accent ?? "text-white"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

export default function Monitor() {
  const [queueRemaining, setQueueRemaining] = useState<number | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [costs, setCosts] = useState<CostSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const workerUrl = localStorage.getItem("WORKER_URL") ?? "";
  const renderEndpoint = workerUrl; // Health check proxied through worker via /health would need render endpoint — use best-effort

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    await Promise.all([
      // Queue depth
      fetchQueue()
        .then((topics) => setQueueRemaining(topics.filter((t) => t.used === 0).length))
        .catch(() => {}),

      // Cost summary
      fetchCostSummary()
        .then(setCosts)
        .catch(() => {}),

      // Render health — call worker /health which is proxied (if not, show offline)
      fetch(`${workerUrl.replace(/\/$/, "")}/health`)
        .then(async (r) => {
          if (r.ok) {
            setHealth((await r.json()) as HealthStatus);
            setHealthError(null);
          } else {
            setHealthError(`HTTP ${r.status}`);
          }
        })
        .catch((e: unknown) => setHealthError(String(e))),
    ]);

    setLoading(false);
  }, [workerUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalAllTime = costs.reduce((n, c) => n + (c.total ?? 0), 0);
  const thisMonth = costs[0]?.total ?? 0;

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold">Monitor</h2>
        <button
          className="rounded-lg bg-surface-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-surface-600"
          onClick={load}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-xl bg-red-900/40 p-3 text-sm text-red-300">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Queue + health */}
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label="Queue remaining"
              value={queueRemaining ?? "—"}
              sub="unused topics"
              accent={
                queueRemaining != null && queueRemaining < 5
                  ? "text-yellow-400"
                  : "text-white"
              }
            />
            <StatCard
              label="Render service"
              value={healthError ? "Offline" : health ? "Online" : "—"}
              sub={health?.ts ? new Date(health.ts).toLocaleTimeString() : healthError ?? undefined}
              accent={healthError ? "text-red-400" : health ? "text-green-400" : "text-gray-400"}
            />
          </div>

          {/* Cost stats */}
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label="This month"
              value={`$${thisMonth.toFixed(2)}`}
              sub={costs[0]?.month ?? "no data"}
              accent="text-indigo-300"
            />
            <StatCard
              label="All-time total"
              value={`$${totalAllTime.toFixed(2)}`}
              sub={`${costs.length} month${costs.length !== 1 ? "s" : ""} of data`}
              accent="text-indigo-300"
            />
          </div>

          {/* Monthly cost table */}
          {costs.length > 0 && (
            <div className="rounded-xl bg-surface-800 p-4">
              <p className="mb-3 text-sm font-semibold text-gray-300">Monthly Cost History</p>
              <div className="space-y-2">
                {costs.map((c) => (
                  <div key={c.month} className="flex items-center justify-between text-sm">
                    <span className="text-gray-400">{c.month}</span>
                    <span className="font-semibold text-white">${c.total.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {costs.length === 0 && (
            <div className="rounded-xl bg-surface-800 p-6 text-center">
              <p className="text-sm text-gray-500">No cost data yet.</p>
              <p className="mt-1 text-xs text-gray-600">Costs are logged as episodes are produced.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
