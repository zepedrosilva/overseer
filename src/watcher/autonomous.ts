// ── Autonomous Policy Evaluator & Circuit Breaker ────────────────────────────
// Monitors PR state transitions, applies per-repo automation policies,
// enforces safety circuit breakers (max retries, concurrency caps, cooldowns),
// and triggers playbook execution.

import type { AppState, PrState, AppConfig, RepoPolicyConfig } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { getRepoPolicy, getRepoMode, getRepoRoleAgent, appendLog } from '../app/state.js';
import { dispatchAgent } from '../agents/index.js';
import {
  fetchFailedCiLogs,
  fetchUnresolvedReviewComments,
  fetchPrDiffSummary,
} from './gh.js';

export const MAX_CONCURRENT_WORKERS = 2;
export const MAX_CONSECUTIVE_AUTONOMOUS_RETRIES = 2;
export const AUTONOMOUS_COOLDOWN_MS = 15 * 1000; // 15s stage cooldown

// In-memory retry & cooldown tracker (ephemeral per process session)
const prRetryCounters = new Map<string, number>();
const prLastDispatchAt = new Map<string, number>();
const prReviewedKeys = new Set<string>();
const prFixedKeys = new Set<string>();

export function getPrRetryCount(keyStr: string): number {
  return prRetryCounters.get(keyStr) || prRetryCounters.get(`${keyStr}:ci`) || prRetryCounters.get(`${keyStr}:fix`) || prRetryCounters.get(`${keyStr}:review`) || 0;
}

export function resetPrRetryCount(keyStr: string): void {
  prRetryCounters.delete(keyStr);
  prRetryCounters.delete(`${keyStr}:ci`);
  prRetryCounters.delete(`${keyStr}:fix`);
  prRetryCounters.delete(`${keyStr}:review`);
}

export function resetAutonomousState(): void {
  prRetryCounters.clear();
  prLastDispatchAt.clear();
  prReviewedKeys.clear();
  prFixedKeys.clear();
}

