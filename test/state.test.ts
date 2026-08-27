import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createEmptyState,
  saveState,
  loadState,
  saveSettings,
  loadSettings,
  resolveSettingsPath,
  resetState,
  resetSettings,
  resetAll,
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
  getAgentDefinition,
  loadAgentsConfig,
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
      author: 'alice',
      url: 'https://github.com/acme-corp/web-frontend/pull/142',
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
      const pr1 = createMockPR({ owner: 'acme-corp', repo: 'web-frontend', number: 142 }, 'Ready');
      const pr2 = createMockPR({ owner: 'acme-corp', repo: 'api-gateway', number: 88 }, 'ChangesRequested');

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

    it('persists and restores circuitBreaker state correctly', () => {
      const state = createEmptyState();
      state.circuitBreaker = {
        retryCounters: { 'acme-corp/web-frontend#142:ci': 2 },
        lastDispatchAt: { 'acme-corp/web-frontend#142:ci': 1700000000 },
        reviewedKeys: ['acme-corp/web-frontend#142@rev1'],
        fixedKeys: ['acme-corp/web-frontend#142@comments-2-1@rev1'],
        batchIndex: { 'acme-corp/web-frontend#142:fix': 1 },
      };

      saveState(state, customStatePath);

      const loaded = loadState(customStatePath);
      expect(loaded).not.toBeNull();
      expect(loaded?.circuitBreaker).toEqual({
        retryCounters: { 'acme-corp/web-frontend#142:ci': 2 },
        lastDispatchAt: { 'acme-corp/web-frontend#142:ci': 1700000000 },
        reviewedKeys: ['acme-corp/web-frontend#142@rev1'],
        fixedKeys: ['acme-corp/web-frontend#142@comments-2-1@rev1'],
        batchIndex: { 'acme-corp/web-frontend#142:fix': 1 },
      });
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
      expect(getRepoAgent(state, { owner: 'acme-corp', repo: 'web-frontend' })).toBe('claude');

      setRepoAgent(state, { owner: 'acme-corp', repo: 'web-frontend' }, 'agy');
      expect(getRepoAgent(state, { owner: 'acme-corp', repo: 'web-frontend' })).toBe('agy');

      const agents = getAvailableAgents(state, tmpDir);
      expect(agents).toContain('claude');
      expect(agents).toContain('agy');
      expect(agents).toContain('gemini');
      expect(agents).toContain('pi');
    });

    it('loads custom agents and filters disabled agents from .overseer/agents.json', async () => {
      const { loadAgentsConfig } = await import('../src/app/state.js');
      const agentsDir = path.join(tmpDir, '.overseer');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, 'agents.json'),
        JSON.stringify({
          customAgents: {
            opencode: { command: 'opencode run', description: 'OpenCode CLI' },
          },
          disabledAgents: ['pi'],
        })
      );

      const loaded = loadAgentsConfig(tmpDir);
      expect(loaded.customAgents?.opencode?.command).toBe('opencode run');
      expect(loaded.disabledAgents).toEqual(['pi']);

      const state = createEmptyState();
      const available = getAvailableAgents(state, tmpDir);
      expect(available).toContain('opencode');
      expect(available).toContain('claude');
      expect(available).not.toContain('pi');

      const def = getAgentDefinition('opencode', state, tmpDir);
      expect(def.command).toBe('opencode run');
    });

    it('preserves MERGED status and timestamps in recordHistoricalPr without accidental downgrades', async () => {
      const { recordHistoricalPr } = await import('../src/app/state.js');
      const state = createEmptyState();
      const prKey: PrKey = { owner: 'acme-corp', repo: 'web-frontend', number: 101 };

      const mergedPr = createMockPR(prKey, 'Merged');
      mergedPr.state = 'MERGED';
      mergedPr.mergedAt = '2026-08-15T12:00:00Z';

      recordHistoricalPr(state, mergedPr);
      expect(state.historicalStats?.records[0].state).toBe('MERGED');
      expect(state.historicalStats?.records[0].mergedAt).toBe('2026-08-15T12:00:00Z');

      // Attempting to record as generic CLOSED without closedAt does not overwrite MERGED
      const closedPr = createMockPR(prKey, 'Closed');
      closedPr.state = 'CLOSED';
      recordHistoricalPr(state, closedPr);

      expect(state.historicalStats?.records[0].state).toBe('MERGED');
      expect(state.historicalStats?.records[0].mergedAt).toBe('2026-08-15T12:00:00Z');
    });

    it('persists and restores rateLimitedUntil correctly', () => {
      const state = createEmptyState();
      const resetTime = Date.now() + 1800000;
      state.rateLimitedUntil = resetTime;

      saveState(state, customStatePath);
      const loaded = loadState(customStatePath);

      expect(loaded?.rateLimitedUntil).toBe(resetTime);
    });

    it('persists and restores memberWatermarks in historicalStats correctly', () => {
      const state = createEmptyState();
      state.historicalStats = {
        records: [],
        memberWatermarks: {
          alice: {
            lastBackfilledAt: '2026-08-20T10:00:00.000Z',
            timeframeDays: 90,
            prCount: 15,
            status: 'success',
          },
          bob: {
            lastBackfilledAt: '2026-08-20T10:00:00.000Z',
            timeframeDays: 90,
            prCount: 0,
            status: 'rate_limited',
          },
        },
      };

      saveState(state, customStatePath);
      const loaded = loadState(customStatePath);

      expect(loaded?.historicalStats?.memberWatermarks).toBeDefined();
      expect(loaded?.historicalStats?.memberWatermarks?.alice.prCount).toBe(15);
      expect(loaded?.historicalStats?.memberWatermarks?.alice.status).toBe('success');
      expect(loaded?.historicalStats?.memberWatermarks?.bob.status).toBe('rate_limited');
    });
  });

  describe('settings.json Separation & Migration', () => {
    it('saves and loads user preferences from settings.json independently', () => {
      const state = createEmptyState({
        team: 'acme-infra',
        pollIntervalSecs: 45,
        defaultAgent: 'gemini',
      }, {
        api: { enabled: true, port: 4444 },
      });
      setRepoAgent(state, { owner: 'acme-corp', repo: 'backend' }, 'pi');

      const customSettingsPath = path.join(tmpDir, '.overseer', 'settings.json');
      saveSettings(state, customSettingsPath, tmpDir);

      const loaded = loadSettings(customSettingsPath, tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded?.settings?.team).toBe('acme-infra');
      expect(loaded?.settings?.pollIntervalSecs).toBe(45);
      expect(loaded?.settings?.defaultAgent).toBe('gemini');
      expect(loaded?.extensions?.api?.enabled).toBe(true);
      expect(loaded?.extensions?.api?.port).toBe(4444);
      expect(loaded?.repoAgents?.['acme-corp/backend']).toBe('pi');
    });

    it('migrates legacy settings from state.json when settings.json is missing', () => {
      const overseerDir = path.join(tmpDir, '.overseer');
      fs.mkdirSync(overseerDir, { recursive: true });
      const legacyState = {
        settings: {
          team: 'legacy-team',
          pollIntervalSecs: 60,
          defaultAgent: 'agy',
        },
        extensions: {
          api: { enabled: true, port: 5000 },
        },
        repoAgents: {
          'acme-corp/frontend': 'claude',
        },
        prs: {},
      };
      fs.writeFileSync(path.join(overseerDir, 'state.json'), JSON.stringify(legacyState, null, 2));

      const loaded = loadSettings(undefined, tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded?.settings?.team).toBe('legacy-team');
      expect(loaded?.settings?.pollIntervalSecs).toBe(60);
      expect(loaded?.settings?.defaultAgent).toBe('agy');
      expect(loaded?.extensions?.api?.port).toBe(5000);
      expect(loaded?.repoAgents?.['acme-corp/frontend']).toBe('claude');
    });

    it('resets state, settings, and all cleanly with reset helpers', () => {
      const overseerDir = path.join(tmpDir, '.overseer');
      fs.mkdirSync(overseerDir, { recursive: true });
      const stateFile = path.join(overseerDir, 'state.json');
      const settingsFile = path.join(overseerDir, 'settings.json');

      fs.writeFileSync(stateFile, JSON.stringify({ prs: {} }));
      fs.writeFileSync(settingsFile, JSON.stringify({ settings: { team: 'test' } }));

      expect(fs.existsSync(stateFile)).toBe(true);
      expect(fs.existsSync(settingsFile)).toBe(true);

      resetState(tmpDir);
      expect(fs.existsSync(stateFile)).toBe(false);
      expect(fs.existsSync(settingsFile)).toBe(true);

      fs.writeFileSync(stateFile, JSON.stringify({ prs: {} }));
      resetSettings(tmpDir);
      expect(fs.existsSync(settingsFile)).toBe(false);
      expect(fs.existsSync(stateFile)).toBe(true);

      fs.writeFileSync(settingsFile, JSON.stringify({ settings: { team: 'test' } }));
      resetAll(tmpDir);
      expect(fs.existsSync(stateFile)).toBe(false);
      expect(fs.existsSync(settingsFile)).toBe(false);
    });
  });
});
