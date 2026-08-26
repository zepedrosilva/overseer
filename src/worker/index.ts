// ── Worktree & Worker Manager ────────────────────────────────────────────────
// Manages local git worktrees and agent process executions in ./.overseer/worktrees.

import fs from 'node:fs';
import path from 'node:path';
import type { PrState, AppConfig } from '../app/types.js';

export function resolveWorktreePath(
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

export function cleanupWorktree(worktreePath: string): void {
  if (fs.existsSync(worktreePath)) {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error if already removed
    }
  }
}
