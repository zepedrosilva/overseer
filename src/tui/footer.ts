// ── TUI Footer & Modal Prompt Engine ────────────────────────────────────────
// Context-sensitive footer actions and interactive prompt modals matching llmfit.

import type { PrState, RepoPolicyMode } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { colors, rgbColor } from './colors.js';
import { padEndVisual } from './layout.js';

export type FooterMode =
  | 'NORMAL'
  | 'SEARCH'
  | 'CONFIRM_MERGE'
  | 'CONFIRM_CLOSE'
  | 'COMMENT_INPUT'
  | 'AGENT_SELECT'
  | 'AGENT_INPUT';

export interface FooterContext {
  mode: FooterMode;
  selectedPR: PrState | null;
  inputBuffer: string;
  selectedAgent?: string;
  availableAgents?: string[];
  repoMode?: RepoPolicyMode;
  message?: string;
}

export function renderFooter(context: FooterContext, width: number): string {
  const { mode, selectedPR, inputBuffer, selectedAgent, availableAgents, repoMode = 'off', message } = context;
  const safeWidth = Math.max(10, width - 2);

  if (message) {
    const text = `  \x1B[${rgbColor(colors.yellow)}${message}\x1B[0m  \x1B[${rgbColor(colors.fgDim)}(press any key)\x1B[0m`;
    return padEndVisual(text, safeWidth);
  }

  if (mode === 'CONFIRM_MERGE') {
    const key = selectedPR ? prKeyToString(selectedPR.key) : '';
    const text = `  \x1B[${rgbColor(colors.yellow)}! Squash-merge and delete branch for ${key}? (y/n):\x1B[0m `;
    return padEndVisual(text, safeWidth);
  }

  if (mode === 'CONFIRM_CLOSE') {
    const key = selectedPR ? prKeyToString(selectedPR.key) : '';
    const text = `  \x1B[${rgbColor(colors.red)}! Close Pull Request ${key}? (y/n):\x1B[0m `;
    return padEndVisual(text, safeWidth);
  }

  if (mode === 'COMMENT_INPUT') {
    const text = `  \x1B[${rgbColor(colors.cyan)}› Comment:\x1B[0m ${inputBuffer}\x1B[7m \x1B[0m  \x1B[${rgbColor(colors.fgDim)}[Enter] submit  [Esc] cancel\x1B[0m`;
    return padEndVisual(text, safeWidth);
  }

  if (mode === 'AGENT_SELECT') {
    const repoStr = selectedPR ? `${selectedPR.key.owner}/${selectedPR.key.repo}` : 'repo';
    const agentsList = availableAgents && availableAgents.length > 0 ? availableAgents : ['claude', 'agy', 'gemini', 'pi'];
    const badges = agentsList.map((name, idx) => {
      const isCurrent = name === selectedAgent;
      const icon = isCurrent ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
      const nameColor = isCurrent ? '\x1B[1;37m' : `\x1B[${rgbColor(colors.fgDim)}`;
      return `${icon} \x1B[${rgbColor(colors.cyan)}[${idx + 1}]\x1B[0m ${nameColor}${name}\x1B[0m`;
    }).join('  ');

    const modeStr =
      repoMode === 'live'
        ? `\x1B[${rgbColor(colors.green)}🟢 LIVE\x1B[0m`
        : repoMode === 'dry-run'
        ? `\x1B[${rgbColor(colors.yellow)}🟡 DRY-RUN\x1B[0m`
        : `\x1B[${rgbColor(colors.fgDim)}⚪ OFF\x1B[0m`;

    const text = `  \x1B[${rgbColor(colors.cyan)}› ${repoStr}:\x1B[0m  ${badges}   Mode: \x1B[${rgbColor(colors.cyan)}[m]\x1B[0m ${modeStr}   \x1B[${rgbColor(colors.fgDim)}[Enter] save & prompt  [Esc] cancel\x1B[0m`;
    return padEndVisual(text, safeWidth);
  }

  if (mode === 'AGENT_INPUT') {
    const agentTag = selectedAgent ? ` [${selectedAgent}]` : '';
    const text = `  \x1B[${rgbColor(colors.cyan)}› Agent${agentTag} prompt:\x1B[0m ${inputBuffer}\x1B[7m \x1B[0m  \x1B[${rgbColor(colors.fgDim)}[Enter] run  [Esc] back\x1B[0m`;
    return padEndVisual(text, safeWidth);
  }

  if (mode === 'SEARCH') {
    const text = `  \x1B[${rgbColor(colors.cyan)}› Search:\x1B[0m ${inputBuffer}\x1B[7m \x1B[0m  \x1B[${rgbColor(colors.fgDim)}[Enter] apply  [Esc] clear\x1B[0m`;
    return padEndVisual(text, safeWidth);
  }

  // Normal mode: minimal core actions + [?] all actions
  const candidateKeys = [
    { key: 'Enter', label: 'details' },
    { key: 'Tab', label: 'scope' },
    { key: 'p', label: 'stats' },
    { key: '?', label: 'all actions' },
    { key: 'q', label: 'quit' },
  ];

  const visibleBadges: string[] = [];
  let usedWidth = 4; // 2 leading + 2 trailing spaces

  for (const item of candidateKeys) {
    const rawLen = `[${item.key}] ${item.label}`.length + 2; // badge + separator spaces
    if (usedWidth + rawLen <= safeWidth) {
      visibleBadges.push(`\x1B[${rgbColor(colors.cyan)}[${item.key}]\x1B[0m \x1B[${rgbColor(colors.fgDim)}${item.label}\x1B[0m`);
      usedWidth += rawLen;
    }
  }

  const actionsText = visibleBadges.join('  ');
  return padEndVisual(`  ${actionsText}  `, safeWidth);
}
