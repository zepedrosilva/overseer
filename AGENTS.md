# Overseer — Agent Guidelines (`AGENTS.md`)

This repository is monitored and maintained by Antigravity (AGY) and AI pair programmers. All AI agents contributing to this codebase must adhere to the rules and conventions below.

---

## 1. Project Overview

**Overseer** is a high-performance terminal UI (TUI) dashboard and management tool for GitHub Pull Requests. It monitors PRs globally via dynamic user search (zero-config) or across explicitly configured repositories, visualizes review and CI status in a custom split-view terminal, and enables interactive triage (merge, recheck, comment, diff, browser viewing, and on-demand AI agent dispatching in isolated worktrees).

---

## 2. Core Architecture & Tech Stack

- **Runtime**: Node.js (ESM only, `"type": "module"`)
- **Language**: TypeScript 5.7+ (strict mode enabled)
- **UI Engine**: Custom ANSI escape code renderer with Alternate Screen Buffer (`\x1b[?1049h`), raw mode stdin handling, zero external UI framework dependencies.
- **GitHub Integration**: Official `gh` CLI for auth and operations; dynamic search queries and batch queries via `gh api graphql` with automatic retry on transient errors.
- **Configuration & Storage**: Zero-config architecture with pure code-based defaults (`DEFAULT_SETTINGS`, `DEFAULT_EXTENSIONS`), interactive Settings & Extensions modal (<kbd>s</kbd>), CLI flags, and unified persistence in `./.overseer/state.json`.
- **Testing**: `vitest` for fast ESM unit testing.

---

## 3. Engineering & Code Standards

### 3.1 TypeScript & Code Style
- Use ESM imports with `.js` extensions (e.g., `import { ... } from './types.js';`).
- Maintain strict typing: avoid `any`; declare explicit interfaces for domain models.
- Keep dependencies minimal. Do NOT introduce heavy UI frameworks (such as `blessed` or `ink`) unless explicitly instructed by the user.

### 3.2 Testing & Verification Standards (Strict Requirement)
- **Mandatory Unit Tests**: Every new feature, domain change, or bug fix **must** be accompanied by comprehensive unit tests.
- **Pruning Ineffective Tests**: It is expected and encouraged to remove tests that are redundant, test tautologies (always true), test trivialities that provide no safety, or are obsolete when requirements change. Maintain a lean, high-signal, high-value test suite.
- **Unit Test Location**: Unit tests live under `test/` or alongside source files with `.test.ts` extension.
- **Mandatory Test Execution**: During task verification, agents **must always run and execute** the full test suite and type checker:
  ```bash
  npm run typecheck
  npm test
  ```
- **Continuous Green State**: Before concluding any task or reporting completion to the user, ensure all unit tests pass with a 100% pass rate and TypeScript emits zero errors. Never disable or skip tests simply to bypass failures.

### 3.3 State & Worktree Safety (Strict Local Rule)
- **100% Strictly Local (No Global Files)**: Always store all user settings (`./.overseer/settings.json`), runtime state (`./.overseer/state.json`), modular configs (`./.overseer/agents.json`), logs (`./.overseer/logs/`), and temporary worktrees (`./.overseer/worktrees/`) strictly inside the local project `./.overseer/` folder. Never create or read global files outside the local workspace (no `~/.config/`, no `~/.cache`, no global directories, no `/tmp`).
- **Automatic Cleanup on Merge/Close**: When a PR is merged or closed, all associated local worktrees and agent execution log files **must be deleted automatically**.
- **Credential Hygiene**: Never write credentials, raw tokens, or secrets to disk. Rely exclusively on `gh` CLI ambient authentication.

### 3.4 User Settings Preservation & Test Isolation (Strict Rule)
- **Never Overwrite or Wipe Live User Settings**: AI agents must never delete, reset, or overwrite existing user settings (such as `team`, `defaultAgent`, `searchQuery`, or polling intervals) in `./.overseer/settings.json` or `./.overseer/state.json`.
- **Clean Separation of Concerns**: User preferences, team settings, and repo-agent bindings live in `./.overseer/settings.json`, while volatile PR cache, workers, and historical stats live in `./.overseer/state.json`.
- **Deep-Merge on Schema Updates**: Whenever new setting fields are introduced, `loadSettings()` and configuration loaders must preserve all existing user-configured values while applying defaults only for missing keys.
- **Test Isolation**: Automated unit tests must always use temporary or mock state paths (e.g. dedicated temp directories or in-memory fixtures) and must never write to or mutate live `./.overseer/settings.json` or `./.overseer/state.json` files.

### 3.5 Privacy & Zero Proprietary Leakage Standards (Strict Requirement)
- **Zero Proprietary Data in Code/Docs/Tests**: Never hardcode, commit, or reference private company/organization names, internal team slugs, internal repository names, internal URLs, or real colleague names/usernames in source code, configuration defaults, unit tests, mock fixtures, git commits, or documentation.
- **Universal Placeholders**: Always use generic open-source identifiers for mocks, fixtures, and docs (e.g. `acme-corp`, `octocat`, `@alice`, `@bob`, `@charlie`, `web-frontend`, `api-gateway`, `backend-service`).
- **Zero Default Org Slugs**: `DEFAULT_SETTINGS.team` must always default to an empty string (`team: ''`), allowing users to configure their own team via Settings (<kbd>s</kbd>) or CLI flags.

### 3.6 Public Repository & Packaging Integrity
- **CLI Binary Hashbang**: `src/main.ts` must always retain `#!/usr/bin/env node` at line 1 so compiled `dist/main.js` runs as an executable CLI binary.
- **Package Metadata Preservation**: Never remove or corrupt `package.json` distribution fields (`bin`, `files`, `engines`, `repository`, `homepage`, `bugs`, `keywords`, `license`).
- **Security & Community Files**: Never delete or weaken open-source standards (`LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `.github/dependabot.yml`, and PR/Issue templates).
- **Least-Privilege Workflows**: All GitHub Actions workflows must explicitly declare minimal permissions (`permissions: contents: read`) to maintain fork safety.

---

## 4. Useful Commands

```bash
# Run unit tests
npm test

# Run tests in watch mode
npm run test:watch

# Type check
npm run typecheck

# Build TypeScript to dist/
npm run build

# Run in development mode
npm run dev

# Start built package
npm start
```
