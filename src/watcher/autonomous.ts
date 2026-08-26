// ── Autonomous Policy Evaluator & Circuit Breaker ────────────────────────────
// Monitors PR state transitions, applies per-repo automation policies,
// enforces safety circuit breakers (max retries, concurrency caps, cooldowns),
// and triggers playbook execution.

import type { AppState, PrState, AppConfig, RepoPolicyConfig } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { getRepoPolicy, getRepoMode, appendLog } from '../app/state.js';
import { dispatchAgent } from '../agents/index.js';
import {
  fetchFailedCiLogs,
  fetchUnresolvedReviewComments,
  fetchPrDiffSummary,
} from './gh.js';

export const MAX_CONCURRENT_WORKERS = 2;
export const MAX_CONSECUTIVE_AUTONOMOUS_RETRIES = 2;
export const AUTONOMOUS_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// In-memory retry & cooldown tracker (ephemeral per process session)
const prRetryCounters = new Map<string, number>();
const prLastDispatchAt = new Map<string, number>();
const prReviewedKeys = new Set<string>();

export function getPrRetryCount(keyStr: string): number {
  return prRetryCounters.get(keyStr) || 0;
}

export function resetPrRetryCount(keyStr: string): void {
  prRetryCounters.delete(keyStr);
}

export function resetAutonomousState(): void {
  prRetryCounters.clear();
  prLastDispatchAt.clear();
  prReviewedKeys.clear();
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

    // Check circuit breaker: Cooldown
    const lastAt = prLastDispatchAt.get(keyStr) || 0;
    if (Date.now() - lastAt < AUTONOMOUS_COOLDOWN_MS) {
      continue; // Within cooldown period
    }

    // Check circuit breaker: Max retries
    const retryCount = prRetryCounters.get(keyStr) || 0;
    if (retryCount >= MAX_CONSECUTIVE_AUTONOMOUS_RETRIES) {
      continue; // Max retry loop breaker tripped
    }

    const allowedTriggers = policy.triggers || ['CiFailing', 'ChangesRequested', 'Reviewing'];

    // ── 1. Check CI Failure Trigger ──────────────────────────────────────────
    if (
      pr.overallStatus === 'CiFailing' &&
      allowedTriggers.includes('CiFailing')
    ) {
      const allowedPbs = policy.allowedPlaybooks || ['ci-repair'];
      const playbookName = allowedPbs.includes('ci-repair') ? 'ci-repair' : allowedPbs[0];

      // Mark dispatch attempt
      prRetryCounters.set(keyStr, retryCount + 1);
      prLastDispatchAt.set(keyStr, Date.now());

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

      await dispatchAgent({
        data,
        pr,
        config,
        agentName: policy.agent,
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

    // ── 2. Check Changes Requested / Review Comments Trigger ──────────────────
    if (
      pr.overallStatus === 'ChangesRequested' &&
      allowedTriggers.includes('ChangesRequested')
    ) {
      const allowedPbs = policy.allowedPlaybooks || ['address-comments'];
      const playbookName = allowedPbs.includes('address-comments')
        ? 'address-comments'
        : allowedPbs[0];

      prRetryCounters.set(keyStr, retryCount + 1);
      prLastDispatchAt.set(keyStr, Date.now());

      appendLog(
        data,
        pr.key,
        `[policy] Autonomous trigger fired: ChangesRequested on ${keyStr} (Attempt ${retryCount + 1}/${MAX_CONSECUTIVE_AUTONOMOUS_RETRIES})`
      );

      let comments = 'Reviewers requested changes.';
      try {
        comments = await fetchUnresolvedReviewComments(
          pr.key.owner,
          pr.key.repo,
          pr.key.number
        );
      } catch {
        // Fallback
      }

      await dispatchAgent({
        data,
        pr,
        config,
        agentName: policy.agent,
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

    // ── 3. Check Reviewing / Pre-flight Review Trigger ─────────────────────────
    if (
      pr.overallStatus === 'Reviewing' &&
      allowedTriggers.includes('Reviewing')
    ) {
      const reviewRevisionKey = `${keyStr}@${pr.updatedAt || pr.branch}`;
      if (prReviewedKeys.has(reviewRevisionKey)) {
        continue; // Revision already reviewed
      }

      const allowedPbs = policy.allowedPlaybooks || ['preflight-review'];
      const playbookName = allowedPbs.includes('preflight-review')
        ? 'preflight-review'
        : allowedPbs[0];

      prRetryCounters.set(keyStr, retryCount + 1);
      prLastDispatchAt.set(keyStr, Date.now());
      prReviewedKeys.add(reviewRevisionKey);

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

      await dispatchAgent({
        data,
        pr,
        config,
        agentName: policy.agent,
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
