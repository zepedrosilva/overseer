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

    // By Agent
    expect(stats.byAgent['agy']).toBeDefined();
    expect(stats.byAgent['agy'].runs).toBe(2);
    expect(stats.byAgent['agy'].successCount).toBe(1);
    expect(stats.byAgent['agy'].failedCount).toBe(1);
    expect(stats.byAgent['agy'].successRate).toBe(50);
    expect(stats.byAgent['agy'].topPlaybook).toBe('ci-repair');

    // By Playbook
    expect(stats.byPlaybook['ci-repair']).toBeDefined();
    expect(stats.byPlaybook['ci-repair'].runs).toBe(2);
    expect(stats.byPlaybook['ci-repair'].topRepo).toBe('acme-corp/web-frontend');

    // By Repo
    expect(stats.byRepo['acme-corp/web-frontend']).toBeDefined();
    expect(stats.byRepo['acme-corp/web-frontend'].runs).toBe(2);
    expect(stats.byRepo['acme-corp/web-frontend'].autoRuns).toBe(2);
    expect(stats.byRepo['acme-corp/web-frontend'].manualRuns).toBe(0);
  });
});
