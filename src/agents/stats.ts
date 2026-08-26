// ── Agent Telemetry & Analytics Store ─────────────────────────────────────────
// Manages durable persistence of agent execution records, benchmarks, and metrics.
// Persisted in ./.overseer/agent-stats.json decoupled from volatile state.json.

import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentExecutionRecord,
  AgentStatsStore,
  AgentAggregatedStats,
  RepoPolicyMode,
} from '../app/types.js';
import { prKeyToString } from '../app/types.js';

export const AGENT_STATS_FILE_NAME = 'agent-stats.json';
export const MAX_AGENT_EXECUTION_RECORDS = 200;

export function resolveAgentStatsPath(cwd: string = process.cwd()): string {
  return path.join(cwd, '.overseer', AGENT_STATS_FILE_NAME);
}

export function loadAgentStats(
  customPath?: string,
  cwd: string = process.cwd()
): AgentStatsStore {
  const filePath = customPath || resolveAgentStatsPath(cwd);
  if (!fs.existsSync(filePath)) {
    return { records: [] };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AgentStatsStore>;
    const rawRecords = Array.isArray(parsed?.records) ? parsed.records : [];
    const records: AgentExecutionRecord[] = rawRecords.filter((r): r is AgentExecutionRecord => {
      return Boolean(
        r &&
        typeof r === 'object' &&
        r.sessionId &&
        r.prKey &&
        typeof r.prKey.owner === 'string' &&
        typeof r.prKey.repo === 'string' &&
        typeof r.startedAt === 'string'
      );
    });
    return { records };
  } catch {
    return { records: [] };
  }
}

export function saveAgentStats(
  store: AgentStatsStore,
  customPath?: string,
  cwd: string = process.cwd()
): void {
  // Test isolation guard
  if (
    process.env.VITEST &&
    !customPath &&
    path.resolve(cwd) === path.resolve(process.cwd())
  ) {
    return;
  }

  const filePath = customPath || resolveAgentStatsPath(cwd);
  const dir = path.dirname(filePath);

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Ignore write errors
  }
}

export function recordAgentExecution(
  record: AgentExecutionRecord,
  customPath?: string,
  cwd: string = process.cwd()
): void {
  const store = loadAgentStats(customPath, cwd);
  // Add newest record at start
  store.records.unshift(record);

  // Keep rolling window capped at MAX_AGENT_EXECUTION_RECORDS
  if (store.records.length > MAX_AGENT_EXECUTION_RECORDS) {
    store.records = store.records.slice(0, MAX_AGENT_EXECUTION_RECORDS);
  }

  saveAgentStats(store, customPath, cwd);
}

export function resetAgentStats(cwd: string = process.cwd()): void {
  const filePath = resolveAgentStatsPath(cwd);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore
    }
  }
}

// ── Analytical Aggregations ──────────────────────────────────────────────────

