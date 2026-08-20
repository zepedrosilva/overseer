# Overseer 👁️

[![CI](https://github.com/zepedrosilva/overseer/actions/workflows/ci.yml/badge.svg)](https://github.com/zepedrosilva/overseer/actions/workflows/ci.yml)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Overseer** is a blazing-fast, terminal-based monitoring and management dashboard for GitHub Pull Requests. It monitors PRs across dozens of repositories in real-time, displays code review & CI/Check Run statuses in a responsive full-width table, and provides an interactive pop-up details modal alongside instant keyboard actions to merge, comment, review diffs, open in browser, or dispatch AI agents in isolated git worktrees.

---

## ✨ Features

- **🌐 Zero-Config Architecture**: Works out of the box with pure code-based defaults. No mandatory configuration files or complex setups required.
- **⚡ Real-Time Multi-Repo Polling**: High-performance GraphQL polling (`gh api graphql`) with automated resilience, parallel batched team queries, and automatic fallback across all repositories involving you.
- **📊 90-Day Velocity & Team Leaderboard (<kbd>p</kbd>)**: Trailing 30-day velocity metrics with embedded 60d/90d baseline trend indicators, stack-ranked team leaderboard with dynamic sorting (<kbd>s</kbd>), and high-throughput concurrent 90d backfill (<kbd>b</kbd>).
- **🔍 Comprehensive Status Triage**: Combines code review verdicts (*Approved, Changes Requested, In Review, No Review*) and CI check runs (*Passing, Failing, Pending*) into unified health indicators.
- **⚙️ Live Settings & Extensions Modal (<kbd>s</kbd>)**: Interactively adjust default agents, polling intervals, search queries, dry-run mode, and toggle the Stream Deck server on the fly with live state persistence.
- **📄 Interactive Diff Pop-Up Modal (<kbd>d</kbd>)**: View syntax-colorized git diffs directly inside a modal window without leaving the dashboard, with fast file jumping (<kbd>n</kbd>/<kbd>p</kbd>) and in-memory caching.
- **📜 Live Agent Logs Pop-Up Modal (<kbd>L</kbd>)**: Non-blocking background worker execution! Browse and action other PRs freely while table rows display animated worker spinners (e.g. `⠋ claude 2m`), and press <kbd>L</kbd> on any PR anytime to inspect live or historical logs.
- **🤖 2-Step Agent Selection (<kbd>a</kbd>)**: Select and persist AI agents per repository (`claude`, `agy`, `gemini`, `pi`, or custom agents) with instant `<Enter>` confirmation, followed by optional custom prompt execution in isolated worktrees.
- **🖥️ Flicker-Free Terminal UI**: Built with a custom ANSI engine using the Alternate Screen Buffer (`\x1b[?1049h`), responsive full-width tables, and interactive pop-up modals that adapt to small and wide windows.
- **⌨️ Interactive Keyboard Actions**:
  - `[Enter]` / `[v]` Open interactive pop-up details modal (scrollable CI checks, reviews, and logs)
  - `[s]` Open Settings & Extensions modal
  - `[d]` Open syntax-colorized Diff pop-up modal
  - `[L]` Open live/historical Agent Logs modal
  - `[o]` Open PR in browser
  - `[m]` Merge PR (squash & delete branch with confirmation)
  - `[a]` Select and dispatch AI Agent in isolated local worktree
  - `[c]` Post review comments
  - `[x]` Close PR
  - `[R]` Refresh / recheck immediately
  - `[/]` Real-time fuzzy filter & search
- **🔒 Zero Token Storage**: Relies 100% on the official GitHub CLI (`gh auth login`) — no personal access tokens stored on disk.
- **📦 Clean Workspace Hygiene**: All persistent state, temporary worktrees, and logs live inside a gitignored `./.overseer/` directory.
- **🎛️ Stream Deck Extension**: Built-in HTTP and Server-Sent Events (SSE) server for physical button displays and control, dynamically togglable from the UI or CLI.

---

## 📸 Terminal Interface Preview

### Main Dashboard View
```text
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                                        │
│  ██████╗  ██╗   ██╗ ███████╗ ██████╗  ███████╗ ███████╗ ███████╗ ██████╗  v3                           │
│ ██╔═══██╗ ██║   ██║ ██╔════╝ ██╔══██╗ ██╔════╝ ██╔════╝ ██╔════╝ ██╔══██╗                             │
│ ██║   ██║ ╚██╗ ██╔╝ █████╗   ██████╔╝ ███████╗ █████╗   █████╗   ██████╔╝                             │
│ ╚██████╔╝  ╚████╔╝  ███████╗ ██║  ██╗ ╚════██║ ███████╗ ███████╗ ██║  ██╗                             │
│  User: @alice  Repos: 32  Open PRs: 18  ● 4 Needs Attention  Last Poll: 16:42:15                   │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  [Tab / t]  [1] ● Mine (3)    [2] ○ Team: core-platform (8)                                            │
│  › Filter PRs (press / to search)                                                                      │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  REPO           #     BRANCH             TITLE                               STATUS    CI   REV      AGE   │
│── 🏢 acme-corp (3) ────────────────────────────────────────────────────────────────────────────────────│
│▎ web-frontend  #142  fix/inv-rounding   fix: resolve invoice balance round… 🟢 Ready   ✔   ✔ 2/2    1h    │
│  api-gateway   #88   feat/auth-v3       feat: upgrade authentication flow   🔴 Needs   ✖   ✖ 0/1    3h    │
│  docs-site     #12   docs/api-guide     docs: update webhook architecture   🟡 Revw    ⏳   ⏳1/2    1d    │
│── 👤 octocat (1) ──────────────────────────────────────────────────────────────────────────────────────│
│  overseer      #1    feat/initial-code… feat: Overseer initial release      🟢 Ready   ✔   ✔ 1      10m   │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  [Enter]details  [Tab]scope  [p]stats  [s]settings  [o]open  [m]merge  [a]agent  [d]diff  [q]quit          │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Interactive Diff Pop-up Modal (Press <kbd>d</kbd>)
```text
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ┌─ Diff: acme-corp/web-frontend#142 (fix/inv-rounding) ──────────── [Esc to close] ─┐                 │
│  │ ───  [File 1/2]  src/billing/rounding.ts ──────────────────────────────────────── │                 │
│  │ index 1234567..89abcdef 100644                                                    │                 │
│  │ --- a/src/billing/rounding.ts                                                     │                 │
│  │ +++ b/src/billing/rounding.ts                                                     │                 │
│  │ @@ -42,6 +42,8 @@ export function roundTax(val: number): number {                 │                 │
│  │ -  return Math.round(val * 100) / 100;                                            │                 │
│  │ +  const scale = getCurrencyScale(currency);                                      │                 │
│  │ +  return Number(val.toFixed(scale));                                             │                 │
│  │  }                                                                                │                 │
│  │ ───  [File 2/2]  test/rounding.test.ts ────────────────────────────────────────── │                 │
│  │ @@ -10,3 +10,5 @@ describe('rounding', () => {                                     │                 │
│  │ +  it('handles multi-currency precision correctly', () => {                       │                 │
│  │ +    expect(roundTax(12.3456)).toBe(12.35);                                       │                 │
│  │    });                                                                            │                 │
│  └─ [n/p] file  [j/k] scroll  [o] open  [m] merge  [a] agent  [c] comment ── [1/42 L] ─┘                 │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  [Enter]details  [s]settings  [o]open  [m]merge  [a]agent  [c]comment  [d]diff  [x]close  [R]recheck  [q]  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
### Interactive Stats & Velocity Modal (Press <kbd>p</kbd>)
```text
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ┌─ PR Stats & Leaderboard: Team: core-platform (30d trailing) ─────── [Esc to close] ─┐                 │
│  │ Scope: [Tab/t] ○ Mine  ● Team: core-platform    Leaderboard Sort: [s] ● 30d Merged PRs             │ │
│  ├──────────────────────────────────────────────────────────────────────────────────────────────────┤ │
│  │ 📦 Code Volume & Merged PR History (90d baseline)                                                 │ │
│  │   • Merged PRs:  48 (30d)  ▲ +12 vs 60d baseline  │  Avg Size: 240 lines                          │ │
│  │   • Total Volume: 30d: 48 merged  •  60d: 84 merged  •  90d: 120 merged                           │ │
│  ├──────────────────────────────────────────────────────────────────────────────────────────────────┤ │
│  │ ⏱️ Velocity & Review Turnaround                                                                    │ │
│  │   • Median Time to First Review: 4.2h      • Median Time to Merge: 1.5d                           │ │
│  │   • CI Pass Rate:                98% (120/122 runs)   • Discussion Density:   2.4 cmts/PR         │ │
│  ├──────────────────────────────────────────────────────────────────────────────────────────────────┤ │
│  │ 👥 Team Member Leaderboard (Ranked by 30d Merged PRs)                                             │ │
│  │   RANK  MEMBER                    30d   60d   90d  OPEN CLOSED  TOTAL  CMTS/PR  STALE             │ │
│  │   #1    Alice Walker (@alice)      18    32    45     2      1     21      2.1      0             │ │
│  │   #2    Bob Dylan (@bob)           15    28    40     1      0     16      1.8      0             │ │
│  │   #3    Charlie Day (@charlie)     10    16    24     3      2     15      3.4      1             │ │
│  │   #4    Diana Prince (@diana)       5     8    11     0      1      6      1.2      0             │ │
│  ├──────────────────────────────────────────────────────────────────────────────────────────────────┤ │
│  │ ⚠️ Bottlenecks Requiring Attention (>3d pending)                                                  │ │
│  │   • acme-corp/web-frontend#142 (5d pending — CI failing)                                          │ │
│  └─ [Tab] scope  [s] sort  [b] backfill  [Esc/p] close ────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  [Enter]details  [Tab]scope  [p]stats  [s]settings  [o]open  [m]merge  [a]agent  [d]diff  [q]quit          │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Prerequisites

1. **Node.js**: `v22.0.0` or higher.
2. **GitHub CLI (`gh`)**: Installed and authenticated.
   ```bash
   gh auth login
   ```

---

## 📥 Installation & Running

```bash
# 1. Clone repo
git clone https://github.com/zepedrosilva/overseer.git
cd overseer

# 2. Install dependencies & build
npm install
npm run build

# 3. Launch Overseer (zero-config, launches immediately)
npm start
```

### Command-Line Options (CLI Flags)

All runtime settings and extensions can also be configured via CLI flags:

```bash
# Enable Stream Deck extension on startup
overseer --streamdeck --port 3210

# Set default agent to agy and poll every 15s
overseer --agent agy --poll 15

# Run in safe dry-run mode (no merges or comments executed)
overseer --dry-run

# Custom GitHub search query override
overseer --search "is:pr is:open org:mycompany"

# Reset persisted state in ./.overseer/state.json
overseer --reset-state
```

---

## 🎮 Keyboard Shortcuts

| Key | Action | Description |
|---|---|---|
| `Tab` / `t` | **Toggle Scope** | Switch instantly between **Mine** and **Team** monitoring scopes |
| `1` / `2` | **Switch Scope** | Select **[1] Mine** or **[2] Team** directly |
| `p` | **PR Stats & Leaderboard** | Open performance dashboard (trailing 30d/60d/90d historical metrics, stack-ranked team leaderboard with direct right-aligned numbers and [s] sorting) |
| `b` / `B` | **Backfill PR Stats** | Trigger on-demand historical stats backfill (defaults to 90d, with [1/2/3] timeframe keys) |
| `?` / `h` | **All Actions & Help** | Open comprehensive categorized actions modal |
| `↑` / `k` | **Navigate Up** | Move selection up in PR list |
| `↓` / `j` | **Navigate Down** | Move selection down in PR list |
| `Enter` / `v` | **View Details Modal** | Open centered pop-up window with CI checks, threads, agent status, and scrollable logs |
| `s` | **Settings & Extensions** | Open interactive settings modal to configure team slug, defaults, and extensions |
| `d` | **View Diff Modal** | Open syntax-colorized git diff in a pop-up window (with file jumping <kbd>n</kbd>/<kbd>p</kbd> and triage shortcuts) |
| `L` / `l` | **View Agent Logs** | Open real-time streaming or historical agent execution logs for the selected PR |
| `a` | **Trigger Agent (2-Step)** | Select/change repo agent with <kbd>1-N</kbd> or <kbd>←/→</kbd>, confirm with <kbd>Enter</kbd> (persists preference), then input prompt |
| `o` | **Open in Browser** | Open PR web page using `gh pr view --web` |
| `m` | **Merge PR** | Squash-merge PR and delete branch (prompts confirmation) |
| `c` | **Comment** | Post a review comment to the PR |
| `x` | **Close PR** | Close the pull request (prompts confirmation) |
| `R` | **Recheck** | Force an immediate poll & refresh |
| `/` or `f` | **Filter / Search** | Filter list by repo, PR #, branch, author, or title |
| `Escape` | **Clear / Dismiss** | Cancel search filter or dismiss active modal |
| `q` / `Ctrl+C` | **Quit** | Cleanly exit and restore terminal |

---

## 🤖 2-Step Agent Selection & Worktree Execution

When you press `[a]` on a selected PR:
1. **Step 1 (Agent Picker)**: Overseer shows the current assigned agent for that repository pre-selected (e.g. `● [1] claude  ○ [2] agy  ○ [3] pi ...`). Pressing <kbd>Enter</kbd> accepts it, or pressing <kbd>1-N</kbd> / <kbd>←/→</kbd> selects a different agent and automatically persists it to `./.overseer/state.json`.
2. **Step 2 (Prompt Entry)**: Input an optional custom prompt (e.g., `Fix typing error in billing controller`) and press <kbd>Enter</kbd>.
3. **Execution**: Overseer provisions an isolated git worktree inside `./.overseer/worktrees/<owner>-<repo>-<number>/`, checks out the PR branch, and dispatches the AI agent. Logs stream in real-time to the Details panel.

### 🧩 Custom Local Agents (`./.overseer/agents.json`)

You can define custom CLI agents or bot comment triggers locally in the gitignored `./.overseer/agents.json` file without modifying source code:

```json
{
  "customAgents": {
    "opencode": {
      "command": "opencode run --repo {owner}/{repo} --pr {pr} \"{prompt}\"",
      "description": "OpenCode autonomous agentic CLI"
    },
    "copilot": {
      "command": "gh pr comment {pr} --repo {owner}/{repo} --body \"/copilot {prompt}\"",
      "description": "GitHub Copilot PR comment trigger"
    }
  },
  "disabledAgents": ["pi"]
}
```

---

## 🎛️ Stream Deck Extension API

When the Stream Deck extension is enabled (via Settings modal <kbd>s</kbd> or `--streamdeck` flag), Overseer starts an HTTP and Server-Sent Events (SSE) server:

- **`GET /status`**: Overall health, monitored repos count, open PR count, needs attention count.
- **`GET /pr/:owner/:repo/:number`**: Detailed metadata, CI checks, and logs for a PR.
- **`POST /action/:type`**: Execute actions (`recheck`, `merge`, `agent`, `open`).
- **`GET /events`**: Real-time SSE stream of status changes and logs.

---

## 🛠️ Development & Testing

```bash
# Run unit tests
npm test

# Run tests in watch mode
npm run test:watch

# Type check
npm run typecheck

# Build TypeScript
npm run build
```

---

## 📄 License

MIT © [José Silva](https://github.com/zepedrosilva)

