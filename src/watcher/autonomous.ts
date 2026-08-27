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
export const MAX_BREAKER_ENTRIES = 500;

// In-memory retry & cooldown tracker (synchronized with AppState.circuitBreaker)
const prRetryCounters = new Map<string, number>();
const prLastDispatchAt = new Map<string, number>();
const prReviewedKeys = new Set<string>();
const prFixedKeys = new Set<string>();
const prBatchIndex = new Map<string, number>();

export function syncFromCircuitBreaker(data: AppState): void {
  if (!data.circuitBreaker) {
    data.circuitBreaker = {
      retryCounters: {},
      lastDispatchAt: {},
      reviewedKeys: [],
      fixedKeys: [],
      batchIndex: {},
    };
  }
  const cb = data.circuitBreaker;
  if (cb.retryCounters) {
    for (const [k, v] of Object.entries(cb.retryCounters)) {
      prRetryCounters.set(k, v);
    }
  }
  if (cb.lastDispatchAt) {
    for (const [k, v] of Object.entries(cb.lastDispatchAt)) {
      prLastDispatchAt.set(k, v);
    }
  }
  if (Array.isArray(cb.reviewedKeys)) {
    for (const k of cb.reviewedKeys) {
      prReviewedKeys.add(k);
    }
  }
  if (Array.isArray(cb.fixedKeys)) {
    for (const k of cb.fixedKeys) {
      prFixedKeys.add(k);
    }
  }
  if (cb.batchIndex) {
    for (const [k, v] of Object.entries(cb.batchIndex)) {
      prBatchIndex.set(k, v);
    }
  }
}

export function syncToCircuitBreaker(data: AppState): void {
  if (!data.circuitBreaker) {
    data.circuitBreaker = {};
  }
  data.circuitBreaker.retryCounters = Object.fromEntries(prRetryCounters.entries());
  data.circuitBreaker.lastDispatchAt = Object.fromEntries(prLastDispatchAt.entries());
  data.circuitBreaker.reviewedKeys = Array.from(prReviewedKeys);
  data.circuitBreaker.fixedKeys = Array.from(prFixedKeys);
  data.circuitBreaker.batchIndex = Object.fromEntries(prBatchIndex.entries());
}

export function getPrRetryCount(keyStr: string, stage?: 'ci' | 'fix' | 'review', data?: AppState): number {
  if (data?.circuitBreaker?.retryCounters) {
    if (stage) {
      return data.circuitBreaker.retryCounters[`${keyStr}:${stage}`] ?? prRetryCounters.get(`${keyStr}:${stage}`) ?? 0;
    }
    return (
      data.circuitBreaker.retryCounters[keyStr] ??
      data.circuitBreaker.retryCounters[`${keyStr}:ci`] ??
      data.circuitBreaker.retryCounters[`${keyStr}:fix`] ??
      data.circuitBreaker.retryCounters[`${keyStr}:review`] ??
      prRetryCounters.get(keyStr) ??
      prRetryCounters.get(`${keyStr}:ci`) ??
      prRetryCounters.get(`${keyStr}:fix`) ??
      prRetryCounters.get(`${keyStr}:review`) ??
      0
    );
  }
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

export function resetPrRetryCount(keyStr: string, stage?: 'ci' | 'fix' | 'review', data?: AppState): void {
  if (stage) {
    prRetryCounters.delete(`${keyStr}:${stage}`);
  } else {
    prRetryCounters.delete(keyStr);
    prRetryCounters.delete(`${keyStr}:ci`);
    prRetryCounters.delete(`${keyStr}:fix`);
    prRetryCounters.delete(`${keyStr}:review`);
    prBatchIndex.delete(keyStr);
    prBatchIndex.delete(`${keyStr}:fix`);
  }
  if (data?.circuitBreaker) {
    syncToCircuitBreaker(data);
  }
}

export function resetAutonomousState(data?: AppState): void {
  prRetryCounters.clear();
  prLastDispatchAt.clear();
  prReviewedKeys.clear();
  prFixedKeys.clear();
  prBatchIndex.clear();
  if (data?.circuitBreaker) {
    data.circuitBreaker.retryCounters = {};
    data.circuitBreaker.lastDispatchAt = {};
    data.circuitBreaker.reviewedKeys = [];
    data.circuitBreaker.fixedKeys = [];
    data.circuitBreaker.batchIndex = {};
  }
}

function trimSet(set: Set<string>, maxSize: number): void {
  if (set.size > maxSize) {
    const toRemove = set.size - maxSize;
    let count = 0;
    for (const item of set) {
      set.delete(item);
      count++;
      if (count >= toRemove) break;
    }
  }
}

function trimMap<K, V>(map: Map<K, V>, maxSize: number): void {
  if (map.size > maxSize) {
    const toRemove = map.size - maxSize;
    let count = 0;
    for (const key of map.keys()) {
      map.delete(key);
      count++;
      if (count >= toRemove) break;
    }
  }
}

export function pruneAutonomousCaches(data?: AppState): void {
  // 1. Prune timestamps older than 24 hours (cooldowns are only 15s)
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;
  for (const [k, timestamp] of prLastDispatchAt.entries()) {
    if (now - timestamp > maxAge) {
      prLastDispatchAt.delete(k);
    }
  }

  // 2. Bound collection sizes by removing oldest entries (FIFO)
  trimSet(prReviewedKeys, MAX_BREAKER_ENTRIES);
  trimSet(prFixedKeys, MAX_BREAKER_ENTRIES);
  trimMap(prRetryCounters, MAX_BREAKER_ENTRIES);
  trimMap(prLastDispatchAt, MAX_BREAKER_ENTRIES);
  trimMap(prBatchIndex, MAX_BREAKER_ENTRIES);

  // 3. If data is provided, clean up closed/merged PRs
  if (data?.prs) {
    const openKeys = new Set(
      Array.from(data.prs.values())
        .filter((p) => p.state === 'OPEN')
        .map((p) => prKeyToString(p.key))
    );
    for (const key of prRetryCounters.keys()) {
      const baseKey = key.split(':')[0];
      if (!openKeys.has(baseKey)) {
        prRetryCounters.delete(key);
      }
    }
    for (const key of prBatchIndex.keys()) {
      const baseKey = key.split(':')[0];
      if (!openKeys.has(baseKey)) {
        prBatchIndex.delete(key);
      }
    }
  }
}

export async function evaluateAutonomousPolicies(
  data: AppState,
  config: AppConfig,
  cwd?: string
): Promise<void> {
  if (data.extensions?.agents?.enabled === false) {
    return;
  }

  syncFromCircuitBreaker(data);
  pruneAutonomousCaches(data);

  try {
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
        resetPrRetryCount(keyStr, undefined, data);
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
  } finally {
    syncToCircuitBreaker(data);
  }
}
