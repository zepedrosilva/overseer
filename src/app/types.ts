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
  filterUserOnly: boolean;
  searchQuery: string;
  dryRun: boolean;
}

export interface ApiServerConfig {
  enabled: boolean;
  port: number;
}

export interface AppExtensions {
  api: ApiServerConfig;
}

// ── App State ───────────────────────────────────────────────────────────────

export interface AppState {
  settings: AppSettings;
  extensions: AppExtensions;
  repoAgents: Record<string, string>;               // key: "owner/repo" in lowercase -> agentName
  customAgents: Record<string, AgentDefinition>;    // custom agent templates
  repos: RepoHandle[];
  prs: Map<string, PrState>;                        // key: prKeyToString(key)
  workers: Map<string, WorkerHandle>;               // key: prKeyToString(prKey)
  dryRun: boolean;
  lastPolled?: number;
  isPolling?: boolean;
  currentUser?: string;
}

// ── Legacy/Adapter Config Type for Seamless Integration ─────────────────────

export interface AppConfig {
  defaults: {
    agent: string;
    pollIntervalSecs: number;
    worktrees_dir: string;
    batch_size: number;
    user?: string;
    filter_user_only?: boolean;
    search_query?: string;
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
