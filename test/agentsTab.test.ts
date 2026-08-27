import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createEmptyState, upsertPR } from '../src/app/state.js';
import { recordAgentExecution } from '../src/agents/stats.js';
import { collectPRWorkflowGroups, renderAgentsTab } from '../src/tui/agentsTab.js';
import { renderScopeTabBar } from '../src/tui/search.js';
import { renderTable } from '../src/tui/table.js';
import { stripAnsi } from '../src/tui/layout.js';
import type { PrState, WorkerHandle, AgentExecutionRecord } from '../src/app/types.js';

describe('Agents Tab & Session Stream Engine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-agent-ui-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  function createMockPR(number: number): PrState {
    return {
      key: { owner: 'acme-corp', repo: 'backend-service', number },
      title: `Feature database refactor #${number}`,
      branch: `feat/db-refactor-${number}`,
      baseBranch: 'main',
      author: 'alice',
      url: `https://github.com/acme-corp/backend-service/pull/${number}`,
      isDraft: false,
      state: 'OPEN',
      reviewVerdict: 'APPROVED',
      ciStatus: 'SUCCESS',
      overallStatus: 'Ready',
      ciChecks: [],
      commentsCount: 2,
      unresolvedThreadsCount: 0,
      createdAt: '2026-08-20T10:00:00Z',
      updatedAt: '2026-08-20T11:00:00Z',
      log: [],
    };
  }

  it('renders clean empty state when no agent workflows exist', () => {
    const data = createEmptyState();
    const lines = renderAgentsTab({
      data,
      width: 100,
      height: 15,
      selectedPrIndex: 0,
      selectedSessionIndex: 0,
      focusedPane: 'left',
      expandedSessionIds: new Set(),
      scrollOffset: 0,
      cwd: tmpDir,
    });

    const plain = lines.map(stripAnsi).join('\n');
    expect(plain).toContain('No active or historical agent workflows recorded yet');
  });

  it('collects workflow groups from historical records and sorts correctly', () => {
    const data = createEmptyState();
    upsertPR(data, createMockPR(10));
    upsertPR(data, createMockPR(20));

    const rec1: AgentExecutionRecord = {
      sessionId: 'sess-10-1',
      prKey: { owner: 'acme-corp', repo: 'backend-service', number: 10 },
      agentName: 'claude',
      playbookName: 'preflight-review',
      driver: 'local',
      mode: 'live',
      startedAt: '2026-08-20T10:00:00Z',
      finishedAt: '2026-08-20T10:01:00Z',
      durationMs: 60000,
      status: 'completed',
      exitCode: 0,
      summary: 'Reviewed 5 files',
    };
    recordAgentExecution(rec1, undefined, tmpDir);

    const rec2: AgentExecutionRecord = {
      sessionId: 'sess-20-1',
      prKey: { owner: 'acme-corp', repo: 'backend-service', number: 20 },
      agentName: 'agy',
      playbookName: 'address-comments',
      driver: 'local',
      mode: 'live',
      startedAt: '2026-08-20T12:00:00Z',
      finishedAt: '2026-08-20T12:02:00Z',
      durationMs: 120000,
      status: 'completed',
      exitCode: 0,
      summary: 'Fixed 3 comments',
    };
    recordAgentExecution(rec2, undefined, tmpDir);

    const groups = collectPRWorkflowGroups(data, tmpDir);
    expect(groups.length).toBe(2);
    // Most recent activity (#20) is first
    expect(groups[0].number).toBe(20);
    expect(groups[1].number).toBe(10);
  });

  it('pins active running worker to the top of PR workflows', () => {
    const data = createEmptyState();
    upsertPR(data, createMockPR(10));
    upsertPR(data, createMockPR(20));

    const rec1: AgentExecutionRecord = {
      sessionId: 'sess-10-1',
      prKey: { owner: 'acme-corp', repo: 'backend-service', number: 10 },
      agentName: 'claude',
      playbookName: 'preflight-review',
      driver: 'local',
      mode: 'live',
      startedAt: '2026-08-20T12:00:00Z',
      status: 'completed',
    };
    recordAgentExecution(rec1, undefined, tmpDir);

    const runningWorker: WorkerHandle = {
      sessionId: 'sess-20-live',
      prKey: { owner: 'acme-corp', repo: 'backend-service', number: 20 },
      agentName: 'agy',
      playbookName: 'ci-repair',
      branch: 'feat/db-refactor-20',
      worktreePath: path.join(tmpDir, 'wt-20'),
      logPath: path.join(tmpDir, 'log-20.log'),
      startedAt: Date.now() - 30000,
      status: 'running',
      child: null,
    };
    data.workers.set('acme-corp/backend-service#20', runningWorker);

    const groups = collectPRWorkflowGroups(data, tmpDir);
    expect(groups[0].number).toBe(20);
    expect(groups[0].activeWorker).not.toBeNull();
  });

  it('renders two-pane view with live running card and completed cards', () => {
    const data = createEmptyState();
    upsertPR(data, createMockPR(15));

    // Historical completed record
    const rec1: AgentExecutionRecord = {
      sessionId: 'sess-15-1',
      prKey: { owner: 'acme-corp', repo: 'backend-service', number: 15 },
      agentName: 'claude',
      playbookName: 'preflight-review',
      driver: 'local',
      mode: 'live',
      startedAt: '2026-08-20T10:00:00Z',
      durationMs: 42000,
      status: 'completed',
      exitCode: 0,
      summary: 'Posted review with 8 items',
    };
    recordAgentExecution(rec1, undefined, tmpDir);

    // Active running worker
    const logFile = path.join(tmpDir, 'log-15.log');
    fs.writeFileSync(logFile, 'Line 1\nLine 2: Running vitest suite\nLine 3: 203/203 passed\n');

    const runningWorker: WorkerHandle = {
      sessionId: 'sess-15-live',
      prKey: { owner: 'acme-corp', repo: 'backend-service', number: 15 },
      agentName: 'agy',
      playbookName: 'address-comments',
      branch: 'feat/db-refactor-15',
      worktreePath: path.join(tmpDir, 'wt-15'),
      logPath: logFile,
      startedAt: Date.now() - 48000,
      status: 'running',
      child: null,
    };
    data.workers.set('acme-corp/backend-service#15', runningWorker);

    const lines = renderAgentsTab({
      data,
      width: 120,
      height: 20,
      selectedPrIndex: 0,
      selectedSessionIndex: 0,
      focusedPane: 'left',
      expandedSessionIds: new Set(['sess-15-1']),
      scrollOffset: 0,
      cwd: tmpDir,
    });

    const plain = lines.map(stripAnsi).join('\n');
    // Left pane checks
    expect(plain).toContain('PR WORKFLOWS (1)');
    expect(plain).toContain('#15 · backend-service');

    // Right pane checks
    expect(plain).toContain('TIMELINE · #15 (acme-corp/backend-service)');
    expect(plain).toContain('🤖 agy · address-comments');
    expect(plain).toContain('Running vitest suite');
    expect(plain).toContain('203/203 passed');
    expect(plain).toContain('Running 48s...');

    // Historical card
    expect(plain).toContain('🤖 claude · preflight-review');
    expect(plain).toContain('Completed in 42s · Exit Code: 0');
  });

  it('renders scope tab bar with [1] Mine, [2] Team, and [3] Agents correctly', () => {
    const rendered = renderScopeTabBar({
      scope: 'agents',
      mineCount: 4,
      teamCount: 18,
      runningAgentsCount: 3,
      hasRunningAgent: true,
      width: 100,
    });

    const plain = stripAnsi(rendered);
    expect(plain).toContain('[1] Mine (4)');
    expect(plain).toContain('[2] Team (18)');
    expect(plain).toContain('[3] Agents (3)');
  });

  it('renders pulsating spinner when running and clean dot when idle', () => {
    // Inactive with running agent
    const inactiveRunning = renderScopeTabBar({
      scope: 'mine',
      mineCount: 4,
      teamCount: 18,
      runningAgentsCount: 2,
      hasRunningAgent: true,
      spinnerTick: 0,
      width: 100,
    });
    expect(inactiveRunning).toContain('⠋');
    expect(stripAnsi(inactiveRunning)).toContain('[1] Mine (4)');
    expect(stripAnsi(inactiveRunning)).toContain('[3] Agents (2)');

    // Active with running agent (1 running, no count needed)
    const activeRunning = renderScopeTabBar({
      scope: 'agents',
      mineCount: 4,
      teamCount: 18,
      runningAgentsCount: 1,
      hasRunningAgent: true,
      spinnerTick: 0,
      width: 100,
    });
    expect(activeRunning).toContain('⠋');
    expect(stripAnsi(activeRunning)).toContain('[3] Agents');

    // Active idle (no number)
    const activeIdle = renderScopeTabBar({
      scope: 'agents',
      mineCount: 4,
      teamCount: 18,
      runningAgentsCount: 0,
      hasRunningAgent: false,
      width: 100,
    });
    expect(activeIdle).toContain('●');
    expect(stripAnsi(activeIdle)).toContain('[3] Agents');
  });

  it('omits Agents tab when agentsEnabled is false (stealth mode)', () => {
    const rendered = renderScopeTabBar({
      scope: 'mine',
      mineCount: 4,
      teamCount: 18,
      agentsEnabled: false,
      width: 100,
    });

    const plain = stripAnsi(rendered);
    expect(plain).toContain('[1] Mine (4)');
    expect(plain).toContain('[2] Team (18)');
    expect(plain).not.toContain('Agents');
  });

  it('renders inline repository mode dots in table when agents are enabled and hides them when disabled', () => {
    const pr1 = createMockPR(101);
    const pr2 = createMockPR(102);
    pr2.key.repo = 'api-gateway';
    const pr3 = createMockPR(103);
    pr3.key.repo = 'web-frontend';

    const repoPolicies = {
      'acme-corp/backend-service': { mode: 'live' as const },
      'acme-corp/api-gateway': { mode: 'dry-run' as const },
    };

    // 1. Enabled: live (●), dry-run (🟡), unconfigured/off (○)
    const enabledLines = renderTable({
      prs: [pr1, pr2, pr3],
      selectedIndex: 0,
      width: 120,
      height: 10,
      repoPolicies,
      agentsEnabled: true,
    });
    const enabledPlain = enabledLines.map(stripAnsi).join('\n');
    expect(enabledPlain).toContain('● backend-service');
    expect(enabledPlain).toContain('🟡 api-gateway');
    expect(enabledPlain).toContain('○ web-frontend');

    // 2. Disabled (Stealth Mode: zero dots)
    const disabledLines = renderTable({
      prs: [pr1, pr2, pr3],
      selectedIndex: 0,
      width: 120,
      height: 10,
      repoPolicies,
      agentsEnabled: false,
    });
    const disabledPlain = disabledLines.map(stripAnsi).join('\n');
    expect(disabledPlain).toContain('backend-service');
    expect(disabledPlain).toContain('web-frontend');
    expect(disabledPlain).not.toContain('● backend-service');
    expect(disabledPlain).not.toContain('🟡 api-gateway');
    expect(disabledPlain).not.toContain('○ web-frontend');
  });

  it('renders non-running workers (interrupted, completed) as session cards', () => {
    const data = createEmptyState();
    upsertPR(data, createMockPR(30));

    const interruptedWorker: WorkerHandle = {
      sessionId: 'sess-30-interrupted',
      prKey: { owner: 'acme-corp', repo: 'backend-service', number: 30 },
      agentName: 'claude',
      playbookName: 'preflight-review',
      command: 'claude run',
      worktreePath: path.join(tmpDir, 'wt-30'),
      branch: 'feat/db-refactor-30',
      startedAt: Date.now() - 60000,
      finishedAt: Date.now() - 10000,
      status: 'interrupted',
      error: 'Worker interrupted by user',
    };
    data.workers.set('acme-corp/backend-service#30', interruptedWorker);

    const groups = collectPRWorkflowGroups(data, tmpDir);
    expect(groups.length).toBe(1);
    expect(groups[0].activeWorker).toBeNull();
    expect(groups[0].records.length).toBe(1);
    expect(groups[0].records[0].status).toBe('interrupted');

    const lines = renderAgentsTab({
      data,
      width: 120,
      height: 20,
      selectedPrIndex: 0,
      selectedSessionIndex: 0,
      focusedPane: 'left',
      expandedSessionIds: new Set(),
      scrollOffset: 0,
      cwd: tmpDir,
    });

    const plain = lines.map(stripAnsi).join('\n');
    expect(plain).toContain('1 session');
    expect(plain).not.toContain('0 sessions');
    expect(plain).not.toContain('(No agent execution sessions recorded for this PR yet)');
    expect(plain).toContain('TIMELINE · #30 (acme-corp/backend-service)');
    expect(plain).toContain('🤖 claude · preflight-review');
    expect(plain).toContain('Worker interrupted by user');
  });

  it('renders single-width dot in dry-run mode without misaligning left column', () => {
    const data = createEmptyState();
    upsertPR(data, createMockPR(40));

    const rec: AgentExecutionRecord = {
      sessionId: 'sess-40-dry',
      prKey: { owner: 'acme-corp', repo: 'backend-service', number: 40 },
      agentName: 'agy',
      playbookName: 'address-comments',
      driver: 'local',
      mode: 'dry-run',
      startedAt: '2026-08-20T10:00:00Z',
      finishedAt: '2026-08-20T10:01:00Z',
      durationMs: 60000,
      status: 'dry-run',
      summary: 'Dry-run simulation completed',
    };
    recordAgentExecution(rec, undefined, tmpDir);

    data.repoPolicies = {
      'acme-corp/backend-service': { mode: 'dry-run' },
    };

    const lines = renderAgentsTab({
      data,
      width: 120,
      height: 20,
      selectedPrIndex: 0,
      selectedSessionIndex: 0,
      focusedPane: 'left',
      expandedSessionIds: new Set(),
      scrollOffset: 0,
      cwd: tmpDir,
    });

    const raw = lines.join('\n');
    // Ensure yellow single-width ● is used rather than 2-cell emoji 🟡
    expect(raw).toContain('\x1B[1;33m●\x1B[0m');
    expect(raw).not.toContain('🟡');

    const plain = lines.map(stripAnsi).join('\n');
    expect(plain).toContain('● #40 · backend-service');
    expect(plain).toContain('1 session');
  });
});

