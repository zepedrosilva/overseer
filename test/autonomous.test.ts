import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  evaluateAutonomousPolicies,
  MAX_CONSECUTIVE_AUTONOMOUS_RETRIES,
  resetAutonomousState,
} from '../src/watcher/autonomous.js';
import { createEmptyState, upsertPR, setRepoPolicy, setWorker } from '../src/app/state.js';
import type { PrState, AppConfig } from '../src/app/types.js';
import * as agentsModule from '../src/agents/index.js';

function createPrFixture(num: number, status: 'CiFailing' | 'ChangesRequested' | 'Ready'): PrState {
  return {
    key: { owner: 'acme-corp', repo: 'web-frontend', number: num },
    title: `Fix item ${num}`,
    url: `https://github.com/acme-corp/web-frontend/pull/${num}`,
    branch: `feat/item-${num}`,
    baseBranch: 'main',
    author: 'alice',
    isDraft: false,
    state: 'OPEN',
    overallStatus: status,
    ciStatus: status === 'CiFailing' ? 'FAILURE' : 'SUCCESS',
    reviewVerdict: status === 'ChangesRequested' ? 'CHANGES_REQUESTED' : 'APPROVED',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ciChecks: [
      {
        name: 'unit-tests',
        status: 'COMPLETED',
        conclusion: status === 'CiFailing' ? 'FAILURE' : 'SUCCESS',
      },
    ],
    commentsCount: 2,
    log: [],
  };
}

const mockConfig: AppConfig = {
  defaults: {
    agent: 'claude',
    pollIntervalSecs: 30,
    worktrees_dir: './.overseer/worktrees',
    batch_size: 25,
  },
  repos: [],
  agents: {},
  runtime: { dryRun: false },
  api: { enabled: false, port: 3210 },
};

describe('Autonomous Policy Evaluator & Safety Circuit Breakers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetAutonomousState();
  });

  it('triggers ci-repair when PR is CiFailing on repo with live policy', async () => {
    const data = createEmptyState();
    const pr = createPrFixture(1, 'CiFailing');
    upsertPR(data, pr);

    setRepoPolicy(data, 'acme-corp/web-frontend', {
      mode: 'live',
      agent: 'agy',
      triggers: ['CiFailing'],
      allowedPlaybooks: ['ci-repair'],
    });

    const dispatchSpy = vi.spyOn(agentsModule, 'dispatchAgent').mockResolvedValue({
      sessionId: 'sess-1',
      prKey: pr.key,
      agentName: 'agy',
      command: 'mock',
      worktreePath: 'mock',
      branch: pr.branch,
      startedAt: Date.now(),
      status: 'running',
    });

    await evaluateAutonomousPolicies(data, mockConfig);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'agy',
        playbookName: 'ci-repair',
        trigger: 'autonomous_ci',
        mode: 'live',
      })
    );
  });

  it('triggers dry-run when repo policy mode is dry-run', async () => {
    const data = createEmptyState();
    const pr = createPrFixture(1, 'ChangesRequested');
    upsertPR(data, pr);

    setRepoPolicy(data, 'acme-corp/web-frontend', {
      mode: 'dry-run',
      agent: 'claude',
      triggers: ['ChangesRequested'],
      allowedPlaybooks: ['address-comments'],
    });

    const dispatchSpy = vi.spyOn(agentsModule, 'dispatchAgent').mockResolvedValue({
      sessionId: 'sess-2',
      prKey: pr.key,
      agentName: 'claude',
      command: 'mock',
      worktreePath: 'mock',
      branch: pr.branch,
      startedAt: Date.now(),
      status: 'dry-run',
    });

    await evaluateAutonomousPolicies(data, mockConfig);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'claude',
        playbookName: 'address-comments',
        trigger: 'autonomous_review',
        mode: 'dry-run',
      })
    );
  });

  it('does nothing when repo policy mode is off', async () => {
    const data = createEmptyState();
    const pr = createPrFixture(1, 'CiFailing');
    upsertPR(data, pr);

    setRepoPolicy(data, 'acme-corp/web-frontend', {
      mode: 'off',
      agent: 'agy',
    });

    const dispatchSpy = vi.spyOn(agentsModule, 'dispatchAgent');

    await evaluateAutonomousPolicies(data, mockConfig);

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('enforces concurrency limits and skips dispatch when max workers running', async () => {
    const data = createEmptyState();
    const pr = createPrFixture(3, 'CiFailing');
    upsertPR(data, pr);

    // Populate 2 running workers
    setWorker(data, { owner: 'acme-corp', repo: 'web-frontend', number: 10 }, {
      sessionId: 'w-1',
      prKey: { owner: 'acme-corp', repo: 'web-frontend', number: 10 },
      agentName: 'claude',
      command: 'mock',
      worktreePath: 'mock',
      branch: 'b1',
      startedAt: Date.now(),
      status: 'running',
    });
    setWorker(data, { owner: 'acme-corp', repo: 'web-frontend', number: 11 }, {
      sessionId: 'w-2',
      prKey: { owner: 'acme-corp', repo: 'web-frontend', number: 11 },
      agentName: 'claude',
      command: 'mock',
      worktreePath: 'mock',
      branch: 'b2',
      startedAt: Date.now(),
      status: 'running',
    });

    setRepoPolicy(data, 'acme-corp/web-frontend', {
      mode: 'live',
      agent: 'agy',
    });

    const dispatchSpy = vi.spyOn(agentsModule, 'dispatchAgent');
    await evaluateAutonomousPolicies(data, mockConfig);

    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});
