#!/usr/bin/env bun
/**
 * scripts/cost-report.ts
 *
 * Queries the D1 costs table via wrangler and prints a formatted cost report.
 *
 * Usage:
 *   bun run scripts/cost-report.ts
 *   make cost-report
 */

import { execSync } from "node:child_process";

const DB_NAME = "bible-videos-series-memory";

function wranglerQuery(sql: string): unknown[] {
  try {
    const out = execSync(
      `cd "${import.meta.dir}/.." && npx wrangler d1 execute ${DB_NAME} --command "${sql.replace(/"/g, '\\"')}" --remote --json`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const parsed = JSON.parse(out) as Array<{ results?: unknown[] }>;
    return parsed[0]?.results ?? [];
  } catch {
    return [];
  }
}

function pad(s: string, n: number, right = false): string {
  const str = String(s ?? "");
  if (right) return str.slice(0, n).padEnd(n);
  return str.slice(0, n).padStart(n);
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

// ── 1. Monthly totals ─────────────────────────────────────────────────────────
console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║           Bible Videos for Kids — Cost Report           ║");
console.log("╚══════════════════════════════════════════════════════════╝\n");

console.log("── Monthly Totals ──────────────────────────────────────────");
const monthly = wranglerQuery(
  "SELECT strftime('%Y-%m', datetime(recorded_at,'unixepoch')) as month, SUM(total_usd) as total FROM costs GROUP BY month ORDER BY month DESC LIMIT 12",
) as Array<{ month: string; total: number }>;

if (monthly.length === 0) {
  console.log("  (no data)\n");
} else {
  console.log(`  ${"Month".padEnd(10)}  ${"Total".padStart(10)}`);
  console.log(`  ${"─".repeat(10)}  ${"─".repeat(10)}`);
  for (const row of monthly) {
    console.log(`  ${pad(row.month, 10, true)}  ${pad(usd(row.total), 10)}`);
  }
  const grandTotal = monthly.reduce((s, r) => s + r.total, 0);
  console.log(`  ${"─".repeat(10)}  ${"─".repeat(10)}`);
  console.log(`  ${"TOTAL".padEnd(10)}  ${pad(usd(grandTotal), 10)}`);
  console.log();
}

// ── 2. Provider breakdown ─────────────────────────────────────────────────────
console.log("── Provider Breakdown ──────────────────────────────────────");
const providers = wranglerQuery(
  "SELECT provider, SUM(total_usd) as total, SUM(units) as units, unit_type FROM costs GROUP BY provider ORDER BY total DESC",
) as Array<{ provider: string; total: number; units: number; unit_type: string }>;

if (providers.length === 0) {
  console.log("  (no data)\n");
} else {
  console.log(
    `  ${"Provider".padEnd(16)}  ${"Total".padStart(10)}  ${"Units".padStart(12)}  Type`,
  );
  console.log(`  ${"─".repeat(16)}  ${"─".repeat(10)}  ${"─".repeat(12)}  ${"─".repeat(12)}`);
  for (const row of providers) {
    console.log(
      `  ${pad(row.provider, 16, true)}  ${pad(usd(row.total), 10)}  ${pad(String(Math.round(row.units)), 12)}  ${row.unit_type}`,
    );
  }
  console.log();
}

// ── 3. Per-episode costs (last 20) ────────────────────────────────────────────
console.log("── Recent Episodes (last 20) ───────────────────────────────");
const episodes = wranglerQuery(
  "SELECT c.episode_id, e.title, SUM(c.total_usd) as total, COUNT(*) as stages FROM costs c LEFT JOIN episodes e ON e.id = c.episode_id GROUP BY c.episode_id ORDER BY MAX(c.recorded_at) DESC LIMIT 20",
) as Array<{ episode_id: string; title: string | null; total: number; stages: number }>;

if (episodes.length === 0) {
  console.log("  (no data)\n");
} else {
  console.log(
    `  ${"Episode (truncated)".padEnd(36)}  ${"Total".padStart(9)}  Stages`,
  );
  console.log(`  ${"─".repeat(36)}  ${"─".repeat(9)}  ${"─".repeat(6)}`);
  for (const row of episodes) {
    const label = (row.title ?? row.episode_id).slice(0, 34);
    console.log(
      `  ${pad(label, 36, true)}  ${pad(usd(row.total), 9)}  ${row.stages}`,
    );
  }
  console.log();
}

console.log("Run 'make cost-report' to refresh.\n");
