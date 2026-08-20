// ── State Store & Persistence ──────────────────────────────────────────────
// In-memory domain store with JSON serialization to ./.overseer/state.json.

import fs from 'node:fs';
import path from 'node:path';
import type {
  AppState,
  PrState,
  PrKey,
  WorkerHandle,
  PrOverallStatus,
  ReviewVerdict,
  CiStatus,
  AppSettings,
  AppExtensions,
  AgentDefinition,
  AgentsConfigFile,
  AppConfig,
  HistoricalPrRecord,
  HistoricalStatsStore,
  MemberBackfillWatermark,
} from './types.js';
import { prKeyToString } from './types.js';

export const LOCAL_OVERSEER_DIR = '.overseer';
export const STATE_FILE_NAME = 'state.json';
export const AGENTS_FILE_NAME = 'agents.json';
export const MAX_PR_LOG_ENTRIES = 200;

export function resolveStateDir(cwd: string = process.cwd()): string {
  const localDir = path.join(cwd, LOCAL_OVERSEER_DIR);
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }
  return localDir;
}

export function resolveStatePath(cwd: string = process.cwd()): string {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultAgent: 'claude',
  pollIntervalSecs: 30,
  worktreesDir: '.overseer/worktrees',
  filterUserOnly: true,
  searchQuery: '',
  dryRun: false,
  team: '',
  recentPrWindowDays: 7,
  teamActiveWindowDays: 30,
  teamPollIntervalSecs: 120,
};

export const DEFAULT_EXTENSIONS: AppExtensions = {
  streamdeck: {
    enabled: false,
    port: 3210,
  },
};

export function createEmptyState(
  options?: Partial<AppSettings>,
  extensions?: Partial<AppExtensions>
): AppState {
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...options,
  };
  const ext: AppExtensions = {
    streamdeck: {
      ...DEFAULT_EXTENSIONS.streamdeck,
      ...(extensions?.streamdeck || {}),
    },
  };

  return {
    settings,
    extensions: ext,
    repoAgents: {},
    customAgents: {},
    repos: [],
    prs: new Map<string, PrState>(),
    workers: new Map<string, WorkerHandle>(),
    viewScope: 'mine',
    historicalStats: { records: [] },
    dryRun: settings.dryRun,
    lastPolled: undefined,
  };
}

export function saveState(data: AppState, customPath?: string, cwd: string = process.cwd()): void {
  // Safety guard: Automated tests running in Vitest must never overwrite live project state in process.cwd()
  if (process.env.VITEST && !customPath && path.resolve(cwd) === path.resolve(process.cwd())) {
    return;
  }

  const filePath = customPath || resolveStatePath(cwd);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  pruneHistoricalStats(data, 90);

  const serializable = {
    settings: data.settings,
    extensions: data.extensions,
    repoAgents: data.repoAgents,
    customAgents: data.customAgents,
    repos: data.repos,
    prs: Object.fromEntries(data.prs.entries()),
    workers: Object.fromEntries(data.workers.entries()),
    viewScope: data.viewScope || 'mine',
    teamMembers: data.teamMembers || [],
    teamProfiles: data.teamProfiles || {},
    historicalStats: data.historicalStats || { records: [] },
    dryRun: data.dryRun || data.settings?.dryRun || false,
    lastPolled: data.lastPolled,
    currentUser: data.currentUser,
    rateLimitedUntil: data.rateLimitedUntil,
  };

  fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2), 'utf-8');
}

