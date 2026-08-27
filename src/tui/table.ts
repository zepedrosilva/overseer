import type { PrState, WorkerHandle, RepoPolicyConfig } from '../app/types.js';
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
  scope?: 'mine' | 'team';
  currentUser?: string;
  workers?: Map<string, WorkerHandle>;
  repoPolicies?: Record<string, RepoPolicyConfig>;
  agentsEnabled?: boolean;
  teamProfiles?: Record<string, { login: string; name?: string }>;
  spinnerTick?: number;
}

type TableItem =
  | { type: 'header'; owner: string; count: number }
  | { type: 'pr'; pr: PrState; originalIndex: number };

export function renderTable(options: RenderTableOptions): string[] {
  const { prs, selectedIndex, width, height, scope, currentUser } = options;
  const lines: string[] = [];

  const safeWidth = Math.max(10, width - 2);
  const isTeam = scope === 'team';

  // Responsive column width allocation (repo column consistently set to 25)
  let revColWidth = 12;
  let repoColWidth = 25;
  let branchColWidth = 15;
  let authorColWidth = isTeam ? 12 : 0;

  if (safeWidth < 60) {
    revColWidth = 5;
    repoColWidth = 12;
    branchColWidth = 6;
    authorColWidth = isTeam ? 6 : 0;
  } else if (safeWidth < 75) {
    revColWidth = 6;
    repoColWidth = 16;
    branchColWidth = 8;
    authorColWidth = isTeam ? 8 : 0;
  } else if (safeWidth < 95) {
    revColWidth = 8;
    repoColWidth = 20;
    branchColWidth = 10;
    authorColWidth = isTeam ? 10 : 0;
  } else if (safeWidth < 115) {
    revColWidth = 10;
    repoColWidth = 22;
    branchColWidth = 12;
    authorColWidth = isTeam ? 11 : 0;
  }

  // Exact column breakdown:
  // 1. marker: 2 ("▎ ")
  // 2. status: 8 ("🟢 Ready ") + 1 space
  // 3. ci: 2 ("✔ ") + 1 space
  // 4. rev: revColWidth + 1 space
  // 5. repo: repoColWidth + 1 space
  // 6. prNum: 6 ("#142  ") + 1 space
  // 7. author: (authorColWidth ? authorColWidth + 1 space : 0)
  // 8. branch: branchColWidth + 1 space
  // 9. title: titleWidth + 1 space
  // 10. age: 5 ("  40d")
  const authorSpacing = isTeam ? authorColWidth + 1 : 0;
  const fixedWidthWithoutTitle =
    2 + 8 + 1 + 2 + 1 + revColWidth + 1 + repoColWidth + 1 + 6 + 1 + authorSpacing + branchColWidth + 1 + 1 + 5;
  const titleWidth = Math.max(4, safeWidth - fixedWidthWithoutTitle);

  // Table header in cool slate
  const repoHeader = 'REPO'.padEnd(repoColWidth);
  const numHeader = '#'.padEnd(6);
  const authorHeader = isTeam ? 'AUTHOR'.padEnd(authorColWidth) + ' ' : '';
  const branchHeader = 'BRANCH'.padEnd(branchColWidth);
  const titleHeader = 'TITLE'.padEnd(titleWidth);
  const statusHeader = 'STATUS'.padEnd(8);
  const ciHeader = 'CI'.padEnd(2);
  const revHeader = 'REV'.padEnd(revColWidth);
  const ageHeader = 'AGE'.padStart(5);

  const header = `  ${repoHeader} ${numHeader} ${authorHeader}${branchHeader} ${titleHeader} ${statusHeader} ${ciHeader} ${revHeader} ${ageHeader}`;
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

  // 2. Build flat list of visual items (headers + PR rows) with organizations sorted alphabetically by name
  const sortedOwners = Array.from(groupsMap.keys()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );

  const items: TableItem[] = [];
  for (const owner of sortedOwners) {
    const groupPrs = groupsMap.get(owner)!;
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
    const agentsEnabled = options.agentsEnabled !== false;
    const worker = agentsEnabled ? options.workers?.get(prKeyToString(pr.key)) : undefined;
    const isWorkerRunning = Boolean(worker && worker.status === 'running');
    const isDryRunWorker = Boolean(worker && worker.status === 'dry-run');

    let sIcon = statusIcon(pr.overallStatus);
    let sName = pr.overallStatus.slice(0, 6).padEnd(6);
    let sc = rgbColor(statusColor(pr.overallStatus));

    if (isWorkerRunning) {
      const activeRunningList = Array.from(options.workers?.values() || []).filter((w) => w.status === 'running');
      const activeIdx = activeRunningList.findIndex(
        (w) =>
          w.prKey.owner === pr.key.owner &&
          w.prKey.repo === pr.key.repo &&
          w.prKey.number === pr.key.number
      );
      const workerIdxStr = activeIdx >= 0 ? `[${activeIdx + 1}]` : '';
      sIcon = getSpinnerChar(options.spinnerTick);
      const agentShort = worker!.agentName.slice(0, 3);
      sName = workerIdxStr ? `${workerIdxStr}${agentShort}`.slice(0, 6).padEnd(6) : worker!.agentName.slice(0, 6).padEnd(6);
      sc = rgbColor(colors.yellow);
    } else if (isDryRunWorker) {
      sIcon = '🟡';
      sName = 'DRY'.padEnd(6);
      sc = rgbColor(colors.yellow);
    }
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
    const profile = options.teamProfiles?.[pr.author.toLowerCase()];
    const rawAuthor = profile?.name || pr.author;
    const authorName = isTeam ? truncateVisual(rawAuthor, authorColWidth).padEnd(authorColWidth) : '';
    const branch = truncateVisual(pr.branch, branchColWidth).padEnd(branchColWidth);

    // Check Repo Policy Mode indicator (🟢 LIVE / 🟡 DRY-RUN / ⚪ OFF) when agents are enabled
    const repoKey = `${pr.key.owner}/${pr.key.repo}`.toLowerCase();
    const repoPolicy = options.repoPolicies?.[repoKey] || options.repoPolicies?.['*'];
    const repoMode = repoPolicy?.mode || 'off';
    const modeDot = agentsEnabled
      ? repoMode === 'live'
        ? `\x1B[1;32m●\x1B[0m `
        : repoMode === 'dry-run'
        ? `\x1B[1;33m🟡\x1B[0m `
        : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m `
      : '';
    const modeDotLen = modeDot ? 2 : 0;
    const availableRepoWidth = Math.max(2, repoColWidth - modeDotLen);

    const isCompleted =
      pr.overallStatus === 'Merged' ||
      pr.overallStatus === 'Closed' ||
      pr.state === 'MERGED' ||
      pr.state === 'CLOSED';

    const branchColor = isCompleted ? colors.fgMuted : colors.fgDim;
    const titleColor = isCompleted ? colors.fgDim : colors.fg;
    const completedTime = pr.mergedAt || pr.closedAt || pr.updatedAt;
    const age = formatTimeAgo(completedTime).padStart(5);

    const bgPrefix = isSelected ? `\x1B[48;2;30;41;59m` : '';
    const bgReset = isSelected ? `\x1B[0m` : '';

    const repoPart = `${modeDot}\x1B[${rgbColor(colors.fg)}${truncateVisual(pr.key.repo, availableRepoWidth).padEnd(availableRepoWidth)}\x1B[0m`;
    const numPart = `\x1B[${rgbColor(colors.fg)}${prNum}\x1B[0m`;
    const authorPart = isTeam ? `\x1B[${rgbColor(colors.cyan)}${authorName}\x1B[0m ` : '';
    const branchPart = `\x1B[${rgbColor(branchColor)}${branch}\x1B[0m`;
    const titlePart = `\x1B[${rgbColor(titleColor)}${truncateVisual(pr.title, titleWidth).padEnd(titleWidth)}\x1B[0m`;
    const statusPart = `\x1B[${sc}${sIcon} ${sName}\x1B[0m`;
    const ciPart = `\x1B[${cc}${cIcon} \x1B[0m`;
    const revPart = `\x1B[${rgbColor(revColorHex)}${revText}\x1B[0m`;
    const agePart = `\x1B[${rgbColor(colors.fgMuted)}${age}\x1B[0m`;

    const rowContent = `${bgPrefix}${marker}${repoPart} ${numPart} ${authorPart}${branchPart} ${titlePart} ${statusPart} ${ciPart} ${revPart} ${agePart}${bgReset}`;

    lines.push(padEndVisual(rowContent, safeWidth));
  }

  // Pad remaining rows if table is shorter than viewport
  while (lines.length < height) {
    lines.push(padEndVisual('', safeWidth));
  }

  return lines;
}
