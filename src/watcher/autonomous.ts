// ── Autonomous Policy Evaluator & Circuit Breaker ────────────────────────────
// Monitors PR state transitions, applies per-repo automation policies,
// enforces safety circuit breakers (max retries, concurrency caps, cooldowns),
// and triggers playbook execution.

import type { AppState, AppConfig } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { getRepoPolicy, getRepoMode, getRepoRoleAgent, appendLog } from '../app/state.js';
import { dispatchAgent } from '../agents/index.js';
import {
  fetchFailedCiLogs,
  fetchUnresolvedReviewComments,
  fetchPrDiffSummary,
} from './gh.js';
import { chunkReviewFeedback } from './feedbackChunker.js';

export const MAX_CONCURRENT_WORKERS = 2;
export const MAX_CONSECUTIVE_AUTONOMOUS_RETRIES = 2;
export const AUTONOMOUS_COOLDOWN_MS = 15 * 1000; // 15s stage cooldown

// In-memory retry & cooldown tracker (ephemeral per process session)
const prRetryCounters = new Map<string, number>();
const prLastDispatchAt = new Map<string, number>();
const prReviewedKeys = new Set<string>();
const prFixedKeys = new Set<string>();
const prBatchIndex = new Map<string, number>();

export function getPrRetryCount(keyStr: string, stage?: 'ci' | 'fix' | 'review'): number {
  if (stage) {
    return prRetryCounters.get(`${keyStr}:${stage}`) || 0;
  }
  return (
    prRetryCounters.get(keyStr) ||
    prRetryCounters.get(`${keyStr}:ci`) ||
    prRetryCounters.get(`${keyStr}:fix`) ||
    prRetryCounters.get(`${keyStr}:review`) ||
    0
  );
}

export function resetPrRetryCount(keyStr: string, stage?: 'ci' | 'fix' | 'review'): void {
  if (stage) {
    prRetryCounters.delete(`${keyStr}:${stage}`);
    return;
  }
  prRetryCounters.delete(keyStr);
  prRetryCounters.delete(`${keyStr}:ci`);
  prRetryCounters.delete(`${keyStr}:fix`);
  prRetryCounters.delete(`${keyStr}:review`);
  prBatchIndex.delete(keyStr);
  prBatchIndex.delete(`${keyStr}:fix`);
}

export function resetAutonomousState(): void {
  prRetryCounters.clear();
  prLastDispatchAt.clear();
  prReviewedKeys.clear();
  prFixedKeys.clear();
  prBatchIndex.clear();
}

function pruneAutonomousCaches(): void {
  if (prReviewedKeys.size > 500) {
    prReviewedKeys.clear();
  }
  if (prFixedKeys.size > 500) {
    prFixedKeys.clear();
  }
  if (prRetryCounters.size > 500) {
    prRetryCounters.clear();
  }
  if (prLastDispatchAt.size > 500) {
    prLastDispatchAt.clear();
  }
}

