import { describe, it, expect } from 'vitest';
import {
  getAvailablePlaybooks,
  getPlaybookDefinition,
  BUILTIN_PLAYBOOKS,
} from '../src/agents/playbooks.js';
import { interpolateAgentCommand } from '../src/agents/index.js';

describe('Agent Playbooks & Pathways Registry', () => {
  it('returns built-in playbooks', () => {
    const playbooks = getAvailablePlaybooks();
    expect(playbooks).toContain('ci-repair');
    expect(playbooks).toContain('address-comments');
    expect(playbooks).toContain('preflight-review');
    expect(playbooks).toContain('rebase-resolver');
  });

  it('retrieves built-in playbook definitions correctly', () => {
    const def = getPlaybookDefinition('ci-repair');
    expect(def.name).toBe('ci-repair');
    expect(def.includeCiLogs).toBe(true);
    expect(def.promptTemplate).toContain('{failingCheck}');
    expect(def.promptTemplate).toContain('{ciLogs}');
  });

  it('interpolates all dynamic context tokens in prompt templates', () => {
    const template =
      'PR #{pr} ({branch} -> {baseBranch}) on {owner}/{repo}. CI failing on {failingCheck}:\n{ciLogs}\nComments:\n{comments}\nDiff:\n{diffSummary}';

    const rendered = interpolateAgentCommand(template, {
      pr: 142,
      branch: 'feat/login',
      baseBranch: 'main',
      owner: 'acme-corp',
      repo: 'web-frontend',
      url: 'https://github.com/acme-corp/web-frontend/pull/142',
      failingCheck: 'lint-check',
      ciLogs: 'Error: line 42 syntax error',
      comments: '@reviewer: please fix formatting',
      diffSummary: 'src/login.ts | 4 ++--',
    });

    expect(rendered).toContain('PR #142 (feat/login -> main) on acme-corp/web-frontend.');
    expect(rendered).toContain('CI failing on lint-check:');
    expect(rendered).toContain('Error: line 42 syntax error');
    expect(rendered).toContain('@reviewer: please fix formatting');
    expect(rendered).toContain('src/login.ts | 4 ++--');
  });
});
