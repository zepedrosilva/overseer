import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  interpolateAgentCommand,
  buildAgentCommand,
  resolveWorktreeDir,
  cleanupWorktree,
  cleanupPRLogs,
  cleanupPRArtifacts,
  dispatchAgent,
  cancelWorker,
} from '../src/agents/index.js';
import { createEmptyState, upsertPR } from '../src/app/state.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { PrState, AppConfig } from '../src/app/types.js';

describe('AI Agent Dispatcher & Worktrees', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-agent-test-'));
  });

  afterEach(async () => {
    // Wait briefly for background child processes to exit before cleanup
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  function createMockPR(): PrState {
    return {
      key: { owner: 'MewsSystems', repo: 'billing', number: 142 },
      title: 'Fix invoice calculation',
      branch: 'fix/invoice-rounding',
      baseBranch: 'main',
      author: 'josesilva',
      url: 'https://github.com/MewsSystems/billing/pull/142',
      isDraft: false,
      state: 'OPEN',
      reviewVerdict: 'CHANGES_REQUESTED',
      ciStatus: 'FAILURE',
      overallStatus: 'ChangesRequested',
      ciChecks: [],
      commentsCount: 2,
      unresolvedThreadsCount: 1,
      createdAt: '2026-08-17T10:00:00Z',
      updatedAt: '2026-08-17T11:00:00Z',
      log: [],
    };
  }

  describe('interpolateAgentCommand', () => {
    it('replaces all placeholders accurately', () => {
      const template = 'my-agent --pr {pr} --branch {branch} --repo {owner}/{repo} --dir {worktree} -p "{prompt}"';
      const result = interpolateAgentCommand(template, {
        pr: 142,
        branch: 'fix/rounding',
        owner: 'MewsSystems',
        repo: 'billing',
        url: 'https://github.com/MewsSystems/billing/pull/142',
        worktree: '/tmp/wt',
        prompt: 'Fix the bug',
      });

      expect(result).toBe(
        'my-agent --pr 142 --branch fix/rounding --repo MewsSystems/billing --dir /tmp/wt -p "Fix the bug"'
      );
    });

    it('injects default prompt when no prompt is provided', () => {
      const template = 'claude -p "{prompt}"';
      const result = interpolateAgentCommand(template, {
        pr: 142,
        branch: 'fix/rounding',
        owner: 'MewsSystems',
        repo: 'billing',
        url: 'https://github.com/MewsSystems/billing/pull/142',
      });

      expect(result).toContain('claude -p "Review this Pull Request');
    });
  });

  describe('buildAgentCommand', () => {
    it('builds built-in claude preset command', () => {
      const pr = createMockPR();
      const { command, definition } = buildAgentCommand('claude', pr, DEFAULT_CONFIG, '/tmp/wt');
      expect(command).toContain('claude -p');
      expect(definition.description).toContain('Claude');
    });

    it('builds custom agent command from config', () => {
      const pr = createMockPR();
      const config: AppConfig = {
        ...DEFAULT_CONFIG,
        agents: {
          'custom-reviewer': {
            command: 'custom-cli review --pr {pr}',
            description: 'Custom reviewer',
          },
        },
      };

      const { command } = buildAgentCommand('custom-reviewer', pr, config, '/tmp/wt');
      expect(command).toBe('custom-cli review --pr 142');
    });
  });

  describe('Worktree Path & Lifecycle', () => {
    it('resolves worktree path correctly inside worktrees directory', () => {
      const pr = createMockPR();
      const config: AppConfig = {
        ...DEFAULT_CONFIG,
        defaults: {
          ...DEFAULT_CONFIG.defaults,
          worktrees_dir: './.overseer/worktrees',
        },
      };

      const wtPath = resolveWorktreeDir(config, pr, tmpDir);
      expect(wtPath).toBe(path.join(tmpDir, '.overseer', 'worktrees', 'MewsSystems-billing-142'));
    });

    it('cleans up worktree directory without throwing', () => {
      const folder = path.join(tmpDir, 'test-wt');
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'test.txt'), 'hello');

      expect(fs.existsSync(folder)).toBe(true);
      cleanupWorktree(folder);
      expect(fs.existsSync(folder)).toBe(false);
    });

    it('cleans up PR log files and worktree artifacts together', () => {
      const pr = createMockPR();
      const config: AppConfig = {
        ...DEFAULT_CONFIG,
        defaults: {
          ...DEFAULT_CONFIG.defaults,
          worktrees_dir: './.overseer/worktrees',
        },
      };

      const wtPath = resolveWorktreeDir(config, pr, tmpDir);
      fs.mkdirSync(wtPath, { recursive: true });
      fs.writeFileSync(path.join(wtPath, 'test.txt'), 'code');

      const logDir = path.join(tmpDir, '.overseer', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, `${pr.key.owner}-${pr.key.repo}-${pr.key.number}.log`);
      fs.writeFileSync(logFile, 'agent stdout');

      expect(fs.existsSync(wtPath)).toBe(true);
      expect(fs.existsSync(logFile)).toBe(true);

      cleanupPRArtifacts(pr, config, tmpDir);

      expect(fs.existsSync(wtPath)).toBe(false);
      expect(fs.existsSync(logFile)).toBe(false);
    });
  });

  describe('dispatchAgent and cancelWorker', () => {
    it('dispatches agent and records active worker in state', async () => {
      const state = createEmptyState();
      const pr = createMockPR();
      upsertPR(state, pr);

      const config: AppConfig = {
        ...DEFAULT_CONFIG,
        agents: {
          echo: {
            command: 'node -e "process.stdout.write(\'done\\n\')"',
            description: 'Echo agent',
          },
        },
      };

      const worker = await dispatchAgent({
        data: state,
        pr,
        config,
        agentName: 'echo',
        cwd: tmpDir,
      });

      expect(worker).not.toBeNull();
      expect(worker.agentName).toBe('echo');
      expect(worker.prKey).toEqual(pr.key);
      expect(state.workers.size).toBe(1);

      // Wait for process to exit
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(worker.status).toBe('completed');
    }, 15000);

    it('cancels active worker process', async () => {
      const state = createEmptyState();
      const pr = createMockPR();
      upsertPR(state, pr);

      const config: AppConfig = {
        ...DEFAULT_CONFIG,
        agents: {
          sleeper: {
            command: 'node -e "setInterval(() => {}, 1000)"',
            description: 'Long running agent',
          },
        },
      };

      const worker = await dispatchAgent({
        data: state,
        pr,
        config,
        agentName: 'sleeper',
        cwd: tmpDir,
      });

      expect(worker.status).toBe('running');
      const cancelled = cancelWorker(state, pr.key);
      expect(cancelled).toBe(true);
      expect(worker.status).toBe('cancelled');
    }, 15000);
  });
});
