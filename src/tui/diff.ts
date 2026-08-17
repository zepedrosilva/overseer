// ── TUI Diff Modal & Syntax Colorizer ──────────────────────────────────────────
// Renders colorized unified git diffs in a pop-up modal with file navigation and scroll indicators.

import type { PrState } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { colors, rgbColor, getSpinnerChar } from './colors.js';
import { padEndVisual, truncateVisual, visualLength } from './layout.js';

export interface DiffLine {
  text: string;
  raw: string;
  type: 'file-header' | 'hunk-header' | 'addition' | 'deletion' | 'meta' | 'context';
  fileIndex?: number;
}

export interface ParsedDiff {
  lines: DiffLine[];
  fileOffsets: number[];
  filesCount: number;
}

export function parseAndColorizeDiff(rawDiff: string, innerWidth: number): ParsedDiff {
  if (!rawDiff || !rawDiff.trim()) {
    return {
      lines: [
        {
          text: `\x1B[${rgbColor(colors.fgDim)}No file changes found in this Pull Request.\x1B[0m`,
          raw: 'No file changes found in this Pull Request.',
          type: 'context',
        },
      ],
      fileOffsets: [],
      filesCount: 0,
    };
  }

  const rawLines = rawDiff.split('\n');
  const lines: DiffLine[] = [];
  const fileOffsets: number[] = [];
  let fileCount = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];

    // File Header (diff --git a/... b/...)
    if (rawLine.startsWith('diff --git')) {
      fileCount++;
      fileOffsets.push(lines.length);

      const parts = rawLine.split(' ');
      const filePath = parts[3] ? parts[3].replace(/^b\//, '') : parts[2] || '';

      const badge = ` [File ${fileCount}] `;
      const headerText = `─── ${badge} ${filePath} `;
      const paddedHeader = padEndVisual(headerText, innerWidth, '─');

      lines.push({
        text: `\x1B[1;37m\x1B[48;2;30;41;59m${paddedHeader}\x1B[0m`,
        raw: rawLine,
        type: 'file-header',
        fileIndex: fileCount,
      });
      continue;
    }

    // Git Index / Metadata lines (--- a/..., +++ b/..., index ..., new file mode ...)
    if (
      rawLine.startsWith('--- ') ||
      rawLine.startsWith('+++ ') ||
      rawLine.startsWith('index ') ||
      rawLine.startsWith('new file mode ') ||
      rawLine.startsWith('deleted file mode ') ||
      rawLine.startsWith('similarity index ')
    ) {
      lines.push({
        text: `\x1B[${rgbColor(colors.fgMuted)}${truncateVisual(rawLine, innerWidth)}\x1B[0m`,
        raw: rawLine,
        type: 'meta',
      });
      continue;
    }

    // Hunk Header (@@ -a,b +c,d @@ ...)
    if (rawLine.startsWith('@@')) {
      lines.push({
        text: `\x1B[${rgbColor(colors.cyan)}${truncateVisual(rawLine, innerWidth)}\x1B[0m`,
        raw: rawLine,
        type: 'hunk-header',
      });
      continue;
    }

    // Addition line (+...)
    if (rawLine.startsWith('+')) {
      lines.push({
        text: `\x1B[${rgbColor(colors.green)}${truncateVisual(rawLine, innerWidth)}\x1B[0m`,
        raw: rawLine,
        type: 'addition',
      });
      continue;
    }

    // Deletion line (-...)
    if (rawLine.startsWith('-')) {
      lines.push({
        text: `\x1B[${rgbColor(colors.red)}${truncateVisual(rawLine, innerWidth)}\x1B[0m`,
        raw: rawLine,
        type: 'deletion',
      });
      continue;
    }

    // Context line
    lines.push({
      text: `\x1B[${rgbColor(colors.fgDim)}${truncateVisual(rawLine, innerWidth)}\x1B[0m`,
      raw: rawLine,
      type: 'context',
    });
  }

  return {
    lines,
    fileOffsets,
    filesCount: fileCount,
  };
}

export interface RenderDiffModalOptions {
  pr: PrState;
  diffText: string | null;
  isLoading: boolean;
  modalWidth: number;
  modalHeight: number;
  scrollOffset: number;
  spinnerTick?: number;
}

