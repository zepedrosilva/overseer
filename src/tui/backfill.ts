// ── Backfill Progress Modal ───────────────────────────────────────────────────
// Real-time progress bar, member status, and streaming activity log for 30-day stats sync.

import type { BackfillProgress } from '../app/types.js';
import { colors, rgbColor, getSpinnerChar } from './colors.js';
import { padEndVisual, truncateVisual, visualLength } from './layout.js';

export interface RenderBackfillModalOptions {
  progress: BackfillProgress;
  modalWidth: number;
  modalHeight: number;
  spinnerTick?: number;
}

export function renderBackfillModal(options: RenderBackfillModalOptions): string[] {
  const { progress, modalWidth, modalHeight, spinnerTick = 0 } = options;
  const innerWidth = Math.max(10, modalWidth - 4);
  const outputLines: string[] = [];

  const days = progress.timeframeDays || 90;
  const titleLeft = ` ⚡ Backfilling ${days}-Day PR History`;
  const titleRight = progress.status === 'done' ? ` [Esc/Enter to view stats] ` : ` [Please wait...] `;
  const availableDash = modalWidth - visualLength(titleLeft) - visualLength(titleRight) - 4;

  let topBorder: string;
  if (availableDash >= 0) {
    const dashes = '─'.repeat(availableDash);
    topBorder = `\x1B[${rgbColor(colors.cyan)}┌─\x1B[1;37m${titleLeft}\x1B[0m\x1B[${rgbColor(colors.cyan)}${dashes}\x1B[${rgbColor(colors.fgDim)}${titleRight}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┐\x1B[0m`;
  } else {
    topBorder = `\x1B[${rgbColor(colors.cyan)}┌${'─'.repeat(Math.max(0, modalWidth - 2))}┐\x1B[0m`;
  }
  outputLines.push(padEndVisual(topBorder, modalWidth));

  const addLine = (content: string) => {
    const truncated = truncateVisual(content, innerWidth);
    const padded = padEndVisual(truncated, innerWidth);
    outputLines.push(`\x1B[${rgbColor(colors.cyan)}│\x1B[0m ${padded} \x1B[${rgbColor(colors.cyan)}│\x1B[0m`);
  };

  const addDivider = () => {
    const div = '─'.repeat(innerWidth);
    outputLines.push(`\x1B[${rgbColor(colors.cyan)}├─${div}─┤\x1B[0m`);
  };

  // Status & Progress bar
  const spinner = progress.status === 'done' ? '✔' : getSpinnerChar(spinnerTick);
  const statusColor = progress.status === 'done' ? rgbColor(colors.green) : rgbColor(colors.yellow);

  addLine(`Status: \x1B[${statusColor}${spinner} ${progress.status === 'done' ? 'Sync Completed' : 'Fetching PR History...'}\x1B[0m`);

  const pct = progress.totalMembers > 0 ? Math.round((progress.memberIndex / progress.totalMembers) * 100) : 0;
  const barWidth = Math.max(10, Math.min(30, innerWidth - 30));
  const filled = Math.min(barWidth, Math.round((pct / 100) * barWidth));
  const empty = Math.max(0, barWidth - filled);
  const bar = `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pct}%`;

  const memberInfo = progress.totalMembers > 0
    ? `Member ${progress.memberIndex}/${progress.totalMembers}: \x1B[1;37m${progress.currentMember}\x1B[0m`
    : `Preparing...`;

  addLine(`Progress: \x1B[${rgbColor(colors.cyan)}${bar}\x1B[0m  │  ${memberInfo}`);
  addLine(`Total Records Fetched: \x1B[1;37m${progress.totalPRs}\x1B[0m PRs stored`);
  addDivider();

  // Log viewport
  addLine(`\x1B[${rgbColor(colors.fgDim)}Activity Log:\x1B[0m`);
  const logCapacity = Math.max(3, modalHeight - 9);
  const visibleLogs = progress.log.slice(-logCapacity);

  for (let i = 0; i < logCapacity; i++) {
    const logLine = visibleLogs[i] || '';
    addLine(`  ${logLine}`);
  }

  while (outputLines.length < modalHeight - 1) {
    addLine('');
  }

  // Bottom Border
  const footerHelp = progress.status === 'done' ? ` [Esc/Enter] View Stats ` : ` [Please wait] `;
  const botDash = Math.max(0, modalWidth - visualLength(footerHelp) - 4);
  const botBorder = `\x1B[${rgbColor(colors.cyan)}└─\x1B[${rgbColor(colors.fgDim)}${footerHelp}\x1B[0m\x1B[${rgbColor(colors.cyan)}${'─'.repeat(botDash)}─┘\x1B[0m`;
  outputLines.push(padEndVisual(botBorder, modalWidth));

  return outputLines;
}
