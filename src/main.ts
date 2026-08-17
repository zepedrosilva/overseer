// ── Main Entrypoint ──────────────────────────────────────────────────────────
// Boot sequence, zero-config state management, Stream Deck extension, and TUI lifecycle.

import type { AppState, PrState } from './app/types.js';
import { prKeyToString } from './app/types.js';
import {
  loadState,
  saveState,
  createEmptyState,
  updatePRStatus,
  appendLog,
  getRepoAgent,
  appStateToAppConfig,
} from './app/state.js';
import { startStreamDeckServer, type StreamDeckServerController } from './streamdeck/server.js';
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
  streamdeck?: boolean;
  port?: number;
  agent?: string;
  poll?: number;
  dryRun?: boolean;
  search?: string;
  user?: string;
  resetState?: boolean;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--streamdeck' || arg === '--streamdeck=true') {
      result.streamdeck = true;
    } else if (arg === '--no-streamdeck' || arg === '--streamdeck=false') {
      result.streamdeck = false;
    } else if (arg === '--port' || arg === '--streamdeck-port') {
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
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--search' && args[i + 1]) {
      result.search = args[++i];
    } else if (arg === '--user' && args[i + 1]) {
      result.user = args[++i];
    } else if (arg === '--reset-state') {
      result.resetState = true;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const cli = parseCliArgs();

  // 1. Load persisted state or initialize empty domain state
  const data: AppState = cli.resetState ? createEmptyState() : (loadState() || createEmptyState());

  // 2. Apply CLI flags on top of loaded settings & extensions
  if (cli.streamdeck !== undefined) data.extensions.streamdeck.enabled = cli.streamdeck;
  if (cli.port !== undefined) data.extensions.streamdeck.port = cli.port;
  if (cli.agent !== undefined) data.settings.defaultAgent = cli.agent;
  if (cli.poll !== undefined) data.settings.pollIntervalSecs = Math.max(5, cli.poll);
  if (cli.dryRun !== undefined) {
    data.settings.dryRun = cli.dryRun;
    data.dryRun = cli.dryRun;
  }
  if (cli.search !== undefined) data.settings.searchQuery = cli.search;
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
  let streamDeckServer: StreamDeckServerController | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  function syncStreamDeckServer(): void {
    const isEnabled = data.extensions.streamdeck.enabled;
    const port = data.extensions.streamdeck.port || 3210;

    if (!isEnabled) {
      if (streamDeckServer) {
        streamDeckServer.close().catch(() => {});
        streamDeckServer = null;
      }
      return;
    }

    if (streamDeckServer) {
      streamDeckServer.close().catch(() => {});
      streamDeckServer = null;
    }

    try {
      streamDeckServer = startStreamDeckServer(data, port, (action, pld) => handleAction(action, pld));
    } catch {
      // Ignore if port occupied
    }
  }

  function reschedulePollTimer(): void {
    if (pollTimer) clearInterval(pollTimer);
    const intervalMs = Math.max(5, data.settings.pollIntervalSecs || 30) * 1000;
    pollTimer = setInterval(() => {
      runPollCycle().catch(() => {});
    }, intervalMs);
  }

  async function handleAction(action: string, payload?: Record<string, unknown>): Promise<void> {
    const pr = (payload?.pr as PrState) || tui?.getSelectedPR();

    if (action === 'recheck') {
      appendLog(data, pr?.key || { owner: 'all', repo: 'repos', number: 0 }, 'Manual refresh requested');
      await runPollCycle();
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
        streamDeckServer?.broadcast('prUpdated', { key: keyStr, status: 'Merged' });
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
        streamDeckServer?.broadcast('prUpdated', { key: keyStr, status: 'Closed' });
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
    syncStreamDeckServer();
    reschedulePollTimer();
    saveState(data);
    tui?.render();
  }

  // 4. Start TUI Immediately (Zero Startup Lag)
  tui = createTUI(
    data,
    (act, pld) => handleAction(act, pld),
    () => handleQuit(),
    {
      streamDeckEnabled: data.extensions.streamdeck.enabled,
      streamDeckPort: data.extensions.streamdeck.port,
      onSettingsChange: () => handleSettingsChange(),
    }
  );

  // 5. Start Stream Deck Server if enabled in state or CLI
  syncStreamDeckServer();

  // 6. Asynchronous Background Auth & Initial Poll
  async function runPollCycle(): Promise<void> {
    try {
      await pollAllRepos(data, appStateToAppConfig(data));
      streamDeckServer?.broadcast('pollCompleted', {
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

    // Run first background poll
    await runPollCycle();
  })().catch(() => {});

  // 7. Watcher Polling Interval
  reschedulePollTimer();

  process.on('SIGINT', () => handleQuit());
  process.on('SIGTERM', () => handleQuit());

  async function handleQuit(): Promise<void> {
    if (pollTimer) clearInterval(pollTimer);
    if (streamDeckServer) {
      await streamDeckServer.close();
    }
    tui.destroy();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
