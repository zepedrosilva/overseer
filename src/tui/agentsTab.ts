// ── Agents Tab: Two-Pane Master / Detail View with Boxed Session Cards ─────────
// Organizes PR agent workflows on the left and sequential, delimited execution
// session cards with live real-time output tails on the right.

import fs from 'node:fs';
import path from 'node:path';
import type { AppState, WorkerHandle, PrKey, AgentExecutionRecord } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { loadAgentStats } from '../agents/stats.js';
import { colors, rgbColor, getSpinnerChar } from './colors.js';
import { padEndVisual, truncateVisual } from './layout.js';

export interface RenderAgentsTabOptions {
  data: AppState;
  width: number;
  height: number;
  selectedPrIndex: number;
  selectedSessionIndex: number;
  focusedPane: 'left' | 'right';
  expandedSessionIds: Set<string>;
  scrollOffset: number;
  spinnerTick?: number;
  cwd?: string;
}

export interface PRWorkflowGroup {
  prKey: PrKey;
  keyStr: string;
  repo: string;
  number: number;
  branch: string;
  activeWorker: WorkerHandle | null;
  records: AgentExecutionRecord[];
  lastActivityAt: number;
}

function workerToRecord(w: WorkerHandle): AgentExecutionRecord {
  const startedIso = w.startedAt ? new Date(w.startedAt).toISOString() : new Date().toISOString();
  const finishedIso = w.finishedAt ? new Date(w.finishedAt).toISOString() : new Date().toISOString();
  const durationMs = w.finishedAt && w.startedAt ? Math.max(0, w.finishedAt - w.startedAt) : 0;
  return {
    sessionId: w.sessionId || `worker-${w.startedAt || Date.now()}`,
    prKey: w.prKey,
    agentName: w.agentName,
    playbookName: w.playbookName || 'task',
    driver: w.driver || 'local',
    mode: w.mode || 'live',
    trigger: 'manual',
    startedAt: startedIso,
    finishedAt: finishedIso,
    durationMs,
    status: w.status,
    exitCode: w.status === 'completed' || w.status === 'dry-run' ? 0 : 1,
    error: w.error,
    summary:
      w.error ||
      (w.status === 'completed'
        ? 'Refactored code and verified unit tests'
        : w.status === 'interrupted'
        ? 'Worker process interrupted'
        : w.status === 'cancelled'
        ? 'Worker execution cancelled'
        : w.status === 'dry-run'
        ? 'Dry-run simulation completed'
        : `Worker ${w.status}`),
    touchedFiles: w.touchedFiles,
  };
}

export function collectPRWorkflowGroups(data: AppState, cwd?: string): PRWorkflowGroup[] {
  const groupsMap = new Map<string, PRWorkflowGroup>();

  // 1. Collect from active and non-running workers in memory
  if (data.workers) {
    for (const [keyStr, worker] of data.workers.entries()) {
      const isRunning = worker.status === 'running';
      if (!groupsMap.has(keyStr)) {
        const pr = data.prs?.get(keyStr);
        const group: PRWorkflowGroup = {
          prKey: worker.prKey,
          keyStr,
          repo: `${worker.prKey.owner}/${worker.prKey.repo}`,
          number: worker.prKey.number,
          branch: worker.branch || pr?.branch || 'main',
          activeWorker: isRunning ? worker : null,
          records: isRunning ? [] : [workerToRecord(worker)],
          lastActivityAt: worker.startedAt || Date.now(),
        };
        groupsMap.set(keyStr, group);
      } else {
        const group = groupsMap.get(keyStr)!;
        if (isRunning) {
          group.activeWorker = worker;
          group.lastActivityAt = Math.max(group.lastActivityAt, worker.startedAt || Date.now());
        } else {
          if (!group.records.some((r) => r.sessionId === worker.sessionId)) {
            group.records.push(workerToRecord(worker));
            group.lastActivityAt = Math.max(group.lastActivityAt, worker.startedAt || Date.now());
          }
        }
      }
    }
  }

  // 2. Collect from historical records
  const statsStore = loadAgentStats(undefined, cwd);
  if (statsStore?.records) {
    for (const rec of statsStore.records) {
      if (!rec?.prKey?.owner || !rec?.prKey?.repo || typeof rec?.prKey?.number !== 'number') {
        continue;
      }
      const keyStr = prKeyToString(rec.prKey);
      const pr = data.prs?.get(keyStr);
      const startedMs = rec.startedAt ? new Date(rec.startedAt).getTime() : 0;

      if (!groupsMap.has(keyStr)) {
        groupsMap.set(keyStr, {
          prKey: rec.prKey,
          keyStr,
          repo: `${rec.prKey.owner}/${rec.prKey.repo}`,
          number: rec.prKey.number,
          branch: pr?.branch || 'main',
          activeWorker: null,
          records: [rec],
          lastActivityAt: startedMs || Date.now(),
        });
      } else {
        const group = groupsMap.get(keyStr)!;
        const existingIdx = group.records.findIndex((r) => r.sessionId === rec.sessionId);
        if (existingIdx >= 0) {
          group.records[existingIdx] = rec;
        } else {
          group.records.push(rec);
        }
        group.lastActivityAt = Math.max(group.lastActivityAt, startedMs);
      }
    }
  }

  // 3. Sort: Active running workers pinned to top, then most recent activity descending
  const groups = Array.from(groupsMap.values());
  groups.sort((a, b) => {
    if (a.activeWorker && !b.activeWorker) return -1;
    if (!a.activeWorker && b.activeWorker) return 1;
    return b.lastActivityAt - a.lastActivityAt;
  });

  return groups;
}

