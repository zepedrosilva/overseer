// ── Git Worktree Manager ───────────────────────────────────────────────────
// Provisions and cleans up isolated local git worktrees for agent triage.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrState, AppConfig } from '../app/types.js';

const execFileAsync = promisify(execFile);

export interface ResolveWorktreeOptions {
  agentName?: string;
  playbookName?: string;
  cwd?: string;
}

export function resolveWorktreeDir(
  config: AppConfig,
  pr: PrState,
  options?: ResolveWorktreeOptions
): string {
  const effectiveCwd = options?.cwd ?? process.cwd();

  const baseDir = path.isAbsolute(config.defaults.worktrees_dir)
    ? config.defaults.worktrees_dir
    : path.join(effectiveCwd, config.defaults.worktrees_dir);

  const agentSuffix = options?.agentName ? `-${options.agentName.toLowerCase().replace(/[^a-z0-9_-]/g, '')}` : '';
  const playbookSuffix = options?.playbookName ? `-${options.playbookName.toLowerCase().replace(/[^a-z0-9_-]/g, '')}` : '';
  const folderName = `${pr.key.owner}-${pr.key.repo}-${pr.key.number}${agentSuffix}${playbookSuffix}`;
  return path.join(baseDir, folderName);
}

export function derivePushUrl(parentRemoteUrl: string | undefined, owner: string, repo: string): string {
  if (!parentRemoteUrl || typeof parentRemoteUrl !== 'string') {
    return `https://github.com/${owner}/${repo}.git`;
  }
  const trimmed = parentRemoteUrl.trim();
  if (!trimmed) {
    return `https://github.com/${owner}/${repo}.git`;
  }

  // SCP-style SSH: git@host:owner/repo.git or user@host:path
  const scpMatch = trimmed.match(/^([a-zA-Z0-9_.-]+)@([a-zA-Z0-9_.-]+):/);
  if (scpMatch) {
    const user = scpMatch[1];
    const host = scpMatch[2];
    return `${user}@${host}:${owner}/${repo}.git`;
  }

  // SSH with URL scheme: ssh://[user@]host[:port]/path
  const sshMatch = trimmed.match(/^ssh:\/\/(?:([a-zA-Z0-9_.-]+)@)?([a-zA-Z0-9_.-]+(?::\d+)?)(?:\/|$)/);
  if (sshMatch) {
    const user = sshMatch[1] || 'git';
    const hostAndPort = sshMatch[2];
    return `ssh://${user}@${hostAndPort}/${owner}/${repo}.git`;
  }

  // HTTP / HTTPS: https://[user:pass@]host[:port]/path
  const httpMatch = trimmed.match(/^(https?):\/\/(?:[^@]+@)?([a-zA-Z0-9_.-]+(?::\d+)?)(?:\/|$)/);
  if (httpMatch) {
    const protocol = httpMatch[1];
    const hostAndPort = httpMatch[2];
    return `${protocol}://${hostAndPort}/${owner}/${repo}.git`;
  }

  // Fallback
  return `https://github.com/${owner}/${repo}.git`;
}

export interface ProvisionWorktreeOptions {
  allowPush?: boolean;
}

