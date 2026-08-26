// ── Built-in Agent Presets ──────────────────────────────────────────────────
// Presets for popular CLI agents and review bots.

import type { AgentDefinition } from '../app/types.js';

export const BUILTIN_PRESETS: Record<string, AgentDefinition> = {
  claude: {
    command: 'claude --dangerously-skip-permissions -p "{prompt}"',
    description: 'Claude CLI autonomous assistant',
  },
  gemini: {
    command: 'agy --sandbox --dangerously-skip-permissions -p "{prompt}"',
    description: 'Antigravity / Gemini CLI agent',
  },
  agy: {
    command: 'agy --sandbox --dangerously-skip-permissions -p "{prompt}"',
    description: 'Antigravity CLI agent',
  },
  pi: {
    command: 'pi "{prompt}"',
    description: 'Pi CLI agent',
  },
};

export const DEFAULT_AGENT_PROMPT = 'Review this Pull Request and fix all unresolved comments and CI failures.';
