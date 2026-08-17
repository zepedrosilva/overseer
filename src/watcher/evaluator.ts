// ── PR Status Evaluator ──────────────────────────────────────────────────────
// Pure functions to evaluate Review Verdict, CI Status, and Overall PR Status.

import type {
  ReviewVerdict,
  CiStatus,
  PrOverallStatus,
  CiCheckRun,
  PrState,
} from '../app/types.js';

export interface RawReview {
  state: string; // 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  author?: string;
  submittedAt?: string;
}

export function evaluateReviewVerdict(reviews: RawReview[]): ReviewVerdict {
  if (!reviews || reviews.length === 0) {
    return 'NO_REVIEW';
  }

  // Track latest review state per author
  const latestByAuthor = new Map<string, string>();

  // Sort chronologically if submittedAt is present
  const sorted = [...reviews].sort((a, b) => {
    if (!a.submittedAt || !b.submittedAt) return 0;
    return new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
  });

  for (const review of sorted) {
    const author = review.author || 'anonymous';
    const state = review.state.toUpperCase();
    if (state === 'DISMISSED') {
      latestByAuthor.delete(author);
    } else if (state === 'APPROVED' || state === 'CHANGES_REQUESTED' || state === 'COMMENTED' || state === 'PENDING') {
      latestByAuthor.set(author, state);
    }
  }

  const latestStates = Array.from(latestByAuthor.values());

  if (latestStates.length === 0) {
    return 'NO_REVIEW';
  }

  // Any changes requested takes precedence
  if (latestStates.includes('CHANGES_REQUESTED')) {
    return 'CHANGES_REQUESTED';
  }

  // At least one approval (and no changes requested)
  if (latestStates.includes('APPROVED')) {
    return 'APPROVED';
  }

  if (latestStates.includes('COMMENTED')) {
    return 'COMMENTED';
  }

  if (latestStates.includes('PENDING')) {
    return 'PENDING';
  }

  return 'NO_REVIEW';
}

export function evaluateCiStatus(checks: CiCheckRun[]): CiStatus {
  if (!checks || checks.length === 0) {
    return 'UNKNOWN';
  }

  let hasFailure = false;
  let hasPending = false;
  let hasSuccess = false;

  for (const check of checks) {
    const status = check.status?.toUpperCase();
    const conclusion = check.conclusion?.toUpperCase();

    if (
      conclusion === 'FAILURE' ||
      conclusion === 'TIMED_OUT' ||
      conclusion === 'ACTION_REQUIRED' ||
      conclusion === 'CANCELLED'
    ) {
      hasFailure = true;
    } else if (status === 'IN_PROGRESS' || status === 'QUEUED' || !conclusion) {
      hasPending = true;
    } else if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') {
      hasSuccess = true;
    }
  }

  if (hasFailure) {
    return 'FAILURE';
  }

  if (hasPending) {
    return 'PENDING';
  }

  if (hasSuccess) {
    return 'SUCCESS';
  }

  return 'UNKNOWN';
}

export interface EvaluationInput {
  isDraft: boolean;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  reviewVerdict: ReviewVerdict;
  ciStatus: CiStatus;
  checksCount?: number;
}

export interface EvaluationResult {
  overallStatus: PrOverallStatus;
  statusDetail: string;
}

export function evaluateOverallStatus(input: EvaluationInput): EvaluationResult {
  if (input.state === 'MERGED') {
    return {
      overallStatus: 'Merged',
      statusDetail: 'PR merged',
    };
  }

  if (input.state === 'CLOSED') {
    return {
      overallStatus: 'Closed',
      statusDetail: 'PR closed',
    };
  }

  if (input.isDraft) {
    return {
      overallStatus: 'Draft',
      statusDetail: 'Draft PR',
    };
  }

  if (input.reviewVerdict === 'CHANGES_REQUESTED') {
    return {
      overallStatus: 'ChangesRequested',
      statusDetail: 'Reviewers requested changes',
    };
  }

  if (input.ciStatus === 'FAILURE') {
    return {
      overallStatus: 'CiFailing',
      statusDetail: 'CI check runs failing',
    };
  }

  if (input.reviewVerdict === 'APPROVED') {
    if (input.ciStatus === 'PENDING') {
      return {
        overallStatus: 'CiPending',
        statusDetail: 'Approved, waiting for CI checks',
      };
    }
    return {
      overallStatus: 'Ready',
      statusDetail: 'Approved and ready to merge',
    };
  }

  // Not approved yet (Reviewing or CiPending)
  if (input.ciStatus === 'PENDING') {
    return {
      overallStatus: 'CiPending',
      statusDetail: 'Awaiting review and CI checks',
    };
  }

  if (input.reviewVerdict === 'COMMENTED') {
    return {
      overallStatus: 'Reviewing',
      statusDetail: 'Comments posted, awaiting approval',
    };
  }

  return {
    overallStatus: 'Reviewing',
    statusDetail: 'Awaiting review',
  };
}

export interface ReviewBadgeResult {
  text: string;
  kind: 'approved' | 'changes_requested' | 'pending' | 'none';
}

export function formatReviewBadge(pr: Partial<PrState>): ReviewBadgeResult {
  const approved = pr.approvedCount ?? (pr.reviewVerdict === 'APPROVED' ? 1 : 0);
  const required = pr.requiredApprovalsCount ?? 0;
  const pending = pr.pendingReviewersCount ?? 0;
  const isChangesRequested =
    pr.reviewVerdict === 'CHANGES_REQUESTED' ||
    (Boolean(pr.changesRequestedReviewers && pr.changesRequestedReviewers.length > 0));

  if (required > 0) {
    if (approved >= required) {
      return {
        text: `✔ ${approved}/${required}`,
        kind: 'approved',
      };
    }
    if (isChangesRequested) {
      const pendStr = pending > 0 ? ` (${pending} pend)` : '';
      return {
        text: `✖ ${approved}/${required}${pendStr}`,
        kind: 'changes_requested',
      };
    }
    const pendStr = pending > 0 ? ` (${pending} pend)` : '';
    return {
      text: `⏳${approved}/${required}${pendStr}`,
      kind: 'pending',
    };
  }

  // No explicit branch protection rule (required === 0)
  if (isChangesRequested) {
    const pendStr = pending > 0 ? ` (${pending} pend)` : '';
    return {
      text: `✖ ${approved}${pendStr}`,
      kind: 'changes_requested',
    };
  }

  if (approved > 0) {
    const pendStr = pending > 0 ? ` (${pending} pend)` : '';
    return {
      text: `✔ ${approved}${pendStr}`,
      kind: 'approved',
    };
  }

  if (pending > 0) {
    return {
      text: `⏳0 (${pending} pend)`,
      kind: 'pending',
    };
  }

  return {
    text: '—',
    kind: 'none',
  };
}
