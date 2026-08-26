// ── Agent & Automation Modal Renderer ───────────────────────────────────────
// High-contrast interactive modal for configuring per-repo automation policies,
// specialized agent roles (Reviewer, Fixer, CI Repair), and 1-key playbook dispatching.

import type { AppState, PrState } from '../app/types.js';
import { getRepoMode, getRepoRoleAgent } from '../app/state.js';
import { colors, rgbColor } from './colors.js';
import { padEndVisual } from './layout.js';

export interface AgentModalState {
  selectedIndex: number; // 0..4 for playbooks
}

export interface PlaybookOption {
  key: string;
  name: string;
  hotkey: string;
  description: string;
}

export const PLAYBOOK_OPTIONS: PlaybookOption[] = [
  {
    key: 'preflight-review',
    name: 'Pre-flight Code Review',
    hotkey: 'r',
    description: 'Audits security, style, correctness, and posts findings to PR',
  },
  {
    key: 'ci-repair',
    name: 'CI Failure Auto-Repair',
    hotkey: 'c',
    description: 'Extracts failing check logs and repairs code in worktree',
  },
  {
    key: 'address-comments',
    name: 'Address Review Comments',
    hotkey: 'f',
    description: 'Reads unresolved review threads, fixes code, and pushes',
  },
  {
    key: 'rebase-resolver',
    name: 'Rebase & Conflict Resolver',
    hotkey: 'b',
    description: 'Rebases branch onto base and resolves merge conflicts',
  },
  {
    key: 'custom...',
    name: 'Custom Prompt...',
    hotkey: 'x',
    description: 'Dispatch agent with user-specified instructions',
  },
];

export function renderAgentModal(
  data: AppState,
  selectedPR: PrState | null,
  modalState: AgentModalState,
  width: number,
  height: number
): string[] {
  const modalWidth = Math.min(84, Math.max(60, width - 4));
  const innerWidth = modalWidth - 4;
  const lines: string[] = [];

  const repoKey = selectedPR ? `${selectedPR.key.owner}/${selectedPR.key.repo}` : 'Repository';
  const prNumStr = selectedPR ? `#${selectedPR.key.number}` : '';
  const currentMode = selectedPR ? getRepoMode(data, selectedPR.key) : 'off';
  const reviewerAgent = selectedPR ? getRepoRoleAgent(data, selectedPR.key, 'reviewer') : 'claude';
  const fixerAgent = selectedPR ? getRepoRoleAgent(data, selectedPR.key, 'fixer') : 'agy';
  const ciAgent = selectedPR ? getRepoRoleAgent(data, selectedPR.key, 'ciRepair') : 'agy';

  const modeBadge =
    currentMode === 'live'
      ? `\x1B[${rgbColor(colors.green)}🟢 LIVE\x1B[0m`
      : currentMode === 'dry-run'
      ? `\x1B[${rgbColor(colors.yellow)}🟡 DRY-RUN\x1B[0m`
      : `\x1B[${rgbColor(colors.fgDim)}⚪ OFF\x1B[0m`;

  // Top Border
  const titleText = ` 🤖 Agent & Automation Config: ${repoKey}${prNumStr ? ' ' + prNumStr : ''} `;
  const topBorder = `┌─\x1B[1;37m${titleText}\x1B[0m${'─'.repeat(Math.max(0, modalWidth - titleText.length - 18))}[Esc to close]─┐`;
  lines.push(topBorder);

  // Blank line
  lines.push(`│${' '.repeat(modalWidth - 2)}│`);

  // Section 1: Policy & Multi-Agent Roles
  lines.push(`│  \x1B[1;36m⚙️  REPOSITORY AUTOMATION POLICY\x1B[0m${' '.repeat(Math.max(0, innerWidth - 31))}│`);

  const modeLine = `    • Policy Mode:       ${modeBadge}  \x1B[${rgbColor(colors.fgDim)}(off, dry-run, live)\x1B[0m`;
  const modeKeyHint = `\x1B[${rgbColor(colors.cyan)}[m]\x1B[0m cycle mode`;
  lines.push(`│${padEndVisual(modeLine, innerWidth - 15)}${modeKeyHint}  │`);

  const revLine = `    • Reviewer Agent:    \x1B[1;37m🤖 ${reviewerAgent}\x1B[0m`;
  const revHint = `\x1B[${rgbColor(colors.cyan)}[1]\x1B[0m cycle reviewer`;
  lines.push(`│${padEndVisual(revLine, innerWidth - 19)}${revHint}  │`);

  const fixLine = `    • Fixer Agent:       \x1B[1;37m🤖 ${fixerAgent}\x1B[0m`;
  const fixHint = `\x1B[${rgbColor(colors.cyan)}[2]\x1B[0m cycle fixer`;
  lines.push(`│${padEndVisual(fixLine, innerWidth - 16)}${fixHint}  │`);

  const ciLine = `    • CI Repair Agent:   \x1B[1;37m🤖 ${ciAgent}\x1B[0m`;
  const ciHint = `\x1B[${rgbColor(colors.cyan)}[3]\x1B[0m cycle CI agent`;
  lines.push(`│${padEndVisual(ciLine, innerWidth - 19)}${ciHint}  │`);

  // Section Divider
  lines.push(`│  \x1B[${rgbColor(colors.fgDim)}${'─'.repeat(innerWidth)}\x1B[0m  │`);

  // Section 2: Playbook Presets
  lines.push(`│  \x1B[1;36m⚡ ON-DEMAND PLAYBOOK DISPATCH\x1B[0m${' '.repeat(Math.max(0, innerWidth - 29))}│`);
  lines.push(`│  \x1B[${rgbColor(colors.fgDim)}Select a playbook to run immediately on this PR:\x1B[0m${' '.repeat(Math.max(0, innerWidth - 49))}│`);
  lines.push(`│${' '.repeat(modalWidth - 2)}│`);

  PLAYBOOK_OPTIONS.forEach((opt, idx) => {
    const isSelected = idx === modalState.selectedIndex;
    const dot = isSelected ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
    const hotkey = `\x1B[${rgbColor(colors.cyan)}[${opt.hotkey}]\x1B[0m`;
    const nameColor = isSelected ? '\x1B[1;37m' : `\x1B[${rgbColor(colors.fgDim)}`;
    const line = `    ${dot} ${hotkey} ${nameColor}${opt.name}\x1B[0m  \x1B[${rgbColor(colors.fgDim)}(${opt.description})\x1B[0m`;
    lines.push(`│${padEndVisual(line, innerWidth + 2)}│`);
  });

  lines.push(`│${' '.repeat(modalWidth - 2)}│`);
  lines.push(`│  \x1B[${rgbColor(colors.fgDim)}${'─'.repeat(innerWidth)}\x1B[0m  │`);

  // Footer Navigation
  const navText = `  \x1B[${rgbColor(colors.cyan)}[Enter/r/c/f/b/x]\x1B[0m Dispatch  \x1B[${rgbColor(colors.cyan)}[m/1/2/3]\x1B[0m Roles  \x1B[${rgbColor(colors.fgDim)}[Esc] Close\x1B[0m`;
  lines.push(`│${padEndVisual(navText, innerWidth + 2)}│`);

  // Bottom Border
  lines.push(`└${'─'.repeat(modalWidth - 2)}┘`);

  return lines;
}