export function loadState(customPath?: string, cwd: string = process.cwd()): AppState | null {
  const filePath = customPath || resolveStatePath(cwd);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const parsedSettings = (parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}) as Partial<AppSettings>;
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...parsedSettings,
      dryRun: Boolean(parsedSettings.dryRun ?? parsed.dryRun ?? DEFAULT_SETTINGS.dryRun),
    };

    const parsedExt = (parsed.extensions && typeof parsed.extensions === 'object' ? parsed.extensions : {}) as Partial<AppExtensions>;
    const extensions: AppExtensions = {
      streamdeck: {
        ...DEFAULT_EXTENSIONS.streamdeck,
        ...(parsedExt.streamdeck || {}),
      },
    };

    const repoAgents: Record<string, string> = (parsed.repoAgents && typeof parsed.repoAgents === 'object')
      ? (parsed.repoAgents as Record<string, string>)
      : {};

    const customAgents: Record<string, AgentDefinition> = (parsed.customAgents && typeof parsed.customAgents === 'object')
      ? (parsed.customAgents as Record<string, AgentDefinition>)
      : {};

    const prs = new Map<string, PrState>();
    if (parsed.prs && typeof parsed.prs === 'object') {
      for (const [k, v] of Object.entries(parsed.prs as Record<string, PrState>)) {
        if (v && typeof v === 'object' && v.key) {
          prs.set(k, {
            ...v,
            log: Array.isArray(v.log) ? v.log : [],
            ciChecks: Array.isArray(v.ciChecks) ? v.ciChecks : [],
          });
        }
      }
    }

    const workers = new Map<string, WorkerHandle>();
    if (parsed.workers && typeof parsed.workers === 'object') {
      for (const [k, v] of Object.entries(parsed.workers as Record<string, WorkerHandle>)) {
        if (v && typeof v === 'object') {
          workers.set(k, v);
        }
      }
    }

    const viewScope = parsed.viewScope === 'team' ? 'team' : 'mine';
    const teamMembers = Array.isArray(parsed.teamMembers) ? parsed.teamMembers.filter((m) => typeof m === 'string') : undefined;
    const teamProfiles = parsed.teamProfiles && typeof parsed.teamProfiles === 'object'
      ? (parsed.teamProfiles as Record<string, { login: string; name?: string }>)
      : undefined;
    let historicalStats: HistoricalStatsStore = { records: [] };
    if (parsed.historicalStats && typeof parsed.historicalStats === 'object') {
      const histObj = parsed.historicalStats as Record<string, unknown>;
      const records = Array.isArray(histObj.records)
        ? (histObj.records as any[]).filter((r: any) => r && r.key && r.createdAt)
        : [];
      const memberWatermarks = (histObj.memberWatermarks && typeof histObj.memberWatermarks === 'object')
        ? (histObj.memberWatermarks as Record<string, MemberBackfillWatermark>)
        : undefined;
      historicalStats = {
        records,
        memberWatermarks,
      };
    }

    return {
      settings,
      extensions,
      repoAgents,
      customAgents,
      repos: Array.isArray(parsed.repos) ? parsed.repos : [],
      prs,
      workers,
      viewScope,
      teamMembers,
      teamProfiles,
      historicalStats,
      dryRun: settings.dryRun,
      lastPolled: typeof parsed.lastPolled === 'number' ? parsed.lastPolled : undefined,
      currentUser: typeof parsed.currentUser === 'string' ? parsed.currentUser : undefined,
      rateLimitedUntil: typeof parsed.rateLimitedUntil === 'number' ? parsed.rateLimitedUntil : undefined,
    };
  } catch {
    return null;
  }
}

// ── Historical Stats Recording ──────────────────────────────────────────────

