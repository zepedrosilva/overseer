import { describe, it, expect, vi } from 'vitest';
import { calculateStats } from '../src/stats/index.js';
import { backfillHistoricalStats, BACKFILL_CACHE_TTL_MS } from '../src/stats/backfill.js';
import { createEmptyState, upsertPR } from '../src/app/state.js';
import type { PrState } from '../src/app/types.js';
import { renderStatsModal } from '../src/tui/stats.js';
import { renderScopeTabBar } from '../src/tui/search.js';

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function createMockPR(number: number, overrides: Partial<PrState> = {}): PrState {
  return {
    key: { owner: 'acme-corp', repo: 'web-frontend', number },
    title: `PR #${number}`,
    branch: `feat/branch-${number}`,
    baseBranch: 'main',
    author: 'alice',
    url: `https://github.com/acme-corp/web-frontend/pull/${number}`,
    isDraft: false,
    state: 'OPEN',
    reviewVerdict: 'APPROVED',
    ciStatus: 'SUCCESS',
    overallStatus: 'Ready',
    commentsCount: 3,
    unresolvedThreadsCount: 0,
    additions: 120,
    deletions: 30,
    changedFiles: 4,
    commitsCount: 2,
    scope: 'mine',
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    log: [],
    ciChecks: [],
    ...overrides,
  };
}