export function calculateAgentStats(
  records: AgentExecutionRecord[],
  timeframeDays: number = 30,
  data?: {
    repoPolicies?: Record<string, { mode?: RepoPolicyMode }>;
    repoAgents?: Record<string, string>;
    settings?: { defaultAgent?: string };
  }
): AgentAggregatedStats {
  const cutoff = Date.now() - timeframeDays * 24 * 60 * 60 * 1000;
  const filtered = records.filter((r) => {
    if (!r || !r.startedAt) return false;
    const ts = new Date(r.startedAt).getTime();
    return !isNaN(ts) && ts >= cutoff;
  });

  const totalRuns = filtered.length;
  let successCount = 0;
  let totalDuration = 0;
  let dryRunsCount = 0;

  const byAgent: Record<
    string,
    {
      runs: number;
      successCount: number;
      failedCount: number;
      successRate: number;
      totalDuration: number;
      avgDurationMs: number;
      playbookCounts: Record<string, number>;
      topPlaybook?: string;
    }
  > = {};

  const byPlaybook: Record<
    string,
    {
      runs: number;
      successCount: number;
      failedCount: number;
      successRate: number;
      totalDuration: number;
      avgDurationMs: number;
      repoCounts: Record<string, number>;
      topRepo?: string;
    }
  > = {};

  const byRepo: Record<
    string,
    {
      runs: number;
      autoRuns: number;
      manualRuns: number;
      successCount: number;
      failedCount: number;
      successRate: number;
      totalDuration: number;
      mode: RepoPolicyMode;
      defaultAgent: string;
    }
  > = {};

  for (const r of filtered) {
    if (r.mode === 'dry-run' || r.status === 'dry-run') {
      dryRunsCount++;
    }

    const isSuccess = r.status === 'completed';
    if (isSuccess) successCount++;
    totalDuration += r.durationMs || 0;

    // 1. Group by Agent
    const agent = r.agentName || 'unknown';
    if (!byAgent[agent]) {
      byAgent[agent] = {
        runs: 0,
        successCount: 0,
        failedCount: 0,
        successRate: 0,
        totalDuration: 0,
        avgDurationMs: 0,
        playbookCounts: {},
      };
    }
    byAgent[agent].runs++;
    if (isSuccess) byAgent[agent].successCount++;
    else byAgent[agent].failedCount++;
    byAgent[agent].totalDuration = (byAgent[agent].totalDuration || 0) + (r.durationMs || 0);
    const pb = r.playbookName || 'custom';
    byAgent[agent].playbookCounts[pb] = (byAgent[agent].playbookCounts[pb] || 0) + 1;

    // 2. Group by Playbook
    if (!byPlaybook[pb]) {
      byPlaybook[pb] = {
        runs: 0,
        successCount: 0,
        failedCount: 0,
        successRate: 0,
        totalDuration: 0,
        avgDurationMs: 0,
        repoCounts: {},
      };
    }
    byPlaybook[pb].runs++;
    if (isSuccess) byPlaybook[pb].successCount++;
    else byPlaybook[pb].failedCount++;
    byPlaybook[pb].totalDuration = (byPlaybook[pb].totalDuration || 0) + (r.durationMs || 0);
    const repoSlug = r.prKey ? `${r.prKey.owner}/${r.prKey.repo}`.toLowerCase() : 'unknown';
    byPlaybook[pb].repoCounts[repoSlug] = (byPlaybook[pb].repoCounts[repoSlug] || 0) + 1;

    // 3. Group by Repo
    if (!byRepo[repoSlug]) {
      const livePolicy = data?.repoPolicies?.[repoSlug] || data?.repoPolicies?.['*'];
      const liveMode = livePolicy?.mode || (r.mode === 'dry-run' ? 'dry-run' : 'live');
      const liveAgent = data?.repoAgents?.[repoSlug] || data?.settings?.defaultAgent || agent;

      byRepo[repoSlug] = {
        runs: 0,
        autoRuns: 0,
        manualRuns: 0,
        successCount: 0,
        failedCount: 0,
        successRate: 0,
        totalDuration: 0,
        mode: liveMode,
        defaultAgent: liveAgent,
      };
    }
    byRepo[repoSlug].runs++;
    const trigger = typeof r.trigger === 'string' ? r.trigger : 'manual';
    if (trigger.startsWith('autonomous')) {
      byRepo[repoSlug].autoRuns++;
    } else {
      byRepo[repoSlug].manualRuns++;
    }
    if (isSuccess) byRepo[repoSlug].successCount++;
    else byRepo[repoSlug].failedCount++;
    byRepo[repoSlug].totalDuration += r.durationMs || 0;
  }

  // Calculate averages & top associations
  const finalByAgent: AgentAggregatedStats['byAgent'] = {};
  for (const [agent, stat] of Object.entries(byAgent)) {
    let topPb = '';
    let topPbCount = 0;
    for (const [pName, cnt] of Object.entries(stat.playbookCounts)) {
      if (cnt > topPbCount) {
        topPbCount = cnt;
        topPb = pName;
      }
    }
    finalByAgent[agent] = {
      runs: stat.runs,
      successCount: stat.successCount,
      failedCount: stat.failedCount,
      successRate: stat.runs > 0 ? (stat.successCount / stat.runs) * 100 : 0,
      avgDurationMs: stat.runs > 0 ? Math.round(stat.totalDuration / stat.runs) : 0,
      topPlaybook: topPb || undefined,
    };
  }

  const finalByPlaybook: AgentAggregatedStats['byPlaybook'] = {};
  for (const [pb, stat] of Object.entries(byPlaybook)) {
    let topR = '';
    let topRCount = 0;
    for (const [rSlug, cnt] of Object.entries(stat.repoCounts)) {
      if (cnt > topRCount) {
        topRCount = cnt;
        topR = rSlug;
      }
    }
    finalByPlaybook[pb] = {
      runs: stat.runs,
      successCount: stat.successCount,
      failedCount: stat.failedCount,
      successRate: stat.runs > 0 ? (stat.successCount / stat.runs) * 100 : 0,
      avgDurationMs: stat.runs > 0 ? Math.round(stat.totalDuration / stat.runs) : 0,
      topRepo: topR || undefined,
    };
  }

  const finalByRepo: AgentAggregatedStats['byRepo'] = {};
  for (const [repoSlug, stat] of Object.entries(byRepo)) {
    finalByRepo[repoSlug] = {
      runs: stat.runs,
      autoRuns: stat.autoRuns,
      manualRuns: stat.manualRuns,
      successCount: stat.successCount,
      failedCount: stat.failedCount,
      successRate: stat.runs > 0 ? (stat.successCount / stat.runs) * 100 : 0,
      mode: stat.mode,
      defaultAgent: stat.defaultAgent,
    };
  }

  const successRate = totalRuns > 0 ? (successCount / totalRuns) * 100 : 0;
  const avgDurationMs = totalRuns > 0 ? Math.round(totalDuration / totalRuns) : 0;

  return {
    totalRuns,
    successRate,
    avgDurationMs,
    dryRunsCount,
    byAgent: finalByAgent,
    byPlaybook: finalByPlaybook,
    byRepo: finalByRepo,
    recentAuditTrail: filtered.slice(0, 50),
  };
}
