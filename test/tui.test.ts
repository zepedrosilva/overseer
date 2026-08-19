import { describe, it, expect } from 'vitest';
import {
  calculateLayout,
  stripAnsi,
  visualLength,
  padEndVisual,
  truncateVisual,
  formatTimeAgo,
} from '../src/tui/layout.js';
import { filterPRs, renderSearchBar } from '../src/tui/search.js';
import { renderBanner, renderStatsBar, renderDivider } from '../src/tui/banner.js';
import { renderTable } from '../src/tui/table.js';
import { renderDetails, renderDetailsModal } from '../src/tui/details.js';
import { renderSettingsModal } from '../src/tui/settings.js';
import { renderBackfillModal } from '../src/tui/backfill.js';
import { renderStatsModal } from '../src/tui/stats.js';
import { renderHelpModal } from '../src/tui/help.js';
import { renderDiffModal } from '../src/tui/diff.js';
import { renderLogsModal } from '../src/tui/logs.js';
import { renderFooter } from '../src/tui/footer.js';
import { createEmptyState, upsertPR } from '../src/app/state.js';
import { calculateStats } from '../src/stats/index.js';
import type { PrState } from '../src/app/types.js';

describe('TUI Components & Engine', () => {
  function createMockPR(number: number, status: PrState['overallStatus'] = 'Ready'): PrState {
    return {
      key: { owner: 'acme-corp', repo: 'web-frontend', number },
      title: `Feature invoice calculations #${number}`,
      branch: `feat/invoice-${number}`,
      baseBranch: 'main',
      author: 'alice',
      url: `https://github.com/acme-corp/web-frontend/pull/${number}`,
      isDraft: false,
      state: 'OPEN',
      reviewVerdict: 'APPROVED',
      ciStatus: 'SUCCESS',
      overallStatus: status,
      statusDetail: 'Ready for merge',
      ciChecks: [
        { name: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'build-dist', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
      agent: 'claude',
      commentsCount: 3,
      unresolvedThreadsCount: 0,
      createdAt: '2026-08-17T10:00:00Z',
      updatedAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      log: ['[10:00:00] Discovered PR', '[10:05:00] Review approved'],
    };
  }

  describe('Layout & String Utilities', () => {
    it('calculates full width view for clean responsive layout', () => {
      const layout = calculateLayout(140, 40);
      expect(layout.isSplitView).toBe(false);
      expect(layout.leftWidth).toBe(140);
      expect(layout.bannerHeight).toBe(5);
      expect(layout.statsHeight).toBe(1);
    });

    it('calculates layout for narrow terminals', () => {
      const layout = calculateLayout(90, 30);
      expect(layout.isSplitView).toBe(false);
      expect(layout.leftWidth).toBe(90);
    });

    it('strips ANSI escape codes and computes visual length', () => {
      const colored = '\x1B[31mError\x1B[0m: \x1B[32mOK\x1B[0m';
      expect(stripAnsi(colored)).toBe('Error: OK');
      expect(visualLength(colored)).toBe(9);
    });

    it('pads and truncates strings visually', () => {
      expect(padEndVisual('test', 8)).toBe('test    ');
      expect(truncateVisual('SuperLongStringTitle', 10)).toBe('SuperLong…');
    });

    it('formats time ago strings correctly', () => {
      const now = new Date().toISOString();
      expect(formatTimeAgo(now)).toBe('0s');

      const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
      expect(formatTimeAgo(oneHourAgo)).toBe('1h');

      const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      expect(formatTimeAgo(twoDaysAgo)).toBe('2d');
    });
  });

  describe('Search & Filtering', () => {
    const prs: PrState[] = [
      createMockPR(101, 'Ready'),
      { ...createMockPR(102, 'ChangesRequested'), title: 'Refactor database schema' },
      { ...createMockPR(103, 'Draft'), branch: 'wip/experiments' },
    ];

    it('filters by PR title substring', () => {
      const filtered = filterPRs(prs, 'database');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].key.number).toBe(102);
    });

    it('filters by PR number', () => {
      const filtered = filterPRs(prs, '#103');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].key.number).toBe(103);
    });

    it('filters by PR branch or status', () => {
      expect(filterPRs(prs, 'experiments')).toHaveLength(1);
      expect(filterPRs(prs, 'changes')).toHaveLength(1);
    });

    it('renders search bar in idle and active states', () => {
      const idle = renderSearchBar('', false, 100);
      expect(stripAnsi(idle)).toContain('Filter PRs');

      const active = renderSearchBar('fix', true, 100);
      expect(stripAnsi(active)).toContain('Filter: fix');
    });
  });

  describe('Monochromatic Banner & Stats Rendering', () => {
    it('renders blank line above logo and adjacent version tag on top line', async () => {
      const { getAppVersion } = await import('../src/app/version.js');
      const version = getAppVersion();
      expect(version).toMatch(/^v\d+$/);

      const banner = renderBanner(120);
      expect(banner).toHaveLength(5);
      // Line 0 is blank padding above logo
      expect(stripAnsi(banner[0]).trim()).toBe('');
      // Line 1 contains logo block and adjacent version
      expect(stripAnsi(banner[1])).toContain('██████╗');
      expect(stripAnsi(banner[1])).toContain(version);

      const explicitBanner = renderBanner(120, 'v42');
      expect(stripAnsi(explicitBanner[1])).toContain('v42');
    });

    it('renders compact stats bar directly below logo with counts and user', () => {
      const state = createEmptyState();
      state.repos = [{ owner: 'owner', repo: 'repo', url: 'https://github.com/owner/repo', agent: 'claude' }];
      state.currentUser = 'josesilva';
      upsertPR(state, createMockPR(1, 'Ready'));
      upsertPR(state, createMockPR(2, 'CiFailing'));

      const stats = renderStatsBar(state, 120, { streamDeckEnabled: true, streamDeckPort: 3210 });
      expect(stripAnsi(stats)).toContain('User: @josesilva');
      expect(stripAnsi(stats)).toContain('Repos: 1');
      expect(stripAnsi(stats)).toContain('Open PRs: 2');
      expect(stripAnsi(stats)).toContain('1 Needs Attention');
      expect(stripAnsi(stats)).toContain(':3210');
    });

    it('renders live spinner in stats bar during polling', () => {
      const state = createEmptyState();
      state.isPolling = true;

      const stats = renderStatsBar(state, 120, { spinnerTick: 2 });
      expect(stripAnsi(stats)).toContain('Fetching PRs from GitHub');
    });
  });

  describe('Table & Details Views', () => {
    it('renders table headers and rows with exact line length matching safeWidth', () => {
      const prs = [createMockPR(142, 'Ready')];
      const widths = [60, 80, 100, 140];

      for (const w of widths) {
        const lines = renderTable({ prs, selectedIndex: 0, width: w, height: 5 });
        const expectedSafeWidth = w - 2;
        expect(lines).toHaveLength(5);
        for (const line of lines) {
          expect(visualLength(line)).toBe(expectedSafeWidth);
        }
      }

      const lines = renderTable({ prs, selectedIndex: 0, width: 100, height: 10 });
      expect(stripAnsi(lines[0])).toContain('STATUS');
      expect(stripAnsi(lines[0])).toContain('REV');
      expect(stripAnsi(lines[0])).toContain('REPO');
      expect(stripAnsi(lines[1])).toContain('acme-corp');
      expect(stripAnsi(lines[2])).toContain('Ready');
      expect(stripAnsi(lines[2])).toContain('web-frontend');
      expect(stripAnsi(lines[2])).toContain('#142');
    });

    it('renders multiple organization headers separating different owners', () => {
      const pr1 = createMockPR(142, 'Ready');
      const pr2 = createMockPR(1, 'Reviewing');
      pr2.key = { owner: 'zepedrosilva', repo: 'overseer', number: 1 };
      pr2.title = 'feat: initial release';

      const lines = renderTable({
        prs: [pr1, pr2],
        selectedIndex: 0,
        width: 100,
        height: 10,
        currentUser: 'zepedrosilva',
      });

      const fullText = lines.map(stripAnsi).join('\n');
      expect(fullText).toContain('🏢 acme-corp (1)');
      expect(fullText).toContain('👤 zepedrosilva (1)');
      expect(fullText).toContain('web-frontend');
      expect(fullText).toContain('overseer');
    });

    it('correctly selects and displays the last PR of an organization before crossing to the next', () => {
      const mews1 = createMockPR(101, 'Ready');
      const mews2 = createMockPR(102, 'Ready');
      const zepedro = createMockPR(1, 'Ready');
      zepedro.key = { owner: 'zepedrosilva', repo: 'overseer', number: 1 };

      const prs = [mews1, mews2, zepedro];

      // Select index 1 (the last PR of acme-corp)
      const lines = renderTable({
        prs,
        selectedIndex: 1,
        width: 100,
        height: 10,
      });

      // Line 0: Header
      // Line 1: 🏢 acme-corp (2)
      // Line 2: Acme #101
      // Line 3: ▎ Acme #102 (selected marker)
      // Line 4: 🏢 zepedrosilva (1)
      // Line 5: zepedro #1
      expect(stripAnsi(lines[1])).toContain('acme-corp');
      expect(stripAnsi(lines[2])).toContain('#101');
      expect(stripAnsi(lines[3])).toContain('#102');
      expect(lines[3]).toContain('▎'); // Has cyan selection marker on the last PR of acme-corp!
      expect(stripAnsi(lines[4])).toContain('zepedrosilva');
      expect(stripAnsi(lines[5])).toContain('#1');
      expect(lines[5]).not.toContain('▎');
    });

    it('renders dedicated AUTHOR column when scope is team', () => {
      const pr = createMockPR(101, 'Ready');
      pr.author = 'bob';

      const teamLines = renderTable({
        prs: [pr],
        selectedIndex: 0,
        width: 100,
        height: 5,
        scope: 'team',
      });

      expect(stripAnsi(teamLines[0])).toContain('AUTHOR');
      expect(stripAnsi(teamLines[2])).toContain('bob');

      const mineLines = renderTable({
        prs: [pr],
        selectedIndex: 0,
        width: 100,
        height: 5,
        scope: 'mine',
      });

      expect(stripAnsi(mineLines[0])).not.toContain('AUTHOR');
    });

    it('renders Merged and Closed PR rows with appropriate state badges and age formatting', () => {
      const mergedPr = createMockPR(201, 'Merged');
      mergedPr.state = 'MERGED';
      mergedPr.mergedAt = new Date(Date.now() - 3600000).toISOString();

      const closedPr = createMockPR(202, 'Closed');
      closedPr.state = 'CLOSED';
      closedPr.closedAt = new Date(Date.now() - 7200000).toISOString();

      const lines = renderTable({
        prs: [mergedPr, closedPr],
        selectedIndex: 0,
        width: 100,
        height: 6,
      });

      const fullText = lines.map(stripAnsi).join('\n');
      expect(fullText).toContain('Merged');
      expect(fullText).toContain('#201');
      expect(fullText).toContain('Closed');
      expect(fullText).toContain('#202');
    });

    it('renders animated spinner in CI column when CI check runs are pending', async () => {
      const { ciIcon, getSpinnerChar } = await import('../src/tui/colors.js');
      expect(ciIcon('PENDING', 2)).toBe(getSpinnerChar(2));

      const pr = createMockPR(142, 'CiPending');
      pr.ciStatus = 'PENDING';
      const lines = renderTable({
        prs: [pr],
        selectedIndex: 0,
        width: 100,
        height: 5,
        spinnerTick: 3,
      });

      const rowText = stripAnsi(lines[2]);
      expect(rowText).toContain(getSpinnerChar(3));
    });

    it('renders details modal for selected PR with borders, reviewers roster, and scroll hints', () => {
      const pr = createMockPR(142, 'Ready');
      const lines = renderDetails(pr, 70, 20);

      expect(lines).toHaveLength(20);
      const fullText = lines.map(stripAnsi).join('\n');
      expect(fullText).toContain('PR Details: acme-corp/web-frontend#142');
      expect(fullText).toContain('Review: APPROVED');
      expect(fullText).toContain('Reviewers & Approvals');
      expect(fullText).toContain('CI Checks (2)');
      expect(fullText).toContain('unit-tests');
      expect(fullText).toContain('Activity & Logs');
      expect(fullText).toContain('[Esc/Enter to close]');
    });

    it('renders flawless popup on very narrow terminal without line overflowing or wrapping', () => {
      const pr = createMockPR(142, 'Ready');
      const narrowWidth = 48;
      const lines = renderDetailsModal({ pr, modalWidth: narrowWidth, modalHeight: 12 });

      expect(lines).toHaveLength(12);
      for (const line of lines) {
        expect(visualLength(line)).toBe(narrowWidth);
      }
      expect(stripAnsi(lines[0])).toContain('#142');
      expect(stripAnsi(lines[lines.length - 1])).toContain('└─');
      expect(stripAnsi(lines[lines.length - 1])).toContain('─┘');
    });

    it('renders placeholder when no PR is selected', () => {
      const lines = renderDetails(null, 50, 10);
      expect(lines).toHaveLength(10);
      expect(stripAnsi(lines[0])).toContain('Select a Pull Request');
    });
  });

  describe('Footer Actions & Modals', () => {
    it('renders streamlined core keybinding hints with [?] all actions', () => {
      const footer = renderFooter({ mode: 'NORMAL', selectedPR: null, inputBuffer: '' }, 180);
      const text = stripAnsi(footer);
      expect(text).toContain('[Enter] details');
      expect(text).toContain('[Tab] scope');
      expect(text).toContain('[p] stats');
      expect(text).toContain('[?] all actions');
      expect(text).toContain('[q] quit');
    });

    it('renders All Actions Help modal with categorized commands', async () => {
      const { renderHelpModal } = await import('../src/tui/help.js');
      const lines = renderHelpModal({ modalWidth: 90, modalHeight: 20 });
      const fullText = stripAnsi(lines.join('\n'));
      expect(fullText).toContain('All Actions & Keybindings');
      expect(fullText).toContain('Navigation & Scope');
      expect(fullText).toContain('PR Triage & Operations');
      expect(fullText).toContain('AI Agents & Background Worktrees');
      expect(fullText).toContain('Performance & Configuration');
      expect(fullText).toContain('[? / h]');
      expect(fullText).toContain('[b / B]');
    });

    it('renders Backfill Progress modal with live status and log', async () => {
      const { renderBackfillModal } = await import('../src/tui/backfill.js');
      const lines = renderBackfillModal({
        progress: {
          currentMember: 'Bob Dylan (@bob)',
          memberIndex: 2,
          totalMembers: 12,
          prsFound: 25,
          totalPRs: 50,
          timeframeDays: 90,
          status: 'in_progress',
          log: ['Querying 90d PRs for Bob Dylan (@bob)...'],
        },
        modalWidth: 80,
        modalHeight: 16,
      });
      const fullText = stripAnsi(lines.join('\n'));
      expect(fullText).toContain('Backfilling 90-Day PR History');
      expect(fullText).toContain('Bob Dylan (@bob)');
      expect(fullText).toContain('50 PRs stored');
      expect(fullText).toContain('Activity Log');
    });

    it('adaptively collapses footer hints on narrow screens to prevent line wrapping', () => {
      const footer = renderFooter({ mode: 'NORMAL', selectedPR: null, inputBuffer: '' }, 40);
      expect(visualLength(footer)).toBe(38);
      const text = stripAnsi(footer);
      expect(text).toContain('[Enter]');
      expect(text).toContain('[Tab]');
    });

    it('renders confirmation modals for merge and close', () => {
      const pr = createMockPR(142);
      const mergeFooter = renderFooter({ mode: 'CONFIRM_MERGE', selectedPR: pr, inputBuffer: '' }, 100);
      expect(stripAnsi(mergeFooter)).toContain('Squash-merge');
      expect(stripAnsi(mergeFooter)).toContain('(y/n)');

      const closeFooter = renderFooter({ mode: 'CONFIRM_CLOSE', selectedPR: pr, inputBuffer: '' }, 100);
      expect(stripAnsi(closeFooter)).toContain('Close Pull Request');
    });

    it('renders comment and agent input modals', () => {
      const commentFooter = renderFooter({ mode: 'COMMENT_INPUT', selectedPR: null, inputBuffer: 'LGTM' }, 100);
      expect(stripAnsi(commentFooter)).toContain('Comment: LGTM');

      const agentFooter = renderFooter({
        mode: 'AGENT_INPUT',
        selectedPR: null,
        inputBuffer: 'fix typos',
        selectedAgent: 'agy',
      }, 100);
      expect(stripAnsi(agentFooter)).toContain('Agent [agy] prompt: fix typos');
    });

    it('renders 2-step agent selector footer with available agent badges', () => {
      const pr = createMockPR(142);
      const selectFooter = renderFooter({
        mode: 'AGENT_SELECT',
        selectedPR: pr,
        inputBuffer: '',
        selectedAgent: 'claude',
        availableAgents: ['claude', 'agy', 'pi', 'moxly'],
      }, 100);
      const text = stripAnsi(selectFooter);
      expect(text).toContain('Agent for web-frontend:');
      expect(text).toContain('[1] claude');
      expect(text).toContain('[2] agy');
      expect(text).toContain('[3] pi');
      expect(text).toContain('[Enter] accept');
    });
  });

  describe('Settings & Extensions Modal', () => {
    it('renders settings modal with defaults, extensions, and navigation hints', () => {
      const state = createEmptyState();
      const lines = renderSettingsModal({
        state,
        selectedIndex: 0,
        isEditingText: false,
        editBuffer: '',
        modalWidth: 80,
        modalHeight: 24,
      });

      expect(lines).toHaveLength(24);
      const fullText = lines.map(stripAnsi).join('\n');
      expect(fullText).toContain('Settings & Extensions');
      expect(fullText).toContain('[DEFAULTS]');
      expect(fullText).toContain('Default AI Agent');
      expect(fullText).toContain('Personal Poll Interval');
      expect(fullText).toContain('Team Poll Interval');
      expect(fullText).toContain('[EXTENSIONS]');
      expect(fullText).toContain('Stream Deck Server');
      expect(fullText).toContain('[Esc to save & close]');
    });
  });

  describe('Modal Box Frames & 4-Corner Trace Integrity (All 7 Modals)', () => {
    const pr = createMockPR(42);
    const state = createEmptyState();
    upsertPR(state, pr);
    const stats = calculateStats(state, '30d', 'mine');

    const testModalGeometry = (name: string, lines: string[], expectedWidth: number, expectedHeight: number) => {
      expect(lines.length, `${name} line count must match expected height`).toBe(expectedHeight);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const vLen = visualLength(line);
        expect(vLen, `${name} row ${i} visualLength (${vLen}) must strictly equal modalWidth (${expectedWidth})`).toBe(expectedWidth);
      }

      // Check Top Border
      const top = stripAnsi(lines[0]);
      expect(top.startsWith('┌─'), `${name} top border must start with ┌─`).toBe(true);
      expect(top.endsWith('─┐'), `${name} top border must end with ─┐`).toBe(true);

      // Check Bottom Border
      const bottom = stripAnsi(lines[lines.length - 1]);
      expect(bottom.startsWith('└─'), `${name} bottom border must start with └─`).toBe(true);
      expect(bottom.endsWith('─┘'), `${name} bottom border must end with ─┘`).toBe(true);

      // Check Middle Rows
      for (let i = 1; i < lines.length - 1; i++) {
        const mid = stripAnsi(lines[i]);
        if (mid.startsWith('├─')) {
          expect(mid.endsWith('─┤'), `${name} divider at line ${i} must end with ─┤`).toBe(true);
        } else {
          expect(mid.startsWith('│'), `${name} content row at line ${i} must start with │`).toBe(true);
          expect(mid.endsWith('│'), `${name} content row at line ${i} must end with │`).toBe(true);
        }
      }
    };

    it('validates 1. Backfill Progress Modal frame trace', () => {
      const lines = renderBackfillModal({
        progress: {
          currentMember: 'Alice',
          memberIndex: 1,
          totalMembers: 5,
          prsFound: 10,
          totalPRs: 50,
          timeframeDays: 90,
          status: 'in_progress',
          log: ['Querying...'],
        },
        modalWidth: 90,
        modalHeight: 18,
      });
      testModalGeometry('BackfillModal', lines, 90, 18);
    });

    it('validates 2. Stats & Leaderboard Modal frame trace', () => {
      const lines = renderStatsModal({
        stats,
        scope: 'team',
        sortBy: 'merged30',
        teamName: 'platform-core',
        modalWidth: 100,
        modalHeight: 22,
      });
      testModalGeometry('StatsModal', lines, 100, 22);
    });

    it('validates 3. Details Modal frame trace', () => {
      const lines = renderDetailsModal({
        pr,
        modalWidth: 92,
        modalHeight: 20,
        scrollOffset: 0,
      });
      testModalGeometry('DetailsModal', lines, 92, 20);
    });

    it('validates 4. All Actions & Help Modal frame trace', () => {
      const lines = renderHelpModal({
        modalWidth: 88,
        modalHeight: 28,
      });
      testModalGeometry('HelpModal', lines, 88, 28);
    });

    it('validates 5. Settings Modal frame trace', () => {
      const lines = renderSettingsModal({
        state,
        selectedIndex: 0,
        isEditingText: false,
        editBuffer: '',
        modalWidth: 86,
        modalHeight: 24,
      });
      testModalGeometry('SettingsModal', lines, 86, 24);
      const text = lines.map(stripAnsi).join('\n');
      expect(text).toContain('Recent Work Window');
      expect(text).toContain('7 days (1w)');
      expect(text).toContain('Team Open PR Max Age');
      expect(text).toContain('30 days (1m)');
      expect(text).toContain('Team Poll Interval');
      expect(text).toContain('120s');
    });

    it('validates 6. Diff Modal frame trace', () => {
      const lines = renderDiffModal({
        pr,
        diffText: 'diff --git a/file.ts b/file.ts\n+added line\n-removed line',
        modalWidth: 96,
        modalHeight: 20,
        scrollOffset: 0,
      });
      testModalGeometry('DiffModal', lines, 96, 20);
    });

    it('validates 7. Logs Modal frame trace', () => {
      const lines = renderLogsModal({
        pr,
        logLines: ['[10:00:00] Worker started', '[10:01:00] Completed'],
        modalWidth: 94,
        modalHeight: 18,
        scrollOffset: 0,
      });
      testModalGeometry('LogsModal', lines, 94, 18);
    });
  });
});
