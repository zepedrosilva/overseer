// ── Agent Playbooks & Pathway Registry ────────────────────────────────────────
// Reusable instruction templates and context requirements for PR triage operations.

import type { PlaybookDefinition, AgentsConfigFile } from '../app/types.js';

export const BUILTIN_PLAYBOOKS: Record<string, PlaybookDefinition> = {
  'ci-repair': {
    name: 'ci-repair',
    description: 'Diagnose failing CI check runs, fix code in worktree, and push',
    promptTemplate:
      'You are already located directly at the root of the repository worktree for PR #{pr} ({owner}/{repo}, branch: \'{branch}\'). Current working directory is the repository root (\'.\'). Do NOT search for or locate the repository elsewhere on the system.\n\n' +
      'The CI check \'{failingCheck}\' failed on this PR.\n\n' +
      'Failing Logs & Diagnostics:\n{ciLogs}\n\n' +
      'Investigate the root cause, apply fixes directly in this codebase, verify by running tests locally, commit with message "fix(ci): address {failingCheck} failure", and push to origin {branch}.',
    includeCiLogs: true,
  },
  'address-comments': {
    name: 'address-comments',
    description: 'Address unresolved review comments and reviewer feedback',
    promptTemplate:
      'You are already located directly at the root of the repository worktree for PR #{pr} ({owner}/{repo}, branch: \'{branch}\'). Current working directory is the repository root (\'.\'). Do NOT search for or locate the repository elsewhere on the system.\n\n' +
      'Address the following unresolved review comments on this PR:\n\n' +
      '{comments}\n\n' +
      'Apply the requested changes directly to the codebase, verify that tests pass, commit with message "refactor: address review comments", and push to origin {branch}.',
    includeReviewComments: true,
  },
  'preflight-review': {
    name: 'preflight-review',
    description: 'Perform automated pre-flight code review against repo standards',
    promptTemplate:
      'You are already located directly at the root of the repository worktree for PR #{pr} ({owner}/{repo}, branch: \'{branch}\' -> base: \'{baseBranch}\'). Current working directory is the repository root (\'.\'). Do NOT search for or locate the repository elsewhere on the system.\n\n' +
      'Perform a thorough code review for PR #{pr}.\n\n' +
      'Diff Summary:\n{diffSummary}\n\n' +
      'Review for correctness, edge cases, performance, security, and repository conventions. Provide actionable feedback.',
    includeDiff: true,
    readOnly: true,
  },
  'rebase-resolver': {
    name: 'rebase-resolver',
    description: 'Rebase branch onto base target and resolve merge conflicts',
    promptTemplate:
      'You are already located directly at the root of the repository worktree for PR #{pr} ({owner}/{repo}, branch: \'{branch}\' -> base: \'{baseBranch}\'). Current working directory is the repository root (\'.\'). Do NOT search for or locate the repository elsewhere on the system.\n\n' +
      'Rebase branch \'{branch}\' onto \'{baseBranch}\'. If there are merge conflicts, resolve them carefully, verify tests pass, and push.',
  },
};

export function getAvailablePlaybooks(customConfig?: AgentsConfigFile): string[] {
  const custom = customConfig?.customPlaybooks ? Object.keys(customConfig.customPlaybooks) : [];
  const builtin = Object.keys(BUILTIN_PLAYBOOKS);
  return Array.from(new Set([...builtin, ...custom]));
}

export function getPlaybookDefinition(
  name: string,
  customConfig?: AgentsConfigFile
): PlaybookDefinition {
  if (customConfig?.customPlaybooks && customConfig.customPlaybooks[name]) {
    return customConfig.customPlaybooks[name];
  }
  if (BUILTIN_PLAYBOOKS[name]) {
    return BUILTIN_PLAYBOOKS[name];
  }
  return {
    name,
    description: 'Custom execution prompt',
    promptTemplate: '{prompt}',
  };
}
