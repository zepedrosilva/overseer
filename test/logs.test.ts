import { describe, it, expect } from 'vitest';
import { renderLogsModal, loadPRLogFile } from '../src/tui/logs.js';
import { renderTable } from '../src/tui/table.js';
import { stripAnsi, visualLength } from '../src/tui/layout.js';
import type { PrState, WorkerHandle } from '../src/app/types.js';
import { prKeyToString } from '../src/app/types.js';

describe('Agent Logs Modal & Table Worker Indicators', () => {
  function createMockPR(): PrState {
    return {
      key: { owner: 'acme-corp', repo: 'web-frontend', number: 142 },
      title: 'Fix invoice rounding calculations',
      branch: 'fix/rounding',
      baseBranch: 'main',
      author: 'alice',
      url: 'https://github.com/acme-corp/web-frontend/pull/142',
      isDraft: false,
      state: 'OPEN',
      reviewVerdict: 'APPROVED',
      ciStatus: 'SUCCESS',
      overallStatus: 'Ready',
      ciChecks: [],
      commentsCount: 0,
      unresolvedThreadsCount: 0,
      createdAt: '2026-08-17T10:00:00Z',
      updatedAt: '2026-08-17T11:00:00Z',
      log: ['[12:00:00] Initialized worktree', '[12:00:05] Running tests'],
    };
  }

  describe('loadPRLogFile', () => {
    it('falls back to in-memory PR logs when file does not exist', () => {
      const pr = createMockPR();
      const logs = loadPRLogFile(pr, '/tmp/nonexistent');
      expect(logs).toEqual(pr.log);
    });

    it('returns helper message when no logs exist at all', () => {
      const pr = createMockPR();
      pr.log = [];
      const logs = loadPRLogFile(pr, '/tmp/nonexistent');
      expect(logs[0]).toContain('No agent logs recorded yet');
    });
  });

  describe('renderLogsModal', () => {
    it('renders running worker state with live elapsed badge', () => {
      const pr = createMockPR();
      const worker: WorkerHandle = {
        sessionId: 'test-123',
        prKey: pr.key,
        agentName: 'claude',
        command: 'claude -p fix',
        worktreePath: '/tmp/worktree',
        branch: pr.branch,
        startedAt: Date.now() - 45000,
        pid: 1234,
        logPath: '/tmp/log.log',
        status: 'running',
      };

      const lines = renderLogsModal({
        pr,
        worker,
        logLines: ['[12:00:00] Running tests', '[12:00:10] All tests passed'],
        modalWidth: 80,
        modalHeight: 12,
        scrollOffset: 0,
        spinnerTick: 0,
      });

      expect(lines).toHaveLength(12);
      for (const line of lines) {
        expect(visualLength(line)).toBe(80);
      }

      const fullText = lines.map(stripAnsi).join('\n');
      expect(fullText).toContain('TIMELINE · #142 (acme-corp/web-frontend)');
      expect(fullText).toContain('🤖 claude');
      expect(fullText).toContain('[↑/↓] scroll');
      expect(fullText).toContain('[Esc to close]');
    });

    it('renders completed worker status', () => {
      const pr = createMockPR();
      const worker: WorkerHandle = {
        sessionId: 'test-123',
        prKey: pr.key,
        agentName: 'agy',
        command: 'agy --prompt review',
        worktreePath: '/tmp/worktree',
        branch: pr.branch,
        startedAt: Date.now() - 120000,
        finishedAt: Date.now() - 10000,
        pid: 1234,
        logPath: '/tmp/log.log',
        status: 'completed',
      };

      const lines = renderLogsModal({
        pr,
        worker,
        logLines: ['Review finished with 0 errors'],
        modalWidth: 80,
        modalHeight: 10,
        scrollOffset: 0,
      });

      expect(lines).toHaveLength(10);
      const fullText = lines.map(stripAnsi).join('\n');
      expect(fullText).toContain('🤖 agy');
      expect(fullText).toContain('Completed in');
    });
  });

  describe('renderTable with active workers', () => {
    it('displays active running worker spinner and name in table row', () => {
      const pr = createMockPR();
      const workers = new Map<string, WorkerHandle>();
      workers.set(prKeyToString(pr.key), {
        sessionId: 'test-123',
        prKey: pr.key,
        agentName: 'claude',
        command: 'claude -p fix',
        worktreePath: '/tmp/worktree',
        branch: pr.branch,
        startedAt: Date.now(),
        pid: 1234,
        logPath: '/tmp/log.log',
        status: 'running',
      });

      const lines = renderTable({
        prs: [pr],
        selectedIndex: 0,
        width: 100,
        height: 5,
        workers,
        spinnerTick: 2,
      });

      expect(stripAnsi(lines[1])).toContain('acme-corp');
      const rowText = stripAnsi(lines[2]);
      expect(rowText).toContain('[1]');
      expect(rowText).toContain('web-frontend');
      expect(rowText).toContain('#142');
    });
  });
});
