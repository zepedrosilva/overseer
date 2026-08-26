// ── TUI Stats, Velocity & Agent Telemetry Modal ──────────────────────────────
// Visual performance dashboard with 30d PR metrics, team stack ranking,
// and dedicated agent operations telemetry & intervention audit trails.

import type {
  AggregatedStats,
  StatsTimeframe,
  LeaderboardSort,
  AgentAggregatedStats,
} from '../app/types.js';
import { colors, rgbColor } from './colors.js';
import { padEndVisual, visualLength, truncateVisual } from './layout.js';

export interface RenderStatsModalOptions {
  stats: AggregatedStats;
  agentStats?: AgentAggregatedStats;
  activeTab?: 'pr' | 'agents';
  timeframe?: StatsTimeframe;
  scope: 'mine' | 'team';
  sortBy?: LeaderboardSort;
  teamName?: string;
  modalWidth: number;
  modalHeight: number;
}

export function formatDurationMs(ms: number): string {
  if (!ms || ms <= 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

export function renderStatsModal(options: RenderStatsModalOptions): string[] {
  const {
    stats,
    agentStats,
    activeTab = 'pr',
    scope,
    sortBy = 'merged30',
    teamName,
    modalWidth,
    modalHeight,
  } = options;

  const innerWidth = Math.max(10, modalWidth - 4);
  const outputLines: string[] = [];

  const cleanTeam = teamName ? teamName.replace(/^[^/]+\//, '') : 'Team';
  const scopeLabel = scope === 'team' ? `Team: ${cleanTeam}` : 'Mine';

  // 1. Top Header Border
  const titleLeft =
    activeTab === 'agents'
      ? ` 🤖 Agent Operations & Interventions (${stats.timeframe || '30d'} trailing)`
      : ` PR Stats & Leaderboard: ${scopeLabel} (${stats.timeframe || '30d'} trailing)`;
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

  // 2. View Sub-Tabs (PR Velocity vs Agent Telemetry)
  const isPrTab = activeTab === 'pr';
  const isAgentTab = activeTab === 'agents';

  const prTabBadge = isPrTab
    ? `\x1B[${rgbColor(colors.green)}●\x1B[0m \x1B[1;37m[p] PR Velocity & Team\x1B[0m`
    : `\x1B[${rgbColor(colors.fgDim)}○ [p] PR Velocity & Team\x1B[0m`;

  const agentTabBadge = isAgentTab
    ? `\x1B[${rgbColor(colors.green)}●\x1B[0m \x1B[1;37m[a] 🤖 Agent Interventions\x1B[0m`
    : `\x1B[${rgbColor(colors.fgDim)}○ [a] 🤖 Agent Interventions\x1B[0m`;

  addLine(`View: ${prTabBadge}    ${agentTabBadge}`);
  addDivider();

  // ── RENDER AGENT TELEMETRY TAB ─────────────────────────────────────────────
  if (isAgentTab && agentStats) {
    // 1. High-Level KPI Summary
    const totalRuns = agentStats.totalRuns;
    const rateColor =
      agentStats.successRate >= 85
        ? colors.green
        : agentStats.successRate >= 70
        ? colors.yellow
        : colors.red;
    const rateStr = `\x1B[${rgbColor(rateColor)}${agentStats.successRate.toFixed(1)}%\x1B[0m`;
    const avgDurationStr = `\x1B[1;37m${formatDurationMs(agentStats.avgDurationMs)}\x1B[0m`;
    const dryRunStr = `\x1B[${rgbColor(colors.yellow)}${agentStats.dryRunsCount}\x1B[0m`;

    addLine(
      `TOTAL RUNS: \x1B[1;37m${totalRuns}\x1B[0m   │ SUCCESS RATE: ${rateStr}   │ AVG TIME: ${avgDurationStr}   │ DRY-RUNS: ${dryRunStr}`
    );
    addDivider();

    // 2. Performance by Agent
    const agents = Object.entries(agentStats.byAgent);
    if (agents.length > 0) {
      addLine(`\x1B[1;37m📊 Performance by Agent\x1B[0m`);
      const aHead =
        `  AGENT`.padEnd(16) +
        `DISPATCHES`.padStart(12) +
        `SUCCESS %`.padStart(12) +
        `AVG TIME`.padStart(12) +
        `FAILED`.padStart(10) +
        `  TOP PLAYBOOK`;
      addLine(`\x1B[${rgbColor(colors.fgDim)}${aHead}\x1B[0m`);

      for (const [agentName, s] of agents) {
        const agCol = `  \x1B[1;37m${agentName}\x1B[0m`.padEnd(16 + 10);
        const runsCol = String(s.runs).padStart(12);
        const sColor = s.successRate >= 85 ? colors.green : s.successRate >= 70 ? colors.yellow : colors.red;
        const rateCol = `\x1B[${rgbColor(sColor)}${s.successRate.toFixed(1)}%\x1B[0m`.padStart(12 + 10);
        const timeCol = formatDurationMs(s.avgDurationMs).padStart(12);
        const failCol = String(s.failedCount).padStart(10);
        const topPb = s.topPlaybook ? `  \x1B[${rgbColor(colors.cyan)}${s.topPlaybook}\x1B[0m` : '  —';

        addLine(`${agCol}${runsCol}${rateCol}${timeCol}${failCol}${topPb}`);
      }
      addDivider();
    }

    // 3. Performance by Playbook
    const playbooks = Object.entries(agentStats.byPlaybook);
    if (playbooks.length > 0) {
      addLine(`\x1B[1;37m🛠️ Performance by Operation / Playbook\x1B[0m`);
      const pHead =
        `  PLAYBOOK`.padEnd(20) +
        `RUNS`.padStart(10) +
        `SUCCESS %`.padStart(12) +
        `AVG TIME`.padStart(12) +
        `  TOP TARGET REPOSITORY`;
      addLine(`\x1B[${rgbColor(colors.fgDim)}${pHead}\x1B[0m`);

      for (const [pbName, s] of playbooks) {
        const pbCol = `  \x1B[${rgbColor(colors.cyan)}${pbName}\x1B[0m`.padEnd(20 + 10);
        const runsCol = String(s.runs).padStart(10);
        const sColor = s.successRate >= 85 ? colors.green : s.successRate >= 70 ? colors.yellow : colors.red;
        const rateCol = `\x1B[${rgbColor(sColor)}${s.successRate.toFixed(1)}%\x1B[0m`.padStart(12 + 10);
        const timeCol = formatDurationMs(s.avgDurationMs).padStart(12);
        const topR = s.topRepo ? `  \x1B[${rgbColor(colors.fgDim)}${s.topRepo}\x1B[0m` : '  —';

        addLine(`${pbCol}${runsCol}${rateCol}${timeCol}${topR}`);
      }
      addDivider();
    }

    // 4. Breakdown by Repository
    const repos = Object.entries(agentStats.byRepo);
    if (repos.length > 0) {
      addLine(`\x1B[1;37m🏢 Intervention Breakdown by Repository\x1B[0m`);
      const rHead =
        `  REPOSITORY`.padEnd(32) +
        `RUNS`.padStart(8) +
        `AUTO / MAN`.padStart(12) +
        `SUCCESS %`.padStart(12) +
        `  MODE`.padEnd(10) +
        `AGENT`;
      addLine(`\x1B[${rgbColor(colors.fgDim)}${rHead}\x1B[0m`);

      for (const [repoSlug, s] of repos) {
        const rCol = `  \x1B[1;37m${truncateVisual(repoSlug, 28)}\x1B[0m`.padEnd(32 + 10);
        const runsCol = String(s.runs).padStart(8);
        const autoManCol = `${s.autoRuns}/${s.manualRuns}`.padStart(12);
        const sColor = s.successRate >= 85 ? colors.green : s.successRate >= 70 ? colors.yellow : colors.red;
        const rateCol = `\x1B[${rgbColor(sColor)}${s.successRate.toFixed(1)}%\x1B[0m`.padStart(12 + 10);
        const modeBadge =
          s.mode === 'live'
            ? `  \x1B[${rgbColor(colors.green)}🟢 LIVE\x1B[0m  `
            : s.mode === 'dry-run'
            ? `  \x1B[${rgbColor(colors.yellow)}🟡 DRY\x1B[0m   `
            : `  \x1B[${rgbColor(colors.fgDim)}⚪ OFF\x1B[0m   `;
        const agentCol = `\x1B[${rgbColor(colors.cyan)}${s.defaultAgent}\x1B[0m`;

        addLine(`${rCol}${runsCol}${autoManCol}${rateCol}${modeBadge}${agentCol}`);
      }
      addDivider();
    }

    // 5. Recent Audit Trail
    if (agentStats.recentAuditTrail.length > 0) {
      addLine(`\x1B[1;37m📜 Recent Execution Audit Trail\x1B[0m`);
      for (let i = 0; i < Math.min(5, agentStats.recentAuditTrail.length); i++) {
        const r = agentStats.recentAuditTrail[i];
        const timeStr = new Date(r.startedAt).toLocaleTimeString();
        const prStr = `${r.prKey.owner}/${r.prKey.repo}#${r.prKey.number}`;
        const outcome =
          r.status === 'completed'
            ? `\x1B[${rgbColor(colors.green)}✔ Success\x1B[0m`
            : r.status === 'dry-run'
            ? `\x1B[${rgbColor(colors.yellow)}🟡 DRY-RUN\x1B[0m`
            : `\x1B[${rgbColor(colors.red)}✖ Failed\x1B[0m`;
        const dur = formatDurationMs(r.durationMs);

        addLine(
          `  \x1B[${rgbColor(colors.fgDim)}${timeStr}\x1B[0m  \x1B[1;37m${prStr.padEnd(26)}\x1B[0m \x1B[${rgbColor(colors.cyan)}${r.agentName.padEnd(8)}\x1B[0m \x1B[${rgbColor(colors.fgDim)}${r.playbookName.padEnd(16)}\x1B[0m ${dur.padStart(8)}  ${outcome}`
        );
      }
    } else {
      addLine(`\x1B[${rgbColor(colors.fgDim)}No recent agent executions recorded in ./.overseer/agent-stats.json\x1B[0m`);
    }

    // Fill space
    if (outputLines.length > modalHeight - 1) {
      outputLines.length = modalHeight - 1;
    } else {
      while (outputLines.length < modalHeight - 1) {
        addLine('');
      }
    }

    const botHelp = ` [p] PR Velocity tab  [a] Agent tab  [Esc] close `;
    const bDash = Math.max(0, modalWidth - visualLength(botHelp) - 4);
    const bBorder = `\x1B[${rgbColor(colors.cyan)}└─\x1B[${rgbColor(colors.fgDim)}${botHelp}\x1B[0m\x1B[${rgbColor(colors.cyan)}${'─'.repeat(bDash)}─┘\x1B[0m`;
    outputLines.push(padEndVisual(bBorder, modalWidth));
    return outputLines;
  }

  // ── RENDER PR VELOCITY & TEAM TAB ──────────────────────────────────────────
  const isMine = scope === 'mine';
  const mineDot = isMine ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
  const mineText = isMine ? '\x1B[1;37mMine\x1B[0m' : `\x1B[${rgbColor(colors.fgDim)}Mine\x1B[0m`;

  const isTeam = scope === 'team';
  const teamDot = isTeam ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
  const teamText = isTeam ? `\x1B[1;37mTeam: ${cleanTeam}\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}Team: ${cleanTeam}\x1B[0m`;

  const currentTimeframe = stats.timeframe || '30d';
  const tfList: StatsTimeframe[] = ['7d', '14d', '30d', '60d', '90d'];
  const tfBadges = tfList
    .map((tf, idx) => {
      const isCurrent = tf === currentTimeframe;
      const dot = isCurrent ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
      const color = isCurrent ? '\x1B[1;37m' : `\x1B[${rgbColor(colors.fgDim)}`;
      return `${dot} \x1B[${rgbColor(colors.cyan)}[${idx + 1}]\x1B[0m ${color}${tf}\x1B[0m`;
    })
    .join('  ');

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
  const sortTabs = isTeam ? `    Sort: \x1B[${rgbColor(colors.fgDim)}[s]\x1B[0m \x1B[1;37m● ${sortLabel}\x1B[0m` : '';

  addLine(scopeTabs);
  addLine(`${tfTabs}${sortTabs}`);
  addDivider();

  // High-Contrast 2x3 KPI Metric Cards
  const addStr = `\x1B[${rgbColor(colors.green)}+${stats.totalAdditions.toLocaleString()}\x1B[0m`;
  const delStr = `\x1B[${rgbColor(colors.red)}-${stats.totalDeletions.toLocaleString()}\x1B[0m`;

  const reviewTimeStr =
    stats.medianTimeToFirstReviewHours !== null
      ? `\x1B[1;37m${stats.medianTimeToFirstReviewHours} hrs\x1B[0m`
      : `\x1B[${rgbColor(colors.fgDim)}N/A\x1B[0m`;

  const mergeTimeStr =
    stats.medianTimeToMergeDays !== null
      ? `\x1B[1;37m${stats.medianTimeToMergeDays} days\x1B[0m`
      : `\x1B[${rgbColor(colors.fgDim)}N/A\x1B[0m`;

  const ciColor =
    stats.ciPassRatePercent >= 90
      ? rgbColor(colors.green)
      : stats.ciPassRatePercent >= 75
      ? rgbColor(colors.yellow)
      : rgbColor(colors.red);
  const respRate = stats.reviewResponseRatePercent ?? 100;
  const respColor =
    respRate >= 80
      ? rgbColor(colors.green)
      : respRate >= 60
      ? rgbColor(colors.yellow)
      : rgbColor(colors.red);

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

  const row1Cards: MetricCard[] = [
    {
      title: 'TOTAL PRS MONITORED',
      line1: `\x1B[1;37m${stats.totalPRs}\x1B[0m total PRs`,
      line2: `\x1B[${rgbColor(colors.green)}${stats.mergedPRs} merged\x1B[0m, \x1B[${rgbColor(colors.yellow)}${stats.openPRs} open\x1B[0m`,
    },
    {
      title: 'MERGED PR VELOCITY',
      line1: `\x1B[1;37m${stats.mergedPRs30} merged\x1B[0m (30d)`,
      line2: `7d: \x1B[${rgbColor(colors.green)}${stats.mergedPRs7}\x1B[0m  14d: \x1B[${rgbColor(colors.green)}${stats.mergedPRs14}\x1B[0m`,
    },
    {
      title: 'AVG PR SIZE & DIFF',
      line1: `${addStr} / ${delStr}`,
      line2: `Avg: \x1B[1;37m~${stats.avgPRSize} lines\x1B[0m / PR`,
    },
  ];

  const row2Cards: MetricCard[] = [
    {
      title: 'REVIEW TURNAROUND',
      line1: `1st Review: ${reviewTimeStr}`,
      line2: `To Merge:   ${mergeTimeStr}`,
    },
    {
      title: 'CI PASS RATE',
      line1: `\x1B[${ciColor}${stats.ciPassRatePercent}%\x1B[0m success rate`,
      line2: `Checks: \x1B[1;37m${stats.totalCiRuns}\x1B[0m total runs`,
    },
    {
      title: 'DISCUSSION DENSITY',
      line1: `\x1B[1;37m${stats.reviewDensityCommentsPerPR}\x1B[0m comments / PR`,
      line2: `Response: \x1B[${respColor}${respRate}%\x1B[0m`,
    },
  ];

  renderCardRow(row1Cards);
  renderCardRow(row2Cards);

  // Stack-Ranked Leaderboard Section (in Team View)
  if (scope === 'team') {
    addDivider();
    if (!teamName || teamName.trim() === '') {
      addLine(
        `\x1B[${rgbColor(colors.fgDim)}👥 No team configured. Press [s] to set your GitHub team slug or members list.\x1B[0m`
      );
    } else if (stats.memberBreakdown && stats.memberBreakdown.length > 0) {
      addLine(`\x1B[1;37m👥 Team Member Leaderboard (Ranked by ${sortLabel})\x1B[0m`);

      const numColsWidth = 5 + 5 + 5 + 5 + 5 + 5 + 6 + 6 + 6 + 7 + 6;
      const memberColWidth = Math.max(20, Math.min(30, innerWidth - numColsWidth));
      const maxNameLen = Math.max(10, memberColWidth - 6);

      const mHead =
        `  RANK  MEMBER`.padEnd(memberColWidth) +
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
        const staleStr =
          m.bottlenecksCount > 0
            ? `\x1B[${rgbColor(colors.yellow)}${String(m.bottlenecksCount).padStart(6)}\x1B[0m`
            : String(0).padStart(6);

        const mRespColor =
          (m.responseRatePercent ?? 100) >= 80
            ? colors.green
            : (m.responseRatePercent ?? 100) >= 60
            ? colors.yellow
            : colors.red;

        const mLine = `${memberCol}\x1B[${rgbColor(colors.green)}${m7Col}\x1B[0m\x1B[${rgbColor(colors.green)}${m14Col}\x1B[0m\x1B[${rgbColor(colors.cyan)}${m30Col}\x1B[0m\x1B[${rgbColor(colors.blue)}${m60Col}\x1B[0m\x1B[${rgbColor(colors.magenta)}${m90Col}\x1B[0m\x1B[1;37m${openCol}\x1B[0m\x1B[1;37m${totalCol}\x1B[0m\x1B[${rgbColor(colors.fgDim)}${reqCol}\x1B[0m\x1B[${rgbColor(colors.cyan)}${revCol}\x1B[0m\x1B[${rgbColor(mRespColor)}${respCol}\x1B[0m${staleStr}`;
        addLine(mLine);
      }
    }
  }

  // Bottlenecks Section
  if (stats.staleBottlenecks.length > 0) {
    addDivider();
    addLine(`\x1B[${rgbColor(colors.yellow)}⚠️ Bottlenecks Requiring Attention (>3d pending)\x1B[0m`);
    for (let i = 0; i < Math.min(3, stats.staleBottlenecks.length); i++) {
      const b = stats.staleBottlenecks[i];
      const keyStr = `${b.key.owner}/${b.key.repo}#${b.key.number}`;
      addLine(
        `  \x1B[${rgbColor(colors.yellow)}•\x1B[0m \x1B[1;37m${keyStr}\x1B[0m \x1B[${rgbColor(colors.fgDim)}(${b.daysPending}d pending — ${b.reason})\x1B[0m`
      );
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

  const footerHelp = ` [1-5/w] timeframe  [Tab] scope  [s] sort  [a] agent tab  [b] backfill  [Esc/p] close `;
  const botDash = Math.max(0, modalWidth - visualLength(footerHelp) - 4);
  const botBorder = `\x1B[${rgbColor(colors.cyan)}└─\x1B[${rgbColor(colors.fgDim)}${footerHelp}\x1B[0m\x1B[${rgbColor(colors.cyan)}${'─'.repeat(botDash)}─┘\x1B[0m`;
  outputLines.push(padEndVisual(botBorder, modalWidth));

  return outputLines;
}