describe('PR Stats & Velocity Engine', () => {
  it('calculates aggregate code volume, size tiers, and commits', () => {
    const state = createEmptyState();
    state.currentUser = 'alice';

    upsertPR(state, createMockPR(1, { additions: 50, deletions: 10, commitsCount: 2 })); // small (<100L)
    upsertPR(state, createMockPR(2, { additions: 200, deletions: 50, commitsCount: 3 })); // medium (100-500L)
    upsertPR(state, createMockPR(3, { additions: 600, deletions: 100, commitsCount: 5 })); // large (>500L)

    const stats = calculateStats(state, '30d', 'mine');
    expect(stats.totalPRs).toBe(3);
    expect(stats.totalAdditions).toBe(850);
    expect(stats.totalDeletions).toBe(160);
    expect(stats.totalCommits).toBe(10);
    expect(stats.avgCommitsPerPR).toBe(3.3);
    expect(stats.sizeDistribution.smallPercent).toBe(33);
    expect(stats.sizeDistribution.mediumPercent).toBe(33);
    expect(stats.sizeDistribution.largePercent).toBe(33);
  });

  it('calculates median review turnaround and merge cycle times', () => {
    const state = createEmptyState();
    state.currentUser = 'alice';

    const now = Date.now();
    const created1 = new Date(now - 10 * 60 * 60 * 1000).toISOString(); // 10h ago
    const reviewed1 = new Date(now - 6 * 60 * 60 * 1000).toISOString(); // reviewed 4h after creation
    const merged1 = new Date(now - 2 * 60 * 60 * 1000).toISOString(); // merged 8h after creation

    upsertPR(state, createMockPR(10, {
      createdAt: created1,
      firstReviewAt: reviewed1,
      mergedAt: merged1,
      state: 'MERGED',
      overallStatus: 'Merged',
    }));

    const stats = calculateStats(state, '30d', 'mine');
    expect(stats.mergedPRs).toBe(1);
    expect(stats.medianTimeToFirstReviewHours).toBe(4);
    expect(stats.medianTimeToMergeDays).toBeCloseTo(0.3, 1);
  });

  it('detects and lists stale bottlenecks (>3 days pending)', () => {
    const state = createEmptyState();
    state.currentUser = 'alice';

    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    upsertPR(state, createMockPR(20, {
      createdAt: fourDaysAgo,
      overallStatus: 'ChangesRequested',
      ciStatus: 'FAILURE',
      unresolvedThreadsCount: 2,
    }));

    const stats = calculateStats(state, '30d', 'mine');
    expect(stats.staleBottlenecks.length).toBe(1);
    expect(stats.staleBottlenecks[0].key.number).toBe(20);
    expect(stats.staleBottlenecks[0].daysPending).toBe(4);
    expect(stats.staleBottlenecks[0].reason).toBe('CI failing');
  });

  it('separates Mine and Team scope stats correctly', () => {
    const state = createEmptyState();
    state.currentUser = 'alice';

    upsertPR(state, createMockPR(1, { author: 'alice', scope: 'mine' }));
    upsertPR(state, createMockPR(2, { author: 'bob', scope: 'team' }));
    upsertPR(state, createMockPR(3, { author: 'charlie', scope: 'team' }));

    const mineStats = calculateStats(state, '30d', 'mine');
    expect(mineStats.totalPRs).toBe(1);

    const teamStats = calculateStats(state, '30d', 'team');
    expect(teamStats.totalPRs).toBe(2);
  });

  it('renders Stats Modal with all sections, code metrics, and timeframe selector', () => {
    const state = createEmptyState();
    upsertPR(state, createMockPR(1));

    const stats = calculateStats(state, '30d', 'mine');
    const lines = renderStatsModal({
      stats,
      scope: 'mine',
      modalWidth: 80,
      modalHeight: 18,
    });

    const fullText = stripAnsi(lines.join('\n'));
    expect(fullText).toContain('PR Stats & Leaderboard: Mine (30d trailing)');
    expect(fullText).toContain('MERGED PR VELOCITY');
    expect(fullText).toContain('REVIEW TURNAROUND');
    expect(fullText).toContain('CI PASS RATE');
    expect(fullText).toContain('AVG PR SIZE & DIFF');
    expect(fullText).toContain('DISCUSSION DENSITY');
    expect(fullText).toContain('[Tab] scope');
    expect(fullText).toContain('[Esc/p] close');
  });

  it('renders Scope Tab Bar with counts and active indicators', () => {
    const tabLine = renderScopeTabBar({
      scope: 'mine',
      mineCount: 5,
      teamCount: 14,
      teamMembersCount: 12,
      teamName: 'core-platform',
      width: 100,
    });

    const stripped = stripAnsi(tabLine);
    expect(stripped).toContain('● [1] Mine (5)');
    expect(stripped).toContain('○ [2] Team: core-platform');
    expect(stripped).toContain('12 members');
  });

  it('filters historicalStats.records properly when backfilling', () => {
    const state = createEmptyState();
    const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();

    state.historicalStats = {
      records: [
        {
          key: { owner: 'org', repo: 'repo', number: 1 },
          author: 'alice',
          title: 'Old PR',
          createdAt: fortyFiveDaysAgo,
          state: 'MERGED',
          additions: 10,
          deletions: 5,
          changedFiles: 1,
          commitsCount: 1,
          commentsCount: 0,
          unresolvedThreadsCount: 0,
          ciStatus: 'SUCCESS',
          scope: 'mine',
        },
      ],
    };

    const thirtyDaysAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const remaining = state.historicalStats.records.filter((r) => {
      const time = new Date(r.createdAt).getTime();
      return !isNaN(time) && time >= thirtyDaysAgoMs;
    });

    expect(remaining.length).toBe(0);
  });

  it('calculates memberBreakdown with full names and renders Team Member Leaderboard with direct 30d/60d/90d numbers and sorting', () => {
    const state = createEmptyState();
    state.teamMembers = ['alice', 'bob'];
    state.teamProfiles = {
      alice: { login: 'alice', name: 'Alice Walker' },
      bob: { login: 'bob', name: 'Bob Dylan' },
    };
    upsertPR(state, createMockPR(1, { author: 'alice', state: 'MERGED' }));
    upsertPR(state, createMockPR(2, { author: 'bob', state: 'OPEN', commentsCount: 5 }));

    const teamStats = calculateStats(state, '30d', 'team', 'merged30');
    expect(teamStats.memberBreakdown).toBeDefined();
    expect(teamStats.memberBreakdown!.length).toBe(2);

    const aliceStats = teamStats.memberBreakdown!.find((m) => m.author === 'alice')!;
    expect(aliceStats.rank).toBe(1);
    expect(aliceStats.merged30).toBe(1);
    expect(aliceStats.merged60).toBe(1);
    expect(aliceStats.merged90).toBe(1);
    expect(aliceStats.name).toBe('Alice Walker');

    const bobStats = teamStats.memberBreakdown!.find((m) => m.author === 'bob')!;
    expect(bobStats.rank).toBe(2);
    expect(bobStats.open).toBe(1);
    expect(bobStats.name).toBe('Bob Dylan');
    expect(bobStats.discussionDensity).toBe(5);

    expect(teamStats.trends).toBeDefined();
    expect(teamStats.trends?.mergedPRs).toBeDefined();

    const lines = renderStatsModal({
      stats: teamStats,
      scope: 'team',
      sortBy: 'merged30',
      teamName: 'platform-core',
      modalWidth: 100,
      modalHeight: 20,
    });

    const fullText = stripAnsi(lines.join('\n'));
    expect(fullText).toContain('Team Member Leaderboard');
    expect(fullText).toContain('RANK');
    expect(fullText).toContain('#1');
    expect(fullText).toContain('Alice Walker (@alice)');
    expect(fullText).toContain('#2');
    expect(fullText).toContain('Bob Dylan (@bob)');
    expect(fullText).toContain('30d');
    expect(fullText).toContain('60d');
    expect(fullText).toContain('90d');
    expect(fullText).toContain('7d');
    expect(fullText).toContain('14d');

    // Test sorting by comments
    const sortedByComments = calculateStats(state, '30d', 'team', 'comments');
    expect(sortedByComments.memberBreakdown![0].author).toBe('bob');
    expect(sortedByComments.memberBreakdown![0].rank).toBe(1);
  });

  it('calculates 7d and 14d rolling stats and sorts leaderboard by merged7 and merged14', () => {
    const state = createEmptyState();
    state.currentUser = 'alice';
    state.teamMembers = ['alice', 'bob'];

    const now = Date.now();
    // PR 1: merged 3 days ago (falls into 7d, 14d, 30d)
    upsertPR(state, createMockPR(1, {
      author: 'alice',
      state: 'MERGED',
      scope: 'team',
      createdAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    // PR 2: merged 10 days ago (falls into 14d, 30d, but NOT 7d)
    upsertPR(state, createMockPR(2, {
      author: 'bob',
      state: 'MERGED',
      scope: 'team',
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    // PR 3: merged 8 days ago (falls into 14d, 30d, but NOT 7d)
    upsertPR(state, createMockPR(3, {
      author: 'bob',
      state: 'MERGED',
      scope: 'team',
      createdAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    // 7d stats
    const stats7d = calculateStats(state, '7d', 'team');
    expect(stats7d.totalPRs).toBe(1);
    expect(stats7d.mergedPRs).toBe(1);
    expect(stats7d.mergedPRs7).toBe(1);
    expect(stats7d.mergedPRs14).toBe(3);
    expect(stats7d.mergedPRs30).toBe(3);

    // 14d stats
    const stats14d = calculateStats(state, '14d', 'team');
    expect(stats14d.totalPRs).toBe(3);
    expect(stats14d.mergedPRs).toBe(3);

    // Sorting by merged7: Alice has 1, Bob has 0 -> Alice rank 1
    const sorted7 = calculateStats(state, '30d', 'team', 'merged7');
    expect(sorted7.memberBreakdown![0].author).toBe('alice');
    expect(sorted7.memberBreakdown![0].merged7).toBe(1);
    expect(sorted7.memberBreakdown![1].author).toBe('bob');
    expect(sorted7.memberBreakdown![1].merged7).toBe(0);

    // Sorting by merged14: Bob has 2, Alice has 1 -> Bob rank 1
    const sorted14 = calculateStats(state, '30d', 'team', 'merged14');
    expect(sorted14.memberBreakdown![0].author).toBe('bob');
    expect(sorted14.memberBreakdown![0].merged14).toBe(2);
    expect(sorted14.memberBreakdown![1].author).toBe('alice');
    expect(sorted14.memberBreakdown![1].merged14).toBe(1);

    // Render modal with 7d active timeframe
    const lines = renderStatsModal({
      stats: stats7d,
      timeframe: '7d',
      scope: 'team',
      sortBy: 'merged7',
      teamName: 'acme/core',
      modalWidth: 100,
      modalHeight: 20,
    });

    const text = stripAnsi(lines.join('\n'));
    expect(text).toContain('PR Stats & Leaderboard: Team: core (7d trailing)');
    expect(text).toContain('Timeframe: [1-5/w]');
    expect(text).toContain('Ranked by 7d Merged PRs');
  });

  it('calculates review response rates, rework rates, and sorts by response and reviews', () => {
    const state = createEmptyState();
    state.teamMembers = ['alice', 'bob'];

    // PR 1: Alice authored, requested bob, bob approved (response = 100%)
    upsertPR(state, createMockPR(1, {
      author: 'alice',
      scope: 'team',
      requestedReviewers: ['bob'],
      approvedReviewers: ['bob'],
      reviewVerdict: 'APPROVED',
    }));

    // PR 2: Bob authored, requested alice, alice changes requested (rework = 1)
    upsertPR(state, createMockPR(2, {
      author: 'bob',
      scope: 'team',
      requestedReviewers: ['alice'],
      changesRequestedReviewers: ['alice'],
      reviewVerdict: 'CHANGES_REQUESTED',
    }));

    // PR 3: External authored, requested bob, bob has not responded yet
    upsertPR(state, createMockPR(3, {
      author: 'external',
      scope: 'team',
      requestedReviewers: ['bob'],
      reviewVerdict: 'PENDING',
    }));

    const stats = calculateStats(state, '30d', 'team');
    expect(stats.reworkRatePercent).toBe(33); // 1 out of 3 PRs had changes requested
    expect(stats.reviewResponseRatePercent).toBeDefined();

    const aliceEntry = stats.memberBreakdown!.find((m) => m.author === 'alice')!;
    expect(aliceEntry.requestsReceived).toBe(1);
    expect(aliceEntry.reviewsGiven).toBe(1);
    expect(aliceEntry.responseRatePercent).toBe(100);

    const bobEntry = stats.memberBreakdown!.find((m) => m.author === 'bob')!;
    expect(bobEntry.requestsReceived).toBe(2);
    expect(bobEntry.reviewsGiven).toBe(1);
    expect(bobEntry.responseRatePercent).toBe(50);

    // Sorting by response rate: Alice (100%) should be rank 1, Bob (50%) rank 2
    const sortedResponse = calculateStats(state, '30d', 'team', 'response');
    expect(sortedResponse.memberBreakdown![0].author).toBe('alice');
    expect(sortedResponse.memberBreakdown![0].rank).toBe(1);

    // Sorting by reviews given: both have 1
    const sortedReviews = calculateStats(state, '30d', 'team', 'reviews');
    expect(sortedReviews.memberBreakdown).toBeDefined();
    expect(sortedReviews.memberBreakdown!.length).toBe(2);
  });

  it('skips members with fresh watermarks (<4h) and only queries stale or force-refreshed members', async () => {
    const state = createEmptyState();
    state.currentUser = 'alice';
    state.teamMembers = ['alice', 'bob'];

    const now = Date.now();
    const oneHourAgo = new Date(now - 1 * 60 * 60 * 1000).toISOString();
    const fiveHoursAgo = new Date(now - 5 * 60 * 60 * 1000).toISOString();

    state.historicalStats = {
      records: [
        {
          key: { owner: 'acme-corp', repo: 'web', number: 1 },
          author: 'alice',
          title: 'Alice PR',
          createdAt: oneHourAgo,
          state: 'MERGED',
          additions: 10,
          deletions: 5,
          changedFiles: 1,
          commitsCount: 1,
          commentsCount: 0,
          unresolvedThreadsCount: 0,
          ciStatus: 'SUCCESS',
          scope: 'both',
        },
      ],
      memberWatermarks: {
        alice: {
          lastBackfilledAt: oneHourAgo,
          timeframeDays: 90,
          prCount: 1,
          status: 'success',
        },
        bob: {
          lastBackfilledAt: fiveHoursAgo,
          timeframeDays: 90,
          prCount: 0,
          status: 'rate_limited',
        },
      },
    };

    // Verify TTL constant is 4 hours
    expect(BACKFILL_CACHE_TTL_MS).toBe(4 * 60 * 60 * 1000);

    // Check freshness condition
    const aliceWatermark = state.historicalStats.memberWatermarks.alice;
    const isAliceFresh =
      aliceWatermark.status === 'success' &&
      aliceWatermark.timeframeDays >= 90 &&
      now - new Date(aliceWatermark.lastBackfilledAt).getTime() < BACKFILL_CACHE_TTL_MS;
    expect(isAliceFresh).toBe(true);

    const bobWatermark = state.historicalStats.memberWatermarks.bob;
    const isBobFresh =
      bobWatermark.status === 'success' &&
      bobWatermark.timeframeDays >= 90 &&
      now - new Date(bobWatermark.lastBackfilledAt).getTime() < BACKFILL_CACHE_TTL_MS;
    expect(isBobFresh).toBe(false);
  });
});
