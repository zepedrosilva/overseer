// ── Domain Types ─────────────────────────────────────────────────────────────
// Shared domain models and interfaces for Overseer.

export interface PrKey {
  owner: string;
  repo: string;
  number: number;
}

export function prKeyToString(key: PrKey): string {
  return `${key.owner}/${key.repo}#${key.number}`;
}

export function parsePrKey(str: string): PrKey | null {
  // Format: "owner/repo#number" or "owner/repo/pull/number" or "owner/repo#number"
  const m = str.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:#|\/pull\/|\/)?(\d+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
}

export interface ParsedRepo {
  owner: string;
  repo: string;
}

export function parseRepoUrl(url: string): ParsedRepo | null {
  const clean = url.trim();
  // Match git@github.com:owner/repo.git or ssh://git@github.com/owner/repo.git
  const sshMatch = clean.match(/^(?:ssh:\/\/)?git@github\.com[:/]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // Match https://github.com/owner/repo or http://github.com/owner/repo.git
  const httpMatch = clean.match(/^https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/);
  if (httpMatch) {
    return { owner: httpMatch[1], repo: httpMatch[2] };
  }

  // Match simple "owner/repo" shorthand
  const shortMatch = clean.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2] };
  }

  return null;
}

// ── Review & CI Status Types ────────────────────────────────────────────────

export type ReviewVerdict =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'PENDING'
  | 'NO_REVIEW';

export type CiStatus =
  | 'SUCCESS'
  | 'FAILURE'
  | 'PENDING'
  | 'UNKNOWN';

export type PrOverallStatus =
  | 'Ready'               // Approved and CI passing
  | 'Reviewing'           // Awaiting review or in review
  | 'ChangesRequested'    // Review requested changes
  | 'CiFailing'           // CI checks failed
  | 'CiPending'           // CI in progress
  | 'Draft'               // Draft PR
  | 'Merged'              // Successfully merged
  | 'Closed';             // Closed without merge

export interface CiCheckRun {
  name: string;
  status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED';
  conclusion?: 'SUCCESS' | 'FAILURE' | 'NEUTRAL' | 'CANCELLED' | 'TIMED_OUT' | 'ACTION_REQUIRED' | 'SKIPPED';
  url?: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  author: string;
}

// ── PR State ────────────────────────────────────────────────────────────────

export interface PrState {
  key: PrKey;
  title: string;
  branch: string;
  baseBranch: string;
  author: string;
  url: string;
  isDraft: boolean;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  reviewVerdict: ReviewVerdict;
  ciStatus: CiStatus;
  overallStatus: PrOverallStatus;
  statusDetail?: string;
  ciChecks: CiCheckRun[];
  agent?: string;                // per-repo or per-PR agent override
  commentsCount: number;
  unresolvedThreadsCount: number;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commitsCount?: number;
  firstReviewAt?: string;
  mergedAt?: string;
  closedAt?: string;
  scope?: 'mine' | 'team' | 'both';
  approvedCount?: number;
  requiredApprovalsCount?: number;
  pendingReviewersCount?: number;
  requestedReviewers?: string[];
  approvedReviewers?: string[];
  changesRequestedReviewers?: string[];
  createdAt: string;
  updatedAt: string;
  log: string[];
  logOffset?: number;
}

// ── Repo Handle ─────────────────────────────────────────────────────────────

export interface RepoHandle {
  owner: string;
  repo: string;
  url: string;
  agent: string;
  discovered?: boolean;
}

// ── Agent Configuration ─────────────────────────────────────────────────────

export interface AgentDefinition {
  command: string;
  description?: string;
}

export interface AgentResult {
  success: boolean;
  sessionId: string;
  output?: string;
  error?: string;
  worktreePath?: string;
}

// ── Worker State ────────────────────────────────────────────────────────────

