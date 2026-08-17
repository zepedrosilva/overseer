// ── TUI Terminal Coordinator ───────────────────────────────────────────────
// Manages alternate screen buffer, Warp/iTerm scroll compatibility,
// split-view rendering, and keyboard/mouse events.

import type { AppState, PrState } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { calculateLayout, padEndVisual } from './layout.js';
import { renderBanner, renderStatsBar, renderDivider } from './banner.js';
import { renderSearchBar, filterPRs } from './search.js';
import { renderTable } from './table.js';
import { renderDetails, renderDetailsModal } from './details.js';
import { renderSettingsModal, SETTINGS_ITEMS, POLL_INTERVALS } from './settings.js';
import { renderDiffModal, parseAndColorizeDiff } from './diff.js';
import { renderLogsModal, loadPRLogFile } from './logs.js';
import { renderFooter, type FooterMode, type FooterContext } from './footer.js';
import { getRepoAgent, setRepoAgent, getAvailableAgents, saveState } from '../app/state.js';
import { getPRDiff } from '../watcher/gh.js';
import { colors, rgbColor } from './colors.js';

export type TUIActionCallback = (action: string, payload?: Record<string, unknown>) => void | Promise<void>;

export interface TUIController {
  destroy: () => void;
  render: () => void;
  showMessage: (msg: string) => void;
  getSelectedPR: () => PrState | null;
}

