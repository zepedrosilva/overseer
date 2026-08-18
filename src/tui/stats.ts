// ── TUI Stats & Velocity Modal ──────────────────────────────────────────────
// Visual performance dashboard with 30d metrics, embedded trends, and team stack ranking.

import type { AggregatedStats, StatsTimeframe, LeaderboardSort } from '../app/types.js';
import { colors, rgbColor } from './colors.js';
import { padEndVisual, visualLength, truncateVisual } from './layout.js';

export interface RenderStatsModalOptions {
  stats: AggregatedStats;
  timeframe?: StatsTimeframe;
  scope: 'mine' | 'team';
  sortBy?: LeaderboardSort;
  teamName?: string;
  modalWidth: number;
  modalHeight: number;
}

export function renderStatsModal(options: RenderStatsModalOptions): string[] {
  const { stats, scope, sortBy = 'merged30', teamName, modalWidth, modalHeight } = options;

  const innerWidth = Math.max(10, modalWidth - 4);
  const outputLines: string[] = [];

  const cleanTeam = teamName ? teamName.replace(/^[^/]+\//, '') : 'Team';
  const scopeLabel = scope === 'team' ? `Team: ${cleanTeam}` : 'Mine';

  // 1. Top Header Border
  const titleLeft = ` PR Stats & Leaderboard: ${scopeLabel} (30d trailing)`;
  const titleRight = ` [Esc to close] `;
  const availableDash = modalWidth - visualLength(titleLeft) - visualLength(titleRight) - 4;

  let topBorder: string;
  if (availableDash >= 0) {
    const dashes = '─'.repeat(availableDash);
    topBorder = `\x1B[${rgbColor(colors.cyan)}┌─\x1B[1;37m${titleLeft}\x1B[0m\x1B[${rgbColor(colors.cyan)}${dashes}\x1B[${rgbColor(colors.fgDim)}${titleRight}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┐\x1B[0m`;
  } else {
    topBorder = `\x1B[${rgbColor(colors.cyan)}┌${'─'.repeat(Math.max(0, modalWidth - 2))}┐\x1B[0m`;
  }
  outputLines.push(padEndVisual(topBorder, modalWidth));

  // Helper to add boxed content lines
  const addLine = (content: string) => {
    const truncated = truncateVisual(content, innerWidth);
    const padded = padEndVisual(truncated, innerWidth);
    outputLines.push(`\x1B[${rgbColor(colors.cyan)}│\x1B[0m ${padded} \x1B[${rgbColor(colors.cyan)}│\x1B[0m`);
  };

  const addDivider = () => {
    const div = '─'.repeat(innerWidth);
    outputLines.push(`\x1B[${rgbColor(colors.cyan)}├─${div}─┤\x1B[0m`);
  };

  // 2. Scope & Sort Bar
  const isMine = scope === 'mine';
  const mineDot = isMine ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
  const mineText = isMine ? '\x1B[1;37mMine\x1B[0m' : `\x1B[${rgbColor(colors.fgDim)}Mine\x1B[0m`;

  const isTeam = scope === 'team';
  const teamDot = isTeam ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
  const teamText = isTeam ? `\x1B[1;37mTeam: ${cleanTeam}\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}Team: ${cleanTeam}\x1B[0m`;

  const sortNames: Record<LeaderboardSort, string> = {
    merged30: '30d Merged PRs',
    merged60: '60d Merged PRs',
    merged90: '90d Merged PRs',
    total: 'Total PRs',
    comments: 'Discussion Density',
    stale: 'Stale Bottlenecks',
  };
  const sortLabel = sortNames[sortBy];

  const scopeTabs = `Scope: \x1B[${rgbColor(colors.fgDim)}[Tab/t]\x1B[0m ${mineDot} ${mineText}  ${teamDot} ${teamText}`;
  const sortTabs = isTeam
    ? `    Leaderboard Sort: \x1B[${rgbColor(colors.fgDim)}[s]\x1B[0m \x1B[1;37m● ${sortLabel}\x1B[0m`
    : '';

  addLine(`${scopeTabs}${sortTabs}`);
  addDivider();

  // 3. Code Volume & Low-Level Metrics
  const addStr = `\x1B[${rgbColor(colors.green)}+${stats.totalAdditions.toLocaleString()}\x1B[0m`;
  const delStr = `\x1B[${rgbColor(colors.red)}-${stats.totalDeletions.toLocaleString()}\x1B[0m`;
  const sizeDist = `${stats.sizeDistribution.smallPercent}% S (<100L)  │  ${stats.sizeDistribution.mediumPercent}% M (100-500L)  │  ${stats.sizeDistribution.largePercent}% L (>500L)`;

  const m30Str = `\x1B[1;37m${stats.mergedPRs30 ?? stats.mergedPRs}\x1B[0m (30d)`;
  const m60Str = `\x1B[1;37m${stats.mergedPRs60 ?? stats.mergedPRs}\x1B[0m (60d)`;
  const m90Str = `\x1B[1;37m${stats.mergedPRs90 ?? stats.mergedPRs}\x1B[0m (90d)`;

  addLine(`\x1B[1;37m📦 Code Volume & Merged PR History\x1B[0m`);
  addLine(`  • Merged PRs:  ${m30Str}  │  ${m60Str}  │  ${m90Str}  (${stats.openPRs} open, ${stats.closedPRs} closed)  │  Avg Size: \x1B[1;37m${stats.avgPRSize}L\x1B[0m`);
  addLine(`  • Code Diff:   ${addStr} / ${delStr}  │  Files: \x1B[1;37m${stats.totalChangedFiles}\x1B[0m  │  Commits: \x1B[1;37m${stats.totalCommits}\x1B[0m (${stats.avgCommitsPerPR}/PR)`);
  addLine(`  • PR Tiers:    \x1B[${rgbColor(colors.fgDim)}${sizeDist}\x1B[0m`);
  addDivider();

  // 4. Velocity & Review Turnaround
  const reviewTimeStr = stats.medianTimeToFirstReviewHours !== null
    ? `\x1B[1;37m${stats.medianTimeToFirstReviewHours}h\x1B[0m`
    : `\x1B[${rgbColor(colors.fgDim)}N/A\x1B[0m`;

  const mergeTimeStr = stats.medianTimeToMergeDays !== null
    ? `\x1B[1;37m${stats.medianTimeToMergeDays}d\x1B[0m`
    : `\x1B[${rgbColor(colors.fgDim)}N/A\x1B[0m`;

  const ciColor = stats.ciPassRatePercent >= 90 ? rgbColor(colors.green) : stats.ciPassRatePercent >= 75 ? rgbColor(colors.yellow) : rgbColor(colors.red);
  const ciStr = `\x1B[${ciColor}${stats.ciPassRatePercent}%\x1B[0m \x1B[${rgbColor(colors.fgDim)}(${stats.passedCiRuns}/${stats.totalCiRuns} runs)\x1B[0m`;

  addLine(`\x1B[1;37m⏱️ Velocity & Review Turnaround\x1B[0m`);
  addLine(`  • Median Time to First Review: ${reviewTimeStr}      • Median Time to Merge: ${mergeTimeStr}`);
  addLine(`  • CI Pass Rate:                ${ciStr}   • Discussion Density:   \x1B[1;37m${stats.reviewDensityCommentsPerPR}\x1B[0m cmts/PR`);

  // 5. Stack-Ranked Leaderboard Section (in Team View)
  if (scope === 'team') {
    addDivider();
    if (!teamName || teamName.trim() === '') {
      addLine(`\x1B[${rgbColor(colors.fgDim)}👥 No team configured. Press [s] to set your GitHub team slug or members list.\x1B[0m`);
    } else if (stats.memberBreakdown && stats.memberBreakdown.length > 0) {
      addLine(`\x1B[1;37m👥 Team Member Leaderboard (Ranked by ${sortLabel})\x1B[0m`);

      // Column Header for member table with exact numerical columns
      const mHead = `  RANK  MEMBER`.padEnd(30) +
      `30d`.padStart(6) +
      `60d`.padStart(6) +
      `90d`.padStart(6) +
      `OPEN`.padStart(6) +
      `CLOSED`.padStart(7) +
      `TOTAL`.padStart(7) +
      `CMTS/PR`.padStart(9) +
      `STALE`.padStart(7);
    addLine(`\x1B[${rgbColor(colors.fgDim)}${mHead}\x1B[0m`);

    // Render all team members with right-aligned columns
    for (let i = 0; i < stats.memberBreakdown.length; i++) {
      const m = stats.memberBreakdown[i];
      const rankStr = `#${m.rank}`.padEnd(4);
      const rankColor = m.rank === 1 ? colors.yellow : m.rank <= 3 ? colors.cyan : colors.fgDim;
      const rawName = m.name ? `${m.name} (@${m.author})` : `@${m.author}`;
      const memberText = `  \x1B[${rgbColor(rankColor)}${rankStr}\x1B[0m\x1B[1;37m${truncateVisual(rawName, 22)}\x1B[0m`;
      const memberCol = padEndVisual(memberText, 30);

      const m30Col = String(m.merged30 ?? 0).padStart(6);
      const m60Col = String(m.merged60 ?? 0).padStart(6);
      const m90Col = String(m.merged90 ?? 0).padStart(6);
      const openCol = String(m.open ?? 0).padStart(6);
      const closedCol = String(m.closed ?? 0).padStart(7);
      const totalCol = String(m.total ?? 0).padStart(7);
      const cmtsCol = `${m.discussionDensity}`.padStart(9);
      const staleStr = m.bottlenecksCount > 0
        ? `\x1B[${rgbColor(colors.yellow)}${String(m.bottlenecksCount).padStart(7)}\x1B[0m`
        : String(0).padStart(7);

      const mLine = `${memberCol}\x1B[${rgbColor(colors.green)}${m30Col}\x1B[0m\x1B[${rgbColor(colors.cyan)}${m60Col}\x1B[0m\x1B[${rgbColor(colors.blue)}${m90Col}\x1B[0m\x1B[1;37m${openCol}\x1B[0m\x1B[${rgbColor(colors.fgDim)}${closedCol}\x1B[0m\x1B[1;37m${totalCol}\x1B[0m${cmtsCol}${staleStr}`;
      addLine(mLine);
    }
  }
}

  // 6. Bottlenecks Section
  if (stats.staleBottlenecks.length > 0) {
    addDivider();
    addLine(`\x1B[${rgbColor(colors.yellow)}⚠️ Bottlenecks Requiring Attention (>3d pending)\x1B[0m`);
    for (let i = 0; i < Math.min(3, stats.staleBottlenecks.length); i++) {
      const b = stats.staleBottlenecks[i];
      const keyStr = `${b.key.owner}/${b.key.repo}#${b.key.number}`;
      addLine(`  \x1B[${rgbColor(colors.yellow)}•\x1B[0m \x1B[1;37m${keyStr}\x1B[0m \x1B[${rgbColor(colors.fgDim)}(${b.daysPending}d pending — ${b.reason})\x1B[0m`);
    }
  }

  // Fill empty space up to modalHeight - 1
  while (outputLines.length < modalHeight - 1) {
    addLine('');
  }

  // 7. Bottom Border
  const footerHelp = ` [Tab] scope  [s] sort  [b] backfill  [Esc/p] close `;
  const botDash = Math.max(0, modalWidth - visualLength(footerHelp) - 4);
  const botBorder = `\x1B[${rgbColor(colors.cyan)}└─\x1B[${rgbColor(colors.fgDim)}${footerHelp}\x1B[0m\x1B[${rgbColor(colors.cyan)}${'─'.repeat(botDash)}─┘\x1B[0m`;
  outputLines.push(padEndVisual(botBorder, modalWidth));

  return outputLines;
}
