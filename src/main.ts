#!/usr/bin/env node
// ── Main Entrypoint ──────────────────────────────────────────────────────────
// Boot sequence, zero-config state management, Local REST & SSE API, and TUI lifecycle.

import type { AppState, PrState } from './app/types.js';
import { prKeyToString } from './app/types.js';
import {
  loadState,
  saveState,
  loadSettings,
  saveSettings,
  resetState,
  resetSettings,
  resetAll,
  createEmptyState,
  updatePRStatus,
  appendLog,
  getRepoAgent,
  appStateToAppConfig,
} from './app/state.js';
import { startApiServer, type ApiServerController } from './server/index.js';
import { createTUI, type TUIController } from './tui/index.js';
import {
  isGHAvailable,
  isGHAuthenticated,
  getCurrentUser,
  openInBrowser,
  mergePR,
  closePR,
  addComment,
  viewPRDiffInteractive,
} from './watcher/gh.js';
import { pollAllRepos } from './watcher/index.js';
import { dispatchAgent } from './agents/index.js';
import { resolveWorktreeDir, cleanupWorktree, cleanupPRArtifacts } from './agents/worktree.js';

interface CliArgs {
  api?: boolean;
  port?: number;
  agent?: string;
  poll?: number;
  pollTeam?: number;
  dryRun?: boolean;
  search?: string;
  user?: string;
  team?: string;
  resetState?: boolean;
  resetSettings?: boolean;
  resetAll?: boolean;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--api' || arg === '--api=true') {
      result.api = true;
    } else if (arg === '--no-api' || arg === '--api=false') {
      result.api = false;
    } else if (arg === '--port' || arg === '--api-port') {
      const p = parseInt(args[++i], 10);
      if (!isNaN(p)) result.port = p;
    } else if (arg.startsWith('--port=')) {
      const p = parseInt(arg.split('=')[1], 10);
      if (!isNaN(p)) result.port = p;
    } else if (arg === '--agent' && args[i + 1]) {
      result.agent = args[++i];
    } else if (arg.startsWith('--agent=')) {
      result.agent = arg.split('=')[1];
    } else if (arg === '--poll' && args[i + 1]) {
      const sec = parseInt(args[++i], 10);
      if (!isNaN(sec)) result.poll = sec;
    } else if (arg === '--poll-team' || arg === '--team-poll') {
      const sec = parseInt(args[++i], 10);
      if (!isNaN(sec)) result.pollTeam = sec;
    } else if (arg.startsWith('--poll-team=') || arg.startsWith('--team-poll=')) {
      const sec = parseInt(arg.split('=')[1], 10);
      if (!isNaN(sec)) result.pollTeam = sec;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--search' && args[i + 1]) {
      result.search = args[++i];
    } else if (arg.startsWith('--search=')) {
      result.search = arg.split('=')[1];
    } else if (arg === '--team' && args[i + 1]) {
      result.team = args[++i];
    } else if (arg.startsWith('--team=')) {
      result.team = arg.split('=')[1];
    } else if (arg === '--user' && args[i + 1]) {
      result.user = args[++i];
    } else if (arg.startsWith('--user=')) {
      result.user = arg.split('=')[1];
    } else if (arg === '--reset-state') {
      result.resetState = true;
    } else if (arg === '--reset-settings') {
      result.resetSettings = true;
    } else if (arg === '--reset-all') {
      result.resetAll = true;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const cli = parseCliArgs();

  // 1. Handle reset flags
  if (cli.resetAll) {
    resetAll();
  } else {
    if (cli.resetState) resetState();
    if (cli.resetSettings) resetSettings();
  }

  // 2. Load persisted state or initialize empty domain state
  const data: AppState = loadState() || createEmptyState();

  // 2. Apply CLI flags on top of loaded settings & extensions
  if (cli.api !== undefined) data.extensions.api.enabled = cli.api;
  if (cli.port !== undefined) data.extensions.api.port = cli.port;
  if (cli.agent !== undefined) data.settings.defaultAgent = cli.agent;
  if (cli.poll !== undefined) data.settings.pollIntervalSecs = Math.max(5, cli.poll);
  if (cli.pollTeam !== undefined) data.settings.teamPollIntervalSecs = Math.max(10, cli.pollTeam);
  if (cli.dryRun !== undefined) {
    data.settings.dryRun = cli.dryRun;
    data.dryRun = cli.dryRun;
  }
  if (cli.search !== undefined) data.settings.searchQuery = cli.search;
  if (cli.team !== undefined) data.settings.team = cli.team;
  if (cli.user !== undefined) {
    data.settings.user = cli.user;
    data.currentUser = cli.user;
  }
  if (!data.currentUser) {
    data.currentUser = data.settings.user || 'unknown';
  }
  data.isPolling = true;

  // 3. Action Handlers Forward Reference
  let tui: TUIController;
  let apiServer: ApiServerController | null = null;
  let minePollTimer: NodeJS.Timeout | null = null;
  let teamPollTimer: NodeJS.Timeout | null = null;

  function syncApiServer(): void {
    const isEnabled = data.extensions.api.enabled;
    const port = data.extensions.api.port || 3210;

    if (!isEnabled) {
      if (apiServer) {
        apiServer.close().catch(() => {});
        apiServer = null;
      }
      return;
    }

    if (apiServer) {
      apiServer.close().catch(() => {});
      apiServer = null;
    }

    try {
      apiServer = startApiServer(data, port, (action, pld) => handleAction(action, pld));
    } catch {
      // Ignore if port occupied
    }
  }

  function reschedulePollTimer(): void {
    if (minePollTimer) clearInterval(minePollTimer);
    if (teamPollTimer) clearInterval(teamPollTimer);

    // 1. Personal Poll Interval
    const mineIntervalMs = Math.max(5, data.settings.pollIntervalSecs || 30) * 1000;
    minePollTimer = setInterval(() => {
      runPollCycle('mine').catch(() => {});
    }, mineIntervalMs);

    // 2. Team Poll Interval (only if team configured)
    if (data.settings.team) {
      const teamIntervalMs = Math.max(10, data.settings.teamPollIntervalSecs || 120) * 1000;
      teamPollTimer = setInterval(() => {
        runPollCycle('team').catch(() => {});
      }, teamIntervalMs);
    }
  }

  async function handleAction(action: string, payload?: Record<string, unknown>): Promise<void> {
    const pr = (payload?.pr as PrState) || tui?.getSelectedPR();

    if (action === 'recheck') {
      const targetScope = data.viewScope === 'team' ? 'team' : 'mine';
      appendLog(data, pr?.key || { owner: 'all', repo: 'repos', number: 0 }, `Manual ${targetScope} refresh requested`);
      await runPollCycle(targetScope);
      tui?.render();
      return;
    }

    if (!pr) {
      tui?.showMessage('No Pull Request selected');
      return;
    }

    const keyStr = prKeyToString(pr.key);

    if (action === 'open') {
      try {
        appendLog(data, pr.key, `Opening ${pr.url} in browser`);
        await openInBrowser(pr.key.owner, pr.key.repo, pr.key.number);
      } catch (err) {
        tui?.showMessage(`Open failed: ${(err as Error).message}`);
      }
      return;
    }

    if (action === 'merge') {
      if (data.dryRun) {
        appendLog(data, pr.key, `[DRY-RUN] Would squash-merge ${keyStr} and delete branch`);
        tui?.showMessage(`DRY-RUN: Merge skipped for ${keyStr}`);
        return;
      }

      try {
        appendLog(data, pr.key, 'Squash-merging PR...');
        await mergePR(pr.key.owner, pr.key.repo, pr.key.number, true);
        updatePRStatus(data, pr.key, 'Merged', { statusDetail: 'Merged via Overseer' });
        appendLog(data, pr.key, 'Successfully squash-merged and deleted branch');
        try {
          cleanupPRArtifacts(pr, appStateToAppConfig(data));
        } catch {
          // Ignore artifact deletion errors
        }
        saveState(data);
        apiServer?.broadcast('prUpdated', { key: keyStr, status: 'Merged' });
        tui?.showMessage(`Merged ${keyStr} successfully!`);
      } catch (err) {
        appendLog(data, pr.key, `Merge failed: ${(err as Error).message}`);
        tui?.showMessage(`Merge failed: ${(err as Error).message}`);
      }
      return;
    }

    if (action === 'close') {
      if (data.dryRun) {
        appendLog(data, pr.key, `[DRY-RUN] Would close PR ${keyStr}`);
        tui?.showMessage(`DRY-RUN: Close skipped for ${keyStr}`);
        return;
      }

      try {
        appendLog(data, pr.key, 'Closing PR...');
        await closePR(pr.key.owner, pr.key.repo, pr.key.number);
        updatePRStatus(data, pr.key, 'Closed', { statusDetail: 'Closed via Overseer' });
        appendLog(data, pr.key, 'PR closed');
        try {
          cleanupPRArtifacts(pr, appStateToAppConfig(data));
        } catch {
          // Ignore artifact deletion errors
        }
        saveState(data);
        apiServer?.broadcast('prUpdated', { key: keyStr, status: 'Closed' });
        tui?.showMessage(`Closed ${keyStr} successfully!`);
      } catch (err) {
        appendLog(data, pr.key, `Close failed: ${(err as Error).message}`);
        tui?.showMessage(`Close failed: ${(err as Error).message}`);
      }
      return;
    }

    if (action === 'comment') {
      const text = String(payload?.text || '').trim();
      if (!text) return;

      if (data.dryRun) {
        appendLog(data, pr.key, `[DRY-RUN] Would post comment: "${text}"`);
        tui?.showMessage(`DRY-RUN: Comment skipped for ${keyStr}`);
        return;
      }

      try {
        appendLog(data, pr.key, 'Posting comment...');
        await addComment(pr.key.owner, pr.key.repo, pr.key.number, text);
        pr.commentsCount++;
        appendLog(data, pr.key, `Comment posted: "${text}"`);
        saveState(data);
        tui?.showMessage(`Comment posted to ${keyStr}!`);
      } catch (err) {
        appendLog(data, pr.key, `Comment failed: ${(err as Error).message}`);
        tui?.showMessage(`Comment failed: ${(err as Error).message}`);
      }
      return;
    }

    if (action === 'diff') {
      return;
    }

    if (action === 'agent') {
      const prompt = typeof payload?.prompt === 'string' && payload.prompt.length > 0 ? payload.prompt : undefined;
      const agentName = (payload?.agentName as string) || (pr ? getRepoAgent(data, pr.key) : data.settings.defaultAgent);

      if (data.dryRun) {
        appendLog(data, pr.key, `[DRY-RUN] Would dispatch agent '${agentName}' in worktree`);
        tui?.showMessage(`DRY-RUN: Agent dispatch skipped for ${keyStr}`);
        return;
      }

      tui?.showMessage(`Dispatching agent '${agentName}' for ${keyStr}...`);
      dispatchAgent({
        data,
        pr,
        config: appStateToAppConfig(data),
        agentName,
        prompt,
      })
        .then(() => {
          tui?.render();
        })
        .catch((err) => {
          appendLog(data, pr.key, `Agent error: ${(err as Error).message}`);
          tui?.showMessage(`Agent error: ${(err as Error).message}`);
        });
      return;
    }
  }

  function handleSettingsChange(): void {
    syncApiServer();
    reschedulePollTimer();
    saveState(data);
    runPollCycle().catch(() => {});
    tui?.render();
  }

  // 4. Start TUI Immediately (Zero Startup Lag)
  tui = createTUI(
    data,
    (act, pld) => handleAction(act, pld),
    () => handleQuit(),
    {
      apiEnabled: data.extensions.api.enabled,
      apiPort: data.extensions.api.port,
      onSettingsChange: () => handleSettingsChange(),
    }
  );

  // 5. Start Local API Server if enabled in state or CLI
  syncApiServer();

  // 6. Asynchronous Background Auth & Initial Poll
  async function runPollCycle(scope: 'all' | 'mine' | 'team' = 'all'): Promise<void> {
    try {
      await pollAllRepos(data, appStateToAppConfig(data), scope);
      apiServer?.broadcast('pollCompleted', {
        reposCount: data.repos.length,
        prsCount: data.prs.size,
      });
      tui?.render();
    } catch {
      // Handled internally in pollAllRepos
    }
  }

  (async () => {
    if (!(await isGHAvailable())) {
      tui.showMessage('GitHub CLI (`gh`) not found — install from https://cli.github.com');
      return;
    }

    if (!(await isGHAuthenticated())) {
      tui.showMessage('gh is not authenticated — run `gh auth login` in your terminal');
      return;
    }

    if (data.currentUser === 'unknown') {
      try {
        data.currentUser = await getCurrentUser();
        tui.render();
      } catch {
        // Fallback to unknown
      }
    }

    // Run first background poll (fetch all personal + team PRs)
    await runPollCycle('all');
  })().catch(() => {});

  // 7. Watcher Polling Interval
  reschedulePollTimer();

  process.on('SIGINT', () => handleQuit());
  process.on('SIGTERM', () => handleQuit());

  async function handleQuit(): Promise<void> {
    if (minePollTimer) clearInterval(minePollTimer);
    if (teamPollTimer) clearInterval(teamPollTimer);
    if (apiServer) {
      await apiServer.close();
    }
    tui.destroy();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
