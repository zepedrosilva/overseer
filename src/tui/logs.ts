// ── TUI Agent Log Viewer Modal ───────────────────────────────────────────────
// Live streaming & historical log inspector for AI agent worktree runs.

import fs from 'node:fs';
import path from 'node:path';
import type { PrState, WorkerHandle } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { colors, rgbColor, getSpinnerChar } from './colors.js';
import { padEndVisual, truncateVisual, visualLength } from './layout.js';

export interface RenderLogsModalOptions {
  pr: PrState;
  worker?: WorkerHandle | null;
  logLines: string[];
  modalWidth: number;
  modalHeight: number;
  scrollOffset: number;
  spinnerTick?: number;
}

export function loadPRLogFile(pr: PrState, cwd: string = process.cwd()): string[] {
  const logFile = path.join(cwd, '.overseer', 'logs', `${pr.key.owner}-${pr.key.repo}-${pr.key.number}.log`);
  try {
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf8');
      if (content.trim()) {
        return content.split('\n');
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

function formatElapsed(startedAt: number, finishedAt?: number): string {
  const end = finishedAt || Date.now();
  const diffSec = Math.max(0, Math.floor((end - startedAt) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return `${mins}m${secs}s`;
}

export function renderLogsModal(options: RenderLogsModalOptions): string[] {
  const { pr, worker, logLines, modalWidth, modalHeight, scrollOffset, spinnerTick = 0 } = options;

  const innerWidth = Math.max(10, modalWidth - 4);
  const bodyHeight = Math.max(2, modalHeight - 2);
  const outputLines: string[] = [];

  const keyStr = prKeyToString(pr.key);
  const isRunning = worker?.status === 'running';

  // 1. Top Header with Agent status
  let statusBadge = '';
  if (isRunning) {
    const spinner = getSpinnerChar(spinnerTick);
    const elapsed = formatElapsed(worker!.startedAt);
    statusBadge = ` [${spinner} Running: ${worker!.agentName} (${elapsed})] `;
  } else if (worker?.status === 'completed') {
    const elapsed = formatElapsed(worker.startedAt, worker.finishedAt);
    statusBadge = ` [✔ ${worker.agentName} completed (${elapsed})] `;
  } else if (worker?.status === 'failed') {
    statusBadge = ` [✖ ${worker.agentName} failed] `;
  } else if (pr.agent) {
    statusBadge = ` [Agent: ${pr.agent}] `;
  }

  const titleLeft = ` Agent Logs: ${keyStr}${statusBadge}`;
  const titleRight = ` [Esc to close] `;
  const availableDash = modalWidth - visualLength(titleLeft) - visualLength(titleRight) - 4;

  let topBorder: string;
  if (availableDash >= 0) {
    const dashes = '─'.repeat(availableDash);
    topBorder = `\x1B[${rgbColor(colors.cyan)}┌─\x1B[1;37m${titleLeft}\x1B[0m\x1B[${rgbColor(colors.cyan)}${dashes}\x1B[${rgbColor(colors.fgDim)}${titleRight}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┐\x1B[0m`;
  } else {
    const midTitle = ` Logs: ${pr.key.repo}#${pr.key.number}${statusBadge}`;
    const midDash = modalWidth - visualLength(midTitle) - visualLength(titleRight) - 4;
    if (midDash >= 0) {
      topBorder = `\x1B[${rgbColor(colors.cyan)}┌─\x1B[1;37m${midTitle}\x1B[0m\x1B[${rgbColor(colors.cyan)}${'─'.repeat(midDash)}\x1B[${rgbColor(colors.fgDim)}${titleRight}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┐\x1B[0m`;
    } else {
      const compactTitle = ` Logs: #${pr.key.number}${statusBadge}`;
      const compactDash = modalWidth - visualLength(compactTitle) - visualLength(titleRight) - 4;
      if (compactDash >= 0) {
        topBorder = `\x1B[${rgbColor(colors.cyan)}┌─\x1B[1;37m${compactTitle}\x1B[0m\x1B[${rgbColor(colors.cyan)}${'─'.repeat(compactDash)}\x1B[${rgbColor(colors.fgDim)}${titleRight}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┐\x1B[0m`;
      } else {
        topBorder = `\x1B[${rgbColor(colors.cyan)}┌${'─'.repeat(Math.max(0, modalWidth - 2))}┐\x1B[0m`;
      }
    }
  }
  outputLines.push(padEndVisual(topBorder, modalWidth));

  // 2. Log Body Lines
  const totalLines = logLines.length;
  const clampedOffset = Math.max(0, Math.min(Math.max(0, totalLines - bodyHeight), scrollOffset));

  for (let row = 0; row < bodyHeight; row++) {
    const lineIdx = clampedOffset + row;
    let lineContent = '';

    if (lineIdx < totalLines) {
      const raw = logLines[lineIdx];
      // Highlight errors or success if present
      if (raw.toLowerCase().includes('error') || raw.toLowerCase().includes('failed') || raw.toLowerCase().includes('fatal')) {
        lineContent = `\x1B[${rgbColor(colors.red)}${truncateVisual(raw, innerWidth)}\x1B[0m`;
      } else if (raw.toLowerCase().includes('success') || raw.toLowerCase().includes('passed') || raw.toLowerCase().includes('completed')) {
        lineContent = `\x1B[${rgbColor(colors.green)}${truncateVisual(raw, innerWidth)}\x1B[0m`;
      } else if (raw.startsWith('[') && raw.includes(']')) {
        lineContent = `\x1B[${rgbColor(colors.cyan)}${truncateVisual(raw, innerWidth)}\x1B[0m`;
      } else {
        lineContent = `\x1B[${rgbColor(colors.fg)}${truncateVisual(raw, innerWidth)}\x1B[0m`;
      }
    }

    const padded = padEndVisual(lineContent, innerWidth);
    outputLines.push(`\x1B[${rgbColor(colors.cyan)}│\x1B[0m ${padded} \x1B[${rgbColor(colors.cyan)}│\x1B[0m`);
  }

  // 3. Bottom Border with Actions
  const candidateBadges = [
    '[j/k] scroll',
    '[g/G] top/bottom',
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
  const dashes = '─'.repeat(bottomAvailable);
  const bottomBorder = `\x1B[${rgbColor(colors.cyan)}└─\x1B[${rgbColor(colors.fgDim)}${actionsLeft}\x1B[0m\x1B[${rgbColor(colors.cyan)}${dashes}\x1B[${rgbColor(colors.fgDim)}${scrollIndicator}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┘\x1B[0m`;

  outputLines.push(padEndVisual(bottomBorder, modalWidth));

  return outputLines;
}
