// ── PR Table View ───────────────────────────────────────────────────────────
// Minimalist, high-contrast PR table matching llmfit aesthetic.

import type { PrState, WorkerHandle } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { colors, rgbColor, statusColor, statusIcon, ciIcon, ciColor, getSpinnerChar } from './colors.js';
import { padEndVisual, truncateVisual, formatTimeAgo } from './layout.js';

export interface RenderTableOptions {
  prs: PrState[];
  selectedIndex: number;
  width: number;
  height: number;
  workers?: Map<string, WorkerHandle>;
  spinnerTick?: number;
}

export function renderTable(options: RenderTableOptions): string[] {
  const { prs, selectedIndex, width, height } = options;
  const lines: string[] = [];

  const safeWidth = Math.max(10, width - 2);

  // Responsive column width allocation
  let repoColWidth = 14;
  let branchColWidth = 16;
  if (safeWidth < 55) {
    repoColWidth = 6;
    branchColWidth = 6;
  } else if (safeWidth < 68) {
    repoColWidth = 8;
    branchColWidth = 8;
  } else if (safeWidth < 80) {
    repoColWidth = 10;
    branchColWidth = 10;
  } else if (safeWidth < 100) {
    repoColWidth = 12;
    branchColWidth = 13;
  }

  // Exact column breakdown:
  // 1. marker: 2 ("▎ ")
  // 2. status: 8 ("🟢 Ready ") + 1 space
  // 3. ci: 2 ("✔ ") + 1 space
  // 4. repo: repoColWidth + 1 space
  // 5. prNum: 6 ("#142  ") + 1 space
  // 6. branch: branchColWidth + 1 space
  // 7. title: titleWidth + 1 space
  // 8. age: 5 ("  40d")
  const fixedWidthWithoutTitle = 2 + 8 + 1 + 2 + 1 + repoColWidth + 1 + 6 + 1 + branchColWidth + 1 + 1 + 5;
  const titleWidth = Math.max(4, safeWidth - fixedWidthWithoutTitle);

  // Table header in cool slate
  const statusHeader = 'STATUS'.padEnd(8);
  const ciHeader = 'CI'.padEnd(2);
  const repoHeader = 'REPO'.padEnd(repoColWidth);
  const numHeader = '#'.padEnd(6);
  const branchHeader = 'BRANCH'.padEnd(branchColWidth);
  const titleHeader = 'TITLE'.padEnd(titleWidth);
  const ageHeader = 'AGE'.padStart(5);

  const header = `  ${statusHeader} ${ciHeader} ${repoHeader} ${numHeader} ${branchHeader} ${titleHeader} ${ageHeader}`;
  lines.push(`\x1B[${rgbColor(colors.fgDim)}${padEndVisual(header, safeWidth)}\x1B[0m`);

  if (prs.length === 0) {
    lines.push(`\x1B[${rgbColor(colors.fgMuted)}${padEndVisual('  (No pull requests found matching filter)', safeWidth)}\x1B[0m`);
    while (lines.length < height) {
      lines.push(padEndVisual('', safeWidth));
    }
    return lines;
  }

  // Calculate scrolling window
  const maxRows = Math.max(1, height - 1); // 1 for header
  let startIndex = 0;

  if (prs.length > maxRows) {
    const half = Math.floor(maxRows / 2);
    startIndex = Math.max(0, Math.min(prs.length - maxRows, selectedIndex - half));
  }

  const visiblePRs = prs.slice(startIndex, startIndex + maxRows);

  for (let i = 0; i < visiblePRs.length; i++) {
    const actualIndex = startIndex + i;
    const pr = visiblePRs[i];
    const isSelected = actualIndex === selectedIndex;

    // llmfit solid cyan bar on selected row
    const marker = isSelected ? `\x1B[${rgbColor(colors.cyan)}▎\x1B[0m ` : '  ';
    const worker = options.workers?.get(prKeyToString(pr.key));
    const isWorkerRunning = worker?.status === 'running';

    const sIcon = isWorkerRunning ? getSpinnerChar(options.spinnerTick) : statusIcon(pr.overallStatus);
    const sName = isWorkerRunning ? worker!.agentName.slice(0, 6).padEnd(6) : pr.overallStatus.slice(0, 6).padEnd(6);
    const sc = isWorkerRunning ? rgbColor(colors.yellow) : rgbColor(statusColor(pr.overallStatus));
    const cIcon = ciIcon(pr.ciStatus);
    const cc = rgbColor(ciColor(pr.ciStatus));

    const repoName = truncateVisual(pr.key.repo, repoColWidth).padEnd(repoColWidth);
    const prNum = `#${pr.key.number}`.padEnd(6);
    const branch = truncateVisual(pr.branch, branchColWidth).padEnd(branchColWidth);
    const title = truncateVisual(pr.title, titleWidth).padEnd(titleWidth);
    const age = formatTimeAgo(pr.updatedAt).padStart(5);

    const bgPrefix = isSelected ? `\x1B[48;2;30;41;59m` : '';
    const bgReset = isSelected ? `\x1B[0m` : '';

    const statusPart = `\x1B[${sc}${sIcon} ${sName}\x1B[0m`;
    const ciPart = `\x1B[${cc}${cIcon} \x1B[0m`;
    const repoPart = `\x1B[${rgbColor(colors.fg)}${repoName}\x1B[0m`;
    const numPart = `\x1B[${rgbColor(colors.fg)}${prNum}\x1B[0m`;
    const branchPart = `\x1B[${rgbColor(colors.fgDim)}${branch}\x1B[0m`;
    const titlePart = `\x1B[${rgbColor(colors.fg)}${title}\x1B[0m`;
    const agePart = `\x1B[${rgbColor(colors.fgMuted)}${age}\x1B[0m`;

    const rowContent = `${bgPrefix}${marker}${statusPart} ${ciPart} ${repoPart} ${numPart} ${branchPart} ${titlePart} ${agePart}${bgReset}`;

    lines.push(padEndVisual(rowContent, safeWidth));
  }

  // Pad remaining rows if table is shorter than viewport
  while (lines.length < height) {
    lines.push(padEndVisual('', safeWidth));
  }

  return lines;
}
