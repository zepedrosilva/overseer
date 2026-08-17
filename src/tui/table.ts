// ── PR Table View ───────────────────────────────────────────────────────────
// Minimalist, high-contrast PR table with org dividers & reviewer status.

import type { PrState, WorkerHandle } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { formatReviewBadge } from '../watcher/evaluator.js';
import {
  colors,
  rgbColor,
  statusColor,
  statusIcon,
  ciIcon,
  ciColor,
  getSpinnerChar,
} from './colors.js';
import { padEndVisual, truncateVisual, visualLength, formatTimeAgo } from './layout.js';

export interface RenderTableOptions {
  prs: PrState[];
  selectedIndex: number;
  width: number;
  height: number;
  currentUser?: string;
  workers?: Map<string, WorkerHandle>;
  spinnerTick?: number;
}

type TableItem =
  | { type: 'header'; owner: string; count: number }
  | { type: 'pr'; pr: PrState; originalIndex: number };

export function renderTable(options: RenderTableOptions): string[] {
  const { prs, selectedIndex, width, height, currentUser } = options;
  const lines: string[] = [];

  const safeWidth = Math.max(10, width - 2);

  // Responsive column width allocation
  let revColWidth = 12;
  let repoColWidth = 14;
  let branchColWidth = 15;

  if (safeWidth < 60) {
    revColWidth = 5;
    repoColWidth = 6;
    branchColWidth = 6;
  } else if (safeWidth < 75) {
    revColWidth = 6;
    repoColWidth = 8;
    branchColWidth = 8;
  } else if (safeWidth < 95) {
    revColWidth = 8;
    repoColWidth = 10;
    branchColWidth = 10;
  } else if (safeWidth < 115) {
    revColWidth = 10;
    repoColWidth = 12;
    branchColWidth = 12;
  }

  // Exact column breakdown:
  // 1. marker: 2 ("▎ ")
  // 2. status: 8 ("🟢 Ready ") + 1 space
  // 3. ci: 2 ("✔ ") + 1 space
  // 4. rev: revColWidth + 1 space
  // 5. repo: repoColWidth + 1 space
  // 6. prNum: 6 ("#142  ") + 1 space
  // 7. branch: branchColWidth + 1 space
  // 8. title: titleWidth + 1 space
  // 9. age: 5 ("  40d")
  const fixedWidthWithoutTitle =
    2 + 8 + 1 + 2 + 1 + revColWidth + 1 + repoColWidth + 1 + 6 + 1 + branchColWidth + 1 + 1 + 5;
  const titleWidth = Math.max(4, safeWidth - fixedWidthWithoutTitle);

  // Table header in cool slate
  const repoHeader = 'REPO'.padEnd(repoColWidth);
  const numHeader = '#'.padEnd(6);
  const branchHeader = 'BRANCH'.padEnd(branchColWidth);
  const titleHeader = 'TITLE'.padEnd(titleWidth);
  const statusHeader = 'STATUS'.padEnd(8);
  const ciHeader = 'CI'.padEnd(2);
  const revHeader = 'REV'.padEnd(revColWidth);
  const ageHeader = 'AGE'.padStart(5);

  const header = `  ${repoHeader} ${numHeader} ${branchHeader} ${titleHeader} ${statusHeader} ${ciHeader} ${revHeader} ${ageHeader}`;
  lines.push(`\x1B[${rgbColor(colors.fgDim)}${padEndVisual(header, safeWidth)}\x1B[0m`);

  if (prs.length === 0) {
    lines.push(
      `\x1B[${rgbColor(colors.fgMuted)}${padEndVisual('  (No pull requests found matching filter)', safeWidth)}\x1B[0m`
    );
    while (lines.length < height) {
      lines.push(padEndVisual('', safeWidth));
    }
    return lines;
  }

  // 1. Group PRs by Owner (preserving order of first occurrence)
  const groupsMap = new Map<string, { pr: PrState; originalIndex: number }[]>();
  prs.forEach((pr, idx) => {
    const owner = pr.key.owner || 'Other';
    if (!groupsMap.has(owner)) {
      groupsMap.set(owner, []);
    }
    groupsMap.get(owner)!.push({ pr, originalIndex: idx });
  });

  // 2. Build flat list of visual items (headers + PR rows)
  const items: TableItem[] = [];
  for (const [owner, groupPrs] of groupsMap.entries()) {
    items.push({ type: 'header', owner, count: groupPrs.length });
    for (const item of groupPrs) {
      items.push({ type: 'pr', pr: item.pr, originalIndex: item.originalIndex });
    }
  }

  // 3. Find visual index of the selected PR
  const selectedItemIndex = items.findIndex(
    (item) => item.type === 'pr' && item.originalIndex === selectedIndex
  );

  // 4. Calculate scrolling window
  const maxRows = Math.max(1, height - 1); // 1 line for table header
  let startIndex = 0;

  if (items.length > maxRows && selectedItemIndex >= 0) {
    const half = Math.floor(maxRows / 2);
    startIndex = Math.max(0, Math.min(items.length - maxRows, selectedItemIndex - half));
  }

  const visibleItems = items.slice(startIndex, startIndex + maxRows);

  for (const item of visibleItems) {
    if (item.type === 'header') {
      const isUser =
        currentUser && currentUser !== 'unknown'
          ? item.owner.toLowerCase() === currentUser.toLowerCase()
          : false;
      const icon = isUser ? '👤' : '🏢';
      const label = `── ${icon} ${item.owner} `;
      const badge = `(${item.count})`;
      const prefixVisualLen = visualLength(label) + visualLength(badge) + 2;
      const dashCount = Math.max(0, safeWidth - prefixVisualLen);
      const dashes = '─'.repeat(dashCount);

      const headerRow = `\x1B[${rgbColor(colors.border)}── \x1B[1;37m${icon} ${item.owner}\x1B[0m \x1B[${rgbColor(colors.cyan)}${badge}\x1B[0m \x1B[${rgbColor(colors.border)}${dashes}\x1B[0m`;
      lines.push(padEndVisual(headerRow, safeWidth));
      continue;
    }

    const pr = item.pr;
    const isSelected = item.originalIndex === selectedIndex;

    // Solid cyan marker on selected row
    const marker = isSelected ? `\x1B[${rgbColor(colors.cyan)}▎\x1B[0m ` : '  ';
    const worker = options.workers?.get(prKeyToString(pr.key));
    const isWorkerRunning = worker?.status === 'running';

    const sIcon = isWorkerRunning
      ? getSpinnerChar(options.spinnerTick)
      : statusIcon(pr.overallStatus);
    const sName = isWorkerRunning
      ? worker!.agentName.slice(0, 6).padEnd(6)
      : pr.overallStatus.slice(0, 6).padEnd(6);
    const sc = isWorkerRunning
      ? rgbColor(colors.yellow)
      : rgbColor(statusColor(pr.overallStatus));
    const cIcon = ciIcon(pr.ciStatus, options.spinnerTick);
    const cc = rgbColor(ciColor(pr.ciStatus));

    // Format REV review badge
    const revBadge = formatReviewBadge(pr);
    let revColorHex = colors.fgMuted;
    if (revBadge.kind === 'approved') revColorHex = colors.green;
    else if (revBadge.kind === 'changes_requested') revColorHex = colors.red;
    else if (revBadge.kind === 'pending') revColorHex = colors.yellow;

    const revText = padEndVisual(truncateVisual(revBadge.text, revColWidth), revColWidth);
    const repoName = truncateVisual(pr.key.repo, repoColWidth).padEnd(repoColWidth);
    const prNum = `#${pr.key.number}`.padEnd(6);
    const branch = truncateVisual(pr.branch, branchColWidth).padEnd(branchColWidth);
    const title = truncateVisual(pr.title, titleWidth).padEnd(titleWidth);
    const age = formatTimeAgo(pr.updatedAt).padStart(5);

    const bgPrefix = isSelected ? `\x1B[48;2;30;41;59m` : '';
    const bgReset = isSelected ? `\x1B[0m` : '';

    const repoPart = `\x1B[${rgbColor(colors.fg)}${repoName}\x1B[0m`;
    const numPart = `\x1B[${rgbColor(colors.fg)}${prNum}\x1B[0m`;
    const branchPart = `\x1B[${rgbColor(colors.fgDim)}${branch}\x1B[0m`;
    const titlePart = `\x1B[${rgbColor(colors.fg)}${title}\x1B[0m`;
    const statusPart = `\x1B[${sc}${sIcon} ${sName}\x1B[0m`;
    const ciPart = `\x1B[${cc}${cIcon} \x1B[0m`;
    const revPart = `\x1B[${rgbColor(revColorHex)}${revText}\x1B[0m`;
    const agePart = `\x1B[${rgbColor(colors.fgMuted)}${age}\x1B[0m`;

    const rowContent = `${bgPrefix}${marker}${repoPart} ${numPart} ${branchPart} ${titlePart} ${statusPart} ${ciPart} ${revPart} ${agePart}${bgReset}`;

    lines.push(padEndVisual(rowContent, safeWidth));
  }

  // Pad remaining rows if table is shorter than viewport
  while (lines.length < height) {
    lines.push(padEndVisual('', safeWidth));
  }

  return lines;
}
