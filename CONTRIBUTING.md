# Contributing to Overseer

Thank you for your interest in contributing to Overseer!

Overseer is a high-performance terminal UI dashboard and management tool for GitHub Pull Requests.

---

## 🛠️ Development Setup

### Prerequisites
- **Node.js**: `v22.0.0` or higher
- **GitHub CLI (`gh`)**: Installed and authenticated (`gh auth login`)
- **Git**: `2.30+`

### Getting Started
```bash
# 1. Fork and clone the repository
git clone https://github.com/<your-username>/overseer.git
cd overseer

# 2. Install dependencies
npm install

# 3. Build and test locally
npm run typecheck
npm test
npm run build

# 4. Run development build
npm run dev
```

---

## 🧪 Testing & Code Standards

- **ESM Only**: Overseer is pure Node.js ESM (`"type": "module"`). Use `.js` extensions in imports (e.g. `import { ... } from './types.js'`).
- **Strict TypeScript**: Strict mode is enabled. Avoid `any` types and provide explicit domain interfaces.
- **100% Test Pass Rate**: All unit tests must pass before submitting a pull request:
  ```bash
  npm run typecheck
  npm test
  ```
- **Test Isolation**: Unit tests must use mock fixtures or isolated temp directories and must never mutate `./.overseer/state.json`.

---

## 🔒 Privacy & Zero Proprietary Leakage Standard

- **Zero Proprietary Data**: Never commit private company names, internal organization slugs, internal repository names, real coworker names, internal URLs, or credentials.
- **Universal Placeholders**: Always use generic open-source identifiers in tests, docs, and fixtures (`acme-corp`, `web-frontend`, `@alice`, `@bob`, `@charlie`, `octocat`).

---

## 🚀 Submitting a Pull Request

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Commit your changes with conventional commit prefixes (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).
3. Ensure `npm run typecheck` and `npm test` pass.
4. Push to your fork and open a Pull Request against `main`.
