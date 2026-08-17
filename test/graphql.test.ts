import { describe, it, expect } from 'vitest';
import {
  buildBatchPRQuery,
  parseGraphQLBatchResponse,
  buildSearchPRQuery,
  parseGraphQLSearchResponse,
} from '../src/watcher/graphql.js';
import type { RepoHandle } from '../src/app/types.js';

describe('GraphQL Query Builder & Parser', () => {
  const repos: RepoHandle[] = [
    { owner: 'acme-corp', repo: 'billing', url: 'https://github.com/acme-corp/billing', agent: 'claude' },
    { owner: 'zepedrosilva', repo: 'overseer', url: 'https://github.com/zepedrosilva/overseer', agent: 'gemini' },
  ];

  describe('buildBatchPRQuery', () => {
    it('builds valid GraphQL document with aliases for each repo', () => {
      const query = buildBatchPRQuery(repos, 25);
      expect(query).toContain('query BatchPullRequests');
      expect(query).toContain('repo_0: repository(owner: "acme-corp", name: "billing")');
      expect(query).toContain('repo_1: repository(owner: "zepedrosilva", name: "overseer")');
      expect(query).toContain('first: 25');
      expect(query).toContain('fragment RepoPullRequests on Repository');
    });

    it('handles empty repo list gracefully', () => {
      const query = buildBatchPRQuery([]);
      expect(query).toContain('query EmptyBatch');
    });
  });

  describe('parseGraphQLBatchResponse', () => {
    const mockResponse = {
      data: {
        repo_0: {
          pullRequests: {
            nodes: [
              {
                number: 142,
                title: 'fix: invoice balance calculation',
                url: 'https://github.com/acme-corp/billing/pull/142',
                isDraft: false,
                state: 'OPEN',
                headRefName: 'fix/invoice-rounding',
                baseRefName: 'main',
                author: { login: 'josesilva' },
                createdAt: '2026-08-17T10:00:00Z',
                updatedAt: '2026-08-17T11:00:00Z',
                comments: { totalCount: 3 },
                reviewThreads: {
                  totalCount: 2,
                  nodes: [{ isResolved: true }, { isResolved: false }],
                },
                reviews: {
                  nodes: [
                    { state: 'APPROVED', author: { login: 'reviewer1' }, submittedAt: '2026-08-17T10:30:00Z' },
                  ],
                },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          state: 'SUCCESS',
                          contexts: {
                            nodes: [
                              {
                                __typename: 'CheckRun',
                                name: 'unit-tests',
                                status: 'COMPLETED',
                                conclusion: 'SUCCESS',
                                detailsUrl: 'https://ci/1',
                              },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        repo_1: {
          pullRequests: {
            nodes: [
              {
                number: 10,
                title: 'docs: update readme',
                url: 'https://github.com/zepedrosilva/overseer/pull/10',
                isDraft: true,
                state: 'OPEN',
                headRefName: 'docs/readme',
                baseRefName: 'main',
                author: { login: 'zepedrosilva' },
                createdAt: '2026-08-17T12:00:00Z',
                updatedAt: '2026-08-17T12:05:00Z',
                comments: { totalCount: 0 },
                reviews: { nodes: [] },
              },
            ],
          },
        },
      },
    };

    it('parses multi-repo GraphQL response into PrState array', () => {
      const result = parseGraphQLBatchResponse(mockResponse, repos);
      expect(result).toHaveLength(2);

      const pr1 = result[0];
      expect(pr1.key).toEqual({ owner: 'acme-corp', repo: 'billing', number: 142 });
      expect(pr1.title).toBe('fix: invoice balance calculation');
      expect(pr1.overallStatus).toBe('Ready');
      expect(pr1.reviewVerdict).toBe('APPROVED');
      expect(pr1.ciStatus).toBe('SUCCESS');
      expect(pr1.commentsCount).toBe(3);
      expect(pr1.unresolvedThreadsCount).toBe(1);
      expect(pr1.ciChecks).toHaveLength(1);
      expect(pr1.agent).toBe('claude');

      const pr2 = result[1];
      expect(pr2.key).toEqual({ owner: 'zepedrosilva', repo: 'overseer', number: 10 });
      expect(pr2.overallStatus).toBe('Draft');
      expect(pr2.isDraft).toBe(true);
      expect(pr2.agent).toBe('gemini');
    });

    it('filters PRs to only those relevant to current user when filterUserOnly is enabled', () => {
      // User josesilva authored PR 142 but not PR 10
      const filtered = parseGraphQLBatchResponse(mockResponse, repos, {
        currentUser: 'josesilva',
        filterUserOnly: true,
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].key.number).toBe(142);
    });

    it('includes PRs where user is requested reviewer', () => {
      const reviewReqResponse = {
        data: {
          repo_0: {
            pullRequests: {
              nodes: [
                {
                  number: 200,
                  title: 'Security audit',
                  url: 'https://github.com/acme-corp/billing/pull/200',
                  state: 'OPEN',
                  author: { login: 'otherdev' },
                  reviewRequests: {
                    nodes: [{ requestedReviewer: { login: 'josesilva' } }],
                  },
                },
              ],
            },
          },
        },
      };

      const filtered = parseGraphQLBatchResponse(reviewReqResponse, [repos[0]], {
        currentUser: 'josesilva',
        filterUserOnly: true,
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].key.number).toBe(200);
    });

    it('gracefully handles null or missing repo nodes in response', () => {
      const emptyResponse = {
        data: {
          repo_0: null,
          repo_1: {
            pullRequests: {
              nodes: [],
            },
          },
        },
      };

      const result = parseGraphQLBatchResponse(emptyResponse, repos);
      expect(result).toHaveLength(0);
    });
  });

  describe('buildSearchPRQuery', () => {
    it('builds valid GraphQL search query document', () => {
      const query = buildSearchPRQuery('is:pr is:open involves:josesilva', 50);
      expect(query).toContain('query SearchPullRequests');
      expect(query).toContain('search(query: "is:pr is:open involves:josesilva", type: ISSUE, first: 50)');
      expect(query).toContain('... on PullRequest');
      expect(query).toContain('repository');
    });
  });

  describe('parseGraphQLSearchResponse', () => {
    const mockSearchResponse = {
      data: {
        search: {
          issueCount: 2,
          nodes: [
            {
              __typename: 'PullRequest',
              number: 42,
              title: 'feat: add global PR search',
              url: 'https://github.com/zepedrosilva/overseer/pull/42',
              isDraft: false,
              state: 'OPEN',
              headRefName: 'feature/search-mode',
              baseRefName: 'main',
              repository: {
                name: 'overseer',
                owner: { login: 'zepedrosilva' },
              },
              author: { login: 'zepedrosilva' },
              createdAt: '2026-08-17T12:00:00Z',
              updatedAt: '2026-08-17T12:30:00Z',
              comments: { totalCount: 2 },
              reviewThreads: { totalCount: 0, nodes: [] },
              reviews: {
                nodes: [
                  { state: 'APPROVED', author: { login: 'teammate' }, submittedAt: '2026-08-17T12:15:00Z' },
                ],
              },
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        state: 'SUCCESS',
                        contexts: {
                          nodes: [
                            {
                              __typename: 'CheckRun',
                              name: 'build',
                              status: 'COMPLETED',
                              conclusion: 'SUCCESS',
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
            {
              __typename: 'PullRequest',
              number: 88,
              title: 'fix: handle missing config',
              url: 'https://github.com/acme-corp/api-gateway/pull/88',
              isDraft: false,
              state: 'OPEN',
              headRefName: 'fix/config',
              baseRefName: 'master',
              repository: {
                name: 'api-gateway',
                owner: { login: 'acme-corp' },
              },
              author: { login: 'otherauthor' },
              reviewRequests: {
                nodes: [{ requestedReviewer: { login: 'zepedrosilva' } }],
              },
              createdAt: '2026-08-17T14:00:00Z',
              updatedAt: '2026-08-17T14:10:00Z',
              comments: { totalCount: 0 },
              reviews: { nodes: [] },
            },
          ],
        },
      },
    };

    it('parses search GraphQL response and extracts repository dynamically', () => {
      const result = parseGraphQLSearchResponse(mockSearchResponse, undefined, 'claude');
      expect(result).toHaveLength(2);

      expect(result[0].key).toEqual({ owner: 'zepedrosilva', repo: 'overseer', number: 42 });
      expect(result[0].title).toBe('feat: add global PR search');
      expect(result[0].overallStatus).toBe('Ready');
      expect(result[0].reviewVerdict).toBe('APPROVED');
      expect(result[0].ciStatus).toBe('SUCCESS');

      expect(result[1].key).toEqual({ owner: 'acme-corp', repo: 'api-gateway', number: 88 });
      expect(result[1].title).toBe('fix: handle missing config');
    });

    it('applies user-only filter on search results', () => {
      const filtered = parseGraphQLSearchResponse(mockSearchResponse, {
        currentUser: 'zepedrosilva',
        filterUserOnly: true,
      });

      // Both PR 42 (author) and PR 88 (requested reviewer) match user zepedrosilva
      expect(filtered).toHaveLength(2);

      const filteredOther = parseGraphQLSearchResponse(mockSearchResponse, {
        currentUser: 'unrelateduser',
        filterUserOnly: true,
      });
      expect(filteredOther).toHaveLength(0);
    });

    it('skips non-PullRequest nodes in search response', () => {
      const mixedResponse = {
        data: {
          search: {
            nodes: [
              { __typename: 'Issue', number: 1 },
              null,
              mockSearchResponse.data.search.nodes[0],
            ],
          },
        },
      };

      const result = parseGraphQLSearchResponse(mixedResponse);
      expect(result).toHaveLength(1);
      expect(result[0].key.number).toBe(42);
    });
  });
});
