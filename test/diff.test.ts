import { describe, it, expect } from 'vitest';
import { parseAndColorizeDiff, renderDiffModal } from '../src/tui/diff.js';
import { stripAnsi, visualLength } from '../src/tui/layout.js';
import type { PrState } from '../src/app/types.js';

describe('Diff Engine & Pop-up Modal', () => {
  function createMockPR(): PrState {
    return {
      key: { owner: 'MewsSystems', repo: 'billing', number: 142 },
      title: 'Fix invoice rounding calculations',
      branch: 'fix/rounding',
      baseBranch: 'main',
      author: 'josesilva',
      url: 'https://github.com/MewsSystems/billing/pull/142',
      isDraft: false,
      state: 'OPEN',
      reviewVerdict: 'APPROVED',
      ciStatus: 'SUCCESS',
      overallStatus: 'Ready',
      ciChecks: [],
      commentsCount: 0,
      unresolvedThreadsCount: 0,
      createdAt: '2026-08-17T10:00:00Z',
      updatedAt: '2026-08-17T11:00:00Z',
      log: [],
    };
  }

  const sampleDiff = `diff --git a/src/calc.ts b/src/calc.ts
index 1234567..89abcdef 100644
--- a/src/calc.ts
+++ b/src/calc.ts
@@ -10,6 +10,7 @@ export function calculateTax(amount: number): number {
-  return amount * 0.2;
+  const rate = getTaxRate();
+  return Math.round(amount * rate * 100) / 100;
 }
diff --git a/src/utils.ts b/src/utils.ts
index abcdef1..2345678 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,4 +1,4 @@
-export const VERSION = '1.0';
+export const VERSION = '1.1';
`;

  describe('parseAndColorizeDiff', () => {
    it('handles empty diff gracefully', () => {
      const parsed = parseAndColorizeDiff('', 80);
      expect(parsed.filesCount).toBe(0);
      expect(parsed.lines).toHaveLength(1);
      expect(stripAnsi(parsed.lines[0].text)).toContain('No file changes found');
    });

    it('identifies file headers and indexes file offsets', () => {
      const parsed = parseAndColorizeDiff(sampleDiff, 80);
      expect(parsed.filesCount).toBe(2);
      expect(parsed.fileOffsets).toHaveLength(2);
      expect(parsed.fileOffsets[0]).toBe(0);
      expect(parsed.fileOffsets[1]).toBeGreaterThan(0);

      const file1Header = stripAnsi(parsed.lines[parsed.fileOffsets[0]].text);
      expect(file1Header).toContain('[File 1]');
      expect(file1Header).toContain('src/calc.ts');

      const file2Header = stripAnsi(parsed.lines[parsed.fileOffsets[1]].text);
      expect(file2Header).toContain('[File 2]');
      expect(file2Header).toContain('src/utils.ts');
    });

    it('colorizes additions, deletions, and hunk headers', () => {
      const parsed = parseAndColorizeDiff(sampleDiff, 80);

      const hunkLine = parsed.lines.find((l) => l.type === 'hunk-header');
      expect(hunkLine).toBeDefined();
      expect(hunkLine?.raw).toContain('@@');

      const addLine = parsed.lines.find((l) => l.type === 'addition');
      expect(addLine).toBeDefined();
      expect(addLine?.raw).toContain('+');

      const delLine = parsed.lines.find((l) => l.type === 'deletion');
      expect(delLine).toBeDefined();
      expect(delLine?.raw).toContain('-');
    });
  });

  describe('renderDiffModal', () => {
    it('renders loading state with spinner', () => {
      const pr = createMockPR();
      const lines = renderDiffModal({
        pr,
        diffText: null,
        isLoading: true,
        modalWidth: 80,
        modalHeight: 14,
        scrollOffset: 0,
      });

      expect(lines).toHaveLength(14);
      const fullText = lines.map(stripAnsi).join('\n');
      expect(fullText).toContain('Diff: MewsSystems/billing#142 (fix/rounding)');
      expect(fullText).toContain('Fetching diff from GitHub');
      expect(fullText).toContain('[Esc to close]');
    });

    it('renders parsed diff lines with borders and action hints', () => {
      const pr = createMockPR();
      const lines = renderDiffModal({
        pr,
        diffText: sampleDiff,
        isLoading: false,
        modalWidth: 80,
        modalHeight: 16,
        scrollOffset: 0,
      });

      expect(lines).toHaveLength(16);
      for (const line of lines) {
        expect(visualLength(line)).toBe(80);
      }

      const fullText = lines.map(stripAnsi).join('\n');
      expect(fullText).toContain('Diff: MewsSystems/billing#142');
      expect(fullText).toContain('[File 1]');
      expect(fullText).toContain('[n/p] file');
      expect(fullText).toContain('[j/k] scroll');
      expect(fullText).toContain('[o] open');
      expect(fullText).toContain('[m] merge');
      expect(fullText).toContain('[a] agent');
    });

    it('renders correctly on narrow widths without line overflow', () => {
      const pr = createMockPR();
      const narrowWidth = 48;
      const lines = renderDiffModal({
        pr,
        diffText: sampleDiff,
        isLoading: false,
        modalWidth: narrowWidth,
        modalHeight: 12,
        scrollOffset: 0,
      });

      expect(lines).toHaveLength(12);
      for (const line of lines) {
        expect(visualLength(line)).toBe(narrowWidth);
      }
    });
  });
});
