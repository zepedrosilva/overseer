// ── Git Worktree Manager ───────────────────────────────────────────────────
// Provisions and cleans up isolated local git worktrees for agent triage.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrState, AppConfig } from '../app/types.js';

const execFileAsync = promisify(execFile);

export function resolveWorktreeDir(
  config: AppConfig,
  pr: PrState,
  agentNameOrCwd?: string,
  playbookNameOrCwd?: string,
  cwd?: string
): string {
  let agentName: string | undefined;
  let playbookName: string | undefined;
  let effectiveCwd: string = process.cwd();

  if (cwd !== undefined) {
    agentName = agentNameOrCwd;
    playbookName = playbookNameOrCwd;
    effectiveCwd = cwd;
  } else if (playbookNameOrCwd !== undefined) {
    if (playbookNameOrCwd.includes('/') || playbookNameOrCwd.includes('\\') || path.isAbsolute(playbookNameOrCwd)) {
      agentName = agentNameOrCwd;
      effectiveCwd = playbookNameOrCwd;
    } else {
      agentName = agentNameOrCwd;
      playbookName = playbookNameOrCwd;
    }
  } else if (agentNameOrCwd !== undefined) {
    if (agentNameOrCwd.includes('/') || agentNameOrCwd.includes('\\') || path.isAbsolute(agentNameOrCwd)) {
      effectiveCwd = agentNameOrCwd;
    } else {
      agentName = agentNameOrCwd;
    }
  }

  const baseDir = path.isAbsolute(config.defaults.worktrees_dir)
    ? config.defaults.worktrees_dir
    : path.join(effectiveCwd, config.defaults.worktrees_dir);

  const agentSuffix = agentName ? `-${agentName.toLowerCase().replace(/[^a-z0-9_-]/g, '')}` : '';
  const playbookSuffix = playbookName ? `-${playbookName.toLowerCase().replace(/[^a-z0-9_-]/g, '')}` : '';
  const folderName = `${pr.key.owner}-${pr.key.repo}-${pr.key.number}${agentSuffix}${playbookSuffix}`;
  return path.join(baseDir, folderName);
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
      } catch {
        // Worktree initialized with available files
      }
    }
  }

  // If push is disabled (e.g. read-only review playbook or sandboxed run), intercept git push
  if (options?.allowPush === false) {
    try {
      await execFileAsync('git', ['remote', 'set-url', '--push', 'origin', 'OVERSEER_PUSH_DISABLED'], {
        cwd: worktreePath,
      });
    } catch {
      // Ignore if remote configuration fails in mock environments
    }
  } else {
    // Restore push URL if previously disabled
    try {
      await execFileAsync('git', ['remote', 'set-url', '--push', 'origin', `https://github.com/${pr.key.owner}/${pr.key.repo}.git`], {
        cwd: worktreePath,
      });
    } catch {
      // Ignore
    }
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
      cleanupWorktree(resolveWorktreeDir(config, pr, undefined, cwd));
    }
  }

  cleanupPRLogs(pr, cwd);
}
