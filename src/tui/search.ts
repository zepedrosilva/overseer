// ── Search & Filter Engine ──────────────────────────────────────────────────
// Substring filtering across PR attributes (no emojis, clean CLI glyphs).

import type { PrState } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { colors, rgbColor } from './colors.js';
import { padEndVisual } from './layout.js';

export function filterPRs(prs: PrState[], query: string): PrState[] {
  const clean = query.trim().toLowerCase();
  if (!clean) return prs;

  return prs.filter((pr) => {
    const keyStr = prKeyToString(pr.key).toLowerCase();
    const title = pr.title.toLowerCase();
    const branch = pr.branch.toLowerCase();
    const author = pr.author.toLowerCase();
    const status = pr.overallStatus.toLowerCase();
    const prNum = `#${pr.key.number}`;

    return (
      title.includes(clean) ||
      keyStr.includes(clean) ||
      pr.key.repo.toLowerCase().includes(clean) ||
      pr.key.owner.toLowerCase().includes(clean) ||
      branch.includes(clean) ||
      author.includes(clean) ||
      status.includes(clean) ||
      prNum.includes(clean)
    );
  });
}

export function renderSearchBar(query: string, isSearching: boolean, width: number): string {
  if (isSearching) {
    const cursor = `\x1B[7m \x1B[0m`;
    const text = `  \x1B[${rgbColor(colors.cyan)}› Filter:\x1B[0m ${query}${cursor}  \x1B[${rgbColor(colors.fgDim)}(Enter to submit, Esc to clear)\x1B[0m`;
    return padEndVisual(text, width);
  }

  if (query) {
    const text = `  \x1B[${rgbColor(colors.cyan)}› Filter:\x1B[0m "${query}" \x1B[${rgbColor(colors.fgDim)}(press / to edit, Esc to clear)\x1B[0m`;
    return padEndVisual(text, width);
  }

  const text = `  \x1B[${rgbColor(colors.fgDim)}› Filter PRs (press / to search)\x1B[0m`;
  return padEndVisual(text, width);
}