export async function evaluateAutonomousPolicies(
  data: AppState,
  config: AppConfig,
  cwd?: string
): Promise<void> {
  const activeWorkers = Array.from(data.workers.values()).filter(
    (w) => w.status === 'running'
  );
  if (activeWorkers.length >= MAX_CONCURRENT_WORKERS) {
    return; // Concurrency cap reached
  }

  const prList = Array.from(data.prs.values());

  for (const pr of prList) {
    // Only consider OPEN PRs involving the user or within allowed scope
    if (pr.state !== 'OPEN') continue;

    const repoKey = `${pr.key.owner}/${pr.key.repo}`.toLowerCase();
    const policy = getRepoPolicy(data, pr.key);
    const mode = getRepoMode(data, pr.key);

    if (mode === 'off' || !policy) {
      continue; // Autonomous delegation disabled for this repository
    }

    const keyStr = prKeyToString(pr.key);
    const isAlreadyWorking =
      data.workers.has(keyStr) && data.workers.get(keyStr)?.status === 'running';
    if (isAlreadyWorking) {
      continue; // Worker already running on this PR
    }

    const allowedTriggers = policy.triggers || ['CiFailing', 'ChangesRequested', 'Reviewing'];

    // ── 1. Check CI Failure Trigger ──────────────────────────────────────────
    if (
      pr.overallStatus === 'CiFailing' &&
      allowedTriggers.includes('CiFailing')
    ) {
      const stageKey = `${keyStr}:ci`;
      const lastAt = prLastDispatchAt.get(stageKey) || 0;
      if (Date.now() - lastAt < AUTONOMOUS_COOLDOWN_MS) {
        continue;
      }
      const retryCount = prRetryCounters.get(stageKey) || 0;
      if (retryCount >= MAX_CONSECUTIVE_AUTONOMOUS_RETRIES) {
        continue;
      }

      const allowedPbs = policy.allowedPlaybooks || ['ci-repair'];
      const playbookName = allowedPbs.includes('ci-repair') ? 'ci-repair' : allowedPbs[0];

      prRetryCounters.set(stageKey, retryCount + 1);
      prLastDispatchAt.set(stageKey, Date.now());

      appendLog(
        data,
        pr.key,
        `[policy] Autonomous trigger fired: CiFailing on ${keyStr} (Attempt ${retryCount + 1}/${MAX_CONSECUTIVE_AUTONOMOUS_RETRIES})`
      );

      // Fetch failing CI diagnostics
      let ciLogs = 'CI failure detected.';
      try {
        ciLogs = await fetchFailedCiLogs(pr.key.owner, pr.key.repo, pr.key.number);
      } catch {
        // Fallback
      }

      const failingCheck =
        pr.ciChecks.find((c) => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT')?.name ||
        'test';

      const ciAgent = getRepoRoleAgent(data, pr.key, 'ciRepair');
      await dispatchAgent({
        data,
        pr,
        config,
        agentName: ciAgent,
        playbookName,
        trigger: 'autonomous_ci',
        mode: mode === 'dry-run' ? 'dry-run' : 'live',
        ciLogs,
        failingCheck,
        cwd,
      });

      // Check concurrency again after dispatch
      if (
        Array.from(data.workers.values()).filter((w) => w.status === 'running').length >=
        MAX_CONCURRENT_WORKERS
      ) {
        break;
      }
      continue;
    }

    // ── 2. Check Changes Requested / Review Comments Feedback Trigger ────────
    const hasFeedback =
      pr.overallStatus === 'ChangesRequested' ||
      (typeof pr.unresolvedThreadsCount === 'number' && pr.unresolvedThreadsCount > 0) ||
      (typeof pr.commentsCount === 'number' && pr.commentsCount > 0 && pr.reviewVerdict !== 'APPROVED');

    const allowedPbsForFix = policy.allowedPlaybooks || ['address-comments'];
    if (
      hasFeedback &&
      (allowedTriggers.includes('ChangesRequested') || allowedTriggers.includes('Reviewing')) &&
      allowedPbsForFix.includes('address-comments')
    ) {
      const fixKey = `${keyStr}@comments-${pr.commentsCount || 0}-${pr.unresolvedThreadsCount || 0}@${pr.updatedAt || pr.branch}`;
      const stageKey = `${keyStr}:fix`;

      if (!prFixedKeys.has(fixKey)) {
        const lastAt = prLastDispatchAt.get(stageKey) || 0;
        if (Date.now() - lastAt < AUTONOMOUS_COOLDOWN_MS) {
          continue;
        }
        const retryCount = prRetryCounters.get(stageKey) || 0;
        if (retryCount >= MAX_CONSECUTIVE_AUTONOMOUS_RETRIES) {
          continue;
        }

        const playbookName = 'address-comments';

        prFixedKeys.add(fixKey);
        prRetryCounters.set(stageKey, retryCount + 1);
        prLastDispatchAt.set(stageKey, Date.now());

        appendLog(
          data,
          pr.key,
          `[policy] Autonomous trigger fired: Address Comments on ${keyStr} (${playbookName})`
        );

        let comments = 'Reviewers provided comments and feedback.';
        try {
          comments = await fetchUnresolvedReviewComments(
            pr.key.owner,
            pr.key.repo,
            pr.key.number
          );
        } catch {
          // Fallback
        }

        const fixerAgent = getRepoRoleAgent(data, pr.key, 'fixer');
        await dispatchAgent({
          data,
          pr,
          config,
          agentName: fixerAgent,
          playbookName,
          trigger: 'autonomous_review',
          mode: mode === 'dry-run' ? 'dry-run' : 'live',
          comments,
          cwd,
        });

        if (
          Array.from(data.workers.values()).filter((w) => w.status === 'running').length >=
          MAX_CONCURRENT_WORKERS
        ) {
          break;
        }
        continue;
      }
    }

    // ── 3. Check Reviewing / Pre-flight Review Trigger ─────────────────────────
    const allowedPbsForReview = policy.allowedPlaybooks || ['preflight-review'];
    if (
      pr.overallStatus === 'Reviewing' &&
      !hasFeedback &&
      allowedTriggers.includes('Reviewing') &&
      allowedPbsForReview.includes('preflight-review')
    ) {
      const reviewRevisionKey = `${keyStr}@${pr.updatedAt || pr.branch}`;
      const stageKey = `${keyStr}:review`;

      if (prReviewedKeys.has(reviewRevisionKey)) {
        continue; // Revision already reviewed
      }

      const lastAt = prLastDispatchAt.get(stageKey) || 0;
      if (Date.now() - lastAt < AUTONOMOUS_COOLDOWN_MS) {
        continue;
      }
      const retryCount = prRetryCounters.get(stageKey) || 0;
      if (retryCount >= MAX_CONSECUTIVE_AUTONOMOUS_RETRIES) {
        continue;
      }

      const playbookName = 'preflight-review';

      prReviewedKeys.add(reviewRevisionKey);
      prRetryCounters.set(stageKey, retryCount + 1);
      prLastDispatchAt.set(stageKey, Date.now());

      appendLog(
        data,
        pr.key,
        `[policy] Autonomous trigger fired: Reviewing on ${keyStr} (${playbookName})`
      );

      let diffSummary = `Changed files: ${pr.changedFiles || 0} (+${pr.additions || 0}, -${pr.deletions || 0})`;
      try {
        diffSummary = await fetchPrDiffSummary(
          pr.key.owner,
          pr.key.repo,
          pr.key.number
        );
      } catch {
        // Fallback
      }

      const reviewerAgent = getRepoRoleAgent(data, pr.key, 'reviewer');
      await dispatchAgent({
        data,
        pr,
        config,
        agentName: reviewerAgent,
        playbookName,
        trigger: 'autonomous_review',
        mode: mode === 'dry-run' ? 'dry-run' : 'live',
        diffSummary,
        cwd,
      });

      if (
        Array.from(data.workers.values()).filter((w) => w.status === 'running').length >=
        MAX_CONCURRENT_WORKERS
      ) {
        break;
      }
      continue;
    }
  }
}