export function renderDiffModal(options: RenderDiffModalOptions): string[] {
  const { pr, diffText, isLoading, modalWidth, modalHeight, scrollOffset, spinnerTick = 0 } = options;

  const innerWidth = Math.max(10, modalWidth - 4); // 2 borders + 2 padding
  const bodyHeight = Math.max(2, modalHeight - 2); // 1 top border + 1 bottom border
  const outputLines: string[] = [];

  const keyStr = prKeyToString(pr.key);

  // 1. Modal Top Border with Title
  const titleLeft = ` Diff: ${keyStr} (${pr.branch}) `;
  const titleRight = ` [Esc to close] `;
  const availableDash = modalWidth - visualLength(titleLeft) - visualLength(titleRight) - 4;

  let topBorder: string;
  if (availableDash >= 0) {
    const dashes = '─'.repeat(availableDash);
    topBorder = `\x1B[${rgbColor(colors.cyan)}┌─\x1B[1;37m${titleLeft}\x1B[0m\x1B[${rgbColor(colors.cyan)}${dashes}\x1B[${rgbColor(colors.fgDim)}${titleRight}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┐\x1B[0m`;
  } else {
    const compactTitle = ` Diff: #${pr.key.number} `;
    const compactDash = Math.max(0, modalWidth - visualLength(compactTitle) - visualLength(titleRight) - 4);
    if (compactDash >= 0) {
      topBorder = `\x1B[${rgbColor(colors.cyan)}┌─\x1B[1;37m${compactTitle}\x1B[0m\x1B[${rgbColor(colors.cyan)}${'─'.repeat(compactDash)}\x1B[${rgbColor(colors.fgDim)}${titleRight}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┐\x1B[0m`;
    } else {
      topBorder = `\x1B[${rgbColor(colors.cyan)}┌${'─'.repeat(Math.max(0, modalWidth - 2))}┐\x1B[0m`;
    }
  }
  outputLines.push(padEndVisual(topBorder, modalWidth));

  // 2. Loading State
  if (isLoading) {
    const spinner = getSpinnerChar(spinnerTick);
    const loadingText = ` ${spinner} Fetching diff from GitHub... `;
    const vertPadTop = Math.max(0, Math.floor((bodyHeight - 1) / 2));
    const vertPadBottom = Math.max(0, bodyHeight - 1 - vertPadTop);

    for (let i = 0; i < vertPadTop; i++) {
      outputLines.push(`\x1B[${rgbColor(colors.cyan)}│\x1B[0m ${' '.repeat(innerWidth)} \x1B[${rgbColor(colors.cyan)}│\x1B[0m`);
    }

    const paddedLoading = padEndVisual(`\x1B[${rgbColor(colors.yellow)}${loadingText}\x1B[0m`, innerWidth);
    outputLines.push(`\x1B[${rgbColor(colors.cyan)}│\x1B[0m ${paddedLoading} \x1B[${rgbColor(colors.cyan)}│\x1B[0m`);

    for (let i = 0; i < vertPadBottom; i++) {
      outputLines.push(`\x1B[${rgbColor(colors.cyan)}│\x1B[0m ${' '.repeat(innerWidth)} \x1B[${rgbColor(colors.cyan)}│\x1B[0m`);
    }
  } else {
    // 3. Render Parsed Diff Lines with Scroll Window
    const parsed = parseAndColorizeDiff(diffText || '', innerWidth);
    const totalLines = parsed.lines.length;
    const clampedOffset = Math.max(0, Math.min(Math.max(0, totalLines - bodyHeight), scrollOffset));

    for (let row = 0; row < bodyHeight; row++) {
      const lineIdx = clampedOffset + row;
      let lineVisual = '';

      if (lineIdx < totalLines) {
        lineVisual = parsed.lines[lineIdx].text;
      }

      const padded = padEndVisual(lineVisual, innerWidth);
      outputLines.push(`\x1B[${rgbColor(colors.cyan)}│\x1B[0m ${padded} \x1B[${rgbColor(colors.cyan)}│\x1B[0m`);
    }
  }

  // 4. Modal Bottom Border with Adaptive Navigation & Actions
  const candidateBadges = [
    '[n/p] file',
    '[j/k] scroll',
    '[o] open',
    '[m] merge',
    '[a] agent',
    '[c] comment',
  ];

  const scrollIndicator = options.isLoading
    ? ''
    : ` [${scrollOffset + 1}/${Math.max(1, (diffText || '').split('\n').length)} L] `;

  const maxActionsWidth = Math.max(0, modalWidth - visualLength(scrollIndicator) - 6);
  const visibleBadges: string[] = [];
  let usedWidth = 2;

  for (const badge of candidateBadges) {
    const needed = visualLength(badge) + (visibleBadges.length > 0 ? 2 : 0);
    if (usedWidth + needed <= maxActionsWidth) {
      visibleBadges.push(badge);
      usedWidth += needed;
    }
  }

  const actionsLeft = visibleBadges.length > 0
    ? ` ${visibleBadges.join('  ')} `
    : ' [Esc] close ';

  const bottomAvailable = Math.max(0, modalWidth - visualLength(actionsLeft) - visualLength(scrollIndicator) - 4);
  const dashes = '─'.repeat(bottomAvailable);
  const bottomBorder = `\x1B[${rgbColor(colors.cyan)}└─\x1B[${rgbColor(colors.fgDim)}${actionsLeft}\x1B[0m\x1B[${rgbColor(colors.cyan)}${dashes}\x1B[${rgbColor(colors.fgDim)}${scrollIndicator}\x1B[0m\x1B[${rgbColor(colors.cyan)}─┘\x1B[0m`;

  outputLines.push(padEndVisual(bottomBorder, modalWidth));

  return outputLines;
}