export async function evaluateAutonomousPolicies(
  data: AppState,
  config: AppConfig,
  cwd?: string
): Promise<void> {
  pruneAutonomousCaches();

  const activeWorkers = Array.from(data.workers.values()).filter(
    (w) => w.status === 'running'
  );
  if (activeWorkers.length >= MAX_CONCURRENT_WORKERS) {
    return; // Concurrency cap reached
  }

  const prList = Array.from(data.prs.values());

  for (const pr of prList) {
    const keyStr = prKeyToString(pr.key);

    // If PR is closed or merged, clean up its state
    if (pr.state !== 'OPEN') {
      resetPrRetryCount(keyStr);
      continue;
    }

    // Only consider PRs belonging to user or in user scope (prevent running on teammate branches in team scope)
    const isUserPR =
      pr.scope === 'mine' ||
      pr.scope === 'both' ||
      pr.scope === undefined ||
      (Boolean(data.currentUser && data.currentUser !== 'unknown') &&
        pr.author.toLowerCase() === data.currentUser?.toLowerCase());

    if (!isUserPR) {
      continue;
    }

    const policy = getRepoPolicy(data, pr.key);
    const mode = getRepoMode(data, pr.key);

    if (mode === 'off' || !policy) {
      continue; // Autonomous delegation disabled for this repository
    }

    const isAlreadyWorking =
      data.workers.has(keyStr) && data.workers.get(keyStr)?.status === 'running';
    if (isAlreadyWorking) {
      continue; // Worker already running on this PR
    }

    const effectiveMode =
      data.dryRun || data.settings?.dryRun
        ? 'dry-run'
        : mode === 'dry-run'
        ? 'dry-run'
        : 'live';

    const allowedTriggers = policy.triggers || ['CiFailing', 'ChangesRequested', 'Reviewing'];

    // ── 1. Check CI Failure Trigger ──────────────────────────────────────────
    const isCiFailing = pr.overallStatus === 'CiFailing';
    const ciStageKey = `${keyStr}:ci`;

    if (!isCiFailing) {
      // PR CI is no longer failing — reset the CI retry counter
      prRetryCounters.delete(ciStageKey);
    } else if (allowedTriggers.includes('CiFailing')) {
      const lastAt = prLastDispatchAt.get(ciStageKey) || 0;
      if (Date.now() - lastAt < AUTONOMOUS_COOLDOWN_MS) {
        continue;
      }
      const retryCount = prRetryCounters.get(ciStageKey) || 0;
      if (retryCount >= MAX_CONSECUTIVE_AUTONOMOUS_RETRIES) {
        continue;
      }

      const allowedPbs = policy.allowedPlaybooks || ['ci-repair'];
      if (allowedPbs.length === 0 || !allowedPbs.includes('ci-repair')) {
        continue;
      }
      const playbookName = 'ci-repair';

      prRetryCounters.set(ciStageKey, retryCount + 1);
      prLastDispatchAt.set(ciStageKey, Date.now());

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
        pr.ciChecks?.find((c) => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT')?.name ||
        'test';

      const ciAgent = getRepoRoleAgent(data, pr.key, 'ciRepair');
      await dispatchAgent({
        data,
        pr,
        config,
        agentName: ciAgent,
        playbookName,
        trigger: 'autonomous_ci',
        mode: effectiveMode,
        ciLogs,
        failingCheck,
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

    // ── 2. Check Changes Requested / Review Comments Feedback Trigger ────────
    const hasFeedback =
      pr.overallStatus === 'ChangesRequested' ||
      (typeof pr.unresolvedThreadsCount === 'number' && pr.unresolvedThreadsCount > 0) ||
      (typeof pr.commentsCount === 'number' && pr.commentsCount > 0 && pr.reviewVerdict !== 'APPROVED');

    const fixStageKey = `${keyStr}:fix`;

    if (!hasFeedback) {
      // Feedback cleared — reset fix retry counter
      prRetryCounters.delete(fixStageKey);
    } else {
      const allowedPbsForFix = policy.allowedPlaybooks || ['address-comments'];
      if (
        (allowedTriggers.includes('ChangesRequested') || allowedTriggers.includes('Reviewing')) &&
        allowedPbsForFix.includes('address-comments')
      ) {
        const fixKey = `${keyStr}@comments-${pr.commentsCount || 0}-${pr.unresolvedThreadsCount || 0}@${pr.updatedAt || pr.branch}`;

        if (!prFixedKeys.has(fixKey)) {
          const lastAt = prLastDispatchAt.get(fixStageKey) || 0;
          if (Date.now() - lastAt < AUTONOMOUS_COOLDOWN_MS) {
            continue;
          }
          const retryCount = prRetryCounters.get(fixStageKey) || 0;
          if (retryCount >= MAX_CONSECUTIVE_AUTONOMOUS_RETRIES) {
            continue;
          }

          let rawComments = 'Reviewers provided comments and feedback.';
          try {
            rawComments = await fetchUnresolvedReviewComments(
              pr.key.owner,
              pr.key.repo,
              pr.key.number
            );
          } catch {
            // Fallback
          }

          const chunks = chunkReviewFeedback(rawComments, 3);
          const currentBatchIdx = prBatchIndex.get(fixStageKey) || 0;
          const activeChunk = chunks[currentBatchIdx] || chunks[0];
          const isLastBatch = currentBatchIdx + 1 >= chunks.length;

          const playbookName = 'address-comments';

          if (isLastBatch) {
            prFixedKeys.add(fixKey);
            prBatchIndex.delete(fixStageKey);
          } else {
            prBatchIndex.set(fixStageKey, currentBatchIdx + 1);
          }

          prRetryCounters.set(fixStageKey, retryCount + 1);
          prLastDispatchAt.set(fixStageKey, Date.now());

          appendLog(
            data,
            pr.key,
            `[policy] Autonomous trigger fired: Address Comments on ${keyStr} (Batch ${activeChunk.index}/${activeChunk.total})`
          );

          const fixerAgent = getRepoRoleAgent(data, pr.key, 'fixer');
          await dispatchAgent({
            data,
            pr,
            config,
            agentName: fixerAgent,
            playbookName,
            trigger: 'autonomous_review',
            mode: effectiveMode,
            comments: activeChunk.content,
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

    // ── 3. Check Reviewing / Pre-flight Review Trigger ─────────────────────────
    const isReviewing = pr.overallStatus === 'Reviewing';
    const reviewStageKey = `${keyStr}:review`;

    if (!isReviewing) {
      prRetryCounters.delete(reviewStageKey);
    } else {
      const allowedPbsForReview = policy.allowedPlaybooks || ['preflight-review'];
      if (
        !hasFeedback &&
        allowedTriggers.includes('Reviewing') &&
        allowedPbsForReview.includes('preflight-review')
      ) {
        const reviewRevisionKey = `${keyStr}@${pr.updatedAt || pr.branch}`;

        if (prReviewedKeys.has(reviewRevisionKey)) {
          continue; // Revision already reviewed
        }

        const lastAt = prLastDispatchAt.get(reviewStageKey) || 0;
        if (Date.now() - lastAt < AUTONOMOUS_COOLDOWN_MS) {
          continue;
        }
        const retryCount = prRetryCounters.get(reviewStageKey) || 0;
        if (retryCount >= MAX_CONSECUTIVE_AUTONOMOUS_RETRIES) {
          continue;
        }

        const playbookName = 'preflight-review';

        prReviewedKeys.add(reviewRevisionKey);
        prRetryCounters.set(reviewStageKey, retryCount + 1);
        prLastDispatchAt.set(reviewStageKey, Date.now());

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
          mode: effectiveMode,
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
}
