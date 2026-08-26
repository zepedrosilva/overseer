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
  cwd: string = process.cwd()
): string {
  const baseDir = path.isAbsolute(config.defaults.worktrees_dir)
    ? config.defaults.worktrees_dir
    : path.join(cwd, config.defaults.worktrees_dir);

  const folderName = `${pr.key.owner}-${pr.key.repo}-${pr.key.number}`;
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

  // Initialize and checkout PR branch using gh CLI
  try {
    // Clone minimal repo into worktree if not already a git repository
    const gitDir = path.join(worktreePath, '.git');
    if (!fs.existsSync(gitDir)) {
      await execFileAsync('gh', [
        'repo', 'clone',
        `${pr.key.owner}/${pr.key.repo}`,
        worktreePath,
        '--',
        '--depth', '1',
        '--branch', pr.branch,
      ]);
    }
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

  // If push is disabled (e.g. read-only review playbook or sandboxed run), intercept git push
  if (options?.allowPush === false) {
    try {
      await execFileAsync('git', ['remote', 'set-url', '--push', 'origin', 'OVERSEER_PUSH_DISABLED'], {
        cwd: worktreePath,
      });
    } catch {
      // Ignore if remote configuration fails in mock environments
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
  const worktreePath = resolveWorktreeDir(config, pr, cwd);
  cleanupWorktree(worktreePath);
  cleanupPRLogs(pr, cwd);
}
