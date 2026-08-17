// ── Configuration & Defaults Engine ─────────────────────────────────────────
// Provides zero-config built-in defaults with state-driven overrides and CLI fallbacks.

import type { AppConfig, AgentDefinition } from './app/types.js';
import { parseRepoUrl } from './app/types.js';
import {
  DEFAULT_SETTINGS,
  DEFAULT_EXTENSIONS,
  loadState,
  createEmptyState,
  appStateToAppConfig,
  getAgentDefinition as getAgentDefFromState,
  getRepoAgent as getRepoAgentFromState,
} from './app/state.js';

export const DEFAULT_CONFIG: AppConfig = {
  defaults: {
    agent: DEFAULT_SETTINGS.defaultAgent,
    pollIntervalSecs: DEFAULT_SETTINGS.pollIntervalSecs,
    worktrees_dir: DEFAULT_SETTINGS.worktreesDir,
    batch_size: 25,
    filter_user_only: DEFAULT_SETTINGS.filterUserOnly,
    search_query: DEFAULT_SETTINGS.searchQuery,
  },
  repos: [],
  agents: {},
  runtime: {
    dryRun: DEFAULT_SETTINGS.dryRun,
  },
  streamdeck: {
    enabled: DEFAULT_EXTENSIONS.streamdeck.enabled,
    port: DEFAULT_EXTENSIONS.streamdeck.port,
  },
};

export const BUILTIN_AGENT_PRESETS: Record<string, AgentDefinition> = {
  claude: {
    command: 'claude -p "Review and address the comments on PR #{pr}"',
    description: 'Claude CLI code assistant',
  },
  gemini: {
    command: 'agy "Review and fix issues on PR #{pr}"',
    description: 'Antigravity / Gemini CLI agent',
  },
  agy: {
    command: 'agy "Review and fix issues on PR #{pr}"',
    description: 'Antigravity CLI agent',
  },
  pi: {
    command: 'pi "Review PR #{pr}"',
    description: 'Pi CLI agent',
  },
  moxly: {
    command: 'gh pr comment {pr} --body "@moxly please review and address comments"',
    description: 'Moxly GitHub bot comment trigger',
  },
};

export interface LoadConfigOptions {
  configPath?: string;
  dryRunFlag?: boolean;
  cwd?: string;
}

export function loadConfig(options?: LoadConfigOptions): AppConfig {
  const cwd = options?.cwd || process.cwd();
  const dryRunFlag = options?.dryRunFlag;

  const state = loadState(undefined, cwd) || createEmptyState();
  if (dryRunFlag !== undefined) {
    state.dryRun = dryRunFlag;
    state.settings.dryRun = dryRunFlag;
  }

  return appStateToAppConfig(state);
}

export function getRepoAgent(
  repo: { owner: string; repo: string } | string,
  config: AppConfig
): string {
  const repoName = typeof repo === 'string' ? repo : `${repo.owner}/${repo.repo}`;
  const parsedTarget = typeof repo === 'string' ? parseRepoUrl(repo) : repo;

  for (const r of config.repos) {
    const parsed = parseRepoUrl(r.url);
    if (parsed && parsedTarget) {
      if (
        parsed.owner.toLowerCase() === parsedTarget.owner.toLowerCase() &&
        parsed.repo.toLowerCase() === parsedTarget.repo.toLowerCase()
      ) {
        if (r.agent) return r.agent;
      }
    } else if (r.url.includes(repoName) && r.agent) {
      return r.agent;
    }
  }

  return config.defaults.agent;
}

export function getAgentDefinition(
  agentName: string,
  config?: AppConfig
): AgentDefinition {
  if (config?.agents && config.agents[agentName]) {
    return config.agents[agentName];
  }
  return getAgentDefFromState(agentName);
}
