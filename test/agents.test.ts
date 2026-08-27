import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  interpolateAgentCommand,
  buildAgentCommand,
  parseShellArgs,
  getSpawnExecution,
  resolveWorktreeDir,
  derivePushUrl,
  cleanupWorktree,
  cleanupPRLogs,
  cleanupPRArtifacts,
  buildSanitizedEnvironment,
  dispatchAgent,
  cancelWorker,
} from '../src/agents/index.js';
import { BUILTIN_PLAYBOOKS } from '../src/agents/playbooks.js';
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
      key: { owner: 'acme-corp', repo: 'web-frontend', number: 142 },
      title: 'Fix invoice calculation',
      branch: 'fix/invoice-rounding',
      baseBranch: 'main',
      author: 'alice',
      url: 'https://github.com/acme-corp/web-frontend/pull/142',
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

  describe('interpolateAgentCommand & Context Injection', () => {
    it('replaces all placeholders accurately', () => {
      const template = 'my-agent --pr {pr} --branch {branch} --base {baseBranch} --repo {owner}/{repo} --dir {worktree} -p "{prompt}"';
      const result = interpolateAgentCommand(template, {
        pr: 142,
        branch: 'fix/rounding',
        baseBranch: 'main',
        owner: 'acme-corp',
        repo: 'web-frontend',
        url: 'https://github.com/acme-corp/web-frontend/pull/142',
        worktree: '/tmp/wt',
        prompt: 'Fix the bug',
      });

      expect(result).toBe(
        'my-agent --pr 142 --branch fix/rounding --base main --repo acme-corp/web-frontend --dir /tmp/wt -p "Fix the bug"'
      );
    });

    it('injects default prompt when no prompt is provided', () => {
      const template = 'claude -p "{prompt}"';
      const result = interpolateAgentCommand(template, {
        pr: 142,
        branch: 'fix/rounding',
        owner: 'acme-corp',
        repo: 'web-frontend',
        url: 'https://github.com/acme-corp/web-frontend/pull/142',
      });

      expect(result).toContain('claude -p "Review this Pull Request');
    });

    it('injects failing check and ci logs context correctly', () => {
      const template = BUILTIN_PLAYBOOKS['ci-repair'].promptTemplate;
      const result = interpolateAgentCommand(template, {
        pr: 142,
        branch: 'fix/rounding',
        owner: 'acme-corp',
        repo: 'web-frontend',
        url: 'https://github.com/acme-corp/web-frontend/pull/142',
        failingCheck: 'jest-unit-tests',
        ciLogs: 'FAIL test/invoice.test.ts\nAssertionError: expected 10 to be 12',
      });

      expect(result).toContain("The CI check 'jest-unit-tests' failed on this PR.");
      expect(result).toContain('FAIL test/invoice.test.ts');
      expect(result).toContain('PR #142 (acme-corp/web-frontend, branch: \'fix/rounding\')');
    });

    it('injects review comments context into address-comments template', () => {
      const template = BUILTIN_PLAYBOOKS['address-comments'].promptTemplate;
      const commentsText = 'Comment 1: Please handle negative tax rate.\nComment 2: Add test case for zero balance.';
      const result = interpolateAgentCommand(template, {
        pr: 142,
        branch: 'fix/rounding',
        owner: 'acme-corp',
        repo: 'web-frontend',
        url: 'https://github.com/acme-corp/web-frontend/pull/142',
        comments: commentsText,
      });

      expect(result).toContain('Address the following unresolved review comments on this PR:');
      expect(result).toContain(commentsText);
    });

    it('injects diff summary into preflight-review template', () => {
      const template = BUILTIN_PLAYBOOKS['preflight-review'].promptTemplate;
      const diffSummaryText = 'Changed files: 3 (+45, -12)\n- src/billing/tax.ts\n- test/tax.test.ts';
      const result = interpolateAgentCommand(template, {
        pr: 142,
        branch: 'feat/new-tax',
        baseBranch: 'main',
        owner: 'acme-corp',
        repo: 'web-frontend',
        url: 'https://github.com/acme-corp/web-frontend/pull/142',
        diffSummary: diffSummaryText,
      });

      expect(result).toContain('Diff Summary:\n' + diffSummaryText);
      expect(result).toContain("branch: 'feat/new-tax' -> base: 'main'");
    });

    it('applies fallbacks when optional context parameters are omitted', () => {
      const template = 'Logs: {ciLogs} | Comments: {comments} | Diff: {diffSummary} | Check: {failingCheck} | PB: {playbook}';
      const result = interpolateAgentCommand(template, {
        pr: 142,
        branch: 'fix/rounding',
        owner: 'acme-corp',
        repo: 'web-frontend',
        url: 'https://github.com/acme-corp/web-frontend/pull/142',
      });

      expect(result).toBe(
        'Logs: No CI logs provided. | Comments: No unresolved comments. | Diff: No diff summary provided. | Check: test | PB: custom'
      );
    });

    it('truncates oversized context snippets exceeding MAX_CONTEXT_LENGTH (64 KB)', () => {
      const massiveLog = 'A'.repeat(70 * 1024);
      const template = 'CI output: {ciLogs}';
      const result = interpolateAgentCommand(template, {
        pr: 142,
        branch: 'fix/rounding',
        owner: 'acme-corp',
        repo: 'web-frontend',
        url: 'https://github.com/acme-corp/web-frontend/pull/142',
        ciLogs: massiveLog,
      });

      expect(result).toContain('... (truncated context)');
      expect(result.length).toBeLessThan(massiveLog.length);
    });
  });

  describe('Prompt Escaping & Special Character Handling', () => {
    it('safely handles double quotes, single quotes, and newlines in prompt', () => {
      const pr = createMockPR();
      const rawPrompt = 'Fix issue with "quotes", \'single quotes\',\nand `backticks` $PATH \\escapes';
      const { promptText } = buildAgentCommand('claude', pr, DEFAULT_CONFIG, '/tmp/wt', rawPrompt);

      expect(promptText).toBe(rawPrompt);
    });

    it('prevents cascading interpolation and preserves dollar signs when injected values contain placeholders or regex tokens', () => {
      const template = 'claude -p "{prompt}" --dir {worktree}';
      const promptValue = 'Check if code has {worktree} variable and $1 $$ $& $` $\' pattern';
      const result = interpolateAgentCommand(template, {
        pr: 142,
        branch: 'fix/rounding',
        owner: 'acme-corp',
        repo: 'web-frontend',
        url: 'https://github.com/acme-corp/web-frontend/pull/142',
        worktree: '/tmp/worktree',
        prompt: promptValue,
      });

      // {worktree} in prompt is NOT expanded to /tmp/worktree (no cascading expansion),
      // while outer template's {worktree} is properly replaced. Dollar signs are untouched.
      expect(result).toBe(
        'claude -p "Check if code has {worktree} variable and $1 $$ $& $` $\' pattern" --dir /tmp/worktree'
      );
    });

    it('preserves quotes and arguments in getSpawnExecution for built-in presets', () => {
      const promptWithQuotes = 'Review "login.ts" and check if it handles `null` tokens & $FOO';

      const claudeExec = getSpawnExecution('claude', '', promptWithQuotes, {});
      expect(claudeExec.bin).toBe('claude');
      expect(claudeExec.args).toEqual(['--dangerously-skip-permissions', '-p', promptWithQuotes]);

      const agyExec = getSpawnExecution('agy', '', promptWithQuotes, {});
      expect(agyExec.bin).toBe('agy');
      expect(agyExec.args).toContain(promptWithQuotes);

      const piExec = getSpawnExecution('pi', '', promptWithQuotes, {});
      expect(piExec.bin).toBe('pi');
      expect(piExec.args).toEqual([promptWithQuotes]);
    });

    it('correctly tokenizes complex commands with parseShellArgs', () => {
      const cmd = 'agent-cli run --prompt "Fix invoice calculation #123" --flag \'single value\' --extra normal_val';
      const parsed = parseShellArgs(cmd);

      expect(parsed.bin).toBe('agent-cli');
      expect(parsed.args).toEqual([
        'run',
        '--prompt',
        'Fix invoice calculation #123',
        '--flag',
        'single value',
        '--extra',
        'normal_val',
      ]);
    });

    it('interpolates definition.args without shell corruption for custom agents', () => {
      const definition = {
        bin: 'custom-ai',
        args: ['--input', '{prompt}', '--verbose'],
      };
      const customPrompt = 'Analyze edge cases with "special" symbols & pipes | redirects > /dev/null';
      const result = getSpawnExecution('custom', '', customPrompt, definition);

      expect(result.bin).toBe('custom-ai');
      expect(result.args).toEqual(['--input', customPrompt, '--verbose']);
    });
  });

  describe('buildAgentCommand', () => {
    it('builds built-in claude preset command', () => {
      const pr = createMockPR();
      const { command, definition } = buildAgentCommand('claude', pr, DEFAULT_CONFIG, '/tmp/wt');
      expect(command).toContain('claude --dangerously-skip-permissions -p');
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

  describe('Environment Sanitization & Security Sandbox', () => {
    it('strips cloud credentials and tokens while retaining runtime allowlisted vars', () => {
      const mockHostEnv: NodeJS.ProcessEnv = {
        PATH: '/usr/local/bin:/usr/bin',
        HOME: '/Users/alice',
        USER: 'alice',
        GITHUB_TOKEN: 'ghp_secret_token_12345',
        GH_TOKEN: 'ghp_secret_token_67890',
        AWS_SECRET_ACCESS_KEY: 'aws_secret_key',
        SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        UNKNOWN_SECRET_KEY: 'sensitive_payload',
      };

      const sanitized = buildSanitizedEnvironment(mockHostEnv);

      expect(sanitized.PATH).toBe('/usr/local/bin:/usr/bin');
      expect(sanitized.HOME).toBe('/Users/alice');
      expect(sanitized.USER).toBe('alice');
      expect(sanitized.ANTHROPIC_API_KEY).toBe('sk-ant-test');
      expect(sanitized.CI).toBe('1');
      expect(sanitized.TERM).toBe('dumb');

      // Credentials and secrets MUST be stripped
      expect(sanitized.GITHUB_TOKEN).toBeUndefined();
      expect(sanitized.GH_TOKEN).toBeUndefined();
      expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(sanitized.SSH_AUTH_SOCK).toBeUndefined();
      expect(sanitized.UNKNOWN_SECRET_KEY).toBeUndefined();
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

      const wtPath = resolveWorktreeDir(config, pr, { cwd: tmpDir });
      expect(wtPath).toBe(path.join(tmpDir, '.overseer', 'worktrees', 'acme-corp-web-frontend-142'));
    });

    it('isolates worktree paths per agent and playbook (e.g. claude-preflight-review vs agy-address-comments)', () => {
      const pr = createMockPR();
      const config: AppConfig = {
        ...DEFAULT_CONFIG,
        defaults: {
          ...DEFAULT_CONFIG.defaults,
          worktrees_dir: './.overseer/worktrees',
        },
      };

      const claudePath = resolveWorktreeDir(config, pr, { agentName: 'claude', playbookName: 'preflight-review', cwd: tmpDir });
      const agyFixPath = resolveWorktreeDir(config, pr, { agentName: 'agy', playbookName: 'address-comments', cwd: tmpDir });
      const agyCiPath = resolveWorktreeDir(config, pr, { agentName: 'agy', playbookName: 'ci-repair', cwd: tmpDir });

      expect(claudePath).toBe(
        path.join(tmpDir, '.overseer', 'worktrees', 'acme-corp-web-frontend-142-claude-preflight-review')
      );
      expect(agyFixPath).toBe(
        path.join(tmpDir, '.overseer', 'worktrees', 'acme-corp-web-frontend-142-agy-address-comments')
      );
      expect(agyCiPath).toBe(
        path.join(tmpDir, '.overseer', 'worktrees', 'acme-corp-web-frontend-142-agy-ci-repair')
      );
      expect(claudePath).not.toBe(agyFixPath);
      expect(agyFixPath).not.toBe(agyCiPath);
    });

    it('does not confuse slashes in agent or playbook names with cwd', () => {
      const pr = createMockPR();
      const config: AppConfig = {
        ...DEFAULT_CONFIG,
        defaults: {
          ...DEFAULT_CONFIG.defaults,
          worktrees_dir: './.overseer/worktrees',
        },
      };

      const customPath = resolveWorktreeDir(config, pr, {
        agentName: 'custom/agent',
        playbookName: 'fix/review-comments',
        cwd: tmpDir,
      });

      // Slashes should be stripped/sanitized from folder name and not change effective cwd
      expect(customPath).toBe(
        path.join(tmpDir, '.overseer', 'worktrees', 'acme-corp-web-frontend-142-customagent-fixreview-comments')
      );
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

      const wtPath = resolveWorktreeDir(config, pr, { cwd: tmpDir });
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

  describe('derivePushUrl & GitHub Enterprise support', () => {
    it('preserves GitHub Enterprise HTTPS origin host and protocol', () => {
      const enterpriseUrl = derivePushUrl('https://github.corp.internal/old-owner/old-repo.git', 'acme', 'repo-1');
      expect(enterpriseUrl).toBe('https://github.corp.internal/acme/repo-1.git');
    });

    it('preserves GitHub Enterprise HTTPS origin host with custom port', () => {
      const portUrl = derivePushUrl('https://ghe.local:8443/team/project.git', 'acme', 'repo-1');
      expect(portUrl).toBe('https://ghe.local:8443/acme/repo-1.git');
    });

    it('preserves GitHub Enterprise SCP-style SSH origin host', () => {
      const sshUrl = derivePushUrl('git@github.enterprise.com:org/some-repo.git', 'acme', 'repo-1');
      expect(sshUrl).toBe('git@github.enterprise.com:acme/repo-1.git');
    });

    it('preserves GitHub Enterprise ssh:// origin with custom port', () => {
      const sshPortUrl = derivePushUrl('ssh://git@ghe.internal.net:2222/org/some-repo.git', 'acme', 'repo-1');
      expect(sshPortUrl).toBe('ssh://git@ghe.internal.net:2222/acme/repo-1.git');
    });

    it('handles standard github.com HTTPS and SSH URLs accurately', () => {
      expect(derivePushUrl('https://github.com/someone/somerepo.git', 'acme', 'web')).toBe('https://github.com/acme/web.git');
      expect(derivePushUrl('git@github.com:someone/somerepo.git', 'acme', 'web')).toBe('git@github.com:acme/web.git');
    });

    it('falls back to https://github.com/owner/repo.git on invalid or empty parent url', () => {
      expect(derivePushUrl(undefined, 'acme', 'web')).toBe('https://github.com/acme/web.git');
      expect(derivePushUrl('', 'acme', 'web')).toBe('https://github.com/acme/web.git');
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

    it('provisions worktree with allowPush: false option without errors', async () => {
      const { provisionWorktree } = await import('../src/agents/worktree.js');
      const pr = createMockPR();
      const wtPath = path.join(tmpDir, 'test-wt');
      const res = await provisionWorktree(pr, wtPath, { allowPush: false });
      expect(res).toBe(wtPath);
      expect(fs.existsSync(wtPath)).toBe(true);
    });

    it('writes clean, boxless structured log headers and completion markers without legacy ASCII boxes', async () => {
      const state = createEmptyState();
      const pr = createMockPR();
      upsertPR(state, pr);

      const config: AppConfig = {
        ...DEFAULT_CONFIG,
        agents: {
          logger: {
            command: 'node -e "console.log(\'Processing task...\')"',
            description: 'Logger agent',
          },
        },
      };

      const worker = await dispatchAgent({
        data: state,
        pr,
        config,
        agentName: 'logger',
        cwd: tmpDir,
      });

      // Wait for process to exit and flush logs
      await new Promise((resolve) => setTimeout(resolve, 200));

      const logFile = path.join(tmpDir, '.overseer', 'logs', `${pr.key.owner}-${pr.key.repo}-${pr.key.number}.log`);
      expect(fs.existsSync(logFile)).toBe(true);
      const logContent = fs.readFileSync(logFile, 'utf8');

      // Verify clean lifecycle headers
      expect(logContent).toContain('=== [');
      expect(logContent).toContain('DISPATCH: logger');
      expect(logContent).toContain('COMPLETED in');
      expect(logContent).toContain('Exit Code: 0');
      expect(logContent).toContain('Processing task...');

      // Verify NO legacy ASCII box borders exist
      expect(logContent).not.toContain('┌─');
      expect(logContent).not.toContain('├─ Live Output Stream');
      expect(logContent).not.toContain('└─ [Completed');
    });

    it('formats clean, boxless dry-run simulation log output', async () => {
      const state = createEmptyState();
      const pr = createMockPR();
      upsertPR(state, pr);

      const config: AppConfig = {
        ...DEFAULT_CONFIG,
        agents: {
          sim: {
            command: 'sim-command',
            description: 'Sim agent',
          },
        },
      };

      await dispatchAgent({
        data: state,
        pr,
        config,
        agentName: 'sim',
        mode: 'dry-run',
        cwd: tmpDir,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const logFile = path.join(tmpDir, '.overseer', 'logs', `${pr.key.owner}-${pr.key.repo}-${pr.key.number}.log`);
      expect(fs.existsSync(logFile)).toBe(true);
      const logContent = fs.readFileSync(logFile, 'utf8');

      expect(logContent).toContain('DRY-RUN SIMULATION: sim');
      expect(logContent).toContain('END SIMULATION');
      expect(logContent).not.toContain('┌─');
    });

    it('stages only tracked files with git add -u and verifies branch during auto-commit', async () => {
      const state = createEmptyState();
      const pr = createMockPR();
      upsertPR(state, pr);

      const config: AppConfig = {
        ...DEFAULT_CONFIG,
        agents: {
          fixer: {
            command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(\'tracked.txt\', \'modified\'); fs.writeFileSync(\'untracked-junk.log\', \'junk\');"',
            description: 'Fixer agent',
          },
        },
      };

      const wtPath = resolveWorktreeDir(config, pr, { agentName: 'fixer', playbookName: 'address-comments', cwd: tmpDir });
      fs.mkdirSync(wtPath, { recursive: true });

      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['init', '-b', pr.branch], { cwd: wtPath });
      execFileSync('git', ['config', 'user.name', 'Overseer Bot'], { cwd: wtPath });
      execFileSync('git', ['config', 'user.email', 'bot@overseer.local'], { cwd: wtPath });
      fs.writeFileSync(path.join(wtPath, 'tracked.txt'), 'initial');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: wtPath });
      execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: wtPath });

      const worker = await dispatchAgent({
        data: state,
        pr,
        config,
        agentName: 'fixer',
        playbookName: 'address-comments',
        cwd: tmpDir,
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(worker.status).toBe('completed');

      // Verify tracked.txt was committed
      const logOut = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: wtPath }).toString();
      expect(logOut.trim()).toBe('fix: address address-comments feedback');

      // Verify untracked-junk.log was NOT staged or committed
      const statusOut = execFileSync('git', ['status', '--porcelain'], { cwd: wtPath }).toString();
      expect(statusOut).toContain('?? untracked-junk.log');
    });
  });
});
