// ── Search & Filter Engine ──────────────────────────────────────────────────
// Substring filtering across PR attributes (no emojis, clean CLI glyphs).

import type { PrState, ViewScope } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { colors, rgbColor, getSpinnerChar } from './colors.js';
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

export interface RenderScopeTabBarOptions {
  scope: ViewScope;
  mineCount: number;
  teamCount: number;
  agentsCount?: number;
  hasRunningAgent?: boolean;
  agentsEnabled?: boolean;
  teamMembersCount?: number;
  teamName?: string;
  spinnerTick?: number;
  width: number;
}

export function renderScopeTabBar(options: RenderScopeTabBarOptions): string {
  const {
    scope,
    mineCount,
    teamCount,
    agentsCount = 0,
    hasRunningAgent,
    agentsEnabled = true,
    spinnerTick,
    width,
  } = options;

  const isMine = scope === 'mine';
  const mineDot = isMine ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
  const mineColor = isMine ? '\x1B[1;37m' : `\x1B[${rgbColor(colors.fgDim)}`;
  const mineBadge = `${mineDot} \x1B[${rgbColor(colors.cyan)}[1]\x1B[0m ${mineColor}Mine (${mineCount})\x1B[0m`;

  const isTeam = scope === 'team';
  const teamDot = isTeam ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
  const teamColor = isTeam ? '\x1B[1;37m' : `\x1B[${rgbColor(colors.fgDim)}`;
  const teamBadge = `${teamDot} \x1B[${rgbColor(colors.cyan)}[2]\x1B[0m ${teamColor}Team (${teamCount})\x1B[0m`;

  if (!agentsEnabled) {
    const leftText = `  \x1B[${rgbColor(colors.fgDim)}[Tab / t]\x1B[0m  ${mineBadge}    ${teamBadge}`;
    return padEndVisual(leftText, width);
  }

  const isAgents = scope === 'agents';
  let agentsDot: string;

  if (hasRunningAgent) {
    const spinner = getSpinnerChar(spinnerTick);
    const color = isAgents ? rgbColor(colors.green) : rgbColor(colors.fgDim);
    agentsDot = `\x1B[${color}${spinner}\x1B[0m`;
  } else {
    agentsDot = isAgents
      ? `\x1B[${rgbColor(colors.green)}●\x1B[0m`
      : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
  }

  const agentsColor = isAgents ? '\x1B[1;37m' : `\x1B[${rgbColor(colors.fgDim)}`;
  const agentsBadge = `${agentsDot} \x1B[${rgbColor(colors.cyan)}[3]\x1B[0m ${agentsColor}Agents (${agentsCount})\x1B[0m`;

  const leftText = `  \x1B[${rgbColor(colors.fgDim)}[Tab / t]\x1B[0m  ${mineBadge}    ${teamBadge}    ${agentsBadge}`;
  return padEndVisual(leftText, width);
}