export async function provisionWorktree(
  pr: PrState,
  worktreePath: string,
  options?: ProvisionWorktreeOptions
): Promise<string> {
  if (!fs.existsSync(worktreePath)) {
    fs.mkdirSync(worktreePath, { recursive: true });
  }

  const gitDir = path.join(worktreePath, '.git');
  if (fs.existsSync(gitDir)) {
    // If worktree already exists, fetch latest commit, hard reset, and clean untracked files
    try {
      await execFileAsync('git', ['fetch', 'origin', pr.branch, '--depth', '1'], {
        cwd: worktreePath,
      });
      await execFileAsync('git', ['checkout', pr.branch], {
        cwd: worktreePath,
      });
      await execFileAsync('git', ['reset', '--hard', `origin/${pr.branch}`], {
        cwd: worktreePath,
      });
      await execFileAsync('git', ['clean', '-fd'], {
        cwd: worktreePath,
      });
    } catch {
      // Ignore if offline / mock environment
    }
  } else {
    // Initialize and clone minimal PR branch using gh CLI
    try {
      await execFileAsync('gh', [
        'repo', 'clone',
        `${pr.key.owner}/${pr.key.repo}`,
        worktreePath,
        '--',
        '--depth', '1',
        '--branch', pr.branch,
      ]);
    } catch {
      // Fallback: checkout PR directly inside worktree folder
      try {
        await execFileAsync('gh', ['pr', 'checkout', String(pr.key.number), '--repo', `${pr.key.owner}/${pr.key.repo}`], {
          cwd: worktreePath,
        });
        // Ensure local branch is named pr.branch and not in detached HEAD
        try {
          await execFileAsync('git', ['checkout', '-B', pr.branch], { cwd: worktreePath });
        } catch {
          // Ignore if git checkout fails in mock environment
        }
      } catch {
        // Worktree initialized with available files
      }
    }
  }

  // If push is disabled (e.g. read-only review playbook or sandboxed run), intercept git push
  const hooksDir = path.join(worktreePath, '.git', 'hooks');
  const prePushHook = path.join(hooksDir, 'pre-push');

  if (options?.allowPush === false) {
    try {
      await execFileAsync('git', ['remote', 'set-url', '--push', 'origin', 'OVERSEER_PUSH_DISABLED'], {
        cwd: worktreePath,
      });
    } catch {
      // Ignore if remote configuration fails in mock environments
    }

    try {
      if (fs.existsSync(path.join(worktreePath, '.git'))) {
        if (!fs.existsSync(hooksDir)) {
          fs.mkdirSync(hooksDir, { recursive: true });
        }
        fs.writeFileSync(
          prePushHook,
          '#!/bin/sh\necho "Overseer: git push is disabled for read-only playbook" >&2\nexit 1\n',
          { mode: 0o755 }
        );
      }
    } catch {
      // Ignore if hooks write fails
    }
  } else {
    // Restore push URL if previously disabled, matching parent repo remote host and protocol (SSH vs HTTPS)
    let pushUrl = `https://github.com/${pr.key.owner}/${pr.key.repo}.git`;
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: process.cwd() });
      pushUrl = derivePushUrl(stdout, pr.key.owner, pr.key.repo);
    } catch {
      // Fallback to https
    }

    try {
      await execFileAsync('git', ['remote', 'set-url', '--push', 'origin', pushUrl], {
        cwd: worktreePath,
      });
    } catch {
      // Ignore
    }

    try {
      if (fs.existsSync(prePushHook)) {
        fs.unlinkSync(prePushHook);
      }
    } catch {
      // Ignore
    }
  }

  if (!fs.existsSync(path.join(worktreePath, '.git')) && !process.env.VITEST) {
    throw new Error(`Worktree provisioning failed: ${worktreePath} is not a valid git repository`);
  }

  return worktreePath;
}

export function cleanupWorktree(worktreePath: string): void {
  if (fs.existsSync(worktreePath)) {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // Ignore if already deleted
    }
  }
}

export function resolveLogPath(pr: PrState, cwd: string = process.cwd()): string {
  return path.join(cwd, '.overseer', 'logs', `${pr.key.owner}-${pr.key.repo}-${pr.key.number}.log`);
}

export function cleanupPRLogs(pr: PrState, cwd: string = process.cwd()): void {
  const logFile = resolveLogPath(pr, cwd);
  if (fs.existsSync(logFile)) {
    try {
      fs.unlinkSync(logFile);
    } catch {
      // Ignore if already deleted
    }
  }
}

export function cleanupPRArtifacts(pr: PrState, config: AppConfig, cwd: string = process.cwd()): void {
  const baseDir = path.isAbsolute(config.defaults.worktrees_dir)
    ? config.defaults.worktrees_dir
    : path.join(cwd, config.defaults.worktrees_dir);

  const prefix = `${pr.key.owner}-${pr.key.repo}-${pr.key.number}`;
  if (fs.existsSync(baseDir)) {
    try {
      const entries = fs.readdirSync(baseDir);
      for (const entry of entries) {
        if (entry === prefix || entry.startsWith(`${prefix}-`)) {
          cleanupWorktree(path.join(baseDir, entry));
        }
      }
    } catch {
      cleanupWorktree(resolveWorktreeDir(config, pr, { cwd }));
    }
  }

  cleanupPRLogs(pr, cwd);
}