function loadSessionTailLog(logPath: string, maxLines: number = 5): string[] {
  if (!logPath || !fs.existsSync(logPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => {
        if (!l) return false;
        if (l.startsWith('┌─') || l.startsWith('├─') || l.startsWith('└─') || l.startsWith('=== [')) return false;
        if (l.startsWith('│ Started:') || l.startsWith('│ PR:') || l.startsWith('│ Worktree:') || l.startsWith('│ Time:')) return false;
        if (l.startsWith('│ Playbook:') || l.startsWith('│ Command:') || l.startsWith('│')) return false;
        return true;
      });
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export function renderAgentsTab(options: RenderAgentsTabOptions): string[] {
  const {
    data,
    width,
    height,
    selectedPrIndex,
    selectedSessionIndex,
    focusedPane,
    expandedSessionIds,
    spinnerTick = 0,
    cwd,
  } = options;

  const lines: string[] = [];
  const safeWidth = Math.max(20, width - 2);
  const bodyHeight = Math.max(6, height);

  const groups = collectPRWorkflowGroups(data, cwd);

  if (groups.length === 0) {
    const emptyMsg = '  (No active or historical agent workflows recorded yet)';
    lines.push(`\x1B[${rgbColor(colors.fgMuted)}${padEndVisual(emptyMsg, safeWidth)}\x1B[0m`);
    for (let i = 1; i < bodyHeight; i++) {
      lines.push(padEndVisual('', safeWidth));
    }
    return lines;
  }

  // Layout allocation: Left pane ~35% (min 26, max 42), Right pane remainder
  const leftWidth = Math.max(26, Math.min(42, Math.floor(safeWidth * 0.35)));
  const rightWidth = Math.max(20, safeWidth - leftWidth - 3); // 3 chars for " │ " separator

  const safePrIndex = Math.max(0, Math.min(groups.length - 1, selectedPrIndex));
  const activeGroup = groups[safePrIndex];
  const activeGroupSessionCount = activeGroup ? (activeGroup.activeWorker ? 1 : 0) + activeGroup.records.length : 0;
  const effectiveFocusedPane = (focusedPane === 'right' && activeGroupSessionCount === 0) ? 'left' : focusedPane;

  // ── Render Left Pane: PR Workflows Tree ────────────────────────────────────
  const leftLines: string[] = [];
  const headerLeft = `  PR WORKFLOWS (${groups.length})`;
  leftLines.push(`\x1B[${rgbColor(colors.fgDim)}${padEndVisual(headerLeft, leftWidth)}\x1B[0m`);
  leftLines.push(padEndVisual(`  \x1B[${rgbColor(colors.border)}┊\x1B[0m`, leftWidth));

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const isSelectedPr = i === safePrIndex;
    const isRunning = Boolean(g.activeWorker);
    const isLastPr = i === groups.length - 1;
    const repoKey = g.repo.toLowerCase();
    const policy = data.repoPolicies?.[repoKey] || data.repoPolicies?.['*'];
    const repoMode = policy?.mode || 'off';

    // Prefix Dot matching PR table 1:1
    const prefixDot = isRunning
      ? `\x1B[1;32m${getSpinnerChar(spinnerTick)}\x1B[0m`
      : repoMode === 'live'
      ? `\x1B[1;32m●\x1B[0m`
      : repoMode === 'dry-run'
      ? `\x1B[1;33m●\x1B[0m`
      : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;

    const branchGlyph = isLastPr ? '└── ' : '├── ';
    const subSpine = isLastPr ? '    ' : '┊   ';

    const marker = isSelectedPr
      ? effectiveFocusedPane === 'left'
        ? '\x1B[1;36m❯\x1B[0m '
        : `\x1B[${rgbColor(colors.fgDim)}›\x1B[0m `
      : '  ';
    const titleColor = isSelectedPr ? '\x1B[1;37m' : `\x1B[${rgbColor(colors.fg)}`;
    const prTitle = `${prefixDot} #${g.number} · ${g.repo.split('/')[1] || g.repo}`;
    const headerLine = `${marker}\x1B[${rgbColor(colors.border)}${branchGlyph}\x1B[0m${titleColor}${truncateVisual(prTitle, leftWidth - 8)}\x1B[0m`;
    leftLines.push(padEndVisual(headerLine, leftWidth));

    const branchLine = `  \x1B[${rgbColor(colors.border)}${subSpine}\x1B[0m\x1B[${rgbColor(colors.fgDim)}${truncateVisual(g.branch, leftWidth - 8)}\x1B[0m`;
    leftLines.push(padEndVisual(branchLine, leftWidth));

    const totalSessions = (g.activeWorker ? 1 : 0) + g.records.length;
    const sessionSummary = isRunning
      ? `\x1B[${rgbColor(colors.cyan)}🤖 ${g.activeWorker?.agentName} · ${g.activeWorker?.playbookName}\x1B[0m`
      : `\x1B[${rgbColor(colors.fgMuted)}${totalSessions} session${totalSessions === 1 ? '' : 's'}\x1B[0m`;
    leftLines.push(padEndVisual(`  \x1B[${rgbColor(colors.border)}${subSpine}\x1B[0m${sessionSummary}`, leftWidth));

    if (!isLastPr) {
      leftLines.push(padEndVisual(`  \x1B[${rgbColor(colors.border)}${subSpine}\x1B[0m`, leftWidth));
    }
  }

  // ── Render Right Pane: Git History Sequence Timeline ────────────────────────
  const rightLines: string[] = [];
  const headerRight = `  TIMELINE · #${activeGroup.number} (${activeGroup.repo})`;
  const spacerRight = `  \x1B[${rgbColor(colors.border)}┊\x1B[0m`;

  // Build list of session entries for active group
  interface DisplaySession {
    id: string;
    agentName: string;
    playbookName: string;
    isRunning: boolean;
    durationStr: string;
    exitCode?: number;
    summary?: string;
    startedAtStr: string;
    logPath?: string;
    worktreePath?: string;
    touchedFiles?: string[];
  }

  const sessions: DisplaySession[] = [];

  // Active running worker first
  if (activeGroup.activeWorker) {
    const w = activeGroup.activeWorker;
    let isWorkerAlive = w.status === 'running';
    if (isWorkerAlive && w.pid && typeof w.pid === 'number') {
      try {
        process.kill(w.pid, 0);
      } catch {
        isWorkerAlive = false;
        w.status = 'completed';
        if (!w.finishedAt) w.finishedAt = Date.now();
      }
    }
    if (isWorkerAlive) {
      const elapsedSecs = Math.max(1, Math.round((Date.now() - (w.startedAt || Date.now())) / 1000));
      sessions.push({
        id: w.sessionId || 'active-worker',
        agentName: w.agentName,
        playbookName: w.playbookName || 'task',
        isRunning: true,
        durationStr: `${elapsedSecs}s`,
        startedAtStr: w.startedAt ? new Date(w.startedAt).toLocaleTimeString() : 'Just now',
        logPath: w.logPath,
        worktreePath: w.worktreePath,
        touchedFiles: w.touchedFiles,
      });
    } else {
      const durSecs = (w.finishedAt && w.startedAt) ? Math.round((w.finishedAt - w.startedAt) / 1000) : 0;
      sessions.push({
        id: w.sessionId || 'active-worker',
        agentName: w.agentName,
        playbookName: w.playbookName || 'task',
        isRunning: false,
        durationStr: `${durSecs}s`,
        exitCode: w.status === 'completed' || w.status === 'dry-run' ? 0 : 1,
        summary: w.error || (w.status === 'completed' ? 'Refactored code and verified unit tests' : w.status === 'interrupted' ? 'Worker process interrupted' : `Worker ${w.status}`),
        startedAtStr: w.startedAt ? new Date(w.startedAt).toLocaleTimeString() : '',
        logPath: w.logPath || path.join(cwd || process.cwd(), '.overseer', 'logs', `${activeGroup.prKey.owner}-${activeGroup.prKey.repo}-${activeGroup.prKey.number}.log`),
        worktreePath: w.worktreePath,
        touchedFiles: w.touchedFiles,
      });
    }
  }

  // Historical records
  for (const r of activeGroup.records) {
    if (sessions.some((s) => s.id === r.sessionId)) {
      continue;
    }
    const durSecs = r.durationMs ? Math.round(r.durationMs / 1000) : 0;
    sessions.push({
      id: r.sessionId,
      agentName: r.agentName,
      playbookName: r.playbookName,
      isRunning: false,
      durationStr: `${durSecs}s`,
      exitCode: r.exitCode ?? (r.status === 'completed' || r.status === 'dry-run' ? 0 : 1),
      summary: r.summary || (r.status === 'completed' ? 'Refactored code and verified unit tests' : r.error || (r.status === 'interrupted' ? 'Worker process interrupted' : 'Execution stopped')),
      startedAtStr: r.startedAt ? new Date(r.startedAt).toLocaleTimeString() : '',
      logPath: path.join(cwd || process.cwd(), '.overseer', 'logs', `${activeGroup.prKey.owner}-${activeGroup.prKey.repo}-${activeGroup.prKey.number}.log`),
      touchedFiles: r.touchedFiles,
    });
  }

  const rightContentLines: string[] = [];
  const sessionLineIndices: number[] = [];

  if (sessions.length === 0) {
    rightContentLines.push(`  \x1B[${rgbColor(colors.fgMuted)}(No agent execution sessions recorded for this PR yet)\x1B[0m`);
  }

  for (let sIdx = 0; sIdx < sessions.length; sIdx++) {
    const s = sessions[sIdx];
    const isSelectedCard = focusedPane === 'right' && sIdx === selectedSessionIndex;
    const isLast = sIdx === sessions.length - 1;
    const pointer = isSelectedCard ? '\x1B[1;36m❯\x1B[0m ' : '  ';

    sessionLineIndices[sIdx] = rightContentLines.length;

    const spineColor = rgbColor(colors.border);
    const spine = `  \x1B[${spineColor}┊\x1B[0m`;

    if (s.isRunning) {
      // ── Running Node ────────────────────────────────────────────────────────
      const spinner = getSpinnerChar(spinnerTick);
      const nodeHeader = `${pointer}\x1B[1;32m${spinner} 🤖 ${s.agentName}\x1B[0m \x1B[${rgbColor(colors.fgDim)}· ${s.playbookName}\x1B[0m`;
      rightContentLines.push(truncateVisual(nodeHeader, rightWidth));

      const startedRow = `${spine}  \x1B[${rgbColor(colors.fgDim)}Started:\x1B[0m ${s.startedAtStr}  \x1B[${rgbColor(colors.fgDim)}Worktree:\x1B[0m \x1B[${rgbColor(colors.fgDim)}${truncateVisual(s.worktreePath || '', rightWidth - 36)}\x1B[0m`;
      rightContentLines.push(truncateVisual(startedRow, rightWidth));

      if (s.touchedFiles && s.touchedFiles.length > 0) {
        const fileSample = s.touchedFiles.slice(0, 3).join(', ') + (s.touchedFiles.length > 3 ? ` (+${s.touchedFiles.length - 3} more)` : '');
        const filesRow = `${spine}  \x1B[1;33m⚡ Active Edits (${s.touchedFiles.length} file${s.touchedFiles.length > 1 ? 's' : ''}):\x1B[0m \x1B[33m${truncateVisual(fileSample, rightWidth - 30)}\x1B[0m`;
        rightContentLines.push(truncateVisual(filesRow, rightWidth));
      }

      const tailLogs = loadSessionTailLog(s.logPath || '', 6);
      if (tailLogs.length > 0) {
        for (const logLine of tailLogs) {
          const logRow = `${spine}  \x1B[${rgbColor(colors.fg)}${truncateVisual(logLine, rightWidth - 8)}\x1B[0m`;
          rightContentLines.push(truncateVisual(logRow, rightWidth));
        }
      } else {
        const initRow = `${spine}  \x1B[${rgbColor(colors.cyan)}${spinner} Initializing worktree environment & inspecting codebase...\x1B[0m`;
        rightContentLines.push(truncateVisual(initRow, rightWidth));
      }

      const statusRow = `${spine}  \x1B[${rgbColor(colors.fgDim)}Running ${s.durationStr}...\x1B[0m`;
      rightContentLines.push(truncateVisual(statusRow, rightWidth));

      if (!isLast) {
        rightContentLines.push(spine);
      }
    } else {
      // ── Historical Node ─────────────────────────────────────────────────────
      const isSuccess = s.exitCode === 0;
      const bullet = isSuccess ? `\x1B[${rgbColor(colors.green)}✔\x1B[0m` : `\x1B[${rgbColor(colors.red)}✖\x1B[0m`;
      const nodeHeader = `${pointer}${bullet} \x1B[1;37m🤖 ${s.agentName}\x1B[0m \x1B[${rgbColor(colors.fgDim)}· ${s.playbookName}\x1B[0m`;
      rightContentLines.push(truncateVisual(nodeHeader, rightWidth));

      const startedRow = `${spine}  \x1B[${rgbColor(colors.fgDim)}Started:\x1B[0m ${s.startedAtStr}  \x1B[${rgbColor(colors.fgDim)}Summary:\x1B[0m ${truncateVisual(s.summary || '', rightWidth - 36)}`;
      rightContentLines.push(truncateVisual(startedRow, rightWidth));

      if (s.touchedFiles && s.touchedFiles.length > 0) {
        const fileSample = s.touchedFiles.slice(0, 3).join(', ') + (s.touchedFiles.length > 3 ? ` (+${s.touchedFiles.length - 3} more)` : '');
        const filesRow = `${spine}  \x1B[${rgbColor(colors.fgDim)}Touched (${s.touchedFiles.length} file${s.touchedFiles.length > 1 ? 's' : ''}):\x1B[0m \x1B[${rgbColor(colors.fgDim)}${truncateVisual(fileSample, rightWidth - 30)}\x1B[0m`;
        rightContentLines.push(truncateVisual(filesRow, rightWidth));
      }

      const sessionLogs = loadSessionTailLog(s.logPath || '', 8);
      if (sessionLogs.length > 0) {
        for (const logLine of sessionLogs) {
          const logRow = `${spine}  \x1B[${rgbColor(colors.fg)}${truncateVisual(logLine, rightWidth - 8)}\x1B[0m`;
          rightContentLines.push(truncateVisual(logRow, rightWidth));
        }
      }

      const statusText = isSuccess
        ? `Completed in ${s.durationStr} · Exit Code: 0`
        : `Failed in ${s.durationStr} · Exit Code: ${s.exitCode ?? 1}`;
      const statusRow = `${spine}  \x1B[${rgbColor(colors.fgDim)}${statusText}\x1B[0m`;
      rightContentLines.push(truncateVisual(statusRow, rightWidth));

      if (!isLast) {
        rightContentLines.push(spine);
      }
    }
  }

  // Calculate right pane viewport scroll offset to keep selected session visible
  const availableContentHeight = Math.max(1, bodyHeight - 2);
  const targetLine = sessionLineIndices[selectedSessionIndex] || 0;
  const maxScroll = Math.max(0, rightContentLines.length - availableContentHeight);
  const rightScroll = focusedPane === 'right'
    ? Math.max(0, Math.min(maxScroll, targetLine > availableContentHeight - 2 ? targetLine - 1 : 0))
    : 0;

  rightLines.push(`\x1B[${rgbColor(colors.fgDim)}${padEndVisual(headerRight, rightWidth)}\x1B[0m`);
  rightLines.push(padEndVisual(spacerRight, rightWidth));
  for (let i = 0; i < availableContentHeight; i++) {
    rightLines.push(rightContentLines[rightScroll + i] || '');
  }

  // ── Combine Two Panes Side-by-Side strictly bounded to bodyHeight ───────────
  for (let r = 0; r < bodyHeight; r++) {
    const leftPart = padEndVisual(truncateVisual(leftLines[r] || '', leftWidth), leftWidth);
    const rightPart = padEndVisual(truncateVisual(rightLines[r] || '', rightWidth), rightWidth);
    const sep = ` \x1B[${rgbColor(colors.border)}│\x1B[0m `;
    lines.push(padEndVisual(`${leftPart}${sep}${rightPart}`, safeWidth));
  }

  return lines;
}
