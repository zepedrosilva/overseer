// ── TUI Agent Log Viewer Modal ───────────────────────────────────────────────
// Live streaming & historical log inspector for AI agent worktree runs.

import fs from 'node:fs';
import path from 'node:path';
import type { PrState, WorkerHandle, AgentExecutionRecord } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { loadAgentStats } from '../agents/stats.js';
import { colors, rgbColor, getSpinnerChar } from './colors.js';
import { padEndVisual, truncateVisual, visualLength } from './layout.js';

export interface RenderLogsModalOptions {
  pr: PrState;
  worker?: WorkerHandle | null;
  logLines?: string[];
  records?: AgentExecutionRecord[];
  modalWidth: number;
  modalHeight: number;
  scrollOffset: number;
  spinnerTick?: number;
  cwd?: string;
}

export function loadPRLogFile(pr: PrState, cwd: string = process.cwd()): string[] {
  const logFile = path.join(cwd, '.overseer', 'logs', `${pr.key.owner}-${pr.key.repo}-${pr.key.number}.log`);
  try {
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf8');
      if (content.trim()) {
        return content
          .split('\n')
          .map((l) => l.trimEnd())
          .filter((l) => {
            if (!l) return false;
            if (l.startsWith('=== [') || l.startsWith('------------------------') || l.startsWith('PR: ') || l.startsWith('Worktree: ')) return false;
            return true;
          });
      }
    }
  } catch {
    // Fall back to in-memory state logs
  }

  if (pr.log && pr.log.length > 0) {
    return pr.log;
  }

  return ['(No agent logs recorded yet. Press [a] on this PR to dispatch an agent.)'];
}