export function recordHistoricalPr(data: AppState, pr: PrState): void {
  if (!data.historicalStats) {
    data.historicalStats = { records: [] };
  }

  const keyStr = prKeyToString(pr.key);
  const existingIdx = data.historicalStats.records.findIndex(
    (r) => prKeyToString(r.key) === keyStr
  );
  const existing = existingIdx >= 0 ? data.historicalStats.records[existingIdx] : undefined;

  // Guard against overwriting MERGED state with generic CLOSED if mergedAt was previously recorded
  const finalState = pr.state === 'OPEN'
    ? (existing?.state === 'MERGED' ? 'MERGED' : pr.state)
    : (pr.state === 'CLOSED' && existing?.state === 'MERGED' && !pr.closedAt && existing.mergedAt ? 'MERGED' : pr.state);

  const finalMergedAt = pr.mergedAt || (finalState === 'MERGED' ? existing?.mergedAt : undefined);
  const finalClosedAt = pr.closedAt || existing?.closedAt;

  const record: HistoricalPrRecord = {
    key: pr.key,
    author: pr.author,
    title: pr.title,
    createdAt: pr.createdAt,
    firstReviewAt: pr.firstReviewAt || existing?.firstReviewAt,
    mergedAt: finalMergedAt,
    closedAt: finalClosedAt,
    state: finalState,
    additions: pr.additions || existing?.additions || 0,
    deletions: pr.deletions || existing?.deletions || 0,
    changedFiles: pr.changedFiles || existing?.changedFiles || 0,
    commitsCount: pr.commitsCount || existing?.commitsCount || 1,
    commentsCount: pr.commentsCount || existing?.commentsCount || 0,
    unresolvedThreadsCount: pr.unresolvedThreadsCount || existing?.unresolvedThreadsCount || 0,
    ciStatus: pr.ciStatus || existing?.ciStatus || 'SUCCESS',
    scope: pr.scope || existing?.scope || 'mine',
  };

  if (existingIdx >= 0) {
    data.historicalStats.records[existingIdx] = record;
  } else {
    data.historicalStats.records.push(record);
  }

  pruneHistoricalStats(data, 90);
}

export function pruneHistoricalStats(data: AppState, maxDays: number = 90): number {
  if (!data.historicalStats?.records) return 0;
  const cutoffMs = Date.now() - maxDays * 24 * 60 * 60 * 1000;
  const originalCount = data.historicalStats.records.length;
  data.historicalStats.records = data.historicalStats.records.filter((r) => {
    const time = new Date(r.createdAt).getTime();
    return !isNaN(time) && time >= cutoffMs;
  });
  return originalCount - data.historicalStats.records.length;
}

// ── Agent & Repository Resolution Helpers ────────────────────────────────────

export function getRepoAgent(
  data: AppState,
  repo: { owner: string; repo: string } | string
): string {
  const key = typeof repo === 'string' ? repo.toLowerCase() : `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`;
  if (data.repoAgents && data.repoAgents[key]) {
    return data.repoAgents[key];
  }
  return data.settings?.defaultAgent || DEFAULT_SETTINGS.defaultAgent;
}

export function setRepoAgent(
  data: AppState,
  repo: { owner: string; repo: string } | string,
  agentName: string
): void {
  const key = typeof repo === 'string' ? repo.toLowerCase() : `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`;
  if (!data.repoAgents) {
    data.repoAgents = {};
  }
  data.repoAgents[key] = agentName;
}

