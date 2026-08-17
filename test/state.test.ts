import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createEmptyState,
  saveState,
  loadState,
  findPR,
  upsertPR,
  removePR,
  updatePRStatus,
  appendLog,
  countNeedsAttention,
  getPrList,
  setWorker,
  getWorker,
  removeWorker,
  resolveStateDir,
  resolveStatePath,
  getRepoAgent,
  setRepoAgent,
  getAvailableAgents,
  MAX_PR_LOG_ENTRIES,
} from '../src/app/state.js';
import type { AppState, PrState, PrKey, WorkerHandle } from '../src/app/types.js';

describe('State Store & Persistence', () => {
  let tmpDir: string;
  let customStatePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-state-test-'));
    customStatePath = path.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockPR(key: PrKey, status: PrState['overallStatus'] = 'Ready'): PrState {
    return {
      key,
      title: 'Fix issue with billing rounding',
      branch: 'fix/rounding',
      baseBranch: 'main',
      author: 'josesilva',
      url: 'https://github.com/acme-corp/billing/pull/142',
      isDraft: false,
      state: 'OPEN',
      reviewVerdict: 'APPROVED',
      ciStatus: 'SUCCESS',
      overallStatus: status,
      ciChecks: [{ name: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      commentsCount: 2,
      unresolvedThreadsCount: 0,
      createdAt: '2026-08-17T10:00:00Z',
      updatedAt: '2026-08-17T11:00:00Z',
      log: ['[10:00:00] Initialized'],
    };
  }

  describe('Path Resolution', () => {
    it('creates and resolves .overseer directory in project root', () => {
      const stateDir = resolveStateDir(tmpDir);
      expect(stateDir).toBe(path.join(tmpDir, '.overseer'));
      expect(fs.existsSync(stateDir)).toBe(true);

      const statePath = resolveStatePath(tmpDir);
      expect(statePath).toBe(path.join(tmpDir, '.overseer', 'state.json'));
    });
  });

  describe('saveState and loadState', () => {
    it('saves and loads empty state', () => {
      const state = createEmptyState({ dryRun: true });
      saveState(state, customStatePath);

      const loaded = loadState(customStatePath);
      expect(loaded).not.toBeNull();
      expect(loaded?.dryRun).toBe(true);
      expect(loaded?.prs.size).toBe(0);
      expect(loaded?.workers.size).toBe(0);
    });

    it('persists and restores PRs and workers correctly', () => {
      const state = createEmptyState({ dryRun: false });
      const pr1 = createMockPR({ owner: 'acme-corp', repo: 'billing', number: 142 }, 'Ready');
      const pr2 = createMockPR({ owner: 'acme-corp', repo: 'meridian', number: 88 }, 'ChangesRequested');

      upsertPR(state, pr1);
      upsertPR(state, pr2);

      const worker: WorkerHandle = {
        sessionId: 'test-session-1',
        prKey: pr1.key,
        agentName: 'claude',
        command: 'claude -p test',
        worktreePath: '/tmp/worktree',
        branch: pr1.branch,
        startedAt: Date.now(),
        status: 'running',
      };
      setWorker(state, pr1.key, worker);
      state.lastPolled = 1234567890;

      saveState(state, customStatePath);
      const loaded = loadState(customStatePath);

      expect(loaded).not.toBeNull();
      expect(loaded?.prs.size).toBe(2);
      expect(loaded?.workers.size).toBe(1);
      expect(loaded?.lastPolled).toBe(1234567890);

      const loadedPR1 = findPR(loaded!, pr1.key);
      expect(loadedPR1?.title).toBe(pr1.title);
      expect(loadedPR1?.overallStatus).toBe('Ready');
      expect(loadedPR1?.ciChecks).toHaveLength(1);

      const loadedWorker = getWorker(loaded!, pr1.key);
      expect(loadedWorker?.sessionId).toBe('test-session-1');
    });

    it('returns null when state file does not exist', () => {
      expect(loadState(path.join(tmpDir, 'nonexistent.json'))).toBeNull();
    });
  });

  describe('Mutation & Query Helpers', () => {
    it('upserts and finds PRs', () => {
      const state = createEmptyState();
      const pr = createMockPR({ owner: 'owner', repo: 'repo', number: 1 });
      upsertPR(state, pr);

      expect(findPR(state, { owner: 'owner', repo: 'repo', number: 1 })).toEqual(pr);
      expect(getPrList(state)).toHaveLength(1);
    });

    it('removes PRs', () => {
      const state = createEmptyState();
      const pr = createMockPR({ owner: 'owner', repo: 'repo', number: 1 });
      upsertPR(state, pr);
      expect(findPR(state, pr.key)).not.toBeNull();

      removePR(state, pr.key);
      expect(findPR(state, pr.key)).toBeNull();
      expect(getPrList(state)).toHaveLength(0);
    });

    it('updates PR status and detail', () => {
      const state = createEmptyState();
      const pr = createMockPR({ owner: 'owner', repo: 'repo', number: 1 }, 'Reviewing');
      upsertPR(state, pr);

      updatePRStatus(state, pr.key, 'Ready', {
        reviewVerdict: 'APPROVED',
        ciStatus: 'SUCCESS',
        statusDetail: 'Ready for merge',
      });

      const updated = findPR(state, pr.key);
      expect(updated?.overallStatus).toBe('Ready');
      expect(updated?.reviewVerdict).toBe('APPROVED');
      expect(updated?.ciStatus).toBe('SUCCESS');
      expect(updated?.statusDetail).toBe('Ready for merge');
    });

    it('appends logs with timestamp and enforces max entries limit', () => {
      const state = createEmptyState();
      const pr = createMockPR({ owner: 'owner', repo: 'repo', number: 1 });
      pr.log = [];
      upsertPR(state, pr);

      for (let i = 0; i < MAX_PR_LOG_ENTRIES + 10; i++) {
        appendLog(state, pr.key, `Log message ${i}`);
      }

      const updated = findPR(state, pr.key)!;
      expect(updated.log.length).toBe(MAX_PR_LOG_ENTRIES);
      expect(updated.logOffset).toBe(10);
      expect(updated.log[updated.log.length - 1]).toContain(`Log message ${MAX_PR_LOG_ENTRIES + 9}`);
    });

    it('counts needs attention correctly', () => {
      const state = createEmptyState();
      upsertPR(state, createMockPR({ owner: 'o', repo: 'r', number: 1 }, 'Ready'));
      upsertPR(state, createMockPR({ owner: 'o', repo: 'r', number: 2 }, 'ChangesRequested'));
      upsertPR(state, createMockPR({ owner: 'o', repo: 'r', number: 3 }, 'CiFailing'));
      upsertPR(state, createMockPR({ owner: 'o', repo: 'r', number: 4 }, 'Draft'));

      expect(countNeedsAttention(state)).toBe(2);
    });

    it('manages worker handles', () => {
      const state = createEmptyState();
      const prKey: PrKey = { owner: 'o', repo: 'r', number: 1 };
      const worker: WorkerHandle = {
        sessionId: 'sess-1',
        prKey,
        agentName: 'claude',
        command: 'claude',
        worktreePath: '/tmp/wt',
        branch: 'fix/1',
        startedAt: Date.now(),
        status: 'running',
      };

      setWorker(state, prKey, worker);
      expect(getWorker(state, prKey)?.sessionId).toBe('sess-1');

      removeWorker(state, prKey);
      expect(getWorker(state, prKey)).toBeNull();
    });

    it('manages repo-specific agents and available agent lists', () => {
      const state = createEmptyState();
      expect(getRepoAgent(state, { owner: 'acme-corp', repo: 'billing' })).toBe('claude');

      setRepoAgent(state, { owner: 'acme-corp', repo: 'billing' }, 'agy');
      expect(getRepoAgent(state, { owner: 'acme-corp', repo: 'billing' })).toBe('agy');

      const agents = getAvailableAgents(state);
      expect(agents).toContain('claude');
      expect(agents).toContain('agy');
      expect(agents).toContain('gemini');
      expect(agents).toContain('pi');
    });
  });
});
