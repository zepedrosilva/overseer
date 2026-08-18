// ── All Actions & Help Modal ───────────────────────────────────────────────────
// Comprehensive, categorized overlay listing all keyboard shortcuts and capabilities.

import { colors, rgbColor } from './colors.js';
import { padEndVisual, truncateVisual, visualLength } from './layout.js';

export interface RenderHelpModalOptions {
  modalWidth: number;
  modalHeight: number;
}

export function renderHelpModal(options: RenderHelpModalOptions): string[] {
  const { modalWidth, modalHeight } = options;
  const innerWidth = Math.max(10, modalWidth - 4);
  const outputLines: string[] = [];

  const titleLeft = ` 📖 All Actions & Keybindings`;
  const titleRight = ` [Esc/?/q to close] `;
  const availableDash = modalWidth - visualLength(titleLeft) - visualLength(titleRight) - 4;

  let topBorder: string;
  if (availableDash >= 0) {
    const dashes = '─'.repeat(availableDash);
    topBorder = `\x1B[${rgbColor(colors.cyan)}┌─\x1B[1;37m${titleLeft}\x1B[0m\x1B[${rgbColor(colors.cyan)}${dashes}\x1B[${rgbColor(colors.fgDim)}${titleRight}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┐\x1B[0m`;
  } else {
    topBorder = `\x1B[${rgbColor(colors.cyan)}┌${'─'.repeat(Math.max(0, modalWidth - 2))}┐\x1B[0m`;
  }
  outputLines.push(padEndVisual(topBorder, modalWidth));

  const addLine = (content: string) => {
    const truncated = truncateVisual(content, innerWidth);
    const padded = padEndVisual(truncated, innerWidth);
    outputLines.push(`\x1B[${rgbColor(colors.cyan)}│\x1B[0m ${padded} \x1B[${rgbColor(colors.cyan)}│\x1B[0m`);
  };

  const addDivider = () => {
    const div = '─'.repeat(innerWidth);
    outputLines.push(`\x1B[${rgbColor(colors.cyan)}├─${div}─┤\x1B[0m`);
  };

  const renderKeyRow = (key: string, desc: string) => {
    const keyBadge = padEndVisual(`\x1B[1;37m[${key}]\x1B[0m`, 14);
    const descText = `\x1B[${rgbColor(colors.fg)}${desc}\x1B[0m`;
    addLine(`  ${keyBadge} ${descText}`);
  };

  // 1. Navigation & Scope
  addLine(`\x1B[1;37m🧭 Navigation & Scope\x1B[0m`);
  renderKeyRow('↑ / k', 'Move selection up');
  renderKeyRow('↓ / j', 'Move selection down');
  renderKeyRow('Tab / t', 'Toggle monitoring scope between Mine and Team');
  renderKeyRow('1 / 2', 'Select scope directly: [1] Mine  [2] Team');
  renderKeyRow('/ or f', 'Search / filter PRs by title, repo, author, or branch');
  addDivider();

  // 2. PR Triage & Actions
  addLine(`\x1B[1;37m⚡ PR Triage & Operations\x1B[0m`);
  renderKeyRow('Enter / v', 'Open PR Details modal (CI runs, threads, agent status, logs)');
  renderKeyRow('d', 'Open full git diff in modal (with [n/p] file jump)');
  renderKeyRow('o', 'Open pull request in default browser (gh pr view --web)');
  renderKeyRow('m', 'Squash-merge pull request and delete branch (with prompt)');
  renderKeyRow('c', 'Post review comment to pull request');
  renderKeyRow('x', 'Close pull request (with prompt)');
  renderKeyRow('R', 'Force immediate GitHub polling & recheck');
  addDivider();

  // 3. AI Agents & Automation
  addLine(`\x1B[1;37m🤖 AI Agents & Background Worktrees\x1B[0m`);
  renderKeyRow('a', 'Dispatch AI agent in isolated worktree with custom prompt');
  renderKeyRow('L / l', 'View live streaming or historical agent execution logs');
  addDivider();

  // 4. Performance & Config
  addLine(`\x1B[1;37m📊 Performance & Configuration\x1B[0m`);
  renderKeyRow('p', 'Open PR Stats & Team Leaderboard dashboard (30d metrics & trends)');
  renderKeyRow('b / B', 'Trigger on-demand PR stats backfill (defaults to 90d)');
  renderKeyRow('s', 'Settings & Extensions modal (team, default agent, Stream Deck)');
  renderKeyRow('? / h', 'Show this All Actions & Keybindings modal');
  renderKeyRow('q', 'Quit Overseer');

  // Fill empty space up to modalHeight - 1
  while (outputLines.length < modalHeight - 1) {
    addLine('');
  }

  // Bottom Border
  const footerHelp = ` [Esc/?/q] close `;
  const botDash = Math.max(0, modalWidth - visualLength(footerHelp) - 4);
  const botBorder = `\x1B[${rgbColor(colors.cyan)}└─\x1B[${rgbColor(colors.fgDim)}${footerHelp}\x1B[0m\x1B[${rgbColor(colors.cyan)}${'─'.repeat(botDash)}─┘\x1B[0m`;
  outputLines.push(padEndVisual(botBorder, modalWidth));

  return outputLines;
}
