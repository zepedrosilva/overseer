// ── TUI Settings & Extensions Modal ─────────────────────────────────────────
// Interactive modal to configure global defaults, extensions, and polling options.

import type { AppState } from '../app/types.js';
import { colors, rgbColor } from './colors.js';
import { padEndVisual, truncateVisual, visualLength } from './layout.js';
import { getAvailableAgents } from '../app/state.js';

export interface SettingsModalOptions {
  state: AppState;
  selectedIndex: number;
  isEditingText: boolean;
  editBuffer: string;
  modalWidth?: number;
  modalHeight?: number;
}

export const SETTINGS_ITEMS = [
  { id: 'defaultAgent', label: 'Default AI Agent', section: 'DEFAULTS' },
  { id: 'pollInterval', label: 'Personal Poll Interval', section: 'DEFAULTS' },
  { id: 'filterUserOnly', label: 'Filter Involving @me Only', section: 'DEFAULTS' },
  { id: 'dryRun', label: 'Dry-Run Mode', section: 'DEFAULTS' },
  { id: 'recentPrWindowDays', label: 'Recent Work Window', section: 'TEAM & SCOPE' },
  { id: 'teamActiveWindowDays', label: 'Team Open PR Max Age', section: 'TEAM & SCOPE' },
  { id: 'teamPollInterval', label: 'Team Poll Interval', section: 'TEAM & SCOPE' },
  { id: 'team', label: 'Team Slug / Members', section: 'TEAM & SCOPE' },
  { id: 'searchQuery', label: 'Search Query Override', section: 'TEAM & SCOPE' },
  { id: 'apiEnabled', label: 'Local API Server', section: 'EXTENSIONS' },
  { id: 'apiPort', label: 'Local API Port', section: 'EXTENSIONS' },
] as const;

export const POLL_INTERVALS = [15, 30, 60, 120, 300];
export const RECENT_WINDOW_OPTIONS = [1, 2, 7, 14];
export const TEAM_ACTIVE_WINDOW_OPTIONS = [14, 30, 60, 90, 0];
export const TEAM_POLL_INTERVALS = [30, 60, 120, 300, 600];

