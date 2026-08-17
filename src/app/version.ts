// ── Version Engine (Commit-Count Versioning) ──────────────────────────────
// Automatically derives sequential version (v<count>) from git history with fallback.

import { execSync } from 'node:child_process';

let cachedVersion: string | null = null;

export function getAppVersion(cwd: string = process.cwd()): string {
  if (cachedVersion) return cachedVersion;

  try {
    const count = execSync('git rev-list --count HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (count && /^\d+$/.test(count)) {
      cachedVersion = `v${count}`;
      return cachedVersion;
    }
  } catch {
    // Fallback if git is not available or directory is not a git repository
  }

  cachedVersion = 'v1';
  return cachedVersion;
}

export function resetVersionCache(): void {
  cachedVersion = null;
}
