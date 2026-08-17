// ── GraphQL Batch Query Builder & Parser ──────────────────────────────────
// Batches PR status queries across multiple repositories using gh api graphql.

import type {
  RepoHandle,
  PrState,
  CiCheckRun,
} from '../app/types.js';
import {
  evaluateReviewVerdict,
  evaluateCiStatus,
  evaluateOverallStatus,
  type RawReview,
} from './evaluator.js';

export function buildBatchPRQuery(repos: RepoHandle[], prLimit: number = 20): string {
  if (repos.length === 0) {
    return 'query EmptyBatch { viewer { login } }';
  }

  const queries = repos.map((repo, idx) => {
    const safeOwner = JSON.stringify(repo.owner);
    const safeRepo = JSON.stringify(repo.repo);
    return `  repo_${idx}: repository(owner: ${safeOwner}, name: ${safeRepo}) {
    ...RepoPullRequests
  }`;
  }).join('\n');

  return `query BatchPullRequests {
${queries}
}

fragment RepoPullRequests on Repository {
  pullRequests(states: OPEN, first: ${prLimit}, orderBy: { field: UPDATED_AT, direction: DESC }) {
    nodes {
      number
      title
      url
      isDraft
      state
      headRefName
      baseRefName
      author {
        login
      }
      createdAt
      updatedAt
      comments {
        totalCount
      }
      assignees(first: 10) {
        nodes {
          login
        }
      }
      reviewRequests(first: 10) {
        nodes {
          requestedReviewer {
            ... on User {
              login
            }
          }
        }
      }
      reviewThreads(first: 20) {
        totalCount
        nodes {
          isResolved
        }
      }
      reviews(first: 15) {
        nodes {
          state
          author {
            login
          }
          submittedAt
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 25) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    detailsUrl
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;
}

export function buildSearchPRQuery(searchQuery: string, prLimit: number = 50): string {
  const safeQuery = JSON.stringify(searchQuery);
  return `query SearchPullRequests {
  search(query: ${safeQuery}, type: ISSUE, first: ${prLimit}) {
    issueCount
    nodes {
      __typename
      ... on PullRequest {
        number
        title
        url
        isDraft
        state
        headRefName
        baseRefName
        repository {
          name
          owner {
            login
          }
        }
        author {
          login
        }
        createdAt
        updatedAt
        comments {
          totalCount
        }
        assignees(first: 10) {
          nodes {
            login
          }
        }
        reviewRequests(first: 10) {
          nodes {
            requestedReviewer {
              ... on User {
                login
              }
            }
          }
        }
        reviewThreads(first: 20) {
          totalCount
          nodes {
            isResolved
          }
        }
        reviews(first: 15) {
          nodes {
            state
            author {
              login
            }
            submittedAt
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 25) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      detailsUrl
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;
}

export interface ParseGraphQLBatchOptions {
  currentUser?: string;
  filterUserOnly?: boolean;
}

export function parsePrNode(
  rawPr: Record<string, unknown>,
  repoFallback: RepoHandle,
  options?: ParseGraphQLBatchOptions
): PrState | null {
  const number = typeof rawPr.number === 'number' ? rawPr.number : 0;
  const title = String(rawPr.title || '');
  const url = String(rawPr.url || '');
  const isDraft = Boolean(rawPr.isDraft);
  const stateStr = String(rawPr.state || 'OPEN').toUpperCase();
  const state = (stateStr === 'MERGED' ? 'MERGED' : stateStr === 'CLOSED' ? 'CLOSED' : 'OPEN') as 'OPEN' | 'MERGED' | 'CLOSED';
  const branch = String(rawPr.headRefName || '');
  const baseBranch = String(rawPr.baseRefName || '');
  const authorObj = rawPr.author as { login?: string } | undefined;
  const author = authorObj?.login || 'unknown';
  const createdAt = String(rawPr.createdAt || new Date().toISOString());
  const updatedAt = String(rawPr.updatedAt || new Date().toISOString());

  // Repository extraction (prefer node's repository field if present, otherwise fallback)
  const repoObj = rawPr.repository as { name?: string; owner?: { login?: string } } | undefined;
  const owner = repoObj?.owner?.login || repoFallback.owner;
  const repo = repoObj?.name || repoFallback.repo;

  const commentsObj = rawPr.comments as { totalCount?: number } | undefined;
  const commentsCount = typeof commentsObj?.totalCount === 'number' ? commentsObj.totalCount : 0;

  // Assignees
  const assigneesObj = rawPr.assignees as { nodes?: Array<{ login?: string }> } | undefined;
  const assigneesList: string[] = [];
  if (Array.isArray(assigneesObj?.nodes)) {
    for (const a of assigneesObj.nodes) {
      if (a?.login) assigneesList.push(a.login.toLowerCase());
    }
  }

  // Review Requests
  const reviewReqObj = rawPr.reviewRequests as {
    nodes?: Array<{ requestedReviewer?: { login?: string } }>;
  } | undefined;
  const requestedReviewersList: string[] = [];
  if (Array.isArray(reviewReqObj?.nodes)) {
    for (const rr of reviewReqObj.nodes) {
      if (rr?.requestedReviewer?.login) {
        requestedReviewersList.push(rr.requestedReviewer.login.toLowerCase());
      }
    }
  }

  // Review Threads
  const threadsObj = rawPr.reviewThreads as { totalCount?: number; nodes?: Array<{ isResolved: boolean }> } | undefined;
  let unresolvedThreadsCount = 0;
  if (Array.isArray(threadsObj?.nodes)) {
    unresolvedThreadsCount = threadsObj.nodes.filter(t => !t.isResolved).length;
  }

  // Reviews
  const rawReviews = rawPr.reviews as { nodes?: unknown[] } | undefined;
  const reviewsList: RawReview[] = [];
  const reviewAuthorsList: string[] = [];
  if (Array.isArray(rawReviews?.nodes)) {
    for (const r of rawReviews.nodes) {
      if (r && typeof r === 'object') {
        const reviewItem = r as Record<string, unknown>;
        const rAuthor = reviewItem.author as { login?: string } | undefined;
        if (rAuthor?.login) {
          reviewAuthorsList.push(rAuthor.login.toLowerCase());
        }
        reviewsList.push({
          state: String(reviewItem.state || ''),
          author: rAuthor?.login,
          submittedAt: typeof reviewItem.submittedAt === 'string' ? reviewItem.submittedAt : undefined,
        });
      }
    }
  }

  const userFilter = options?.filterUserOnly && options?.currentUser && options.currentUser !== 'unknown'
    ? options.currentUser.toLowerCase()
    : null;

  // If user-only filter is active, check relevance
  if (userFilter) {
    const isAuthor = author.toLowerCase() === userFilter;
    const isRequestedReviewer = requestedReviewersList.includes(userFilter);
    const isReviewer = reviewAuthorsList.includes(userFilter);
    const isAssignee = assigneesList.includes(userFilter);

    if (!isAuthor && !isRequestedReviewer && !isReviewer && !isAssignee) {
      // PR is not authored by, assigned to, or reviewed by current user — skip it
      return null;
    }
  }

  // CI Checks
  const ciChecks: CiCheckRun[] = [];
  const commitsObj = rawPr.commits as { nodes?: Array<{ commit?: Record<string, unknown> }> } | undefined;
  const latestCommit = commitsObj?.nodes?.[0]?.commit;
  const rollup = latestCommit?.statusCheckRollup as { contexts?: { nodes?: unknown[] } } | undefined;
  const contextNodes = Array.isArray(rollup?.contexts?.nodes) ? rollup.contexts.nodes : [];

  for (const ctx of contextNodes) {
    if (!ctx || typeof ctx !== 'object') continue;
    const c = ctx as Record<string, unknown>;
    const typename = c.__typename;

    if (typename === 'CheckRun') {
      ciChecks.push({
        name: String(c.name || 'check'),
        status: String(c.status || 'COMPLETED') as CiCheckRun['status'],
        conclusion: c.conclusion ? (String(c.conclusion) as CiCheckRun['conclusion']) : undefined,
        url: typeof c.detailsUrl === 'string' ? c.detailsUrl : undefined,
      });
    } else if (typename === 'StatusContext') {
      const stateVal = String(c.state || '').toUpperCase();
      let conclusion: CiCheckRun['conclusion'];
      let status: CiCheckRun['status'] = 'COMPLETED';

      if (stateVal === 'SUCCESS') {
        conclusion = 'SUCCESS';
      } else if (stateVal === 'FAILURE' || stateVal === 'ERROR') {
        conclusion = 'FAILURE';
      } else if (stateVal === 'PENDING') {
        status = 'IN_PROGRESS';
      }

      ciChecks.push({
        name: String(c.context || 'status'),
        status,
        conclusion,
        url: typeof c.targetUrl === 'string' ? c.targetUrl : undefined,
      });
    }
  }

  const reviewVerdict = evaluateReviewVerdict(reviewsList);
  const ciStatus = evaluateCiStatus(ciChecks);
  const { overallStatus, statusDetail } = evaluateOverallStatus({
    isDraft,
    state,
    reviewVerdict,
    ciStatus,
    checksCount: ciChecks.length,
  });

  return {
    key: {
      owner,
      repo,
      number,
    },
    title,
    branch,
    baseBranch,
    author,
    url,
    isDraft,
    state,
    reviewVerdict,
    ciStatus,
    overallStatus,
    statusDetail,
    ciChecks,
    agent: repoFallback.agent,
    commentsCount,
    unresolvedThreadsCount,
    createdAt,
    updatedAt,
    log: [],
  };
}

export function parseGraphQLBatchResponse(
  rawResponse: Record<string, unknown>,
  repos: RepoHandle[],
  options?: ParseGraphQLBatchOptions
): PrState[] {
  const result: PrState[] = [];
  const data = (rawResponse?.data || rawResponse) as Record<string, unknown>;
  if (!data || typeof data !== 'object') {
    return result;
  }

  repos.forEach((repo, idx) => {
    const repoData = data[`repo_${idx}`] as Record<string, unknown> | null;
    if (!repoData || typeof repoData !== 'object') {
      return;
    }

    const prsConnection = repoData.pullRequests as { nodes?: unknown[] } | undefined;
    const prNodes = Array.isArray(prsConnection?.nodes) ? prsConnection.nodes : [];

    for (const rawPr of prNodes) {
      if (!rawPr || typeof rawPr !== 'object') continue;
      const parsed = parsePrNode(rawPr as Record<string, unknown>, repo, options);
      if (parsed) {
        result.push(parsed);
      }
    }
  });

  return result;
}

export function parseGraphQLSearchResponse(
  rawResponse: Record<string, unknown>,
  options?: ParseGraphQLBatchOptions,
  defaultAgent: string = 'claude'
): PrState[] {
  const result: PrState[] = [];
  const data = (rawResponse?.data || rawResponse) as Record<string, unknown>;
  if (!data || typeof data !== 'object') {
    return result;
  }

  const searchObj = data.search as { nodes?: unknown[] } | undefined;
  const nodes = Array.isArray(searchObj?.nodes) ? searchObj.nodes : [];

  for (const rawNode of nodes) {
    if (!rawNode || typeof rawNode !== 'object') continue;
    const node = rawNode as Record<string, unknown>;
    if (node.__typename && node.__typename !== 'PullRequest') {
      continue;
    }

    const parsed = parsePrNode(
      node,
      { owner: '', repo: '', url: '', agent: defaultAgent },
      options
    );

    if (parsed && parsed.key.owner && parsed.key.repo) {
      result.push(parsed);
    }
  }

  return result;
}
