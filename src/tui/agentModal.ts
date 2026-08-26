// ── Agent & Automation Modal Renderer ───────────────────────────────────────
// High-contrast interactive modal for configuring per-repo automation policies,
// specialized agent roles (Reviewer, Fixer, CI Repair), and 1-key playbook dispatching.

import type { AppState, PrState } from '../app/types.js';
import { getRepoMode, getRepoRoleAgent } from '../app/state.js';
import { colors, rgbColor } from './colors.js';
import { padEndVisual, truncateVisual, visualLength } from './layout.js';

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

export interface RenderAgentModalOptions {
  data: AppState;
  selectedPR: PrState | null;
  modalState: AgentModalState;
  modalWidth: number;
  modalHeight: number;
}

export function renderAgentModal(options: RenderAgentModalOptions): string[];
export function renderAgentModal(
  data: AppState,
  selectedPR: PrState | null,
  modalState: AgentModalState,
  modalWidth: number,
  modalHeight: number
): string[];
export function renderAgentModal(
  arg1: AppState | RenderAgentModalOptions,
  arg2?: PrState | null,
  arg3?: AgentModalState,
  arg4?: number,
  arg5?: number
): string[] {
  let data: AppState;
  let selectedPR: PrState | null;
  let modalState: AgentModalState;
  let modalWidth: number;
  let modalHeight: number;

  if ('modalWidth' in arg1) {
    data = arg1.data;
    selectedPR = arg1.selectedPR;
    modalState = arg1.modalState;
    modalWidth = arg1.modalWidth;
    modalHeight = arg1.modalHeight;
  } else {
    data = arg1;
    selectedPR = arg2 || null;
    modalState = arg3 || { selectedIndex: 0 };
    modalWidth = arg4 || 80;
    modalHeight = arg5 || 20;
  }

  const innerWidth = Math.max(10, modalWidth - 4);
  const outputLines: string[] = [];

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

  const addLine = (content: string) => {
    const truncated = truncateVisual(content, innerWidth);
    const padded = padEndVisual(truncated, innerWidth);
    outputLines.push(`\x1B[${rgbColor(colors.cyan)}│\x1B[0m ${padded} \x1B[${rgbColor(colors.cyan)}│\x1B[0m`);
  };

  const addDivider = () => {
    const div = '─'.repeat(innerWidth);
    outputLines.push(`\x1B[${rgbColor(colors.cyan)}├─${div}─┤\x1B[0m`);
  };

  // Top Border
  const titleLeft = ` 🤖 Agent & Automation Config: ${repoKey}${prNumStr ? ' ' + prNumStr : ''} `;
  const titleRight = ` [Esc to close] `;
  const availableDash = modalWidth - visualLength(titleLeft) - visualLength(titleRight) - 4;

  let topBorder: string;
  if (availableDash >= 0) {
    const dashes = '─'.repeat(availableDash);
    topBorder = `\x1B[${rgbColor(colors.cyan)}┌─\x1B[1;37m${titleLeft}\x1B[0m\x1B[${rgbColor(colors.cyan)}${dashes}\x1B[${rgbColor(colors.fgDim)}${titleRight}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┐\x1B[0m`;
  } else {
    const shortTitle = ` 🤖 Agent: ${repoKey} `;
    const shortDash = modalWidth - visualLength(shortTitle) - visualLength(titleRight) - 4;
    if (shortDash >= 0) {
      topBorder = `\x1B[${rgbColor(colors.cyan)}┌─\x1B[1;37m${shortTitle}\x1B[0m\x1B[${rgbColor(colors.cyan)}${'─'.repeat(shortDash)}\x1B[${rgbColor(colors.fgDim)}${titleRight}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┐\x1B[0m`;
    } else {
      topBorder = `\x1B[${rgbColor(colors.cyan)}┌${'─'.repeat(Math.max(0, modalWidth - 2))}┐\x1B[0m`;
    }
  }
  outputLines.push(padEndVisual(topBorder, modalWidth));

  // Section 1: Policy & Multi-Agent Roles
  addLine(`\x1B[1;36m⚙️  REPOSITORY AUTOMATION POLICY\x1B[0m`);

  const modeLeft = `  • Policy Mode:       ${modeBadge}  \x1B[${rgbColor(colors.fgDim)}(off, dry-run, live)\x1B[0m`;
  const modeRight = `\x1B[${rgbColor(colors.cyan)}[m]\x1B[0m cycle mode`;
  const modeSpacing = Math.max(2, innerWidth - visualLength(modeLeft) - visualLength(modeRight));
  addLine(`${modeLeft}${' '.repeat(modeSpacing)}${modeRight}`);

  const revLeft = `  • Reviewer Agent:    \x1B[1;37m🤖 ${reviewerAgent}\x1B[0m`;
  const revRight = `\x1B[${rgbColor(colors.cyan)}[1]\x1B[0m cycle reviewer`;
  const revSpacing = Math.max(2, innerWidth - visualLength(revLeft) - visualLength(revRight));
  addLine(`${revLeft}${' '.repeat(revSpacing)}${revRight}`);

  const fixLeft = `  • Fixer Agent:       \x1B[1;37m🤖 ${fixerAgent}\x1B[0m`;
  const fixRight = `\x1B[${rgbColor(colors.cyan)}[2]\x1B[0m cycle fixer`;
  const fixSpacing = Math.max(2, innerWidth - visualLength(fixLeft) - visualLength(fixRight));
  addLine(`${fixLeft}${' '.repeat(fixSpacing)}${fixRight}`);

  const ciLeft = `  • CI Repair Agent:   \x1B[1;37m🤖 ${ciAgent}\x1B[0m`;
  const ciRight = `\x1B[${rgbColor(colors.cyan)}[3]\x1B[0m cycle CI agent`;
  const ciSpacing = Math.max(2, innerWidth - visualLength(ciLeft) - visualLength(ciRight));
  addLine(`${ciLeft}${' '.repeat(ciSpacing)}${ciRight}`);

  addDivider();

  // Section 2: Playbook Presets
  addLine(`\x1B[1;36m⚡ ON-DEMAND PLAYBOOK DISPATCH\x1B[0m`);
  addLine(`\x1B[${rgbColor(colors.fgDim)}Select a playbook to run immediately on this PR:\x1B[0m`);

  PLAYBOOK_OPTIONS.forEach((opt, idx) => {
    const isSelected = idx === modalState.selectedIndex;
    const dot = isSelected ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
    const hotkey = `\x1B[${rgbColor(colors.cyan)}[${opt.hotkey}]\x1B[0m`;
    const nameColor = isSelected ? '\x1B[1;37m' : `\x1B[${rgbColor(colors.fgDim)}`;
    const line = `  ${dot} ${hotkey} ${nameColor}${opt.name}\x1B[0m  \x1B[${rgbColor(colors.fgDim)}(${opt.description})\x1B[0m`;
    addLine(line);
  });

  // Pad to modalHeight - 1
  while (outputLines.length < modalHeight - 1) {
    addLine('');
  }

  // Bottom Border
  const footerHelp = modalWidth < 70 ? ` [Enter] Run  [Esc] Close ` : ` [Enter/r/c/f/b/x] Dispatch  [m/1/2/3] Roles  [Esc] Close `;
  const availableBotDash = modalWidth - visualLength(footerHelp) - 4;
  let botBorder: string;
  if (availableBotDash >= 0) {
    botBorder = `\x1B[${rgbColor(colors.cyan)}└─\x1B[${rgbColor(colors.fgDim)}${footerHelp}\x1B[0m\x1B[${rgbColor(colors.cyan)}${'─'.repeat(availableBotDash)}─┘\x1B[0m`;
  } else {
    botBorder = `\x1B[${rgbColor(colors.cyan)}└${'─'.repeat(Math.max(0, modalWidth - 2))}┘\x1B[0m`;
  }
  outputLines.push(padEndVisual(botBorder, modalWidth));

  return outputLines;
}
