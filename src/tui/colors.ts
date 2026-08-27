// ── TUI Colors & Badges ──────────────────────────────────────────────────────
// Minimalist, high-contrast palette inspired by llmfit (Electric Cyan & Cool Slate).

import type { PrOverallStatus, CiStatus } from '../app/types.js';

export const colors = {
  // Background & Surfaces
  bg: '#090d13',
  headerBg: '#0f172a',
  selectedBg: '#1e293b',
  selectedFg: '#ffffff',
  border: '#334155',

  // Text
  fg: '#f8fafc',
  fgDim: '#94a3b8',
  fgMuted: '#64748b',

  // Primary Accent (llmfit Electric Cyan)
  cyan: '#38bdf8',
  accent: '#38bdf8',
  blue: '#60a5fa',

  // Status & Utility Colors
  green: '#4ade80',
  red: '#f87171',
  yellow: '#fbbf24',
  magenta: '#c084fc',
  gray: '#64748b',
  white: '#ffffff',
};

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function getSpinnerChar(tick: number = 0): string {
  return SPINNER_FRAMES[Math.abs(tick) % SPINNER_FRAMES.length];
}

export function rgbColor(hex: string): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `38;2;${r};${g};${b}m`;
}

export function rgbBg(hex: string): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `48;2;${r};${g};${b}m`;
}

export function statusColor(status: PrOverallStatus): string {
  switch (status) {
    case 'Ready':
      return colors.green;
    case 'ChangesRequested':
    case 'CiFailing':
      return colors.red;
    case 'CiPending':
    case 'Reviewing':
      return colors.yellow;
    case 'Draft':
    case 'Closed':
      return colors.gray;
    case 'Merged':
      return colors.magenta;
    default:
      return colors.fg;
  }
}

export function statusIcon(status: PrOverallStatus): string {
  switch (status) {
    case 'Ready':
      return '●';
    case 'ChangesRequested':
      return '●';
    case 'CiFailing':
      return '✖';
    case 'CiPending':
      return '◐';
    case 'Reviewing':
      return '●';
    case 'Draft':
      return '○';
    case 'Merged':
      return '●';
    case 'Closed':
      return '○';
    default:
      return '○';
  }
}

export function ciIcon(status: CiStatus, spinnerTick: number = 0): string {
  switch (status) {
    case 'SUCCESS':
      return '✓';
    case 'FAILURE':
      return '✗';
    case 'PENDING':
      return getSpinnerChar(spinnerTick);
    case 'UNKNOWN':
    default:
      return '·';
  }
}

export function ciColor(status: CiStatus): string {
  switch (status) {
    case 'SUCCESS':
      return colors.green;
    case 'FAILURE':
      return colors.red;
    case 'PENDING':
      return colors.yellow;
    case 'UNKNOWN':
    default:
      return colors.gray;
  }
}