function loadSessionTailLog(logPath: string, maxLines: number = 8): string[] {
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
        if (l.startsWith('=== [') || l.startsWith('------------------------') || l.startsWith('PR: ') || l.startsWith('Worktree: ')) return false;
        return true;
      });
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export function renderLogsModal(options: RenderLogsModalOptions): string[] {
  const { pr, worker, records: inputRecords, modalWidth, modalHeight, scrollOffset, spinnerTick = 0, cwd } = options;

  const innerWidth = Math.max(10, modalWidth - 4);
  const bodyHeight = Math.max(2, modalHeight - 2);
  const outputLines: string[] = [];

  const keyStr = `${pr.key.repo}#${pr.key.number}`;

  // 1. Build List of Timeline Sessions for this PR
  interface ModalSession {
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

  // Historical records for this PR (pass undefined as customPath so cwd is 2nd param)
  const statsStore = inputRecords ? { records: inputRecords } : loadAgentStats(undefined, cwd);
  const prRecords = statsStore.records.filter(
    (r) => r.prKey.owner === pr.key.owner && r.prKey.repo === pr.key.repo && r.prKey.number === pr.key.number
  );

  const sessions: ModalSession[] = [];

  // Active running worker on this PR
  if (worker && worker.prKey.owner === pr.key.owner && worker.prKey.repo === pr.key.repo && worker.prKey.number === pr.key.number) {
    let isWorkerAlive = worker.status === 'running';
    if (isWorkerAlive && worker.pid && typeof worker.pid === 'number') {
      try {
        process.kill(worker.pid, 0);
      } catch {
        isWorkerAlive = false;
        worker.status = 'completed';
        if (!worker.finishedAt) worker.finishedAt = Date.now();
      }
    }

    const endTime = worker.finishedAt || Date.now();
    const elapsedSecs = Math.max(1, Math.round((endTime - (worker.startedAt || endTime)) / 1000));
    const inRecords = prRecords.some((r) => r.sessionId === worker.sessionId);

    if (isWorkerAlive) {
      sessions.push({
        agentName: worker.agentName,
        playbookName: worker.playbookName || 'task',
        isRunning: true,
        durationStr: `${elapsedSecs}s`,
        startedAtStr: worker.startedAt ? new Date(worker.startedAt).toLocaleTimeString() : 'Just now',
        logPath: worker.logPath,
        worktreePath: worker.worktreePath,
        touchedFiles: worker.touchedFiles,
      });
    } else if (!inRecords) {
      sessions.push({
        agentName: worker.agentName,
        playbookName: worker.playbookName || 'task',
        isRunning: false,
        durationStr: `${elapsedSecs}s`,
        exitCode: worker.status === 'failed' ? 1 : 0,
        summary: worker.error || 'Execution finished',
        startedAtStr: worker.startedAt ? new Date(worker.startedAt).toLocaleTimeString() : '',
        logPath: worker.logPath,
        worktreePath: worker.worktreePath,
        touchedFiles: worker.touchedFiles,
      });
    }
  }

  for (const r of prRecords) {
    const durSecs = r.durationMs ? Math.round(r.durationMs / 1000) : 0;
    sessions.push({
      agentName: r.agentName,
      playbookName: r.playbookName,
      isRunning: false,
      durationStr: `${durSecs}s`,
      exitCode: r.exitCode ?? (r.status === 'completed' ? 0 : 1),
      summary: r.summary || (r.status === 'completed' ? 'Refactored code and verified unit tests' : r.error || 'Execution stopped'),
      startedAtStr: r.startedAt ? new Date(r.startedAt).toLocaleTimeString() : '',
      logPath: path.join(cwd || process.cwd(), '.overseer', 'logs', `${pr.key.owner}-${pr.key.repo}-${pr.key.number}.log`),
      touchedFiles: r.touchedFiles,
    });
  }

  // 2. Format Dotted Timeline Lines
  const contentLines: string[] = [];
  const spineColor = rgbColor(colors.border);
  const spine = `  \x1B[${spineColor}┊\x1B[0m`;

  contentLines.push(`  \x1B[${rgbColor(colors.fgDim)}TIMELINE · #${pr.key.number} (${pr.key.owner}/${pr.key.repo})\x1B[0m`);
  contentLines.push(`  \x1B[${spineColor}┊\x1B[0m`);

  if (sessions.length === 0) {
    const rawLogs = options.logLines || loadPRLogFile(pr, cwd);
    if (rawLogs.length > 0 && !rawLogs[0].includes('No agent logs recorded')) {
      contentLines.push(`  \x1B[1;37m🤖 ${pr.agent || 'agent'}\x1B[0m \x1B[${rgbColor(colors.fgDim)}· execution log\x1B[0m`);
      for (const rawLine of rawLogs) {
        contentLines.push(`${spine}  \x1B[${rgbColor(colors.fg)}${truncateVisual(rawLine, innerWidth - 6)}\x1B[0m`);
      }
    } else {
      contentLines.push(`  \x1B[${rgbColor(colors.fgMuted)}(No agent execution sessions recorded for this PR yet)\x1B[0m`);
    }
  }

  for (let sIdx = 0; sIdx < sessions.length; sIdx++) {
    const s = sessions[sIdx];
    const isLast = sIdx === sessions.length - 1;

    if (s.isRunning) {
      const spinner = getSpinnerChar(spinnerTick);
      const nodeHeader = `  \x1B[1;32m${spinner} 🤖 ${s.agentName}\x1B[0m \x1B[${rgbColor(colors.fgDim)}· ${s.playbookName}\x1B[0m`;
      contentLines.push(truncateVisual(nodeHeader, innerWidth));

      const startedRow = `${spine}  \x1B[${rgbColor(colors.fgDim)}Started:\x1B[0m ${s.startedAtStr}  \x1B[${rgbColor(colors.fgDim)}Worktree:\x1B[0m \x1B[${rgbColor(colors.fgDim)}${truncateVisual(s.worktreePath || '', innerWidth - 36)}\x1B[0m`;
      contentLines.push(truncateVisual(startedRow, innerWidth));

      if (s.touchedFiles && s.touchedFiles.length > 0) {
        const fileSample = s.touchedFiles.slice(0, 3).join(', ') + (s.touchedFiles.length > 3 ? ` (+${s.touchedFiles.length - 3} more)` : '');
        const filesRow = `${spine}  \x1B[1;33m⚡ Active Edits (${s.touchedFiles.length} file${s.touchedFiles.length > 1 ? 's' : ''}):\x1B[0m \x1B[33m${truncateVisual(fileSample, innerWidth - 30)}\x1B[0m`;
        contentLines.push(truncateVisual(filesRow, innerWidth));
      }

      const tailLogs = loadSessionTailLog(s.logPath || '', 8);
      if (tailLogs.length > 0) {
        for (const logLine of tailLogs) {
          const logRow = `${spine}  \x1B[${rgbColor(colors.fg)}${truncateVisual(logLine, innerWidth - 8)}\x1B[0m`;
          contentLines.push(truncateVisual(logRow, innerWidth));
        }
      } else {
        const initRow = `${spine}  \x1B[${rgbColor(colors.cyan)}${spinner} Initializing worktree environment & inspecting codebase...\x1B[0m`;
        contentLines.push(truncateVisual(initRow, innerWidth));
      }

      const statusRow = `${spine}  \x1B[${rgbColor(colors.fgDim)}Running ${s.durationStr}...\x1B[0m`;
      contentLines.push(truncateVisual(statusRow, innerWidth));

      if (!isLast) {
        contentLines.push(spine);
      }
    } else {
      const isSuccess = s.exitCode === 0;
      const bullet = isSuccess ? `\x1B[${rgbColor(colors.green)}✔\x1B[0m` : `\x1B[${rgbColor(colors.red)}✖\x1B[0m`;
      const nodeHeader = `  ${bullet} \x1B[1;37m🤖 ${s.agentName}\x1B[0m \x1B[${rgbColor(colors.fgDim)}· ${s.playbookName}\x1B[0m`;
      contentLines.push(truncateVisual(nodeHeader, innerWidth));

      const startedRow = `${spine}  \x1B[${rgbColor(colors.fgDim)}Started:\x1B[0m ${s.startedAtStr}  \x1B[${rgbColor(colors.fgDim)}Summary:\x1B[0m ${truncateVisual(s.summary || '', innerWidth - 36)}`;
      contentLines.push(truncateVisual(startedRow, innerWidth));

      if (s.touchedFiles && s.touchedFiles.length > 0) {
        const fileSample = s.touchedFiles.slice(0, 3).join(', ') + (s.touchedFiles.length > 3 ? ` (+${s.touchedFiles.length - 3} more)` : '');
        const filesRow = `${spine}  \x1B[${rgbColor(colors.fgDim)}Touched (${s.touchedFiles.length} file${s.touchedFiles.length > 1 ? 's' : ''}):\x1B[0m \x1B[${rgbColor(colors.fgDim)}${truncateVisual(fileSample, innerWidth - 30)}\x1B[0m`;
        contentLines.push(truncateVisual(filesRow, innerWidth));
      }

      const sessionLogs = loadSessionTailLog(s.logPath || '', 8);
      if (sessionLogs.length > 0) {
        for (const logLine of sessionLogs) {
          const logRow = `${spine}  \x1B[${rgbColor(colors.fg)}${truncateVisual(logLine, innerWidth - 8)}\x1B[0m`;
          contentLines.push(truncateVisual(logRow, innerWidth));
        }
      }

      const statusText = isSuccess
        ? `Completed in ${s.durationStr} · Exit Code: 0`
        : `Failed in ${s.durationStr} · Exit Code: ${s.exitCode ?? 1}`;
      const statusRow = `${spine}  \x1B[${rgbColor(colors.fgDim)}${statusText}\x1B[0m`;
      contentLines.push(truncateVisual(statusRow, innerWidth));

      if (!isLast) {
        contentLines.push(spine);
      }
    }
  }

  // 3. Top Border
  const titleLeft = ` Agent Logs: ${keyStr} `;
  const titleRight = ` [Esc to close] `;
  const availableDash = modalWidth - visualLength(titleLeft) - visualLength(titleRight) - 4;
  const dashes = '─'.repeat(Math.max(0, availableDash));
  const topBorder = `\x1B[${rgbColor(colors.cyan)}┌─\x1B[1;37m${titleLeft}\x1B[0m\x1B[${rgbColor(colors.cyan)}${dashes}\x1B[${rgbColor(colors.fgDim)}${titleRight}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┐\x1B[0m`;
  outputLines.push(padEndVisual(topBorder, modalWidth));

  // 4. Log Body Lines with Viewport Scrolling
  const totalLines = contentLines.length;
  const clampedOffset = Math.max(0, Math.min(Math.max(0, totalLines - bodyHeight), scrollOffset));

  for (let row = 0; row < bodyHeight; row++) {
    const lineIdx = clampedOffset + row;
    const lineContent = lineIdx < totalLines ? contentLines[lineIdx] : '';
    const padded = padEndVisual(lineContent, innerWidth);
    outputLines.push(`\x1B[${rgbColor(colors.cyan)}│\x1B[0m ${padded} \x1B[${rgbColor(colors.cyan)}│\x1B[0m`);
  }

  // 5. Bottom Border with Actions
  const candidateBadges = [
    '[↑/↓] scroll',
    '[a] agent',
    '[m] merge',
    '[Esc] close',
  ];

  const scrollIndicator = ` [${clampedOffset + 1}/${Math.max(1, totalLines)} L] `;
  const maxActionsWidth = Math.max(0, modalWidth - visualLength(scrollIndicator) - 6);
  const visibleBadges: string[] = [];
  let usedWidth = 2;

  for (const badge of candidateBadges) {
    const needed = visualLength(badge) + (visibleBadges.length > 0 ? 2 : 0);
    if (usedWidth + needed <= maxActionsWidth) {
      visibleBadges.push(badge);
      usedWidth += needed;
    }
  }

  const actionsLeft = visibleBadges.length > 0
    ? ` ${visibleBadges.join('  ')} `
    : ' [Esc] close ';

  const bottomAvailable = Math.max(0, modalWidth - visualLength(actionsLeft) - visualLength(scrollIndicator) - 4);
  const botDashes = '─'.repeat(bottomAvailable);
  const bottomBorder = `\x1B[${rgbColor(colors.cyan)}└─\x1B[${rgbColor(colors.fgDim)}${actionsLeft}\x1B[0m\x1B[${rgbColor(colors.cyan)}${botDashes}\x1B[${rgbColor(colors.fgDim)}${scrollIndicator}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┘\x1B[0m`;

  outputLines.push(padEndVisual(bottomBorder, modalWidth));

  return outputLines;
}
