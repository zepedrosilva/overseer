import type { PrState } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { colors, rgbColor, statusColor, statusIcon, ciIcon, ciColor, getSpinnerChar } from './colors.js';
import { padEndVisual, truncateVisual, visualLength } from './layout.js';

export function renderDetails(
  pr: PrState | null,
  width: number,
  height: number
): string[] {
  const safeWidth = Math.max(10, width - 2);
  if (!pr) {
    const lines = [`\x1B[${rgbColor(colors.fgMuted)}${padEndVisual('  (Select a Pull Request to view details)', safeWidth)}\x1B[0m`];
    while (lines.length < height) {
      lines.push(padEndVisual('', safeWidth));
    }
    return lines;
  }
  return renderDetailsModal({ pr, modalWidth: width, modalHeight: height });
}

export interface RenderDetailsModalOptions {
  pr: PrState;
  modalWidth: number;
  modalHeight: number;
  scrollOffset?: number;
  spinnerTick?: number;
}

export function renderDetailsModal(options: RenderDetailsModalOptions): string[] {
  const { pr, modalWidth, modalHeight, scrollOffset = 0, spinnerTick = 0 } = options;
  const lines: string[] = [];
  const innerWidth = Math.max(6, modalWidth - 4); // 2 chars for borders, 2 chars for padding
  const innerHeight = Math.max(4, modalHeight - 2); // 2 chars for top & bottom borders

  const keyStr = prKeyToString(pr.key);
  const sColor = rgbColor(statusColor(pr.overallStatus));
  const sIcon = statusIcon(pr.overallStatus);
  const borderColor = rgbColor(colors.cyan);
  const dimBorder = rgbColor(colors.border);

  // 1. Adaptive top border
  let topTitle = ` PR Details: ${keyStr} `;
  let topHints = ` [Esc/Enter to close] `;

  if (visualLength(topTitle) + visualLength(topHints) + 4 > modalWidth) {
    topTitle = ` #${pr.key.number}: ${pr.key.repo} `;
    topHints = ` [Esc: close] `;
  }
  if (visualLength(topTitle) + visualLength(topHints) + 4 > modalWidth) {
    topTitle = ` #${pr.key.number} `;
    topHints = ` [Esc] `;
  }
  if (visualLength(topTitle) + visualLength(topHints) + 4 > modalWidth) {
    topTitle = ` #${pr.key.number} `;
    topHints = '';
  }
  if (visualLength(topTitle) + 4 > modalWidth) {
    topTitle = '';
    topHints = '';
  }

  const topRemaining = Math.max(0, modalWidth - visualLength(topTitle) - visualLength(topHints) - 4);
  const topBorder = `\x1B[${borderColor}┌─\x1B[0m\x1B[1;37m${topTitle}\x1B[0m\x1B[${dimBorder}${'─'.repeat(topRemaining)}\x1B[0m\x1B[${rgbColor(colors.fgDim)}${topHints}\x1B[0m\x1B[${borderColor}─┐\x1B[0m`;
  lines.push(padEndVisual(topBorder, modalWidth));

  // 2. Prepare inner content lines
  const contentLines: string[] = [];

  // Title & Basic Info
  contentLines.push(`\x1B[${sColor}${sIcon}\x1B[0m \x1B[1;37m${truncateVisual(pr.title, innerWidth - 4)}\x1B[0m`);
  contentLines.push(
    `\x1B[${rgbColor(colors.fgDim)}Branch:\x1B[0m \x1B[${rgbColor(colors.fg)}${pr.branch}\x1B[0m \x1B[${rgbColor(colors.fgDim)}➜\x1B[0m \x1B[${rgbColor(colors.fgDim)}${pr.baseBranch}\x1B[0m  │  \x1B[${rgbColor(colors.fgDim)}Author:\x1B[0m \x1B[${rgbColor(colors.cyan)}@${pr.author}\x1B[0m`
  );
  contentLines.push(
    `\x1B[${rgbColor(colors.fgDim)}URL:\x1B[0m \x1B[${rgbColor(colors.cyan)}${pr.url}\x1B[0m`
  );

  // Status & Reviews
  const vColor = pr.reviewVerdict === 'APPROVED' ? colors.green : pr.reviewVerdict === 'CHANGES_REQUESTED' ? colors.red : colors.yellow;
  const cColor = rgbColor(ciColor(pr.ciStatus));
  const cIcon = ciIcon(pr.ciStatus);

  contentLines.push(
    `\x1B[${rgbColor(colors.fgDim)}Review:\x1B[0m \x1B[${rgbColor(vColor)}${pr.reviewVerdict}\x1B[0m  │  \x1B[${rgbColor(colors.fgDim)}CI:\x1B[0m \x1B[${cColor}${cIcon} ${pr.ciStatus}\x1B[0m  │  \x1B[${rgbColor(colors.fgDim)}Comments:\x1B[0m ${pr.commentsCount}  │  \x1B[${rgbColor(pr.unresolvedThreadsCount > 0 ? colors.yellow : colors.fgDim)}Threads:\x1B[0m ${pr.unresolvedThreadsCount} unres.`
  );

  if (pr.statusDetail) {
    contentLines.push(`\x1B[${rgbColor(colors.fgDim)}Status Detail:\x1B[0m ${pr.statusDetail}`);
  }
  if (pr.agent) {
    contentLines.push(`\x1B[${rgbColor(colors.cyan)}Assigned Agent:\x1B[0m ${pr.agent}`);
  }

  contentLines.push(`\x1B[${dimBorder}${'─'.repeat(innerWidth)}\x1B[0m`);

  // Reviewers & Approvals Section
  const reqStr = pr.requiredApprovalsCount && pr.requiredApprovalsCount > 0
    ? `${pr.requiredApprovalsCount} required`
    : 'None configured';
  contentLines.push(`\x1B[${rgbColor(colors.cyan)}Reviewers & Approvals (${reqStr}):\x1B[0m`);

  let hasReviewers = false;
  if (pr.approvedReviewers && pr.approvedReviewers.length > 0) {
    hasReviewers = true;
    contentLines.push(`  \x1B[${rgbColor(colors.green)}✔ Approved:\x1B[0m ${pr.approvedReviewers.map(u => `@${u}`).join(', ')}`);
  }
  if (pr.changesRequestedReviewers && pr.changesRequestedReviewers.length > 0) {
    hasReviewers = true;
    contentLines.push(`  \x1B[${rgbColor(colors.red)}✖ Changes Requested:\x1B[0m ${pr.changesRequestedReviewers.map(u => `@${u}`).join(', ')}`);
  }
  if (pr.requestedReviewers && pr.requestedReviewers.length > 0) {
    hasReviewers = true;
    contentLines.push(`  \x1B[${rgbColor(colors.yellow)}○ Pending:\x1B[0m ${pr.requestedReviewers.map(u => `@${u}`).join(', ')}`);
  }
  if (!hasReviewers) {
    contentLines.push(`  \x1B[${rgbColor(colors.fgMuted)}(No reviewers assigned or requested)\x1B[0m`);
  }

  contentLines.push(`\x1B[${dimBorder}${'─'.repeat(innerWidth)}\x1B[0m`);

  // CI Checks Section
  if (pr.ciChecks && pr.ciChecks.length > 0) {
    contentLines.push(`\x1B[${rgbColor(colors.cyan)}CI Checks (${pr.ciChecks.length}):\x1B[0m`);
    for (const check of pr.ciChecks) {
      let icon = '✓';
      let cHex = colors.green;
      if (check.conclusion === 'FAILURE' || check.conclusion === 'TIMED_OUT' || check.conclusion === 'CANCELLED') {
        icon = '✗';
        cHex = colors.red;
      } else if (check.status === 'IN_PROGRESS' || check.status === 'QUEUED') {
        icon = getSpinnerChar(spinnerTick);
        cHex = colors.yellow;
      }
      const details = check.url ? ` \x1B[${rgbColor(colors.fgDim)}(${check.url})\x1B[0m` : '';
      contentLines.push(`  \x1B[${rgbColor(cHex)}${icon}\x1B[0m ${check.name}${details}`);
    }
    contentLines.push(`\x1B[${dimBorder}${'─'.repeat(innerWidth)}\x1B[0m`);
  }

  // Activity & Agent Logs Section
  contentLines.push(`\x1B[${rgbColor(colors.cyan)}Activity & Logs (${pr.log?.length || 0}):\x1B[0m`);
  if (!pr.log || pr.log.length === 0) {
    contentLines.push(`\x1B[${rgbColor(colors.fgMuted)}  (No activity logged yet)\x1B[0m`);
  } else {
    for (const entry of pr.log) {
      contentLines.push(`  \x1B[${rgbColor(colors.fgDim)}${entry}\x1B[0m`);
    }
  }

  // Handle scroll window
  const maxScroll = Math.max(0, contentLines.length - innerHeight);
  const actualScroll = Math.max(0, Math.min(maxScroll, scrollOffset));
  const visibleContent = contentLines.slice(actualScroll, actualScroll + innerHeight);

  // Render inner rows with borders, strictly truncated and padded to innerWidth
  const leftBorder = `\x1B[${borderColor}│\x1B[0m `;
  const rightBorder = ` \x1B[${borderColor}│\x1B[0m`;

  for (let i = 0; i < innerHeight; i++) {
    const raw = visibleContent[i] || '';
    const truncated = truncateVisual(raw, innerWidth);
    const padded = padEndVisual(truncated, innerWidth);
    lines.push(`${leftBorder}${padded}${rightBorder}`);
  }

  // 3. Adaptive bottom border with action badges
  const scrollIndicator = maxScroll > 0 ? ` [${actualScroll + 1}/${maxScroll + 1} ↑↓] ` : '';
  const fixedBottomWidth = 4 + visualLength(scrollIndicator); // 2 for └─, 2 for ─┘, plus scrollIndicator
  const maxActionsWidth = Math.max(0, modalWidth - fixedBottomWidth);

  const actionsCandidates = [
    { key: 'o', label: 'open' },
    { key: 'm', label: 'merge' },
    { key: 'a', label: 'agent' },
    { key: 'd', label: 'diff' },
    { key: 'c', label: 'comment' },
    { key: 'x', label: 'close' },
  ];

  const selectedBadges: string[] = [];
  let currentActionsVisualLen = 0;

  for (const candidate of actionsCandidates) {
    const rawBadge = `[${candidate.key}]${candidate.label}`;
    const needed = (selectedBadges.length === 0 ? 2 : 1) + rawBadge.length + 1; // space before and after
    if (currentActionsVisualLen + needed <= maxActionsWidth) {
      selectedBadges.push(`\x1B[${rgbColor(colors.cyan)}[${candidate.key}]\x1B[0m\x1B[${rgbColor(colors.fgDim)}${candidate.label}\x1B[0m`);
      currentActionsVisualLen += (selectedBadges.length === 1 ? 2 : 1) + rawBadge.length;
    }
  }

  const actionsStr = selectedBadges.length > 0 ? ` ${selectedBadges.join(' ')} ` : '';
  const bottomRemaining = Math.max(0, modalWidth - visualLength(actionsStr) - visualLength(scrollIndicator) - 4);
  const bottomBorder = `\x1B[${borderColor}└─\x1B[0m${actionsStr}\x1B[${dimBorder}${'─'.repeat(bottomRemaining)}\x1B[0m\x1B[${rgbColor(colors.cyan)}${scrollIndicator}\x1B[0m\x1B[${borderColor}─┘\x1B[0m`;
  lines.push(padEndVisual(bottomBorder, modalWidth));

  return lines;
}
