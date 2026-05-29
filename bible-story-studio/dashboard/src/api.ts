import type { Episode, Topic, CostEntry, CostSummary } from "./types.js";

function getConfig(): { workerUrl: string; token: string } {
  return {
    workerUrl: localStorage.getItem("WORKER_URL") ?? "",
    token: localStorage.getItem("RENDER_TOKEN") ?? "",
  };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { workerUrl, token } = getConfig();
  if (!workerUrl) throw new Error("WORKER_URL not configured");

  const url = `${workerUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export async function fetchEpisodes(): Promise<Episode[]> {
  return apiFetch<Episode[]>("/episodes");
}

export async function fetchEpisode(id: string): Promise<Episode> {
  return apiFetch<Episode>(`/status/${id}`);
}

export async function approveEpisode(id: string): Promise<{ id: string; url: string }> {
  return apiFetch<{ id: string; url: string }>(`/approve/${id}`, { method: "POST" });
}

export async function fetchQueue(): Promise<Topic[]> {
  return apiFetch<Topic[]>("/queue");
}

export async function generateTopics(): Promise<{ topics: string[] }> {
  return apiFetch<{ topics: string[] }>("/topics/generate", { method: "POST" });
}

export async function triggerRun(topic?: string): Promise<{ instanceId: string }> {
  return apiFetch<{ instanceId: string }>("/run", {
    method: "POST",
    body: JSON.stringify(topic ? { topic } : {}),
  });
}

export async function fetchCosts(episodeId: string): Promise<CostEntry[]> {
  return apiFetch<CostEntry[]>(`/costs/${episodeId}`);
}

export async function fetchCostSummary(): Promise<CostSummary[]> {
  return apiFetch<CostSummary[]>("/costs/summary");
}
