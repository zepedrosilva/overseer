// ── TUI Footer & Modal Prompt Engine ────────────────────────────────────────
// Context-sensitive footer actions and interactive prompt modals matching llmfit.

import type { PrState, RepoPolicyMode, ViewScope, WorkerHandle, PrKey } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { colors, rgbColor, rgbBg, getSpinnerChar } from './colors.js';
import { padEndVisual, truncateVisual } from './layout.js';

export interface DockedWorkersBarOptions {
  workers: WorkerHandle[];
  selectedPrKey?: PrKey | null;
  width: number;
  spinnerTick?: number;
}

export function renderDockedWorkersBar(options: DockedWorkersBarOptions): string[] {
  const { workers, selectedPrKey, width, spinnerTick = 0 } = options;
  const activeWorkers = workers.filter((w) => w.status === 'running');
  if (activeWorkers.length === 0) {
    return [];
  }

  const safeWidth = Math.max(10, width - 2);
  const lines: string[] = [];
  const spinner = getSpinnerChar(spinnerTick);
  const maxRows = Math.min(3, activeWorkers.length);

  for (let idx = 0; idx < maxRows; idx++) {
    const w = activeWorkers[idx];
    const indexNum = idx + 1;
    const isSelected =
      Boolean(selectedPrKey &&
      selectedPrKey.owner === w.prKey.owner &&
      selectedPrKey.repo === w.prKey.repo &&
      selectedPrKey.number === w.prKey.number);

    const prStr = `${w.prKey.repo}#${w.prKey.number}`;
    const elapsedSecs = Math.max(1, Math.round((Date.now() - (w.startedAt || Date.now())) / 1000));
    const timeStr = elapsedSecs >= 60
      ? `${Math.floor(elapsedSecs / 60)}m ${elapsedSecs % 60}s`
      : `${elapsedSecs}s`;

    const pointer = isSelected ? '\x1B[1;36m❯\x1B[0m ' : '  ';
    const indexBadge = `\x1B[1;36m[${indexNum}]\x1B[0m`;
    const spinnerBadge = `\x1B[1;32m${spinner}\x1B[0m`;
    const agentBadge = `\x1B[1;37m🤖 [${w.agentName}]\x1B[0m`;
    const prBadge = `\x1B[${rgbColor(colors.cyan)}${prStr}\x1B[0m`;
    const playbookBadge = `\x1B[${rgbColor(colors.fgDim)}· ${w.playbookName || 'task'}\x1B[0m`;

    let promptSnippet = '';
    if (w.originalPrompt) {
      const cleanPrompt = w.originalPrompt.replace(/\s+/g, ' ').trim();
      promptSnippet = `: \x1B[${rgbColor(colors.fg)}"${truncateVisual(cleanPrompt, 35)}"\x1B[0m`;
    }

    const timerBadge = `\x1B[${rgbColor(colors.fgDim)}(${timeStr}\x1B[0m`;
    const editsBadge = w.touchedFiles && w.touchedFiles.length > 0
      ? ` \x1B[1;33m· ⚡ ${w.touchedFiles.length} modified\x1B[0m`
      : '';
    const endTimer = `\x1B[${rgbColor(colors.fgDim)})\x1B[0m`;

    // Background tint (#0f172a / headerBg or selectedBg if isSelected)
    const bgCode = isSelected ? rgbBg(colors.selectedBg) : rgbBg(colors.headerBg);

    const prefix = `${pointer}${indexBadge} ${spinnerBadge} ${agentBadge} ${prBadge} ${playbookBadge}${promptSnippet} ${timerBadge}${editsBadge}${endTimer}`;
    lines.push(`\x1B[${bgCode}${padEndVisual(prefix, safeWidth)}\x1B[0m`);
  }

  if (activeWorkers.length > maxRows) {
    const extraCount = activeWorkers.length - maxRows;
    const extraText = `  \x1B[${rgbColor(colors.fgDim)}(+${extraCount} more background agent${extraCount > 1 ? 's' : ''} running · press Tab/3 for all)\x1B[0m`;
    lines.push(`\x1B[${rgbBg(colors.headerBg)}${padEndVisual(extraText, safeWidth)}\x1B[0m`);
  }

  return lines;
}