export function createTUI(
  data: AppState,
  onAction: TUIActionCallback,
  onQuit: () => void,
  options?: {
    streamDeckEnabled?: boolean;
    streamDeckPort?: number;
    onSettingsChange?: () => void;
  }
): TUIController {
  let footerMode: FooterMode = 'NORMAL';
  let inputBuffer = '';
  let statusMessage: string | undefined;
  let inAltScreen = false;
  let selectedRow = 0;
  let searchQuery = '';
  let spinnerTick = 0;
  let isDetailsModalOpen = false;
  let detailsScrollOffset = 0;
  let isSettingsModalOpen = false;
  let settingsIndex = 0;
  let isEditingSetting = false;
  let settingInputBuffer = '';
  let isDiffModalOpen = false;
  let diffScrollOffset = 0;
  let diffLoading = false;
  let diffContent: string | null = null;
  const diffCache = new Map<string, { diff: string; fetchedAt: string }>();
  let isLogsModalOpen = false;
  let logsScrollOffset = 0;
  let selectedAgentIndex = 0;
  let availableAgents: string[] = getAvailableAgents(data);

  // Live animation ticker (100ms) for spinners during polling, active CI workflows, and worker runs
  const animationTimer = setInterval(() => {
    const hasRunningWorkers = Array.from(data.workers.values()).some((w) => w.status === 'running');
    const hasPendingCi = Array.from(data.prs.values()).some((pr) => pr.ciStatus === 'PENDING');
    if (data.isPolling || hasRunningWorkers || hasPendingCi || diffLoading) {
      spinnerTick = (spinnerTick + 1) % 1000;
      render();
    }
  }, 100);

  function enterAltScreen(): void {
    if (!inAltScreen) {
      // Enter alt screen, hide cursor, and enable SGR mouse tracking for smooth terminal scrolling
      process.stdout.write('\x1B[?1049h\x1B[?25l\x1B[?1000h\x1B[?1006h');
      inAltScreen = true;
    }
  }

  function exitAltScreen(): void {
    if (inAltScreen) {
      // Disable mouse tracking, show cursor, exit alt screen
      process.stdout.write('\x1B[?1006l\x1B[?1000l\x1B[?25h\x1B[?1049l');
      inAltScreen = false;
    }
  }

  function getFilteredPRs(): PrState[] {
    const list = Array.from(data.prs.values());
    const filtered = filterPRs(list, searchQuery);

    // Group & Sort:
    // 1. Group by organization (owner) sorted strictly alphabetically by name
    // 2. Within each org: attention first (ChangesRequested, CiFailing), then Ready, then others, then updatedAt desc
    filtered.sort((a, b) => {
      const ownerA = (a.key.owner || '').toLowerCase();
      const ownerB = (b.key.owner || '').toLowerCase();
      if (ownerA !== ownerB) {
        return ownerA.localeCompare(ownerB, undefined, { sensitivity: 'base' });
      }

      const priority = (pr: PrState) => {
        if (pr.overallStatus === 'ChangesRequested' || pr.overallStatus === 'CiFailing') return 0;
        if (pr.overallStatus === 'Ready') return 1;
        if (pr.overallStatus === 'Reviewing' || pr.overallStatus === 'CiPending') return 2;
        if (pr.overallStatus === 'Draft') return 3;
        return 4;
      };
      const pDiff = priority(a) - priority(b);
      if (pDiff !== 0) return pDiff;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    return filtered;
  }

  function getSelectedPR(): PrState | null {
    const prs = getFilteredPRs();
    if (prs.length === 0) return null;
    return prs[selectedRow] || null;
  }

  function openDiffForSelectedPR(): void {
    const pr = getSelectedPR();
    if (!pr) return;

    isDiffModalOpen = true;
    isDetailsModalOpen = false;
    isLogsModalOpen = false;
    isSettingsModalOpen = false;
    diffScrollOffset = 0;

    const cacheKey = `${pr.key.owner}/${pr.key.repo}#${pr.key.number}`;
    const cached = diffCache.get(cacheKey);

    if (cached && cached.fetchedAt === pr.updatedAt) {
      diffContent = cached.diff;
      diffLoading = false;
      render();
      return;
    }

    diffLoading = true;
    diffContent = null;
    render();

    getPRDiff(pr.key.owner, pr.key.repo, pr.key.number)
      .then((diffText) => {
        diffCache.set(cacheKey, { diff: diffText, fetchedAt: pr.updatedAt });
        if (isDiffModalOpen && getSelectedPR()?.key.number === pr.key.number) {
          diffContent = diffText;
          diffLoading = false;
          render();
        }
      })
      .catch((err) => {
        if (isDiffModalOpen && getSelectedPR()?.key.number === pr.key.number) {
          diffContent = `Failed to fetch diff: ${(err as Error).message}`;
          diffLoading = false;
          render();
        }
      });
  }

  function openLogsForSelectedPR(): void {
    const pr = getSelectedPR();
    if (!pr) return;

    isLogsModalOpen = true;
    isDetailsModalOpen = false;
    isDiffModalOpen = false;
    isSettingsModalOpen = false;

    const layout = calculateLayout(process.stdout.columns, process.stdout.rows);
    const bodyHeight = Math.max(2, layout.bodyHeight - 2);
    const logLines = loadPRLogFile(pr);
    logsScrollOffset = Math.max(0, logLines.length - bodyHeight);
    render();
  }

  function render(): void {
    enterAltScreen();

    const layout = calculateLayout(process.stdout.columns, process.stdout.rows);
    const filteredPRs = getFilteredPRs();

    if (filteredPRs.length > 0) {
      selectedRow = Math.max(0, Math.min(filteredPRs.length - 1, selectedRow));
    } else {
      selectedRow = 0;
    }

    const selectedPR = getSelectedPR();
    availableAgents = getAvailableAgents(data);

    const allLines: string[] = [];

    // 1. Monochromatic Large ASCII Banner (blank line on top + logo + version adjacent top-right)
    const bannerLines = renderBanner(layout.width);
    allLines.push(...bannerLines);

    // 2. Compact 1-line metadata bar below logo
    allLines.push(
      renderStatsBar(data, layout.width, {
        streamDeckEnabled: data.extensions?.streamdeck?.enabled ?? options?.streamDeckEnabled,
        streamDeckPort: data.extensions?.streamdeck?.port ?? options?.streamDeckPort,
        spinnerTick,
      })
    );

    // 3. Divider & Search Bar
    allLines.push(renderDivider(layout.width));
    allLines.push(renderSearchBar(searchQuery, footerMode === 'SEARCH', Math.max(10, layout.width - 2)));
    allLines.push(renderDivider(layout.width));

    // 4. Main Body Table (Full width) with live worker spinner badges
    const tableLines = renderTable({
      prs: filteredPRs,
      selectedIndex: selectedRow,
      width: layout.width,
      height: layout.bodyHeight,
      currentUser: data.currentUser,
      workers: data.workers,
      spinnerTick,
    });
    for (let i = 0; i < layout.bodyHeight; i++) {
      allLines.push(tableLines[i] || padEndVisual('', layout.width));
    }

    // 5. Divider & Footer
    allLines.push(renderDivider(layout.width));

    const currentChosenAgent = availableAgents[selectedAgentIndex] || (selectedPR ? getRepoAgent(data, selectedPR.key) : data.settings?.defaultAgent) || 'claude';

    const footerContext: FooterContext = {
      mode: footerMode,
      selectedPR,
      inputBuffer,
      selectedAgent: currentChosenAgent,
      availableAgents,
      message: statusMessage,
    };
    allLines.push(renderFooter(footerContext, Math.max(10, layout.width - 2)));

    // 6. Details Pop-up Modal Overlay (if open)
    // Anchored directly over the PR table body (below the banner & search bar)
    if (isDetailsModalOpen && selectedPR && !isSettingsModalOpen && !isDiffModalOpen && !isLogsModalOpen) {
      const headerOffset = bannerLines.length + 4; // stats(1) + div(1) + search(1) + div(1) = 9 lines
      const modalHeight = Math.max(6, layout.bodyHeight);
      const isSmallScreen = layout.width < 90;
      const widthRatio = isSmallScreen ? 0.96 : 0.90;
      const modalWidth = Math.max(20, Math.min(layout.width - 2, Math.floor(layout.width * widthRatio)));

      const modalLines = renderDetailsModal({
        pr: selectedPR,
        modalWidth,
        modalHeight,
        scrollOffset: detailsScrollOffset,
        spinnerTick,
      });

      const xStart = Math.max(0, Math.floor((layout.width - modalWidth) / 2));
      const leftPad = ' '.repeat(xStart);
      const rightPad = ' '.repeat(Math.max(0, layout.width - xStart - modalWidth));

      for (let r = 0; r < modalLines.length; r++) {
        const lineIdx = headerOffset + r;
        if (lineIdx < allLines.length - 2) {
          allLines[lineIdx] = `${leftPad}${modalLines[r]}${rightPad}`;
        }
      }
    }

    // 7. Settings Pop-up Modal Overlay (if open)
    if (isSettingsModalOpen) {
      const headerOffset = bannerLines.length + 4;
      const modalHeight = Math.max(8, layout.bodyHeight);
      const isSmallScreen = layout.width < 90;
      const widthRatio = isSmallScreen ? 0.96 : 0.90;
      const modalWidth = Math.max(20, Math.min(layout.width - 2, Math.floor(layout.width * widthRatio)));

      const modalLines = renderSettingsModal({
        state: data,
        selectedIndex: settingsIndex,
        isEditingText: isEditingSetting,
        editBuffer: settingInputBuffer,
        modalWidth,
        modalHeight,
      });

      const xStart = Math.max(0, Math.floor((layout.width - modalWidth) / 2));
      const leftPad = ' '.repeat(xStart);
      const rightPad = ' '.repeat(Math.max(0, layout.width - xStart - modalWidth));

      for (let r = 0; r < modalLines.length; r++) {
        const lineIdx = headerOffset + r;
        if (lineIdx < allLines.length - 2) {
          allLines[lineIdx] = `${leftPad}${modalLines[r]}${rightPad}`;
        }
      }
    }

    // 8. Diff Pop-up Modal Overlay (if open)
    if (isDiffModalOpen && selectedPR && !isSettingsModalOpen && !isLogsModalOpen) {
      const headerOffset = bannerLines.length + 4;
      const modalHeight = Math.max(6, layout.bodyHeight);
      const isSmallScreen = layout.width < 90;
      const widthRatio = isSmallScreen ? 0.96 : 0.90;
      const modalWidth = Math.max(20, Math.min(layout.width - 2, Math.floor(layout.width * widthRatio)));

      const modalLines = renderDiffModal({
        pr: selectedPR,
        diffText: diffContent,
        isLoading: diffLoading,
        modalWidth,
        modalHeight,
        scrollOffset: diffScrollOffset,
        spinnerTick,
      });

      const xStart = Math.max(0, Math.floor((layout.width - modalWidth) / 2));
      const leftPad = ' '.repeat(xStart);
      const rightPad = ' '.repeat(Math.max(0, layout.width - xStart - modalWidth));

      for (let r = 0; r < modalLines.length; r++) {
        const lineIdx = headerOffset + r;
        if (lineIdx < allLines.length - 2) {
          allLines[lineIdx] = `${leftPad}${modalLines[r]}${rightPad}`;
        }
      }
    }

    // 9. Logs Pop-up Modal Overlay (if open)
    if (isLogsModalOpen && selectedPR && !isSettingsModalOpen) {
      const headerOffset = bannerLines.length + 4;
      const modalHeight = Math.max(6, layout.bodyHeight);
      const isSmallScreen = layout.width < 90;
      const widthRatio = isSmallScreen ? 0.96 : 0.90;
      const modalWidth = Math.max(20, Math.min(layout.width - 2, Math.floor(layout.width * widthRatio)));

      const worker = data.workers?.get(prKeyToString(selectedPR.key)) || null;
      const logLines = loadPRLogFile(selectedPR);

      const modalLines = renderLogsModal({
        pr: selectedPR,
        worker,
        logLines,
        modalWidth,
        modalHeight,
        scrollOffset: logsScrollOffset,
        spinnerTick,
      });

      const xStart = Math.max(0, Math.floor((layout.width - modalWidth) / 2));
      const leftPad = ' '.repeat(xStart);
      const rightPad = ' '.repeat(Math.max(0, layout.width - xStart - modalWidth));

      for (let r = 0; r < modalLines.length; r++) {
        const lineIdx = headerOffset + r;
        if (lineIdx < allLines.length - 2) {
          allLines[lineIdx] = `${leftPad}${modalLines[r]}${rightPad}`;
        }
      }
    }

    // Assemble buffer: strictly bounded to layout.height to prevent terminal auto-scroll / top logo cutoff
    let buffer = '\x1B[H\x1B[?25l';
    const linesToOutput = allLines.slice(0, layout.height);
    for (let i = 0; i < linesToOutput.length; i++) {
      buffer += linesToOutput[i] + '\x1B[K' + (i < linesToOutput.length - 1 ? '\n' : '');
    }
    buffer += '\x1B[J';

    process.stdout.write(buffer);
  }

  // Handle terminal window resize
  const onResize = () => {
    render();
  };
  process.stdout.on('resize', onResize);

  // Stdin Keyboard & Mouse Handling
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (chunk: string) => {
      const key = chunk;

      // Handle Mouse Scroll in Warp / iTerm (SGR mouse mode \x1b[<64;... or \x1b[<65;...)
      if (key.startsWith('\x1b[<64;') || key.startsWith('\x1b[<65;')) {
        if (isLogsModalOpen) {
          if (key.startsWith('\x1b[<64;')) {
            logsScrollOffset = Math.max(0, logsScrollOffset - 1);
          } else {
            logsScrollOffset++;
          }
          render();
          return;
        }

        if (isDiffModalOpen) {
          if (key.startsWith('\x1b[<64;')) {
            diffScrollOffset = Math.max(0, diffScrollOffset - 1);
          } else {
            diffScrollOffset++;
          }
          render();
          return;
        }

        if (isDetailsModalOpen) {
          if (key.startsWith('\x1b[<64;')) {
            detailsScrollOffset = Math.max(0, detailsScrollOffset - 1);
          } else {
            detailsScrollOffset++;
          }
          render();
          return;
        }

        const prs = getFilteredPRs();
        if (key.startsWith('\x1b[<64;')) {
          // Mouse Wheel Up
          selectedRow = Math.max(0, selectedRow - 1);
        } else {
          // Mouse Wheel Down
          selectedRow = Math.min(Math.max(0, prs.length - 1), selectedRow + 1);
        }
        render();
        return;
      }

      // Clear one-time status message on any key
      if (statusMessage) {
        statusMessage = undefined;
        render();
        return;
      }

      // Universal Quit
      if (key === '\x03') { // Ctrl+C
        exitAltScreen();
        onQuit();
        return;
      }

      // Handle Settings Modal Keyboard Events
      if (isSettingsModalOpen) {
        if (isEditingSetting) {
          if (key === '\x1b') { // Esc cancels text edit
            isEditingSetting = false;
            settingInputBuffer = '';
            render();
            return;
          }
          if (key === '\x0d') { // Enter saves text edit
            const item = SETTINGS_ITEMS[settingsIndex];
            if (item.id === 'searchQuery') {
              data.settings.searchQuery = settingInputBuffer.trim();
            } else if (item.id === 'streamdeckPort') {
              const portNum = parseInt(settingInputBuffer.trim(), 10);
              if (!isNaN(portNum) && portNum > 0 && portNum < 65536) {
                data.extensions.streamdeck.port = portNum;
              }
            }
            isEditingSetting = false;
            settingInputBuffer = '';
            saveState(data);
            options?.onSettingsChange?.();
            render();
            return;
          }
          if (key === '\x7f' || key === '\x08') { // Backspace
            settingInputBuffer = settingInputBuffer.slice(0, -1);
            render();
            return;
          }
          if (key.length === 1 && key >= ' ') {
            settingInputBuffer += key;
            render();
            return;
          }
          return;
        }

        // Not in text edit mode:
        if (key === '\x1b' || key === 'q' || key === 'Q') { // Esc / q closes settings
          isSettingsModalOpen = false;
          saveState(data);
          options?.onSettingsChange?.();
          render();
          return;
        }

        if (key === '\x1b[A' || key === 'k' || key === '\x1bOA') { // Up
          settingsIndex = (settingsIndex - 1 + SETTINGS_ITEMS.length) % SETTINGS_ITEMS.length;
          render();
          return;
        }

        if (key === '\x1b[B' || key === 'j' || key === '\x1bOB') { // Down
          settingsIndex = (settingsIndex + 1) % SETTINGS_ITEMS.length;
          render();
          return;
        }

        const item = SETTINGS_ITEMS[settingsIndex];

        if (key === '\x0d' && (item.id === 'searchQuery' || item.id === 'streamdeckPort')) { // Enter to edit text
          isEditingSetting = true;
          settingInputBuffer = item.id === 'searchQuery'
            ? data.settings.searchQuery
            : String(data.extensions.streamdeck.port);
          render();
          return;
        }

        if (key === '\x0d' || key === ' ' || key === '\x1b[C' || key === '\x1b[D') { // Cycle / toggle
          const isForward = key !== '\x1b[D';
          if (item.id === 'defaultAgent') {
            const agents = getAvailableAgents(data);
            const curIdx = agents.indexOf(data.settings.defaultAgent || 'claude');
            const nextIdx = isForward
              ? (curIdx + 1) % agents.length
              : (curIdx - 1 + agents.length) % agents.length;
            data.settings.defaultAgent = agents[nextIdx];
          } else if (item.id === 'pollInterval') {
            const curIdx = POLL_INTERVALS.indexOf(data.settings.pollIntervalSecs || 30);
            const nextIdx = isForward
              ? (curIdx + 1) % POLL_INTERVALS.length
              : (curIdx - 1 + POLL_INTERVALS.length) % POLL_INTERVALS.length;
            data.settings.pollIntervalSecs = POLL_INTERVALS[nextIdx >= 0 ? nextIdx : 1];
          } else if (item.id === 'filterUserOnly') {
            data.settings.filterUserOnly = !data.settings.filterUserOnly;
          } else if (item.id === 'dryRun') {
            data.settings.dryRun = !data.settings.dryRun;
            data.dryRun = data.settings.dryRun;
          } else if (item.id === 'streamdeckEnabled') {
            data.extensions.streamdeck.enabled = !data.extensions.streamdeck.enabled;
            options?.onSettingsChange?.();
          }
          saveState(data);
          render();
          return;
        }
        return;
      }

      // Handle Details Pop-up Modal Keyboard Actions
      if (isDetailsModalOpen) {
        if (key === '\x1b' || key === '\x0d' || key === 'q' || key === 'Q') { // Esc, Enter, or q closes modal
          isDetailsModalOpen = false;
          detailsScrollOffset = 0;
          render();
          return;
        }

        if (key === '\x1b[A' || key === 'k' || key === '\x1bOA') { // Scroll Up
          detailsScrollOffset = Math.max(0, detailsScrollOffset - 1);
          render();
          return;
        }

        if (key === '\x1b[B' || key === 'j' || key === '\x1bOB') { // Scroll Down
          detailsScrollOffset++;
          render();
          return;
        }

        if (key === '\x1b[5~') { // Page Up
          detailsScrollOffset = Math.max(0, detailsScrollOffset - 5);
          render();
          return;
        }

        if (key === '\x1b[6~') { // Page Down
          detailsScrollOffset += 5;
          render();
          return;
        }

        if (key === 'o') { // Open in browser
          onAction('open', { pr: getSelectedPR() });
          return;
        }

        if (key === 'm') { // Merge from modal
          const pr = getSelectedPR();
          if (pr) {
            isDetailsModalOpen = false;
            footerMode = 'CONFIRM_MERGE';
            render();
          }
          return;
        }

        if (key === 'a') { // Agent from modal
          const pr = getSelectedPR();
          if (pr) {
            isDetailsModalOpen = false;
            availableAgents = getAvailableAgents(data);
            const currentAgent = getRepoAgent(data, pr.key);
            selectedAgentIndex = Math.max(0, availableAgents.indexOf(currentAgent));
            footerMode = 'AGENT_SELECT';
            render();
          }
          return;
        }

        if (key === 'c') { // Comment from modal
          const pr = getSelectedPR();
          if (pr) {
            isDetailsModalOpen = false;
            footerMode = 'COMMENT_INPUT';
            inputBuffer = '';
            render();
          }
          return;
        }

        if (key === 'd') { // Diff from modal
          openDiffForSelectedPR();
          return;
        }

        if (key === 'l' || key === 'L') { // Logs from modal
          openLogsForSelectedPR();
          return;
        }

        if (key === 'x') { // Close PR from modal
          const pr = getSelectedPR();
          if (pr) {
            isDetailsModalOpen = false;
            footerMode = 'CONFIRM_CLOSE';
            render();
          }
          return;
        }

        return;
      }

      // Handle Diff Pop-up Modal Keyboard Actions
      if (isDiffModalOpen) {
        if (key === '\x1b' || key === 'q' || key === 'Q' || key === 'd') { // Esc, q, or d closes modal
          isDiffModalOpen = false;
          diffScrollOffset = 0;
          render();
          return;
        }

        if (key === '\x1b[A' || key === 'k' || key === '\x1bOA') { // Scroll Up
          diffScrollOffset = Math.max(0, diffScrollOffset - 1);
          render();
          return;
        }

        if (key === '\x1b[B' || key === 'j' || key === '\x1bOB') { // Scroll Down
          diffScrollOffset++;
          render();
          return;
        }

        if (key === '\x1b[5~' || key === 'u') { // Page Up
          diffScrollOffset = Math.max(0, diffScrollOffset - 10);
          render();
          return;
        }

        if (key === '\x1b[6~' || key === 'f') { // Page Down
          diffScrollOffset += 10;
          render();
          return;
        }

        if (key === 'g') { // Jump to Top
          diffScrollOffset = 0;
          render();
          return;
        }

        if (key === 'G') { // Jump to Bottom
          if (diffContent) {
            const linesCount = diffContent.split('\n').length;
            diffScrollOffset = Math.max(0, linesCount - 10);
          }
          render();
          return;
        }

        if (key === 'n' || key === ']') { // Next changed file
          if (diffContent) {
            const parsed = parseAndColorizeDiff(diffContent, process.stdout.columns || 80);
            const nextOffset = parsed.fileOffsets.find((off) => off > diffScrollOffset);
            if (nextOffset !== undefined) {
              diffScrollOffset = nextOffset;
              render();
            }
          }
          return;
        }

        if (key === 'p' || key === '[') { // Previous changed file
          if (diffContent) {
            const parsed = parseAndColorizeDiff(diffContent, process.stdout.columns || 80);
            const prevOffsets = parsed.fileOffsets.filter((off) => off < diffScrollOffset);
            if (prevOffsets.length > 0) {
              diffScrollOffset = prevOffsets[prevOffsets.length - 1];
              render();
            } else {
              diffScrollOffset = 0;
              render();
            }
          }
          return;
        }

        if (key === 'o') { // Open in browser
          onAction('open', { pr: getSelectedPR() });
          return;
        }

        if (key === 'm') { // Merge from diff modal
          const pr = getSelectedPR();
          if (pr) {
            isDiffModalOpen = false;
            footerMode = 'CONFIRM_MERGE';
            render();
          }
          return;
        }

        if (key === 'a') { // Agent from diff modal
          const pr = getSelectedPR();
          if (pr) {
            isDiffModalOpen = false;
            availableAgents = getAvailableAgents(data);
            const currentAgent = getRepoAgent(data, pr.key);
            selectedAgentIndex = Math.max(0, availableAgents.indexOf(currentAgent));
            footerMode = 'AGENT_SELECT';
            render();
          }
          return;
        }

        if (key === 'c') { // Comment from diff modal
          const pr = getSelectedPR();
          if (pr) {
            isDiffModalOpen = false;
            footerMode = 'COMMENT_INPUT';
            inputBuffer = '';
            render();
          }
          return;
        }

        if (key === 'l' || key === 'L') { // Logs from diff modal
          openLogsForSelectedPR();
          return;
        }

        if (key === 'x') { // Close PR from diff modal
          const pr = getSelectedPR();
          if (pr) {
            isDiffModalOpen = false;
            footerMode = 'CONFIRM_CLOSE';
            render();
          }
          return;
        }

        return;
      }

      // Handle Agent Logs Pop-up Modal Keyboard Actions
      if (isLogsModalOpen) {
        if (key === '\x1b' || key === 'q' || key === 'Q' || key === 'l' || key === 'L') { // Esc, q, or L closes modal
          isLogsModalOpen = false;
          logsScrollOffset = 0;
          render();
          return;
        }

        if (key === '\x1b[A' || key === 'k' || key === '\x1bOA') { // Scroll Up
          logsScrollOffset = Math.max(0, logsScrollOffset - 1);
          render();
          return;
        }

        if (key === '\x1b[B' || key === 'j' || key === '\x1bOB') { // Scroll Down
          logsScrollOffset++;
          render();
          return;
        }

        if (key === '\x1b[5~' || key === 'u') { // Page Up
          logsScrollOffset = Math.max(0, logsScrollOffset - 10);
          render();
          return;
        }

        if (key === '\x1b[6~' || key === 'f') { // Page Down
          logsScrollOffset += 10;
          render();
          return;
        }

        if (key === 'g') { // Jump to Top
          logsScrollOffset = 0;
          render();
          return;
        }

        if (key === 'G') { // Jump to Bottom
          const pr = getSelectedPR();
          if (pr) {
            const logLines = loadPRLogFile(pr);
            const bodyHeight = Math.max(2, calculateLayout(process.stdout.columns, process.stdout.rows).bodyHeight - 2);
            logsScrollOffset = Math.max(0, logLines.length - bodyHeight);
          }
          render();
          return;
        }

        if (key === 'a') { // Dispatch new Agent from logs modal
          const pr = getSelectedPR();
          if (pr) {
            isLogsModalOpen = false;
            availableAgents = getAvailableAgents(data);
            const currentAgent = getRepoAgent(data, pr.key);
            selectedAgentIndex = Math.max(0, availableAgents.indexOf(currentAgent));
            footerMode = 'AGENT_SELECT';
            render();
          }
          return;
        }

        if (key === 'm') { // Merge from logs modal
          const pr = getSelectedPR();
          if (pr) {
            isLogsModalOpen = false;
            footerMode = 'CONFIRM_MERGE';
            render();
          }
          return;
        }

        if (key === 'o') { // Open in browser
          onAction('open', { pr: getSelectedPR() });
          return;
        }

        return;
      }

      // Handle Agent Selection Mode (AGENT_SELECT)
      if (footerMode === 'AGENT_SELECT') {
        const pr = getSelectedPR();
        availableAgents = getAvailableAgents(data);

        if (key === '\x1b') { // Esc cancels
          footerMode = 'NORMAL';
          render();
          return;
        }

        // Direct number key selection
        const num = parseInt(key, 10);
        if (!isNaN(num) && num >= 1 && num <= availableAgents.length) {
          selectedAgentIndex = num - 1;
          render();
          return;
        }

        if (key === '\x1b[D' || key === 'h') { // Left
          selectedAgentIndex = (selectedAgentIndex - 1 + availableAgents.length) % availableAgents.length;
          render();
          return;
        }

        if (key === '\x1b[C' || key === 'l' || key === '\t') { // Right or Tab
          selectedAgentIndex = (selectedAgentIndex + 1) % availableAgents.length;
          render();
          return;
        }

        if (key === '\x0d') { // Enter confirms selection, persists to repo, and opens prompt input
          const chosenAgent = availableAgents[selectedAgentIndex] || 'claude';
          if (pr) {
            const currentRepoAgent = getRepoAgent(data, pr.key);
            if (chosenAgent !== currentRepoAgent) {
              setRepoAgent(data, pr.key, chosenAgent);
              saveState(data);
            }
          }
          footerMode = 'AGENT_INPUT';
          inputBuffer = '';
          render();
          return;
        }
        return;
      }

      // Handle Text Input Modals (SEARCH, COMMENT_INPUT, AGENT_INPUT)
      if (footerMode === 'SEARCH' || footerMode === 'COMMENT_INPUT' || footerMode === 'AGENT_INPUT') {
        if (key === '\x1b') { // Escape
          if (footerMode === 'SEARCH') {
            searchQuery = '';
          }
          if (footerMode === 'AGENT_INPUT') {
            footerMode = 'AGENT_SELECT';
            render();
            return;
          }
          footerMode = 'NORMAL';
          inputBuffer = '';
          render();
          return;
        }

        if (key === '\x0d') { // Enter
          const currentMode = footerMode;
          const val = inputBuffer.trim();
          footerMode = 'NORMAL';
          inputBuffer = '';

          if (currentMode === 'SEARCH') {
            searchQuery = val;
          } else if (currentMode === 'COMMENT_INPUT') {
            if (val) {
              onAction('comment', { text: val, pr: getSelectedPR() });
            }
          } else if (currentMode === 'AGENT_INPUT') {
            const chosenAgent = availableAgents[selectedAgentIndex] || 'claude';
            onAction('agent', { prompt: val, pr: getSelectedPR(), agentName: chosenAgent });
          }

          render();
          return;
        }

        if (key === '\x7f' || key === '\x08') { // Backspace
          inputBuffer = inputBuffer.slice(0, -1);
          if (footerMode === 'SEARCH') {
            searchQuery = inputBuffer;
          }
          render();
          return;
        }

        // Standard character typing
        if (key.length === 1 && key >= ' ') {
          inputBuffer += key;
          if (footerMode === 'SEARCH') {
            searchQuery = inputBuffer;
          }
          render();
          return;
        }

        return;
      }

      // Handle Confirmation Modals (CONFIRM_MERGE, CONFIRM_CLOSE)
      if (footerMode === 'CONFIRM_MERGE' || footerMode === 'CONFIRM_CLOSE') {
        const currentMode = footerMode;
        if (key === 'y' || key === 'Y') {
          footerMode = 'NORMAL';
          if (currentMode === 'CONFIRM_MERGE') {
            onAction('merge', { pr: getSelectedPR() });
          } else if (currentMode === 'CONFIRM_CLOSE') {
            onAction('close', { pr: getSelectedPR() });
          }
          render();
          return;
        }

        if (key === 'n' || key === 'N' || key === '\x1b') {
          footerMode = 'NORMAL';
          render();
          return;
        }

        return;
      }

      // Normal Navigation & Command Mode
      if (key === 'q') {
        exitAltScreen();
        onQuit();
        return;
      }

      if (key === 's') { // Settings Modal
        isSettingsModalOpen = true;
        isDetailsModalOpen = false;
        settingsIndex = 0;
        isEditingSetting = false;
        settingInputBuffer = '';
        render();
        return;
      }

      if (key === '/' || key === 'f') {
        footerMode = 'SEARCH';
        inputBuffer = searchQuery;
        render();
        return;
      }

      if (key === '\x1b') { // Escape clears search
        if (searchQuery) {
          searchQuery = '';
          selectedRow = 0;
          render();
          return;
        }
      }

      if (key === '\x1b[A' || key === 'k' || key === '\x1bOA') { // Up
        selectedRow = Math.max(0, selectedRow - 1);
        render();
        return;
      }

      if (key === '\x1b[B' || key === 'j' || key === '\x1bOB') { // Down
        const prs = getFilteredPRs();
        selectedRow = Math.min(Math.max(0, prs.length - 1), selectedRow + 1);
        render();
        return;
      }

      if (key === 'g') { // Top
        selectedRow = 0;
        render();
        return;
      }

      if (key === 'G') { // Bottom
        const prs = getFilteredPRs();
        selectedRow = Math.max(0, prs.length - 1);
        render();
        return;
      }

      if (key === '\x0d' || key === 'v') { // Enter or v: Open details pop-up modal
        const pr = getSelectedPR();
        if (pr) {
          isDetailsModalOpen = true;
          detailsScrollOffset = 0;
          render();
        }
        return;
      }

      if (key === 'o') { // Open in browser
        onAction('open', { pr: getSelectedPR() });
        return;
      }

      if (key === 'm') { // Merge
        const pr = getSelectedPR();
        if (pr) {
          footerMode = 'CONFIRM_MERGE';
          render();
        }
        return;
      }

      if (key === 'x') { // Close PR
        const pr = getSelectedPR();
        if (pr) {
          footerMode = 'CONFIRM_CLOSE';
          render();
        }
        return;
      }

      if (key === 'c') { // Comment
        const pr = getSelectedPR();
        if (pr) {
          footerMode = 'COMMENT_INPUT';
          inputBuffer = '';
          render();
        }
        return;
      }

      if (key === 'a') { // Agent - Step 1 Agent Picker
        const pr = getSelectedPR();
        if (pr) {
          availableAgents = getAvailableAgents(data);
          const currentAgent = getRepoAgent(data, pr.key);
          selectedAgentIndex = Math.max(0, availableAgents.indexOf(currentAgent));
          footerMode = 'AGENT_SELECT';
          render();
        }
        return;
      }

      if (key === 'd') { // Diff
        openDiffForSelectedPR();
        return;
      }

      if (key === 'l' || key === 'L') { // Agent Logs
        openLogsForSelectedPR();
        return;
      }

      if (key === 'R') { // Recheck
        onAction('recheck');
        return;
      }
    });
  }

  // Initial render
  render();

  return {
    destroy: () => {
      clearInterval(animationTimer);
      process.stdout.removeListener('resize', onResize);
      exitAltScreen();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    },
    render,
    showMessage: (msg: string) => {
      statusMessage = msg;
      render();
    },
    getSelectedPR,
  };
}
