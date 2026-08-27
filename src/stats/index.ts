// ── PR Performance & Velocity Stats Engine ──────────────────────────────────
// Computes rolling 30d/60d/90d velocity, cycle times, CI health, and code volume.

import type {
  AppState,
  StatsTimeframe,
  AggregatedStats,
  HistoricalPrRecord,
  LeaderboardSort,
  ViewScope,
} from '../app/types.js';
import { prKeyToString } from '../app/types.js';

export { backfill30DayStats, backfill90DayStats, backfillHistoricalStats } from './backfill.js';

function getTimeframeCutoffMs(timeframe: StatsTimeframe): number {
  const days = timeframe === '90d' ? 90 : timeframe === '60d' ? 60 : timeframe === '14d' ? 14 : timeframe === '7d' ? 7 : 30;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function calculateMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function calculateStats(
  data: AppState,
  timeframe: StatsTimeframe = '30d',
  scopeOverride?: ViewScope,
  sortBy: LeaderboardSort = 'merged30'
): AggregatedStats {
  const scope = scopeOverride || data.viewScope || 'mine';
  const cutoffMs = getTimeframeCutoffMs(timeframe);
  const user = data.currentUser?.toLowerCase();

  // Combine historical records and currently live PRs in state
  const recordsMap = new Map<string, HistoricalPrRecord>();

  if (data.historicalStats?.records) {
    for (const rec of data.historicalStats.records) {
      recordsMap.set(prKeyToString(rec.key), rec);
    }
  }

  for (const pr of data.prs.values()) {
    const keyStr = prKeyToString(pr.key);
    recordsMap.set(keyStr, {
      key: pr.key,
      author: pr.author,
      title: pr.title,
      createdAt: pr.createdAt,
      firstReviewAt: pr.firstReviewAt,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      state: pr.state,
      additions: pr.additions || 0,
      deletions: pr.deletions || 0,
      changedFiles: pr.changedFiles || 0,
      commitsCount: pr.commitsCount || 1,
      commentsCount: pr.commentsCount || 0,
      unresolvedThreadsCount: pr.unresolvedThreadsCount || 0,
      ciStatus: pr.ciStatus,
      scope: pr.scope || 'mine',
      reviewVerdict: pr.reviewVerdict,
      requestedReviewers: pr.requestedReviewers,
      approvedReviewers: pr.approvedReviewers,
      changesRequestedReviewers: pr.changesRequestedReviewers,
    });
  }

  const allRecords = Array.from(recordsMap.values());
  const memberSet = new Set((data.teamMembers || []).map((m) => m.toLowerCase()));

  // Filter all records by scope first
  const scopedRecords: HistoricalPrRecord[] = allRecords.filter((r) => {
    const authorLower = r.author.toLowerCase();
    if (scope === 'mine') {
      if (user && authorLower === user) return true;
      return r.scope === 'mine' || r.scope === 'both';
    } else {
      // team scope
      if (memberSet.has(authorLower)) return true;
      return r.scope === 'team' || r.scope === 'both';
    }
  });

  // Filter by timeframe
  const filtered = scopedRecords.filter((r) => {
    const createdMs = new Date(r.createdAt).getTime();
    return !isNaN(createdMs) && createdMs >= cutoffMs;
  });

  let mergedPRs = 0;
  let openPRs = 0;
  let closedPRs = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;
  let totalChangedFiles = 0;
  let totalCommits = 0;
  let totalComments = 0;

  let smallCount = 0;
  let mediumCount = 0;
  let largeCount = 0;

  const reviewHoursList: number[] = [];
  const mergeDaysList: number[] = [];

  let totalCiRuns = 0;
  let passedCiRuns = 0;

  const now = Date.now();
  const staleBottlenecks: AggregatedStats['staleBottlenecks'] = [];

  for (const r of filtered) {
    if (r.state === 'MERGED') mergedPRs++;
    else if (r.state === 'CLOSED') closedPRs++;
    else openPRs++;

    totalAdditions += r.additions;
    totalDeletions += r.deletions;
    totalChangedFiles += r.changedFiles;
    totalCommits += r.commitsCount;
    totalComments += r.commentsCount;

    const prSize = r.additions + r.deletions;
    if (prSize < 100) smallCount++;
    else if (prSize <= 500) mediumCount++;
    else largeCount++;

    // Cycle times
    const createdMs = new Date(r.createdAt).getTime();
    if (r.firstReviewAt) {
      const firstReviewMs = new Date(r.firstReviewAt).getTime();
      if (!isNaN(firstReviewMs) && firstReviewMs >= createdMs) {
        const hours = (firstReviewMs - createdMs) / (1000 * 60 * 60);
        reviewHoursList.push(hours);
      }
    }

    if (r.mergedAt) {
      const mergedMs = new Date(r.mergedAt).getTime();
      if (!isNaN(mergedMs) && mergedMs >= createdMs) {
        const days = (mergedMs - createdMs) / (1000 * 60 * 60 * 24);
        mergeDaysList.push(days);
      }
    }

    // CI Health
    if (r.ciStatus !== 'UNKNOWN') {
      totalCiRuns++;
      if (r.ciStatus === 'SUCCESS') {
        passedCiRuns++;
      }
    }

    // Bottlenecks (> 3 days pending)
    if (r.state === 'OPEN') {
      const daysPending = Math.floor((now - createdMs) / (1000 * 60 * 60 * 24));
      if (daysPending >= 3) {
        let reason = 'Awaiting review';
        if (r.ciStatus === 'FAILURE') reason = 'CI failing';
        else if (r.ciStatus === 'PENDING') reason = 'CI pending';
        else if (r.unresolvedThreadsCount > 0) reason = `${r.unresolvedThreadsCount} open discussions`;

        staleBottlenecks.push({
          key: r.key,
          title: r.title,
          daysPending,
          reason,
        });
      }
    }
  }

  // Sort bottlenecks by longest pending first
  staleBottlenecks.sort((a, b) => b.daysPending - a.daysPending);

  const totalPRs = filtered.length;
  const avgPRSize = totalPRs > 0 ? Math.round((totalAdditions + totalDeletions) / totalPRs) : 0;
  const avgCommitsPerPR = totalPRs > 0 ? Number((totalCommits / totalPRs).toFixed(1)) : 0;
  const reviewDensityCommentsPerPR = totalPRs > 0 ? Number((totalComments / totalPRs).toFixed(1)) : 0;

  const smallPercent = totalPRs > 0 ? Math.round((smallCount / totalPRs) * 100) : 0;
  const mediumPercent = totalPRs > 0 ? Math.round((mediumCount / totalPRs) * 100) : 0;
  const largePercent = totalPRs > 0 ? Math.round((largeCount / totalPRs) * 100) : 0;

  const medianTimeToFirstReviewHours = calculateMedian(reviewHoursList);
  const medianTimeToMergeDays = calculateMedian(mergeDaysList);

  const ciPassRatePercent = totalCiRuns > 0 ? Number(((passedCiRuns / totalCiRuns) * 100).toFixed(1)) : 100;

  // Compute 7d, 14d, 30d, 60d, and 90d slices
  const cutoff7Ms = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const cutoff14Ms = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const cutoff30Ms = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const cutoff60Ms = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const cutoff90Ms = Date.now() - 90 * 24 * 60 * 60 * 1000;

  const records7 = scopedRecords.filter((r) => {
    const time = new Date(r.createdAt).getTime();
    return !isNaN(time) && time >= cutoff7Ms;
  });

  const records14 = scopedRecords.filter((r) => {
    const time = new Date(r.createdAt).getTime();
    return !isNaN(time) && time >= cutoff14Ms;
  });

  const records30 = scopedRecords.filter((r) => {
    const time = new Date(r.createdAt).getTime();
    return !isNaN(time) && time >= cutoff30Ms;
  });

  const records60 = scopedRecords.filter((r) => {
    const time = new Date(r.createdAt).getTime();
    return !isNaN(time) && time >= cutoff60Ms;
  });

  const records90 = scopedRecords.filter((r) => {
    const time = new Date(r.createdAt).getTime();
    return !isNaN(time) && time >= cutoff90Ms;
  });

  const mergedPRs7 = records7.filter((r) => r.state === 'MERGED').length;
  const mergedPRs14 = records14.filter((r) => r.state === 'MERGED').length;
  const mergedPRs30 = records30.filter((r) => r.state === 'MERGED').length;
  const mergedPRs60 = records60.filter((r) => r.state === 'MERGED').length;
  const mergedPRs90 = records90.filter((r) => r.state === 'MERGED').length;

  const getDir = (delta: number): 'up' | 'down' | 'flat' => {
    if (Math.abs(delta) < 0.05) return 'flat';
    return delta > 0 ? 'up' : 'down';
  };

  // Compute Rework Rate (% of PRs with changes requested)
  let reworkCount = 0;
  for (const r of filtered) {
    const isChangesRequested =
      r.reviewVerdict === 'CHANGES_REQUESTED' ||
      Boolean(r.changesRequestedReviewers && r.changesRequestedReviewers.length > 0);
    if (isChangesRequested) {
      reworkCount++;
    }
  }
  const reworkRatePercent = totalPRs > 0 ? Math.round((reworkCount / totalPRs) * 100) : 0;

  // Track Review Requests vs Responses across members
  const memberRequestsMap = new Map<string, number>();
  const memberReviewsGivenMap = new Map<string, number>();

  for (const r of filtered) {
    const reqList = (r.requestedReviewers || []).map((u) => u.toLowerCase());
    const appList = (r.approvedReviewers || []).map((u) => u.toLowerCase());
    const crList = (r.changesRequestedReviewers || []).map((u) => u.toLowerCase());

    const allReviewersOnPr = new Set([...appList, ...crList]);
    for (const rev of allReviewersOnPr) {
      memberReviewsGivenMap.set(rev, (memberReviewsGivenMap.get(rev) || 0) + 1);
    }

    const allRequestedOrReviewed = new Set([...reqList, ...allReviewersOnPr]);
    for (const req of allRequestedOrReviewed) {
      memberRequestsMap.set(req, (memberRequestsMap.get(req) || 0) + 1);
    }
  }

  let totalTeamRequests = 0;
  let totalTeamReviews = 0;
  for (const m of (data.teamMembers || [])) {
    const mLower = m.toLowerCase();
    totalTeamRequests += (memberRequestsMap.get(mLower) || 0);
    totalTeamReviews += (memberReviewsGivenMap.get(mLower) || 0);
  }

  const reviewResponseRatePercent =
    totalTeamRequests > 0
      ? Math.min(100, Math.round((totalTeamReviews / totalTeamRequests) * 100))
      : 100;

  // Compute per-member stats for team view
  let memberBreakdown: AggregatedStats['memberBreakdown'] = undefined;
  if (scope === 'team') {
    const memberMap = new Map<string, {
      author: string;
      merged: number;
      open: number;
      closed: number;
      total: number;
      commentsCount: number;
      bottlenecksCount: number;
    }>();

    for (const m of (data.teamMembers || [])) {
      memberMap.set(m.toLowerCase(), {
        author: m,
        merged: 0,
        open: 0,
        closed: 0,
        total: 0,
        commentsCount: 0,
        bottlenecksCount: 0,
      });
    }

    const hasConfiguredTeam = (data.teamMembers || []).length > 0;
    for (const r of filtered) {
      const authorKey = r.author.toLowerCase();
      let mStats = memberMap.get(authorKey);
      if (!mStats) {
        if (hasConfiguredTeam) {
          continue;
        }
        mStats = {
          author: r.author,
          merged: 0,
          open: 0,
          closed: 0,
          total: 0,
          commentsCount: 0,
          bottlenecksCount: 0,
        };
        memberMap.set(authorKey, mStats);
      }

      mStats.total++;
      if (r.state === 'MERGED') mStats.merged++;
      else if (r.state === 'CLOSED') mStats.closed++;
      else mStats.open++;

      mStats.commentsCount += (r.commentsCount || 0);

      if (r.state === 'OPEN') {
        const createdMs = new Date(r.createdAt).getTime();
        const daysPending = Math.floor((now - createdMs) / (1000 * 60 * 60 * 24));
        if (daysPending >= 3) {
          mStats.bottlenecksCount++;
        }
      }
    }

    memberBreakdown = Array.from(memberMap.values())
      .map((m) => {
        const authorLower = m.author.toLowerCase();
        const profile = data.teamProfiles?.[authorLower];
        const memberMerged7 = records7.filter((r) => r.author.toLowerCase() === authorLower && r.state === 'MERGED').length;
        const memberMerged14 = records14.filter((r) => r.author.toLowerCase() === authorLower && r.state === 'MERGED').length;
        const memberMerged30 = records30.filter((r) => r.author.toLowerCase() === authorLower && r.state === 'MERGED').length;
        const memberMerged60 = records60.filter((r) => r.author.toLowerCase() === authorLower && r.state === 'MERGED').length;
        const memberMerged90 = records90.filter((r) => r.author.toLowerCase() === authorLower && r.state === 'MERGED').length;

        const requestsReceived = memberRequestsMap.get(authorLower) || 0;
        const reviewsGiven = memberReviewsGivenMap.get(authorLower) || 0;
        const responseRatePercent =
          requestsReceived > 0
            ? Math.min(100, Math.round((reviewsGiven / requestsReceived) * 100))
            : 100;

        return {
          rank: 1,
          author: m.author,
          name: profile?.name,
          merged7: memberMerged7,
          merged14: memberMerged14,
          merged30: memberMerged30,
          merged60: memberMerged60,
          merged90: memberMerged90,
          open: m.open,
          closed: m.closed,
          total: m.total,
          discussionDensity: m.total > 0 ? Number((m.commentsCount / m.total).toFixed(1)) : 0,
          bottlenecksCount: m.bottlenecksCount,
          requestsReceived,
          reviewsGiven,
          responseRatePercent,
        };
      })
      .sort((a, b) => {
        if (sortBy === 'merged7') {
          return b.merged7 - a.merged7 || b.merged14 - a.merged14 || b.merged30 - a.merged30;
        }
        if (sortBy === 'merged14') {
          return b.merged14 - a.merged14 || b.merged7 - a.merged7 || b.merged30 - a.merged30;
        }
        if (sortBy === 'merged90') {
          return b.merged90 - a.merged90 || b.merged60 - a.merged60 || b.merged30 - a.merged30;
        }
        if (sortBy === 'merged60') {
          return b.merged60 - a.merged60 || b.merged30 - a.merged30 || b.merged90 - a.merged90;
        }
        if (sortBy === 'total') {
          return b.total - a.total || b.merged30 - a.merged30;
        }
        if (sortBy === 'comments') {
          return b.discussionDensity - a.discussionDensity || b.total - a.total;
        }
        if (sortBy === 'stale') {
          return b.bottlenecksCount - a.bottlenecksCount || b.total - a.total;
        }
        if (sortBy === 'response') {
          return (b.responseRatePercent ?? 0) - (a.responseRatePercent ?? 0) || (b.reviewsGiven ?? 0) - (a.reviewsGiven ?? 0);
        }
        if (sortBy === 'reviews') {
          return (b.reviewsGiven ?? 0) - (a.reviewsGiven ?? 0) || (b.responseRatePercent ?? 0) - (a.responseRatePercent ?? 0);
        }
        // Default 'merged30'
        return b.merged30 - a.merged30 || b.merged60 - a.merged60 || b.merged90 - a.merged90;
      })
      .map((m, idx) => ({
        ...m,
        rank: idx + 1,
      }));
  }

  const paceMerged60 = Number((mergedPRs60 / 2).toFixed(1));
  const paceMerged90 = Number((mergedPRs90 / 3).toFixed(1));

  const totalCmts60 = records60.reduce((acc, r) => acc + (r.commentsCount || 0), 0);
  const density60 = records60.length > 0 ? Number((totalCmts60 / records60.length).toFixed(1)) : 0;

  const totalCmts90 = records90.reduce((acc, r) => acc + (r.commentsCount || 0), 0);
  const density90 = records90.length > 0 ? Number((totalCmts90 / records90.length).toFixed(1)) : 0;

  const trends: AggregatedStats['trends'] = {
    mergedPRs: {
      delta60: Number((mergedPRs - paceMerged60).toFixed(1)),
      delta90: Number((mergedPRs - paceMerged90).toFixed(1)),
      direction60: getDir(mergedPRs - paceMerged60),
      direction90: getDir(mergedPRs - paceMerged90),
    },
    discussionDensity: {
      delta60: Number((reviewDensityCommentsPerPR - density60).toFixed(1)),
      delta90: Number((reviewDensityCommentsPerPR - density90).toFixed(1)),
      direction60: getDir(reviewDensityCommentsPerPR - density60),
      direction90: getDir(reviewDensityCommentsPerPR - density90),
    },
  };

  return {
    timeframe,
    scope,
    totalPRs,
    mergedPRs,
    mergedPRs7,
    mergedPRs14,
    mergedPRs30,
    mergedPRs60,
    mergedPRs90,
    openPRs,
    closedPRs,
    totalAdditions,
    totalDeletions,
    totalChangedFiles,
    avgPRSize,
    sizeDistribution: {
      smallPercent,
      mediumPercent,
      largePercent,
    },
    totalCommits,
    avgCommitsPerPR,
    medianTimeToFirstReviewHours: medianTimeToFirstReviewHours !== null ? Number(medianTimeToFirstReviewHours.toFixed(1)) : null,
    medianTimeToMergeDays: medianTimeToMergeDays !== null ? Number(medianTimeToMergeDays.toFixed(1)) : null,
    ciPassRatePercent,
    totalCiRuns,
    passedCiRuns,
    reviewDensityCommentsPerPR,
    reviewResponseRatePercent,
    reworkRatePercent,
    staleBottlenecks,
    memberBreakdown,
    trends,
  };
}
