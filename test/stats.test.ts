import { describe, it, expect } from 'vitest';
import { calculateStats } from '../src/stats/index.js';
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
    expect(fullText).toContain('Code Volume & Merged PR History');
    expect(fullText).toContain('Velocity & Review Turnaround');
    expect(fullText).toContain('Merged PRs');
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

    // Test sorting by comments
    const sortedByComments = calculateStats(state, '30d', 'team', 'comments');
    expect(sortedByComments.memberBreakdown![0].author).toBe('bob');
    expect(sortedByComments.memberBreakdown![0].rank).toBe(1);
  });
});
