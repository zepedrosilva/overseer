// ── TUI Layout & String Utilities ──────────────────────────────────────────
// Layout calculation, viewport sizing, and ANSI string helpers.

export interface ViewportLayout {
  width: number;
  height: number;
  bannerHeight: number;
  statsHeight: number;
  searchHeight: number;
  footerHeight: number;
  bodyHeight: number;
  isSplitView: boolean;
  leftWidth: number;
  rightWidth: number;
}

export function calculateLayout(
  columns: number = process.stdout.columns || 120,
  rows: number = process.stdout.rows || 30
): ViewportLayout {
  const width = Math.max(40, columns);
  const height = Math.max(14, rows);

  const bannerHeight = 5; // 1 blank line + 4 logo lines
  const statsHeight = 1;  // 1 line stats bar directly below logo
  const searchHeight = 1; // 1 line search bar
  const footerHeight = 1; // 1 line footer

  // 1 divider below stats bar, 1 divider below search, 1 divider above footer = 3 dividers
  const bodyHeight = Math.max(3, height - bannerHeight - statsHeight - searchHeight - footerHeight - 3);
  const totalHeight = bannerHeight + statsHeight + searchHeight + footerHeight + 3 + bodyHeight;
  const isSplitView = false; // Primary view is always full width; details shown via interactive modal popup

  const leftWidth = width;
  const rightWidth = 0;

  return {
    width,
    height: totalHeight,
    bannerHeight,
    statsHeight,
    searchHeight,
    footerHeight,
    bodyHeight,
    isSplitView,
    leftWidth,
    rightWidth,
  };
}

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '');
}

export function visualLength(str: string): number {
  return stripAnsi(str).length;
}

export function padEndVisual(str: string, targetLength: number, padChar: string = ' '): string {
  const currentLen = visualLength(str);
  if (currentLen >= targetLength) {
    return str;
  }
  return str + padChar.repeat(targetLength - currentLen);
}

export function truncateVisual(str: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  const raw = stripAnsi(str);
  if (raw.length <= maxLength) {
    return str;
  }
  if (maxLength <= 3) {
    return raw.slice(0, maxLength);
  }
  return raw.slice(0, maxLength - 1) + '…';
}

export function formatTimeAgo(isoDate: string): string {
  if (!isoDate) return '—';
  const now = Date.now();
  const date = new Date(isoDate).getTime();
  const diffSecs = Math.max(0, Math.floor((now - date) / 1000));

  if (diffSecs < 60) return `${diffSecs}s`;
  const mins = Math.floor(diffSecs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
