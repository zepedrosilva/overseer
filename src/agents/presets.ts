// ── Built-in Agent Presets ──────────────────────────────────────────────────
// Presets for popular CLI agents and review bots.

import type { AgentDefinition } from '../app/types.js';

export const BUILTIN_PRESETS: Record<string, AgentDefinition> = {
  claude: {
    bin: 'claude',
    args: ['--dangerously-skip-permissions', '-p', '{prompt}'],
    command: 'claude --dangerously-skip-permissions -p "{prompt}"',
    description: 'Claude CLI autonomous assistant',
  },
  gemini: {
    bin: 'agy',
    args: ['--sandbox', '--dangerously-skip-permissions', '--add-dir', '.', '-p', '{prompt}'],
    command: 'agy --sandbox --dangerously-skip-permissions --add-dir . -p "{prompt}"',
    description: 'Antigravity / Gemini CLI agent',
  },
  agy: {
    bin: 'agy',
    args: ['--sandbox', '--dangerously-skip-permissions', '--add-dir', '.', '-p', '{prompt}'],
    command: 'agy --sandbox --dangerously-skip-permissions --add-dir . -p "{prompt}"',
    description: 'Antigravity CLI agent',
  },
  pi: {
    bin: 'pi',
    args: ['{prompt}'],
    command: 'pi "{prompt}"',
    description: 'Pi CLI agent',
  },
};

export const DEFAULT_AGENT_PROMPT = 'Review this Pull Request and fix all unresolved comments and CI failures.';

