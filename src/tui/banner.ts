// ── Monochromatic ASCII Banner & Minimalist Stats Bar ──────────────────────
// Inspired by llmfit TUI: Clean monochromatic block typography with slate accents.

import type { AppState } from '../app/types.js';
import { colors, rgbColor, getSpinnerChar } from './colors.js';
import { padEndVisual, visualLength } from './layout.js';

export const VERSION = 'v0.1.0';

// Prominent, clean 4-line block ASCII logo
export const BANNER_LINES = [
  '  ██████╗  ██╗   ██╗ ███████╗ ██████╗  ███████╗ ███████╗ ███████╗ ██████╗ ',
  ' ██╔═══██╗ ██║   ██║ ██╔════╝ ██╔══██╗ ██╔════╝ ██╔════╝ ██╔════╝ ██╔══██╗',
  ' ██║   ██║ ╚██╗ ██╔╝ █████╗   ██████╔╝ ███████╗ █████╗   █████╗   ██████╔╝',
  ' ╚██████╔╝  ╚████╔╝  ███████╗ ██║  ██╗ ╚════██║ ███████╗ ███████╗ ██║  ██╗',
];

export interface BannerOptions {
  apiEnabled?: boolean;
  apiPort?: number;
  spinnerTick?: number;
}

export function renderBanner(width: number = 120): string[] {
  const whiteCode = '1;37'; // Bold white
  const safeWidth = Math.max(10, width - 2);
  const lines: string[] = [];

  // 1. Blank line on top of the logo
  lines.push(padEndVisual('', safeWidth));

  // 2. 4-line block ASCII logo with version adjacent to the top right of logo text
  const vBadge = `\x1B[1;37m${VERSION}\x1B[0m`;

  for (let i = 0; i < BANNER_LINES.length; i++) {
    const raw = BANNER_LINES[i];
    const coloredLogo = `\x1B[${whiteCode}m${raw}\x1B[0m`;

    if (i === 0) {
      // Position version badge directly adjacent to top-right of logo
      lines.push(padEndVisual(`${coloredLogo}  ${vBadge}`, safeWidth));
    } else {
      lines.push(padEndVisual(coloredLogo, safeWidth));
    }
  }

  return lines;
}

export function renderStatsBar(
  data: AppState,
  width: number,
  options?: BannerOptions
): string {
  const safeWidth = Math.max(10, width - 2);
  const reposCount = data.repos.length;
  const prsCount = data.prs.size;
  let needsAttention = 0;

  for (const pr of data.prs.values()) {
    if (pr.overallStatus === 'ChangesRequested' || pr.overallStatus === 'CiFailing') {
      needsAttention++;
    }
  }

  const lastPolledStr = data.lastPolled
    ? new Date(data.lastPolled).toLocaleTimeString()
    : '—';

  const userBadge = data.currentUser && data.currentUser !== 'unknown'
    ? `\x1B[${rgbColor(colors.fgDim)}User:\x1B[0m \x1B[${rgbColor(colors.cyan)}@${data.currentUser}\x1B[0m`
    : '';

  const attentionBadge = needsAttention > 0
    ? `\x1B[${rgbColor(colors.red)}● ${needsAttention} Needs Attention\x1B[0m`
    : `\x1B[${rgbColor(colors.green)}● All Clear\x1B[0m`;

  const pollIndicator = data.isPolling
    ? `\x1B[${rgbColor(colors.cyan)}${getSpinnerChar(options?.spinnerTick || 0)} Fetching PRs from GitHub...\x1B[0m`
    : `\x1B[${rgbColor(colors.fgDim)}Last Poll:\x1B[0m \x1B[${rgbColor(colors.fg)}${lastPolledStr}\x1B[0m`;

  const candidateParts: string[] = [];
  if (userBadge) candidateParts.push(userBadge);
  candidateParts.push(`\x1B[${rgbColor(colors.fgDim)}Repos:\x1B[0m \x1B[${rgbColor(colors.fg)}${reposCount}\x1B[0m`);
  candidateParts.push(`\x1B[${rgbColor(colors.fgDim)}Open PRs:\x1B[0m \x1B[${rgbColor(colors.fg)}${prsCount}\x1B[0m`);
  candidateParts.push(attentionBadge);
  candidateParts.push(pollIndicator);

  if (options?.apiEnabled) {
    candidateParts.push(`\x1B[${rgbColor(colors.fgDim)}Local API:\x1B[0m \x1B[${rgbColor(colors.cyan)}:${options.apiPort || 3210}\x1B[0m`);
  }

  if (data.dryRun) {
    candidateParts.push(`\x1B[${rgbColor(colors.yellow)}[DRY-RUN]\x1B[0m`);
  }

  const separator = '  ';
  const visibleParts: string[] = [];
  let usedLen = 4; // 2 leading + 2 trailing spaces

  for (const part of candidateParts) {
    const partLen = visualLength(part) + 2; // part visual length + 2 spaces separator
    if (usedLen + partLen <= safeWidth) {
      visibleParts.push(part);
      usedLen += partLen;
    }
  }

  const content = `  ${visibleParts.join(separator)}`;
  return padEndVisual(content, safeWidth);
}

export function renderDivider(width: number, char: string = '─'): string {
  const safeWidth = Math.max(10, width - 2);
  return `\x1B[${rgbColor(colors.border)}${char.repeat(safeWidth)}\x1B[0m`;
}
