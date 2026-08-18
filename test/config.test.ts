import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadConfig,
  getRepoAgent,
  getAgentDefinition,
  DEFAULT_CONFIG,
  BUILTIN_AGENT_PRESETS,
} from '../src/config.js';
import { createEmptyState, saveState, setRepoAgent } from '../src/app/state.js';

describe('Config & Defaults Engine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Built-in Presets and Defaults', () => {
    it('provides sensible code defaults without any config files', () => {
      expect(DEFAULT_CONFIG.defaults.agent).toBe('claude');
      expect(DEFAULT_CONFIG.defaults.pollIntervalSecs).toBe(30);
      expect(DEFAULT_CONFIG.defaults.filter_user_only).toBe(true);
      expect(DEFAULT_CONFIG.runtime.dryRun).toBe(false);
      expect(DEFAULT_CONFIG.streamdeck.enabled).toBe(false);
      expect(DEFAULT_CONFIG.streamdeck.port).toBe(3210);
    });

    it('contains built-in agent presets', () => {
      expect(BUILTIN_AGENT_PRESETS.claude).toBeDefined();
      expect(BUILTIN_AGENT_PRESETS.agy).toBeDefined();
      expect(BUILTIN_AGENT_PRESETS.gemini).toBeDefined();
      expect(BUILTIN_AGENT_PRESETS.pi).toBeDefined();
    });

    it('resolves agent definitions for built-in presets and custom commands', () => {
      const claudeDef = getAgentDefinition('claude');
      expect(claudeDef.command).toContain('claude');

      const agyDef = getAgentDefinition('agy');
      expect(agyDef.command).toContain('agy');

      const geminiDef = getAgentDefinition('gemini');
      expect(geminiDef.command).toContain('agy');

      const customDef = getAgentDefinition('custom-bot --flag');
      expect(customDef.command).toContain('custom-bot --flag');
    });
  });

  describe('loadConfig with State Integration', () => {
    it('loads state-backed configuration seamlessly', () => {
      const state = createEmptyState({
        defaultAgent: 'agy',
        pollIntervalSecs: 45,
        dryRun: true,
      }, {
        streamdeck: { enabled: true, port: 4000 },
      });
      setRepoAgent(state, { owner: 'acme-corp', repo: 'web-frontend' }, 'agy');

      const statePath = path.join(tmpDir, '.overseer', 'state.json');
      fs.mkdirSync(path.join(tmpDir, '.overseer'), { recursive: true });
      saveState(state, statePath);

      const config = loadConfig({ cwd: tmpDir });
      expect(config.defaults.agent).toBe('agy');
      expect(config.defaults.pollIntervalSecs).toBe(45);
      expect(config.runtime.dryRun).toBe(true);
      expect(config.streamdeck.enabled).toBe(true);
      expect(config.streamdeck.port).toBe(4000);
    });

    it('respects dryRunFlag override when loading config', () => {
      const config = loadConfig({ cwd: tmpDir, dryRunFlag: true });
      expect(config.runtime.dryRun).toBe(true);
    });
  });

  describe('getRepoAgent', () => {
    it('returns default agent if repo has no mapping', () => {
      const agent = getRepoAgent({ owner: 'foo', repo: 'bar' }, DEFAULT_CONFIG);
      expect(agent).toBe('claude');
    });

    it('returns repo-specific agent when defined', () => {
      const customConfig = {
        ...DEFAULT_CONFIG,
        repos: [{ url: 'https://github.com/acme-corp/web-frontend', agent: 'agy' }],
      };
      const agent = getRepoAgent({ owner: 'acme-corp', repo: 'web-frontend' }, customConfig);
      expect(agent).toBe('agy');
    });
  });
});
