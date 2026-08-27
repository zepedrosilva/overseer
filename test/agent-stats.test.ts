import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadAgentStats,
  saveAgentStats,
  recordAgentExecution,
  calculateAgentStats,
  resetAgentStats,
  MAX_AGENT_EXECUTION_RECORDS,
} from '../src/agents/stats.js';
import type { AgentExecutionRecord, AgentStatsStore } from '../src/app/types.js';

describe('Agent Telemetry & Analytics Store (agent-stats.json)', () => {
  let tmpDir: string;
  let customStatsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-agent-stats-test-'));
    customStatsPath = path.join(tmpDir, '.overseer', 'agent-stats.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('loads empty store when file does not exist', () => {
    const store = loadAgentStats(customStatsPath, tmpDir);
    expect(store).toEqual({ records: [] });
  });

  it('saves and loads execution records correctly', () => {
    const record: AgentExecutionRecord = {
      sessionId: 'sess-123',
      prKey: { owner: 'acme-corp', repo: 'web-frontend', number: 42 },
      agentName: 'agy',
      playbookName: 'ci-repair',
      driver: 'local',
      mode: 'live',
      trigger: 'autonomous_ci',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 60000,
      status: 'completed',
      exitCode: 0,
    };

    saveAgentStats({ records: [record] }, customStatsPath, tmpDir);

    const loaded = loadAgentStats(customStatsPath, tmpDir);
    expect(loaded.records.length).toBe(1);
    expect(loaded.records[0].sessionId).toBe('sess-123');
    expect(loaded.records[0].agentName).toBe('agy');
    expect(loaded.records[0].status).toBe('completed');
  });

  it('caps historical records to MAX_AGENT_EXECUTION_RECORDS (rolling window)', () => {
    const records: AgentExecutionRecord[] = [];
    for (let i = 0; i < MAX_AGENT_EXECUTION_RECORDS + 20; i++) {
      recordAgentExecution(
        {
          sessionId: `sess-${i}`,
          prKey: { owner: 'acme-corp', repo: 'web-frontend', number: i },
          agentName: 'claude',
          playbookName: 'address-comments',
          driver: 'local',
          mode: 'live',
          trigger: 'manual',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 5000,
          status: 'completed',
        },
        customStatsPath,
        tmpDir
      );
    }

    const store = loadAgentStats(customStatsPath, tmpDir);
    expect(store.records.length).toBe(MAX_AGENT_EXECUTION_RECORDS);
    // Most recent is at index 0
    expect(store.records[0].sessionId).toBe(`sess-${MAX_AGENT_EXECUTION_RECORDS + 19}`);
  });

  it('calculates aggregated metrics by agent, playbook, and repo', () => {
    const now = Date.now();
    const records: AgentExecutionRecord[] = [
      {
        sessionId: '1',
        prKey: { owner: 'acme-corp', repo: 'web-frontend', number: 10 },
        agentName: 'agy',
        playbookName: 'ci-repair',
        driver: 'local',
        mode: 'live',
        trigger: 'autonomous_ci',
        startedAt: new Date(now - 100000).toISOString(),
        finishedAt: new Date(now - 40000).toISOString(),
        durationMs: 60000,
        status: 'completed',
      },
      {
        sessionId: '2',
        prKey: { owner: 'acme-corp', repo: 'web-frontend', number: 11 },
        agentName: 'agy',
        playbookName: 'ci-repair',
        driver: 'local',
        mode: 'live',
        trigger: 'autonomous_ci',
        startedAt: new Date(now - 80000).toISOString(),
        finishedAt: new Date(now - 40000).toISOString(),
        durationMs: 40000,
        status: 'failed',
      },
      {
        sessionId: '3',
        prKey: { owner: 'acme-corp', repo: 'api-gateway', number: 20 },
        agentName: 'claude',
        playbookName: 'address-comments',
        driver: 'local',
        mode: 'dry-run',
        trigger: 'autonomous_review',
        startedAt: new Date(now - 50000).toISOString(),
        finishedAt: new Date(now - 50000).toISOString(),
        durationMs: 0,
        status: 'dry-run',
      },
    ];

    const stats = calculateAgentStats(records, 30);

    expect(stats.totalRuns).toBe(3);
    expect(stats.dryRunsCount).toBe(1);
    expect(stats.successRate).toBeCloseTo(33.33, 1);
    expect(stats.avgDurationMs).toBe(Math.round(100000 / 3));

    // By Agent
    expect(stats.byAgent['agy']).toBeDefined();
    expect(stats.byAgent['agy'].runs).toBe(2);
    expect(stats.byAgent['agy'].successCount).toBe(1);
    expect(stats.byAgent['agy'].failedCount).toBe(1);
    expect(stats.byAgent['agy'].successRate).toBe(50);
    expect(stats.byAgent['agy'].avgDurationMs).toBe(50000);
    expect(stats.byAgent['agy'].topPlaybook).toBe('ci-repair');

    expect(stats.byAgent['claude']).toBeDefined();
    expect(stats.byAgent['claude'].runs).toBe(1);
    expect(stats.byAgent['claude'].avgDurationMs).toBe(0);

    // By Playbook
    expect(stats.byPlaybook['ci-repair']).toBeDefined();
    expect(stats.byPlaybook['ci-repair'].runs).toBe(2);
    expect(stats.byPlaybook['ci-repair'].avgDurationMs).toBe(50000);
    expect(stats.byPlaybook['ci-repair'].topRepo).toBe('acme-corp/web-frontend');

    expect(stats.byPlaybook['address-comments']).toBeDefined();
    expect(stats.byPlaybook['address-comments'].runs).toBe(1);
    expect(stats.byPlaybook['address-comments'].avgDurationMs).toBe(0);

    // By Repo
    expect(stats.byRepo['acme-corp/web-frontend']).toBeDefined();
    expect(stats.byRepo['acme-corp/web-frontend'].runs).toBe(2);
    expect(stats.byRepo['acme-corp/web-frontend'].autoRuns).toBe(2);
    expect(stats.byRepo['acme-corp/web-frontend'].manualRuns).toBe(0);
  });

  it('computes per-group avg duration accurately across mixed durations and multiple groups', () => {
    const now = Date.now();
    const records: AgentExecutionRecord[] = [
      {
        sessionId: 'a1',
        prKey: { owner: 'acme-corp', repo: 'repo-1', number: 1 },
        agentName: 'claude',
        playbookName: 'preflight-review',
        driver: 'local',
        mode: 'live',
        trigger: 'manual',
        startedAt: new Date(now - 60000).toISOString(),
        finishedAt: new Date(now - 45000).toISOString(),
        durationMs: 15000,
        status: 'completed',
      },
      {
        sessionId: 'a2',
        prKey: { owner: 'acme-corp', repo: 'repo-1', number: 2 },
        agentName: 'claude',
        playbookName: 'preflight-review',
        driver: 'local',
        mode: 'live',
        trigger: 'manual',
        startedAt: new Date(now - 40000).toISOString(),
        finishedAt: new Date(now - 15000).toISOString(),
        durationMs: 25000,
        status: 'completed',
      },
      {
        sessionId: 'b1',
        prKey: { owner: 'acme-corp', repo: 'repo-2', number: 3 },
        agentName: 'agy',
        playbookName: 'ci-repair',
        driver: 'local',
        mode: 'live',
        trigger: 'autonomous_ci',
        startedAt: new Date(now - 30000).toISOString(),
        finishedAt: new Date(now - 10000).toISOString(),
        durationMs: 20000,
        status: 'completed',
      },
    ];

    const stats = calculateAgentStats(records, 30);

    // Claude avg: (15000 + 25000) / 2 = 20000ms
    expect(stats.byAgent['claude'].runs).toBe(2);
    expect(stats.byAgent['claude'].avgDurationMs).toBe(20000);

    // Agy avg: 20000 / 1 = 20000ms
    expect(stats.byAgent['agy'].runs).toBe(1);
    expect(stats.byAgent['agy'].avgDurationMs).toBe(20000);

    // Preflight-review avg: (15000 + 25000) / 2 = 20000ms
    expect(stats.byPlaybook['preflight-review'].runs).toBe(2);
    expect(stats.byPlaybook['preflight-review'].avgDurationMs).toBe(20000);

    // Ci-repair avg: 20000 / 1 = 20000ms
    expect(stats.byPlaybook['ci-repair'].runs).toBe(1);
    expect(stats.byPlaybook['ci-repair'].avgDurationMs).toBe(20000);

    // Overall avg: (15000 + 25000 + 20000) / 3 = 20000ms
    expect(stats.avgDurationMs).toBe(20000);
  });

  it('returns 0 avgDurationMs when there are no runs', () => {
    const stats = calculateAgentStats([], 30);
    expect(stats.totalRuns).toBe(0);
    expect(stats.avgDurationMs).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(Object.keys(stats.byAgent).length).toBe(0);
    expect(Object.keys(stats.byPlaybook).length).toBe(0);
    expect(Object.keys(stats.byRepo).length).toBe(0);
  });

  it('renders stats modal with 3 tabs and properly aligned agent tables', async () => {
    const { renderStatsModal } = await import('../src/tui/stats.js');
    const { calculateStats } = await import('../src/stats/index.js');
    const { createEmptyState } = await import('../src/app/state.js');
    const dummyStats = calculateStats(createEmptyState(), '30d');

    const records: AgentExecutionRecord[] = [
      {
        sessionId: 'test-sess',
        prKey: { owner: 'acme-corp', repo: 'web-frontend', number: 10 },
        agentName: 'agy',
        playbookName: 'address-comments',
        driver: 'local',
        mode: 'live',
        trigger: 'manual',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 120000,
        status: 'completed',
      },
    ];

    const agentStats = calculateAgentStats(records, 30);
    const lines = renderStatsModal({
      stats: dummyStats,
      agentStats,
      activeTab: 'agents',
      modalWidth: 90,
      modalHeight: 25,
    });

    const stripped = lines.map((l) => l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')).join('\n');
    expect(stripped).toContain('[1] Mine');
    expect(stripped).toContain('[2] Team');
    expect(stripped).toContain('[3] 🤖 Agents');
    expect(stripped).toContain('Performance by Agent');
    expect(stripped).toContain('Performance by Operation / Playbook');
    expect(stripped).toContain('Recent Execution Audit Trail');
    // Ensure numbers and percentages have visual space and are not concatenated
    expect(stripped).not.toContain('1100.0%');
    expect(stripped).toContain('100.0%');
  });
});