export interface WorkerHandle {
  sessionId: string;
  prKey: PrKey;
  agentName: string;
  command: string;
  worktreePath: string;
  originalPrompt?: string;
  branch: string;
  startedAt: number;
  finishedAt?: number;
  pid?: number;
  logPath?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

// ── Application Settings & Extensions ────────────────────────────────────────

export interface AppSettings {
  defaultAgent: string;
  pollIntervalSecs: number;
  worktreesDir: string;
  user?: string;
  team?: string;
  filterUserOnly: boolean;
  searchQuery: string;
  dryRun: boolean;
  recentPrWindowDays?: number;
  teamActiveWindowDays?: number;
  teamPollIntervalSecs?: number;
}

export interface ApiServerConfig {
  enabled: boolean;
  port: number;
}

export interface AppExtensions {
  api: ApiServerConfig;
}

// ── Historical PR & Stats Records ──────────────────────────────────────────

export interface HistoricalPrRecord {
  key: PrKey;
  author: string;
  title: string;
  createdAt: string;
  firstReviewAt?: string;
  mergedAt?: string;
  closedAt?: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  additions: number;
  deletions: number;
  changedFiles: number;
  commitsCount: number;
  commentsCount: number;
  unresolvedThreadsCount: number;
  ciStatus: CiStatus;
  scope: 'mine' | 'team' | 'both';
}

export interface HistoricalStatsStore {
  records: HistoricalPrRecord[];
}

export type StatsTimeframe = '7d' | '14d' | '30d' | '60d' | '90d';

export interface TrendDelta {
  delta60: number;
  delta90: number;
  direction60: 'up' | 'down' | 'flat';
  direction90: 'up' | 'down' | 'flat';
}

export interface MetricTrends {
  mergedPRs?: TrendDelta;
  avgPRSize?: TrendDelta;
  commitsPerPR?: TrendDelta;
  reviewTurnaround?: TrendDelta;
  ciPassRate?: TrendDelta;
  discussionDensity?: TrendDelta;
}

export type LeaderboardSort = 'merged7' | 'merged14' | 'merged30' | 'merged60' | 'merged90' | 'total' | 'comments' | 'stale';

export interface MemberLeaderboardEntry {
  rank: number;
  author: string;
  name?: string;
  merged7: number;
  merged14: number;
  merged30: number;
  merged60: number;
  merged90: number;
  open: number;
  closed: number;
  total: number;
  discussionDensity: number;
  bottlenecksCount: number;
}

export interface AggregatedStats {
  timeframe: StatsTimeframe;
  scope: 'mine' | 'team';
  totalPRs: number;
  mergedPRs: number;
  mergedPRs7: number;
  mergedPRs14: number;
  mergedPRs30: number;
  mergedPRs60: number;
  mergedPRs90: number;
  openPRs: number;
  closedPRs: number;
  totalAdditions: number;
  totalDeletions: number;
  totalChangedFiles: number;
  avgPRSize: number;
  sizeDistribution: {
    smallPercent: number; // < 100 lines
    mediumPercent: number; // 100 - 500 lines
    largePercent: number; // > 500 lines
  };
  totalCommits: number;
  avgCommitsPerPR: number;
  medianTimeToFirstReviewHours: number | null;
  medianTimeToMergeDays: number | null;
  ciPassRatePercent: number;
  totalCiRuns: number;
  passedCiRuns: number;
  reviewDensityCommentsPerPR: number;
  staleBottlenecks: Array<{
    key: PrKey;
    title: string;
    daysPending: number;
    reason: string;
  }>;
  memberBreakdown?: MemberLeaderboardEntry[];
  trends?: MetricTrends;
}

export interface BackfillProgress {
  currentMember: string;
  memberIndex: number;
  totalMembers: number;
  prsFound: number;
  totalPRs: number;
  timeframeDays?: number;
  status: 'starting' | 'in_progress' | 'done' | 'error';
  log: string[];
}

// ── App State ───────────────────────────────────────────────────────────────

export interface AppState {
  settings: AppSettings;
  extensions: AppExtensions;
  repoAgents: Record<string, string>; // key: "owner/repo" in lowercase -> agentName
  customAgents: Record<string, AgentDefinition>; // custom agent templates
  repos: RepoHandle[];
  prs: Map<string, PrState>; // key: prKeyToString(key)
  workers: Map<string, WorkerHandle>; // key: prKeyToString(prKey)
  viewScope?: 'mine' | 'team';
  teamMembers?: string[];
  teamProfiles?: Record<string, { login: string; name?: string }>;
  historicalStats?: HistoricalStatsStore;
  dryRun: boolean;
  lastPolled?: number;
  isPolling?: boolean;
  currentUser?: string;
  rateLimitedUntil?: number;
}

// ── Legacy/Adapter Config Type for Seamless Integration ─────────────────────

export interface AppConfig {
  defaults: {
    agent: string;
    pollIntervalSecs: number;
    worktrees_dir: string;
    batch_size: number;
    user?: string;
    team?: string;
    filter_user_only?: boolean;
    search_query?: string;
    recent_pr_window_days?: number;
    team_active_window_days?: number;
    team_poll_interval_secs?: number;
  };
  repos: Array<{ url: string; agent?: string }>;
  agents: Record<string, AgentDefinition>;
  runtime: {
    dryRun: boolean;
  };
  api: {
    enabled: boolean;
    port: number;
  };
}

// ── TUI Action & Footer Types ───────────────────────────────────────────────

export interface TUIFooterAction {
  key: string;
  label: string;
  handler: () => void | Promise<void>;
  disabled?: boolean;
}

// ── Local API Types ───────────────────────────────────────────────────────

export interface ApiStatusResponse {
  reposCount: number;
  prsCount: number;
  needsAttentionCount: number;
  items: Array<{
    id: string;
    title: string;
    status: PrOverallStatus;
    ci: CiStatus;
    review: ReviewVerdict;
    agent?: string;
  }>;
}

export interface ApiPrResponse {
  id: string;
  title: string;
  status: PrOverallStatus;
  ci: CiStatus;
  review: ReviewVerdict;
  statusDetail?: string;
  agent?: string;
  ciChecks: CiCheckRun[];
  log: string[];
}

export type ApiActionType = 'recheck' | 'merge' | 'agent' | 'open' | 'comment';