export type FooterMode =
  | 'NORMAL'
  | 'SEARCH'
  | 'CONFIRM_MERGE'
  | 'CONFIRM_CLOSE'
  | 'COMMENT_INPUT'
  | 'AGENT_SELECT'
  | 'PLAYBOOK_SELECT'
  | 'AGENT_INPUT';

export interface FooterContext {
  mode: FooterMode;
  selectedPR: PrState | null;
  inputBuffer: string;
  scope?: ViewScope;
  selectedAgent?: string;
  availableAgents?: string[];
  selectedPlaybookIndex?: number;
  availablePlaybooks?: string[];
  repoMode?: RepoPolicyMode;
  message?: string;
}

export function renderFooter(context: FooterContext, width: number): string {
  const {
    mode,
    selectedPR,
    inputBuffer,
    scope,
    selectedAgent,
    availableAgents,
    selectedPlaybookIndex = 0,
    availablePlaybooks,
    repoMode = 'off',
    message,
  } = context;
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

    const text = `  \x1B[${rgbColor(colors.cyan)}› ${repoStr}:\x1B[0m  ${badges}   Mode: \x1B[${rgbColor(colors.cyan)}[m]\x1B[0m ${modeStr}   \x1B[${rgbColor(colors.fgDim)}[Enter] select playbook  [Esc] cancel\x1B[0m`;
    return padEndVisual(text, safeWidth);
  }

  if (mode === 'PLAYBOOK_SELECT') {
    const prStr = selectedPR ? `#${selectedPR.key.number}` : 'PR';
    const playbooksList =
      availablePlaybooks && availablePlaybooks.length > 0
        ? availablePlaybooks
        : ['preflight-review', 'ci-repair', 'address-comments', 'rebase-resolver', 'custom...'];
    const badges = playbooksList
      .map((name, idx) => {
        const isCurrent = idx === selectedPlaybookIndex;
        const icon = isCurrent ? `\x1B[${rgbColor(colors.green)}●\x1B[0m` : `\x1B[${rgbColor(colors.fgDim)}○\x1B[0m`;
        const nameColor = isCurrent ? '\x1B[1;37m' : `\x1B[${rgbColor(colors.fgDim)}`;
        return `${icon} \x1B[${rgbColor(colors.cyan)}[${idx + 1}]\x1B[0m ${nameColor}${name}\x1B[0m`;
      })
      .join('  ');

    const text = `  \x1B[${rgbColor(colors.cyan)}› Playbook for ${prStr}:\x1B[0m  ${badges}    \x1B[${rgbColor(colors.fgDim)}[Enter] dispatch  [1-${playbooksList.length} / ← →] select  [Esc] back\x1B[0m`;
    return padEndVisual(text, safeWidth);
  }

  if (mode === 'AGENT_INPUT') {
    const agentTag = selectedAgent ? ` [${selectedAgent}]` : '';
    const text = `  \x1B[${rgbColor(colors.cyan)}› Custom prompt${agentTag}:\x1B[0m ${inputBuffer}\x1B[7m \x1B[0m  \x1B[${rgbColor(colors.fgDim)}[Enter] run  [Esc] back\x1B[0m`;
    return padEndVisual(text, safeWidth);
  }

  if (mode === 'SEARCH') {
    const text = `  \x1B[${rgbColor(colors.cyan)}› Search:\x1B[0m ${inputBuffer}\x1B[7m \x1B[0m  \x1B[${rgbColor(colors.fgDim)}[Enter] apply  [Esc] clear\x1B[0m`;
    return padEndVisual(text, safeWidth);
  }

  // Normal mode: minimal core actions + [?] all actions
  const candidateKeys = scope === 'agents'
    ? [
        { key: '↑/↓', label: 'navigate' },
        { key: '←/→', label: 'pane' },
        { key: 'a', label: 'dispatch' },
        { key: 'c', label: 'cancel' },
        { key: 'Tab', label: 'scope' },
        { key: 'q', label: 'quit' },
      ]
    : [
        { key: '↑/↓', label: 'navigate' },
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
