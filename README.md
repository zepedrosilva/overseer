# Overseer 👁️

[![CI](https://github.com/zepedrosilva/overseer/actions/workflows/ci.yml/badge.svg)](https://github.com/zepedrosilva/overseer/actions/workflows/ci.yml)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Overseer** is a blazing-fast, terminal-based monitoring and management dashboard for GitHub Pull Requests. It monitors PRs across dozens of repositories in real-time, displays code review & CI/Check Run statuses in a responsive full-width table, and provides an interactive pop-up details modal alongside instant keyboard actions to merge, comment, review diffs, open in browser, or dispatch AI agents in isolated git worktrees.

---

## ✨ Features

- **🌐 Zero-Config Architecture**: Works out of the box with pure code-based defaults. No mandatory configuration files or complex setups required.
- **⚡ Real-Time Multi-Repo Polling**: High-performance GraphQL polling (`gh api graphql`) with automated resilience, parallel batched team queries, and automatic fallback across all repositories involving you.
- **🤖 Dedicated Agents Tab (<kbd>3</kbd>)**: Two-pane master/detail triage dashboard organizing active and historical PR workflows on the left with a sequential Git-style timeline stream (`┊`), live output tails, real-time worktree activity polling, and `⚡ Active Edits` tracking on the right.
- **📊 90-Day Velocity & Team Leaderboard (<kbd>p</kbd>)**: Context-aware 3-tab performance dashboard (`[1] Mine`, `[2] Team`, `[3] 🤖 Agents`) with trailing 30d/60d/90d historical metrics, stack-ranked team leaderboard with dynamic sorting (<kbd>s</kbd>), and high-throughput concurrent 90d backfill (<kbd>b</kbd>).
- **🔍 Comprehensive Status Triage**: Combines code review verdicts (*Approved, Changes Requested, In Review, No Review*) and CI check runs (*Passing, Failing, Pending*) into unified health indicators.
- **⚙️ Live Settings & Extensions Modal (<kbd>s</kbd>)**: Interactively adjust default agents, polling intervals, search queries, dry-run mode, and toggle the Local API server on the fly with live state persistence.
- **📄 Interactive Diff Pop-Up Modal (<kbd>d</kbd>)**: View syntax-colorized git diffs directly inside a modal window without leaving the dashboard, with fast file jumping (<kbd>n</kbd>/<kbd>p</kbd>) and in-memory caching.
- **📜 Live Agent Logs Pop-Up Modal (<kbd>L</kbd>)**: Non-blocking background worker execution! Browse and action other PRs freely while table rows display animated worker spinners (e.g. `⠋ claude 2m`), and press <kbd>L</kbd> on any PR anytime to inspect live or historical logs.
- **🤖 2-Step Agent Selection (<kbd>a</kbd>)**: Select and persist AI agents per repository (`claude`, `agy`, `gemini`, `pi`, or custom agents) with instant `<Enter>` confirmation, followed by optional custom prompt execution in isolated worktrees.
- **🖥️ Flicker-Free Terminal UI**: Built with a custom ANSI engine using the Alternate Screen Buffer (`\x1b[?1049h`), responsive full-width tables, and interactive pop-up modals that adapt to small and wide windows.
- **⌨️ Interactive Keyboard Actions**:
  - `[Enter]` / `[v]` Open interactive pop-up details modal (scrollable CI checks, reviews, and logs)
  - `[Tab]` / `[t]` Cycle through dashboard scopes (`Mine` -> `Team` -> `Agents`)
  - `[1] / [2] / [3]` Switch directly to **[1] Mine**, **[2] Team**, or **[3] Agents**
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
- **🔌 Local REST & SSE API**: Built-in HTTP and Server-Sent Events (SSE) server for external integrations, menu bar widgets, Raycast scripts, and hardware displays, dynamically togglable from the UI or CLI.

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
│  [Tab / t]  [1] ● Mine (3)    [2] ○ Team: core-platform (8)    [3] ○ 🤖 Agents (2)                     │
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

### Dedicated Agents Triage Dashboard (Press <kbd>3</kbd> or <kbd>Tab</kbd>)
```text
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  PR WORKFLOWS                     │  TIMELINE · #142 (acme-corp/web-frontend)                          │
│                                   │                                                                    │
│  ❯ acme-corp/web-frontend#142     │  ❯ ⠋ 🤖 agy · address-comments                                     │
│    ┊ fix/inv-rounding             │    ┊  Started: 14:40:00  Worktree: ./.overseer/worktrees/...           │
│    ┊ 🤖 agy · address-comments    │    ┊  ⚡ Active Edits (3 files): src/billing/tax.ts, test/...           │
│                                   │    ┊  [14:40:45] ⚡ File Activity: 3 file(s) modified                 │
│    acme-corp/api-gateway#88       │    ┊  Running 45s...                                               │
│    ┊ feat/auth-v3                 │    ┊                                                               │
│    ┊ 2 sessions                   │    ✔ 🤖 claude · preflight-review                                  │
│                                   │    ┊  Started: 14:35:10  Summary: Pre-flight review completed      │
│                                   │    ┊  Completed in 12s · Exit Code: 0                              │
└───────────────────────────────────┴────────────────────────────────────────────────────────────────────┘
```

### Interactive Stats & Velocity Modal (Press <kbd>p</kbd>)
```text
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ┌─ PR Stats & Velocity: [1] Mine  [2] ● Team  [3] 🤖 Agents ───────────────── [Esc to close] ─┐      │
│  ├──────────────────────────────────────────────────────────────────────────────────────────────┤      │
│  │ 📦 Code Volume & Merged PR History (90d baseline)                                            │      │
│  │   • Merged PRs:  48 (30d)  ▲ +12 vs 60d baseline  │  Avg Size: 240 lines                     │      │
│  │   • Total Volume: 30d: 48 merged  •  60d: 84 merged  •  90d: 120 merged                      │      │
│  ├──────────────────────────────────────────────────────────────────────────────────────────────┤      │
│  │ ⏱️ Velocity & Review Turnaround                                                               │      │
│  │   • Median Time to First Review: 4.2h      • Median Time to Merge: 1.5d                      │      │
│  │   • CI Pass Rate:                98% (120/122 runs)   • Discussion Density:   2.4 cmts/PR    │      │
│  ├──────────────────────────────────────────────────────────────────────────────────────────────┤      │
│  │ 👥 Team Member Leaderboard (Ranked by 30d Merged PRs)                                        │      │
│  │   RANK  MEMBER                    30d   60d   90d  OPEN CLOSED  TOTAL  CMTS/PR  STALE        │      │
│  │   #1    Alice Walker (@alice)      18    32    45     2      1     21      2.1      0        │      │
│  │   #2    Bob Dylan (@bob)           15    28    40     1      0     16      1.8      0        │      │
│  │   #3    Charlie Day (@charlie)     10    16    24     3      2     15      3.4      1        │      │
│  │   #4    Diana Prince (@diana)       5     8    11     0      1      6      1.2      0        │      │
│  └─ [Tab/1-3] switch tab  [w] timeframe  [s] sort  [b] backfill  [Esc] close ───────────────────┘      │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🎮 Keyboard Shortcuts

| Key | Action | Description |
|---|---|---|
| `Tab` / `t` | **Cycle Scope** | Cycle sequentially through **[1] Mine**, **[2] Team**, and **[3] Agents** |
| `1` / `2` / `3` | **Direct Tab Switch** | Jump directly to **[1] Mine**, **[2] Team**, or **[3] 🤖 Agents** |
| `p` | **PR Stats & Velocity** | Open performance dashboard matching current scope with 3-tab navigation |
| `b` / `B` | **Backfill PR Stats** | Trigger on-demand historical stats backfill (defaults to 90d, with [1/2/3] timeframe keys) |
| `?` / `h` | **All Actions & Help** | Open comprehensive categorized actions modal |
| `↑` / `k` | **Navigate Up** | Move selection up in PR list / workflow tree |
| `↓` / `j` | **Navigate Down** | Move selection down in PR list / workflow tree |
| `←` / `→` | **Pane Focus** | Switch focus between left workflow tree and right timeline in Agents tab |
| `Enter` / `v` | **View Details Modal** | Open centered pop-up window with CI checks, threads, agent status, and scrollable logs |
| `s` | **Settings & Extensions** | Open interactive settings modal to configure team slug, defaults, and extensions |
| `d` | **View Diff Modal** | Open syntax-colorized git diff in a pop-up window (with file jumping <kbd>n</kbd>/<kbd>p</kbd> and triage shortcuts) |
| `L` / `l` | **View Agent Logs** | Open real-time streaming or historical agent execution logs for the selected PR |
| `a` | **Agent Automation Modal**| Configure repo automation policy modes (`LIVE`/`DRY`/`OFF`), assign role agents, or dispatch on-demand playbooks |
| `o` | **Open in Browser** | Open PR web page using `gh pr view --web` |
| `m` | **Merge PR** | Squash-merge PR and delete branch (prompts confirmation) |
| `c` | **Comment** | Post a review comment to the PR |
| `x` | **Close PR** | Close the pull request (prompts confirmation) |
| `R` | **Recheck** | Force an immediate poll & refresh |
| `/` or `f` | **Filter / Search** | Filter list by repo, PR #, branch, author, or title |
| `Escape` | **Clear / Dismiss** | Cancel search filter or dismiss active modal |
| `q` / `Ctrl+C` | **Quit** | Cleanly exit and restore terminal |

---

## 🤖 Autonomous Agent Delegation & Playbook Engine

Overseer provides a declarative, policy-driven autonomous agent orchestrator with reusable playbooks, isolated git worktrees, safety circuit breakers, and rich telemetry:

### 1. Built-in Playbook Pathways

| Playbook | Purpose | Injected Context |
| :--- | :--- | :--- |
| **`ci-repair`** | Diagnoses failing CI check runs, fixes code in worktree, and pushes. | `{failingCheck}`, `{ciLogs}` |
| **`address-comments`** | Addresses unresolved review feedback and reviewer comments. | `{comments}` |
| **`preflight-review`** | Performs automated pre-flight code review against repository guidelines. | `{diffSummary}`, `{branch}`, `{baseBranch}` |
| **`rebase-resolver`** | Rebases branch onto base branch and resolves merge conflicts. | `{branch}`, `{baseBranch}` |

### 2. Granular Per-Repo Automation Modes

Configure repository automation in `./.overseer/settings.json` or interactively in the Agent Modal (<kbd>a</kbd>):
* 🟢 **`live`**: Autonomously provisions worktree, executes agent, streams real-time file edits, runs tests, and pushes fixes.
* 🟡 **`dry-run`**: Simulates delegation, logs prompt and command to `./.overseer/logs/`, and records telemetry without touching git or spawning processes.
* ⚪ **`off`**: Manual dispatch only (via <kbd>a</kbd> or API).

```json
{
  "repoPolicies": {
    "acme-corp/web-frontend": {
      "mode": "live",
      "agent": "agy",
      "triggers": ["CiFailing"],
      "allowedPlaybooks": ["ci-repair"]
    },
    "acme-corp/api-gateway": {
      "mode": "dry-run",
      "agent": "claude",
      "triggers": ["ChangesRequested"],
      "allowedPlaybooks": ["address-comments"]
    }
  }
}
```

### 3. Dedicated Telemetry Store (`./.overseer/agent-stats.json`) & Analytics Modal

Agent runs, execution times, success/failure outcomes, and audit trails are persisted in a dedicated `./.overseer/agent-stats.json` store (decoupled from ephemeral PR cache).

Press <kbd>p</kbd> and switch to **`[3] 🤖 Agents`** tab (or press <kbd>3</kbd>) to open the **🤖 Agent Operations & Interventions Dashboard**:
* **Performance by Agent**: Dispatches, success rate %, avg turnaround time, failures.
* **Performance by Playbook**: Runs, success %, avg duration, top target repo.
* **Intervention Breakdown by Repo**: Auto vs manual runs, success %, mode (`LIVE`/`DRY`/`OFF`).
* **Recent Execution Audit Trail**: Chronological log of recent dispatches with duration and outcome.

### 4. Real-Time Worktree Activity & Auto-Push Safety Net

* ⚡ **Live Worktree Activity Polling**: While an agent runs, Overseer polls `git status --porcelain` in the worktree every 1.5s, streaming real-time file edit notifications (`[14:40:45] ⚡ File Activity: 3 file(s) modified`) and updating the `⚡ Active Edits` badge in the UI.
* 🚀 **Overseer Auto-Push Safety Net**: When a fixer agent exits with code `0`, Overseer verifies if unpushed commits exist and automatically publishes them to origin (`git push origin <branch>`), logging push confirmations or errors directly to the stream.
* 🔑 **Remote Protocol Mirroring (`SSH`/`HTTPS`)**: Worktrees mirror the parent repository's remote URL protocol so ambient SSH keys authenticate without HTTPS credential prompts.

```json
{
  "customAgents": {
    "claude": {
      "command": "claude -p \"{prompt}\"",
      "description": "Claude CLI agent",
      "driver": "local"
    },
    "moxly": {
      "driver": "remote",
      "triggerTemplate": "@moxly {prompt}",
      "description": "Moxly Cloud Review & Repair Agent"
    }
  }
}
```

### 5. Multi-Layered Safety & Git Push Guards

Overseer enforces strict physical guards to ensure agents can never clobber branches or push unintended commits:
* 🛡️ **Zero-Process Simulation in Dry-Run**: When a repo is in `dry-run`, prompts and commands are formatted and logged, but no child processes or git worktrees are spawned (0 API tokens consumed).
* 🔒 **Git Remote Push Guard**: For read-only playbooks (such as `preflight-review`), Overseer automatically sets `git remote set-url --push origin OVERSEER_PUSH_DISABLED` inside the isolated worktree so any attempted push is physically rejected by Git.
* 🌿 **Isolated Git Worktrees**: Agents operate exclusively inside ephemeral `./.overseer/worktrees/` folders without touching your main working directory.
* 🧹 **Automatic Worktree Pruning**: On PR merge or close, all associated temporary worktrees and execution logs are deleted automatically.

---

## 🔌 Local REST & SSE API

When the Local API is enabled (via Settings modal <kbd>s</kbd> or `--api` flag), Overseer serves a local REST and Server-Sent Events (SSE) daemon on `http://127.0.0.1:3210` for menu bar widgets, scripts, automation flows, and hardware displays:

### Endpoints

- **`GET /status`**: Health overview, repository count, open PR count, needs-attention count, passing CI count, review-ready count, and item summaries.
- **`GET /prs`**: Full list of open PRs with query filtering (`?scope=mine|team`, `?status=ready|changes_requested|ci_failing|draft`, `?search=...`).
- **`GET /prs/:owner/:repo/:number`** (or `/pr/:owner/:repo/:number`): Deep metadata for a PR including detailed CI checks breakdown, review verdict, activity logs, and running agent worker info.
- **`GET /stats`**: 90-day velocity metrics, team leaderboard, and reviewer turnaround data.
- **`POST /actions/:action`** (or `/action/:type`): Dispatch operational actions (`poll`/`recheck`, `merge`, `close`, `comment`, `agent`, `cancel-agent`, `open`, `backfill`).
- **`GET /events`**: Real-time SSE stream (`connected`, `statusChanged`, `pollCompleted`, `workerUpdated`, `actionTriggered`).

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

