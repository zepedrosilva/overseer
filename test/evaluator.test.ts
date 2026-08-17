import { describe, it, expect } from 'vitest';
import {
  evaluateReviewVerdict,
  evaluateCiStatus,
  evaluateOverallStatus,
  formatReviewBadge,
} from '../src/watcher/evaluator.js';
import type { CiCheckRun } from '../src/app/types.js';

describe('PR Status Evaluator', () => {
  describe('evaluateReviewVerdict', () => {
    it('returns NO_REVIEW when review list is empty', () => {
      expect(evaluateReviewVerdict([])).toBe('NO_REVIEW');
    });

    it('returns APPROVED when approved by reviewers', () => {
      expect(
        evaluateReviewVerdict([
          { state: 'APPROVED', author: 'alice', submittedAt: '2026-08-17T10:00:00Z' },
          { state: 'APPROVED', author: 'bob', submittedAt: '2026-08-17T11:00:00Z' },
        ])
      ).toBe('APPROVED');
    });

    it('returns CHANGES_REQUESTED when any reviewer requests changes', () => {
      expect(
        evaluateReviewVerdict([
          { state: 'APPROVED', author: 'alice', submittedAt: '2026-08-17T10:00:00Z' },
          { state: 'CHANGES_REQUESTED', author: 'bob', submittedAt: '2026-08-17T11:00:00Z' },
        ])
      ).toBe('CHANGES_REQUESTED');
    });

    it('considers latest review per author', () => {
      // Bob requested changes first, then later approved
      expect(
        evaluateReviewVerdict([
          { state: 'CHANGES_REQUESTED', author: 'bob', submittedAt: '2026-08-17T10:00:00Z' },
          { state: 'APPROVED', author: 'bob', submittedAt: '2026-08-17T12:00:00Z' },
        ])
      ).toBe('APPROVED');

      // Alice approved first, then requested changes
      expect(
        evaluateReviewVerdict([
          { state: 'APPROVED', author: 'alice', submittedAt: '2026-08-17T10:00:00Z' },
          { state: 'CHANGES_REQUESTED', author: 'alice', submittedAt: '2026-08-17T12:00:00Z' },
        ])
      ).toBe('CHANGES_REQUESTED');
    });

    it('handles DISMISSED reviews', () => {
      expect(
        evaluateReviewVerdict([
          { state: 'CHANGES_REQUESTED', author: 'bob', submittedAt: '2026-08-17T10:00:00Z' },
          { state: 'DISMISSED', author: 'bob', submittedAt: '2026-08-17T11:00:00Z' },
        ])
      ).toBe('NO_REVIEW');
    });

    it('returns COMMENTED when reviews only contain comments', () => {
      expect(
        evaluateReviewVerdict([
          { state: 'COMMENTED', author: 'carol', submittedAt: '2026-08-17T10:00:00Z' },
        ])
      ).toBe('COMMENTED');
    });
  });

  describe('evaluateCiStatus', () => {
    it('returns UNKNOWN when check runs list is empty', () => {
      expect(evaluateCiStatus([])).toBe('UNKNOWN');
    });

    it('returns SUCCESS when all checks passed or are neutral/skipped', () => {
      const checks: CiCheckRun[] = [
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'lint', status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      ];
      expect(evaluateCiStatus(checks)).toBe('SUCCESS');
    });

    it('returns FAILURE when any check failed or timed out', () => {
      const checks: CiCheckRun[] = [
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' },
      ];
      expect(evaluateCiStatus(checks)).toBe('FAILURE');

      const timedOutChecks: CiCheckRun[] = [
        { name: 'e2e', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      ];
      expect(evaluateCiStatus(timedOutChecks)).toBe('FAILURE');
    });

    it('returns PENDING when checks are in progress and none failed', () => {
      const checks: CiCheckRun[] = [
        { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'test', status: 'IN_PROGRESS' },
      ];
      expect(evaluateCiStatus(checks)).toBe('PENDING');

      const queuedChecks: CiCheckRun[] = [
        { name: 'deploy', status: 'QUEUED' },
      ];
      expect(evaluateCiStatus(queuedChecks)).toBe('PENDING');
    });
  });

  describe('evaluateOverallStatus', () => {
    it('handles MERGED state', () => {
      const res = evaluateOverallStatus({
        isDraft: false,
        state: 'MERGED',
        reviewVerdict: 'APPROVED',
        ciStatus: 'SUCCESS',
      });
      expect(res.overallStatus).toBe('Merged');
    });

    it('handles CLOSED state', () => {
      const res = evaluateOverallStatus({
        isDraft: false,
        state: 'CLOSED',
        reviewVerdict: 'NO_REVIEW',
        ciStatus: 'UNKNOWN',
      });
      expect(res.overallStatus).toBe('Closed');
    });

    it('handles Draft PRs', () => {
      const res = evaluateOverallStatus({
        isDraft: true,
        state: 'OPEN',
        reviewVerdict: 'NO_REVIEW',
        ciStatus: 'SUCCESS',
      });
      expect(res.overallStatus).toBe('Draft');
    });

    it('returns ChangesRequested when changes are requested', () => {
      const res = evaluateOverallStatus({
        isDraft: false,
        state: 'OPEN',
        reviewVerdict: 'CHANGES_REQUESTED',
        ciStatus: 'SUCCESS',
      });
      expect(res.overallStatus).toBe('ChangesRequested');
    });

    it('returns CiFailing when CI check failed even if approved', () => {
      const res = evaluateOverallStatus({
        isDraft: false,
        state: 'OPEN',
        reviewVerdict: 'APPROVED',
        ciStatus: 'FAILURE',
      });
      expect(res.overallStatus).toBe('CiFailing');
    });

    it('returns Ready when approved and CI passing', () => {
      const res = evaluateOverallStatus({
        isDraft: false,
        state: 'OPEN',
        reviewVerdict: 'APPROVED',
        ciStatus: 'SUCCESS',
      });
      expect(res.overallStatus).toBe('Ready');
      expect(res.statusDetail).toContain('ready to merge');
    });

    it('returns CiPending when approved but CI is running', () => {
      const res = evaluateOverallStatus({
        isDraft: false,
        state: 'OPEN',
        reviewVerdict: 'APPROVED',
        ciStatus: 'PENDING',
      });
      expect(res.overallStatus).toBe('CiPending');
    });

    it('returns Reviewing when in progress with no review', () => {
      const res = evaluateOverallStatus({
        isDraft: false,
        state: 'OPEN',
        reviewVerdict: 'NO_REVIEW',
        ciStatus: 'SUCCESS',
      });
      expect(res.overallStatus).toBe('Reviewing');
    });
  });

  describe('formatReviewBadge', () => {
    it('formats approved state when meeting required count', () => {
      const badge = formatReviewBadge({
        approvedCount: 2,
        requiredApprovalsCount: 2,
        pendingReviewersCount: 0,
      });
      expect(badge.text).toBe('✔ 2/2');
      expect(badge.kind).toBe('approved');
    });

    it('formats pending state with required approvals and pending reviewers without extra emoji space', () => {
      const badge = formatReviewBadge({
        approvedCount: 1,
        requiredApprovalsCount: 2,
        pendingReviewersCount: 1,
      });
      expect(badge.text).toBe('⏳1/2 (1 pend)');
      expect(badge.kind).toBe('pending');
    });

    it('formats changes requested with required approvals and pending reviewers', () => {
      const badge = formatReviewBadge({
        approvedCount: 0,
        requiredApprovalsCount: 2,
        pendingReviewersCount: 1,
        reviewVerdict: 'CHANGES_REQUESTED',
      });
      expect(badge.text).toBe('✖ 0/2 (1 pend)');
      expect(badge.kind).toBe('changes_requested');
    });

    it('formats unconfigured rule PR with single approval', () => {
      const badge = formatReviewBadge({
        approvedCount: 1,
        requiredApprovalsCount: 0,
        pendingReviewersCount: 0,
      });
      expect(badge.text).toBe('✔ 1');
      expect(badge.kind).toBe('approved');
    });

    it('formats unconfigured rule PR with pending reviewers', () => {
      const badge = formatReviewBadge({
        approvedCount: 0,
        requiredApprovalsCount: 0,
        pendingReviewersCount: 1,
      });
      expect(badge.text).toBe('⏳0 (1 pend)');
      expect(badge.kind).toBe('pending');
    });

    it('formats unconfigured rule PR with no reviews or requests', () => {
      const badge = formatReviewBadge({
        approvedCount: 0,
        requiredApprovalsCount: 0,
        pendingReviewersCount: 0,
      });
      expect(badge.text).toBe('—');
      expect(badge.kind).toBe('none');
    });
  });
});