export function loadAgentsConfig(cwd: string = process.cwd()): AgentsConfigFile {
  const agentsPath = path.join(cwd, LOCAL_OVERSEER_DIR, AGENTS_FILE_NAME);
  if (!fs.existsSync(agentsPath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(agentsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const custom = parsed.customAgents || (parsed.agents ? parsed.agents : undefined);
    const disabled = Array.isArray(parsed.disabledAgents)
      ? parsed.disabledAgents
      : Array.isArray(parsed.disabled)
      ? parsed.disabled
      : [];
    return {
      customAgents: custom,
      disabledAgents: disabled,
    };
  } catch {
    return {};
  }
}

export function getAvailableAgents(data?: AppState, cwd?: string): string[] {
  const localConfig = loadAgentsConfig(cwd);
  const disabled = new Set(localConfig.disabledAgents || []);
  const builtin = ['claude', 'agy', 'gemini', 'pi'].filter((a) => !disabled.has(a));
  const customFromState = data?.customAgents ? Object.keys(data.customAgents) : [];
  const customFromConfig = localConfig.customAgents ? Object.keys(localConfig.customAgents) : [];
  return Array.from(new Set([...builtin, ...customFromState, ...customFromConfig]));
}

export function getAgentDefinition(agentName: string, data?: AppState, cwd?: string): AgentDefinition {
  const norm = agentName.toLowerCase();
  if (data?.customAgents && data.customAgents[agentName]) {
    return data.customAgents[agentName];
  }

  const localConfig = loadAgentsConfig(cwd);
  if (localConfig.customAgents && localConfig.customAgents[agentName]) {
    return localConfig.customAgents[agentName];
  }

  switch (norm) {
    case 'claude':
      return { command: 'claude -p "{prompt}"', description: 'Claude CLI autonomous assistant' };
    case 'agy':
    case 'gemini':
      return { command: 'agy "{prompt}"', description: 'Antigravity / Gemini CLI agent' };
    case 'pi':
      return { command: 'pi "{prompt}"', description: 'Pi CLI agent' };
    default:
      return {
        command: `${agentName} "{prompt}"`,
        description: `Custom agent ${agentName}`,
      };
  }
}

export function appStateToAppConfig(data: AppState, cwd?: string): AppConfig {
  const localConfig = loadAgentsConfig(cwd);
  return {
    defaults: {
      agent: data.settings.defaultAgent,
      pollIntervalSecs: data.settings.pollIntervalSecs,
      worktrees_dir: data.settings.worktreesDir,
      batch_size: 25,
      user: data.settings.user,
      team: data.settings.team,
      filter_user_only: data.settings.filterUserOnly,
      search_query: data.settings.searchQuery,
      recent_pr_window_days: data.settings.recentPrWindowDays,
      team_active_window_days: data.settings.teamActiveWindowDays,
      team_poll_interval_secs: data.settings.teamPollIntervalSecs,
    },
    repos: [],
    agents: { ...data.customAgents, ...localConfig.customAgents },
    runtime: {
      dryRun: data.dryRun,
    },
    streamdeck: {
      enabled: data.extensions.streamdeck.enabled,
      port: data.extensions.streamdeck.port,
    },
  };
}

// ── State Mutation & Query Helpers ──────────────────────────────────────────

export function findPR(data: AppState, key: PrKey): PrState | null {
  return data.prs.get(prKeyToString(key)) || null;
}

export function upsertPR(data: AppState, pr: PrState): void {
  data.prs.set(prKeyToString(pr.key), pr);
}

export function removePR(data: AppState, key: PrKey): void {
  data.prs.delete(prKeyToString(key));
}

export function updatePRStatus(
  data: AppState,
  key: PrKey,
  overallStatus: PrOverallStatus,
  options?: {
    reviewVerdict?: ReviewVerdict;
    ciStatus?: CiStatus;
    statusDetail?: string;
  }
): void {
  const pr = findPR(data, key);
  if (pr) {
    pr.overallStatus = overallStatus;
    if (options?.reviewVerdict) pr.reviewVerdict = options.reviewVerdict;
    if (options?.ciStatus) pr.ciStatus = options.ciStatus;
    if (options?.statusDetail !== undefined) pr.statusDetail = options.statusDetail;
  }
}

export function appendLog(data: AppState, key: PrKey, message: string): void {
  const pr = findPR(data, key);
  if (!pr) return;

  const timestamp = new Date().toLocaleTimeString();
  const entry = `[${timestamp}] ${message}`;

  pr.log.push(entry);
  if (pr.log.length > MAX_PR_LOG_ENTRIES) {
    const trimmed = pr.log.length - MAX_PR_LOG_ENTRIES;
    pr.logOffset = (pr.logOffset || 0) + trimmed;
    pr.log = pr.log.slice(-MAX_PR_LOG_ENTRIES);
  }
}

export function getPrList(data: AppState): PrState[] {
  return Array.from(data.prs.values());
}

export function countNeedsAttention(data: AppState): number {
  let count = 0;
  for (const pr of data.prs.values()) {
    if (
      pr.overallStatus === 'ChangesRequested' ||
      pr.overallStatus === 'CiFailing'
    ) {
      count++;
    }
  }
  return count;
}

export function setWorker(data: AppState, key: PrKey, worker: WorkerHandle): void {
  data.workers.set(prKeyToString(key), worker);
}

export function getWorker(data: AppState, key: PrKey): WorkerHandle | null {
  return data.workers.get(prKeyToString(key)) || null;
}

export function removeWorker(data: AppState, key: PrKey): void {
  data.workers.delete(prKeyToString(key));
}
