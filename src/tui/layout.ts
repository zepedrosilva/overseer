// ── TUI Layout & String Utilities ──────────────────────────────────────────
// Layout calculation, viewport sizing, and ANSI string helpers.

export interface ViewportLayout {
  width: number;
  height: number;
  bannerHeight: number;
  statsHeight: number;
  scopeHeight: number;
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
  const height = Math.max(16, rows);

  const bannerHeight = 5; // 1 blank line + 4 logo lines
  const statsHeight = 1;  // 1 line stats bar directly below logo
  const scopeHeight = 1;  // 1 line scope tab bar
  const searchHeight = 1; // 1 line search bar
  const footerHeight = 1; // 1 line footer

  // 1 divider below stats bar, 1 divider below search, 1 divider above footer, 1 divider below footer = 4 dividers
  const bodyHeight = Math.max(3, height - bannerHeight - statsHeight - scopeHeight - searchHeight - footerHeight - 4);
  const totalHeight = bannerHeight + statsHeight + scopeHeight + searchHeight + footerHeight + 4 + bodyHeight;
  const isSplitView = false; // Primary view is always full width; details shown via interactive modal popup

  const leftWidth = width;
  const rightWidth = 0;

  return {
    width,
    height: totalHeight,
    bannerHeight,
    statsHeight,
    scopeHeight,
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

function getCharWidth(code: number): number {
  // Zero-width control and modifiers
  if (
    (code >= 0xfe00 && code <= 0xfe0f) || // Variation Selectors
    code === 0x200d || // Zero-width joiner
    code === 0x200b || // Zero-width space
    (code >= 0x0300 && code <= 0x036f) // Combining diacritical marks
  ) {
    return 0;
  }

  // Explicit single-width unicode symbols & box drawing
  if (
    code === 0x2713 || code === 0x2714 || // ✓, ✔
    code === 0x2717 || code === 0x2716 || // ✗, ✖
    code === 0x25cb || code === 0x25cf || // ○, ●
    code === 0x25b2 || code === 0x25bc || // ▲, ▼
    code === 0x2014 || code === 0x2013 || // —, –
    code === 0x2026 ||                    // …
    (code >= 0x2500 && code <= 0x257f)    // Box Drawing ─, │, ┌, └, etc.
  ) {
    return 1;
  }

  // East Asian Wide and full-width Emoji
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || // CJK Radicals, Kangxi, Hiragana, Katakana, CJK Unified Ideographs
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0xfe10 && code <= 0xfe19) || // Vertical forms
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compatibility Forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f000 && code <= 0x1faff) || // Miscellaneous Symbols & Pictographs, Emoticons, Supplemental Symbols
    (code >= 0x2600 && code <= 0x26ff) || // Miscellaneous Symbols (⚡ 0x26a1, ⚠️ 0x26a0, etc.)
    (code >= 0x2700 && code <= 0x27bf) || // Dingbats
    (code >= 0x2300 && code <= 0x23ff) || // Miscellaneous Technical (⌛ 0x231b, ⏳ 0x23f3, ⏱ 0x23f1)
    (code >= 0x2b00 && code <= 0x2bff)   // Miscellaneous Symbols and Arrows
  ) {
    return 2;
  }
  return 1;
}

export function visualLength(str: string): number {
  const stripped = stripAnsi(str);
  let len = 0;
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.codePointAt(i);
    if (code === undefined) continue;
    if (code > 0xffff) i++;
    len += getCharWidth(code);
  }
  return len;
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
  const currentLen = visualLength(str);
  if (currentLen <= maxLength) {
    return str;
  }

  const raw = stripAnsi(str);
  if (raw === str) {
    let accumulated = '';
    let visualLen = 0;
    const targetMax = maxLength <= 3 ? maxLength : maxLength - 1;

    for (let i = 0; i < str.length; i++) {
      const code = str.codePointAt(i);
      if (code === undefined) continue;
      const charWidth = getCharWidth(code);
      if (visualLen + charWidth > targetMax) {
        break;
      }
      const ch = code > 0xffff ? str.slice(i, i + 2) : str[i];
      if (code > 0xffff) i++;
      accumulated += ch;
      visualLen += charWidth;
    }
    return maxLength <= 3 ? accumulated : accumulated + '…';
  }

  let accumulated = '';
  let visualLen = 0;
  const targetMax = maxLength <= 3 ? maxLength : maxLength - 1;

  for (let i = 0; i < raw.length; i++) {
    const code = raw.codePointAt(i);
    if (code === undefined) continue;
    const charWidth = getCharWidth(code);
    if (visualLen + charWidth > targetMax) {
      break;
    }
    const ch = code > 0xffff ? raw.slice(i, i + 2) : raw[i];
    if (code > 0xffff) i++;
    accumulated += ch;
    visualLen += charWidth;
  }
  return (maxLength <= 3 ? accumulated : accumulated + '…') + '\x1B[0m';
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