export function renderSettingsModal(options: SettingsModalOptions): string[] {
  const { state, selectedIndex, isEditingText, editBuffer, modalWidth = 86, modalHeight = 20 } = options;
  const lines: string[] = [];

  const borderColor = rgbColor(colors.cyan);
  const dimBorder = rgbColor(colors.border);
  const innerWidth = Math.max(10, modalWidth - 4);
  const innerHeight = Math.max(6, modalHeight - 2);

  // Top Border
  const topTitle = ' Settings & Extensions ';
  const topHints = ' [Esc to save & close] ';
  const topRemaining = Math.max(0, modalWidth - visualLength(topTitle) - visualLength(topHints) - 4);
  const topBorder = `\x1B[${borderColor}┌─\x1B[0m\x1B[1;37m${topTitle}\x1B[0m\x1B[${dimBorder}${'─'.repeat(topRemaining)}\x1B[0m\x1B[${rgbColor(colors.fgDim)}${topHints}\x1B[0m\x1B[${borderColor}─┐\x1B[0m`;
  lines.push(padEndVisual(topBorder, modalWidth));

  // Content Lines
  const contentLines: string[] = [];
  contentLines.push('');

  let currentSection = '';
  const availableAgents = getAvailableAgents(state);

  for (let i = 0; i < SETTINGS_ITEMS.length; i++) {
    const item = SETTINGS_ITEMS[i];
    const isSelected = i === selectedIndex;

    // Section Header
    if (item.section !== currentSection) {
      if (currentSection !== '') {
        contentLines.push(`  \x1B[${dimBorder}${'─'.repeat(innerWidth - 4)}\x1B[0m`);
      }
      currentSection = item.section;
      contentLines.push(`  \x1B[1;37m[${currentSection}]\x1B[0m`);
    }

    const pointer = isSelected ? `\x1B[${rgbColor(colors.cyan)}▸\x1B[0m ` : '  ';
    const labelColor = isSelected ? `\x1B[1;37m` : `\x1B[${rgbColor(colors.fgDim)}`;
    const label = `${labelColor}${item.label.padEnd(28)}\x1B[0m`;

    let valueStr = '';

    if (item.id === 'defaultAgent') {
      const cur = state.settings.defaultAgent || 'claude';
      valueStr = `\x1B[${rgbColor(colors.cyan)}< ${cur} >\x1B[0m  \x1B[${rgbColor(colors.fgMuted)}(${availableAgents.join(', ')})\x1B[0m`;
    } else if (item.id === 'pollInterval') {
      const cur = state.settings.pollIntervalSecs || 30;
      valueStr = `\x1B[${rgbColor(colors.cyan)}< ${cur}s >\x1B[0m  \x1B[${rgbColor(colors.fgMuted)}(${POLL_INTERVALS.map((s) => `${s}s`).join(', ')})\x1B[0m`;
    } else if (item.id === 'recentPrWindowDays') {
      const cur = state.settings.recentPrWindowDays || 7;
      const labelMap: Record<number, string> = {
        1: '1 day (24h)',
        2: '2 days (48h)',
        7: '7 days (1w)',
        14: '14 days (2w)',
      };
      const curLabel = labelMap[cur] || `${cur} days`;
      valueStr = `\x1B[${rgbColor(colors.cyan)}< ${curLabel} >\x1B[0m  \x1B[${rgbColor(colors.fgMuted)}(24h, 48h, 7d, 14d)\x1B[0m`;
    } else if (item.id === 'teamActiveWindowDays') {
      const cur = state.settings.teamActiveWindowDays ?? 30;
      const labelMap: Record<number, string> = {
        14: '14 days (2w)',
        30: '30 days (1m)',
        60: '60 days (2m)',
        90: '90 days (3m)',
        0: 'All (no limit)',
      };
      const curLabel = labelMap[cur] || (cur === 0 ? 'All' : `${cur} days`);
      valueStr = `\x1B[${rgbColor(colors.cyan)}< ${curLabel} >\x1B[0m  \x1B[${rgbColor(colors.fgMuted)}(14d, 30d, 60d, 90d, All)\x1B[0m`;
    } else if (item.id === 'teamPollInterval') {
      const cur = state.settings.teamPollIntervalSecs || 120;
      valueStr = `\x1B[${rgbColor(colors.cyan)}< ${cur}s >\x1B[0m  \x1B[${rgbColor(colors.fgMuted)}(${TEAM_POLL_INTERVALS.map((s) => `${s}s`).join(', ')})\x1B[0m`;
    } else if (item.id === 'team') {
      if (isSelected && isEditingText) {
        valueStr = `\x1B[${rgbColor(colors.cyan)}${editBuffer}\x1B[7m \x1B[0m\x1B[0m  \x1B[${rgbColor(colors.fgDim)}[Enter] save\x1B[0m`;
      } else {
        const cur = state.settings.team || '(none — personal only)';
        valueStr = `\x1B[${rgbColor(colors.fg)}${cur}\x1B[0m  \x1B[${rgbColor(colors.fgDim)}[Enter to edit]\x1B[0m`;
      }
    } else if (item.id === 'filterUserOnly') {
      const cur = state.settings.filterUserOnly;
      valueStr = cur
        ? `\x1B[${rgbColor(colors.green)}< ● Yes (Involves @me) >\x1B[0m`
        : `\x1B[${rgbColor(colors.yellow)}< ○ No (All Repo PRs) >\x1B[0m`;
    } else if (item.id === 'dryRun') {
      const cur = state.settings.dryRun;
      valueStr = cur
        ? `\x1B[${rgbColor(colors.yellow)}< ● Enabled (Read-only) >\x1B[0m`
        : `\x1B[${rgbColor(colors.fgDim)}< ○ Disabled >\x1B[0m`;
    } else if (item.id === 'searchQuery') {
      if (isSelected && isEditingText) {
        valueStr = `\x1B[${rgbColor(colors.cyan)}${editBuffer}\x1B[7m \x1B[0m\x1B[0m  \x1B[${rgbColor(colors.fgDim)}[Enter] save\x1B[0m`;
      } else {
        const cur = state.settings.searchQuery || '(default dynamic search)';
        valueStr = `\x1B[${rgbColor(colors.fg)}${cur}\x1B[0m  \x1B[${rgbColor(colors.fgDim)}[Enter to edit]\x1B[0m`;
      }
    } else if (item.id === 'apiEnabled') {
      const cur = state.extensions.api.enabled;
      valueStr = cur
        ? `\x1B[${rgbColor(colors.green)}< ● Enabled (HTTP/SSE :${state.extensions.api.port}) >\x1B[0m`
        : `\x1B[${rgbColor(colors.fgDim)}< ○ Disabled >\x1B[0m`;
    } else if (item.id === 'apiPort') {
      if (isSelected && isEditingText) {
        valueStr = `\x1B[${rgbColor(colors.cyan)}${editBuffer}\x1B[7m \x1B[0m\x1B[0m  \x1B[${rgbColor(colors.fgDim)}[Enter] save\x1B[0m`;
      } else {
        valueStr = `\x1B[${rgbColor(colors.cyan)}${state.extensions.api.port}\x1B[0m  \x1B[${rgbColor(colors.fgDim)}[Enter to edit]\x1B[0m`;
      }
    }

    const bgPrefix = isSelected ? `\x1B[48;2;30;41;59m` : '';
    const bgReset = isSelected ? `\x1B[0m` : '';
    contentLines.push(`${bgPrefix}  ${pointer}${label}  ${valueStr}${bgReset}`);
  }

  contentLines.push('');

  // Render Inner Rows
  const leftBorder = `\x1B[${borderColor}│\x1B[0m `;
  const rightBorder = ` \x1B[${borderColor}│\x1B[0m`;

  for (let i = 0; i < innerHeight; i++) {
    const raw = contentLines[i] || '';
    const truncated = truncateVisual(raw, innerWidth);
    const padded = padEndVisual(truncated, innerWidth);
    lines.push(`${leftBorder}${padded}${rightBorder}`);
  }

  // Bottom Border with navigation hints
  const botHints = ' [↑/↓] navigate  [←/→/Space] change  [Enter] edit  [Esc] save ';
  const botRemaining = Math.max(0, modalWidth - visualLength(botHints) - 4);
  const bottomBorder = `\x1B[${borderColor}└─\x1B[0m\x1B[${rgbColor(colors.fgDim)}${botHints}\x1B[0m\x1B[${dimBorder}${'─'.repeat(botRemaining)}\x1B[0m\x1B[${borderColor}─┘\x1B[0m`;
  lines.push(padEndVisual(bottomBorder, modalWidth));

  return lines;
}
