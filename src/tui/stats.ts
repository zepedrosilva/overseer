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
  const titleLeft = ` PR Stats & Leaderboard: ${scopeLabel} (${stats.timeframe || '30d'} trailing)`;
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

  // 2. Scope & Timeframe Bar
  const isMine = scope === 'mine';
  const mineDot = isMine ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
  const mineText = isMine ? '\x1B[1;37mMine\x1B[0m' : `\x1B[${rgbColor(colors.fgDim)}Mine\x1B[0m`;

  const isTeam = scope === 'team';
  const teamDot = isTeam ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
  const teamText = isTeam ? `\x1B[1;37mTeam: ${cleanTeam}\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}Team: ${cleanTeam}\x1B[0m`;

  const currentTimeframe = stats.timeframe || '30d';
  const tfList: StatsTimeframe[] = ['7d', '14d', '30d', '60d', '90d'];
  const tfBadges = tfList.map((tf, idx) => {
    const isCurrent = tf === currentTimeframe;
    const dot = isCurrent ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
    const color = isCurrent ? '\x1B[1;37m' : `\x1B[${rgbColor(colors.fgDim)}`;
    return `${dot} \x1B[${rgbColor(colors.cyan)}[${idx + 1}]\x1B[0m ${color}${tf}\x1B[0m`;
  }).join('  ');

  const sortNames: Record<LeaderboardSort, string> = {
    merged7: '7d Merged PRs',
    merged14: '14d Merged PRs',
    merged30: '30d Merged PRs',
    merged60: '60d Merged PRs',
    merged90: '90d Merged PRs',
    total: 'Total PRs',
    comments: 'Discussion Density',
    stale: 'Stale Bottlenecks',
    response: 'Review Response Rate',
    reviews: 'Reviews Given',
  };
  const sortLabel = sortNames[sortBy];

  const scopeTabs = `Scope: \x1B[${rgbColor(colors.fgDim)}[Tab/t]\x1B[0m ${mineDot} ${mineText}  ${teamDot} ${teamText}`;
  const tfTabs = `Timeframe: \x1B[${rgbColor(colors.fgDim)}[1-5/w]\x1B[0m ${tfBadges}`;
  const sortTabs = isTeam
    ? `    Sort: \x1B[${rgbColor(colors.fgDim)}[s]\x1B[0m \x1B[1;37m● ${sortLabel}\x1B[0m`
    : '';

  addLine(scopeTabs);
  addLine(`${tfTabs}${sortTabs}`);
  addDivider();

  // 3. High-Contrast 2x3 KPI Metric Cards
  const addStr = `\x1B[${rgbColor(colors.green)}+${stats.totalAdditions.toLocaleString()}\x1B[0m`;
  const delStr = `\x1B[${rgbColor(colors.red)}-${stats.totalDeletions.toLocaleString()}\x1B[0m`;

  const reviewTimeStr = stats.medianTimeToFirstReviewHours !== null
    ? `\x1B[1;37m${stats.medianTimeToFirstReviewHours} hrs\x1B[0m`
    : `\x1B[${rgbColor(colors.fgDim)}N/A\x1B[0m`;

  const mergeTimeStr = stats.medianTimeToMergeDays !== null
    ? `\x1B[1;37m${stats.medianTimeToMergeDays} days\x1B[0m`
    : `\x1B[${rgbColor(colors.fgDim)}N/A\x1B[0m`;

  const ciColor = stats.ciPassRatePercent >= 90 ? rgbColor(colors.green) : stats.ciPassRatePercent >= 75 ? rgbColor(colors.yellow) : rgbColor(colors.red);
  const respRate = stats.reviewResponseRatePercent ?? 100;
  const respColor = respRate >= 80 ? rgbColor(colors.green) : respRate >= 60 ? rgbColor(colors.yellow) : rgbColor(colors.red);

  interface MetricCard {
    title: string;
    line1: string;
    line2: string;
  }

  const renderCardRow = (cards: MetricCard[]) => {
    const cardCount = cards.length;
    const totalGap = (cardCount - 1) * 2;
    const cardWidth = Math.max(16, Math.floor((innerWidth - totalGap) / cardCount));

    const topParts: string[] = [];
    const l1Parts: string[] = [];
    const l2Parts: string[] = [];
    const botParts: string[] = [];

    for (let i = 0; i < cardCount; i++) {
      const c = cards[i];
      const tStr = ` ${c.title} `;
      const dashCount = Math.max(0, cardWidth - visualLength(tStr) - 3);
      const top = `\x1B[${rgbColor(colors.cyan)}┌─\x1B[1;37m${tStr}\x1B[0m\x1B[${rgbColor(colors.cyan)}${'─'.repeat(dashCount)}┐\x1B[0m`;
      topParts.push(padEndVisual(top, cardWidth));

      const l1Inner = truncateVisual(c.line1, cardWidth - 4);
      const l1 = `\x1B[${rgbColor(colors.cyan)}│\x1B[0m ${padEndVisual(l1Inner, cardWidth - 4)} \x1B[${rgbColor(colors.cyan)}│\x1B[0m`;
      l1Parts.push(padEndVisual(l1, cardWidth));

      const l2Inner = truncateVisual(c.line2, cardWidth - 4);
      const l2 = `\x1B[${rgbColor(colors.cyan)}│\x1B[0m ${padEndVisual(l2Inner, cardWidth - 4)} \x1B[${rgbColor(colors.cyan)}│\x1B[0m`;
      l2Parts.push(padEndVisual(l2, cardWidth));

      const bot = `\x1B[${rgbColor(colors.cyan)}└${'─'.repeat(Math.max(0, cardWidth - 2))}┘\x1B[0m`;
      botParts.push(padEndVisual(bot, cardWidth));
    }

    addLine(topParts.join('  '));
    addLine(l1Parts.join('  '));
    addLine(l2Parts.join('  '));
    addLine(botParts.join('  '));
  };

  // Card Row 1
  renderCardRow([
    {
      title: 'MERGE VELOCITY',
      line1: `\x1B[1;37m${mergeTimeStr}\x1B[0m \x1B[${rgbColor(colors.fgDim)}median merge\x1B[0m`,
      line2: `\x1B[${rgbColor(colors.green)}${stats.mergedPRs} merged PRs\x1B[0m · \x1B[${rgbColor(colors.fgDim)}${stats.openPRs} open\x1B[0m`,
    },
    {
      title: '1ST REVIEW SPEED',
      line1: `\x1B[1;37m${reviewTimeStr}\x1B[0m \x1B[${rgbColor(colors.fgDim)}to 1st review\x1B[0m`,
      line2: `\x1B[${rgbColor(colors.fgDim)}${stats.reviewDensityCommentsPerPR} comments/PR\x1B[0m`,
    },
    {
      title: 'REVIEW RESPONSE',
      line1: `\x1B[${respColor}${respRate}%\x1B[0m \x1B[${rgbColor(colors.fgDim)}response rate\x1B[0m`,
      line2: `\x1B[${rgbColor(colors.fgDim)}${stats.reworkRatePercent ?? 0}% rework (changes req)\x1B[0m`,
    },
  ]);

  // Card Row 2
  renderCardRow([
    {
      title: 'CI PASS HEALTH',
      line1: `\x1B[${ciColor}${stats.ciPassRatePercent}%\x1B[0m \x1B[${rgbColor(colors.fgDim)}pass rate\x1B[0m`,
      line2: `\x1B[${rgbColor(colors.fgDim)}${stats.passedCiRuns}/${stats.totalCiRuns} runs passed\x1B[0m`,
    },
    {
      title: 'CODE DIFF & VOLUME',
      line1: `${addStr} / ${delStr} \x1B[${rgbColor(colors.fgDim)}lines\x1B[0m`,
      line2: `\x1B[${rgbColor(colors.fgDim)}Avg: \x1B[1;37m${stats.avgPRSize} lines/PR\x1B[0m\x1B[${rgbColor(colors.fgDim)} (${stats.totalChangedFiles} files)\x1B[0m`,
    },
    {
      title: 'MERGED VELOCITY',
      line1: `\x1B[1;37m${stats.mergedPRs7 ?? 0}\x1B[0m \x1B[${rgbColor(colors.fgDim)}PRs (7d) ·\x1B[0m \x1B[1;37m${stats.mergedPRs30 ?? stats.mergedPRs}\x1B[0m \x1B[${rgbColor(colors.fgDim)}(30d) ·\x1B[0m \x1B[1;37m${stats.mergedPRs90 ?? stats.mergedPRs}\x1B[0m \x1B[${rgbColor(colors.fgDim)}(90d)\x1B[0m`,
      line2: `\x1B[${rgbColor(colors.fgDim)}${stats.totalCommits} commits (${stats.avgCommitsPerPR} commits/PR)\x1B[0m`,
    },
  ]);

  // Visual PR Sizing Distribution Bar
  const sBlocks = Math.max(1, Math.round((stats.sizeDistribution.smallPercent / 100) * 8));
  const mBlocks = Math.max(1, Math.round((stats.sizeDistribution.mediumPercent / 100) * 8));
  const lBlocks = Math.max(1, Math.round((stats.sizeDistribution.largePercent / 100) * 8));

  const sBar = `\x1B[${rgbColor(colors.green)}${'█'.repeat(sBlocks)}\x1B[0m \x1B[1;37m${stats.sizeDistribution.smallPercent}%\x1B[0m \x1B[${rgbColor(colors.fgDim)}S (<100 lines)\x1B[0m`;
  const mBar = `\x1B[${rgbColor(colors.cyan)}${'█'.repeat(mBlocks)}\x1B[0m \x1B[1;37m${stats.sizeDistribution.mediumPercent}%\x1B[0m \x1B[${rgbColor(colors.fgDim)}M (100-500 lines)\x1B[0m`;
  const lBar = `\x1B[${rgbColor(colors.yellow)}${'█'.repeat(lBlocks)}\x1B[0m \x1B[1;37m${stats.sizeDistribution.largePercent}%\x1B[0m \x1B[${rgbColor(colors.fgDim)}L (>500 lines)\x1B[0m`;

  addLine(`  \x1B[1;37mPR Sizing:\x1B[0m  ${sBar}    ${mBar}    ${lBar}`);

  // 4. Stack-Ranked Leaderboard Section (in Team View)
  if (scope === 'team') {
    addDivider();
    if (!teamName || teamName.trim() === '') {
      addLine(`\x1B[${rgbColor(colors.fgDim)}👥 No team configured. Press [s] to set your GitHub team slug or members list.\x1B[0m`);
    } else if (stats.memberBreakdown && stats.memberBreakdown.length > 0) {
      addLine(`\x1B[1;37m👥 Team Member Leaderboard (Ranked by ${sortLabel})\x1B[0m`);

      // Dynamic Member column width tailored to modal inner width
      const numColsWidth = 5 + 5 + 5 + 5 + 5 + 5 + 6 + 6 + 6 + 7 + 6; // 61 chars
      const memberColWidth = Math.max(20, Math.min(30, innerWidth - numColsWidth));
      const maxNameLen = Math.max(10, memberColWidth - 6);

      // Column Header for member table with exact numerical columns
      const mHead = `  RANK  MEMBER`.padEnd(memberColWidth) +
        `7d`.padStart(5) +
        `14d`.padStart(5) +
        `30d`.padStart(5) +
        `60d`.padStart(5) +
        `90d`.padStart(5) +
        `OPEN`.padStart(5) +
        `TOTAL`.padStart(6) +
        `REQ`.padStart(6) +
        `REV`.padStart(6) +
        `RESP%`.padStart(7) +
        `STALE`.padStart(6);
      addLine(`\x1B[${rgbColor(colors.fgDim)}${mHead}\x1B[0m`);

      // Render all team members with right-aligned columns
      for (let i = 0; i < stats.memberBreakdown.length; i++) {
        const m = stats.memberBreakdown[i];
        const rankStr = `#${m.rank}`.padEnd(4);
        const rankColor = m.rank === 1 ? colors.yellow : m.rank <= 3 ? colors.cyan : colors.fgDim;
        const rawName = m.name ? `${m.name} (@${m.author})` : `@${m.author}`;
        const memberText = `  \x1B[${rgbColor(rankColor)}${rankStr}\x1B[0m\x1B[1;37m${truncateVisual(rawName, maxNameLen)}\x1B[0m`;
        const memberCol = padEndVisual(memberText, memberColWidth);

        const m7Col = String(m.merged7 ?? 0).padStart(5);
        const m14Col = String(m.merged14 ?? 0).padStart(5);
        const m30Col = String(m.merged30 ?? 0).padStart(5);
        const m60Col = String(m.merged60 ?? 0).padStart(5);
        const m90Col = String(m.merged90 ?? 0).padStart(5);
        const openCol = String(m.open ?? 0).padStart(5);
        const totalCol = String(m.total ?? 0).padStart(6);
        const reqCol = String(m.requestsReceived ?? 0).padStart(6);
        const revCol = String(m.reviewsGiven ?? 0).padStart(6);
        const respCol = `${m.responseRatePercent ?? 100}%`.padStart(7);
        const staleStr = m.bottlenecksCount > 0
          ? `\x1B[${rgbColor(colors.yellow)}${String(m.bottlenecksCount).padStart(6)}\x1B[0m`
          : String(0).padStart(6);

        const mRespColor = (m.responseRatePercent ?? 100) >= 80 ? colors.green : (m.responseRatePercent ?? 100) >= 60 ? colors.yellow : colors.red;

        const mLine = `${memberCol}\x1B[${rgbColor(colors.green)}${m7Col}\x1B[0m\x1B[${rgbColor(colors.green)}${m14Col}\x1B[0m\x1B[${rgbColor(colors.cyan)}${m30Col}\x1B[0m\x1B[${rgbColor(colors.blue)}${m60Col}\x1B[0m\x1B[${rgbColor(colors.magenta)}${m90Col}\x1B[0m\x1B[1;37m${openCol}\x1B[0m\x1B[1;37m${totalCol}\x1B[0m\x1B[${rgbColor(colors.fgDim)}${reqCol}\x1B[0m\x1B[${rgbColor(colors.cyan)}${revCol}\x1B[0m\x1B[${rgbColor(mRespColor)}${respCol}\x1B[0m${staleStr}`;
        addLine(mLine);
      }
    }
  }

  // 5. Bottlenecks Section
  if (stats.staleBottlenecks.length > 0) {
    addDivider();
    addLine(`\x1B[${rgbColor(colors.yellow)}⚠️ Bottlenecks Requiring Attention (>3d pending)\x1B[0m`);
    for (let i = 0; i < Math.min(3, stats.staleBottlenecks.length); i++) {
      const b = stats.staleBottlenecks[i];
      const keyStr = `${b.key.owner}/${b.key.repo}#${b.key.number}`;
      addLine(`  \x1B[${rgbColor(colors.yellow)}•\x1B[0m \x1B[1;37m${keyStr}\x1B[0m \x1B[${rgbColor(colors.fgDim)}(${b.daysPending}d pending — ${b.reason})\x1B[0m`);
    }
  }

  // Fill empty space up to modalHeight - 1 or slice if too tall
  if (outputLines.length > modalHeight - 1) {
    outputLines.length = modalHeight - 1;
  } else {
    while (outputLines.length < modalHeight - 1) {
      addLine('');
    }
  }

  // 6. Bottom Border
  const footerHelp = ` [1-5/w] timeframe  [Tab] scope  [s] sort  [b] backfill  [Esc/p] close `;
  const botDash = Math.max(0, modalWidth - visualLength(footerHelp) - 4);
  const botBorder = `\x1B[${rgbColor(colors.cyan)}└─\x1B[${rgbColor(colors.fgDim)}${footerHelp}\x1B[0m\x1B[${rgbColor(colors.cyan)}${'─'.repeat(botDash)}─┘\x1B[0m`;
  outputLines.push(padEndVisual(botBorder, modalWidth));

  return outputLines;
}
