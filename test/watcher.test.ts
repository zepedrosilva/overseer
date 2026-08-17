import { describe, it, expect } from 'vitest';
import { chunkRepos } from '../src/watcher/index.js';
import type { RepoHandle } from '../src/app/types.js';

describe('Watcher Coordinator', () => {
  describe('chunkRepos', () => {
    it('splits repositories into chunks based on chunkSize', () => {
      const repos: RepoHandle[] = Array.from({ length: 35 }, (_, i) => ({
        owner: 'owner',
        repo: `repo-${i}`,
        url: `https://github.com/owner/repo-${i}`,
        agent: 'claude',
      }));

      const chunks = chunkRepos(repos, 15);
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(15);
      expect(chunks[1]).toHaveLength(15);
      expect(chunks[2]).toHaveLength(5);
    });

    it('handles empty or smaller than chunk size arrays', () => {
      expect(chunkRepos([], 10)).toHaveLength(0);

      const small: RepoHandle[] = [
        { owner: 'o', repo: 'r', url: 'https://github.com/o/r', agent: 'claude' },
      ];
      const chunks = chunkRepos(small, 10);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveLength(1);
    });
  });

  describe('pollAllRepos', () => {
    it('handles search mode execution when no repos are statically configured', async () => {
      const { pollAllRepos } = await import('../src/watcher/index.js');
      const gh = await import('../src/watcher/gh.js');
      const vi = await import('vitest');

      const mockSearchData = {
        data: {
          search: {
            issueCount: 1,
            nodes: [
              {
                __typename: 'PullRequest',
                number: 101,
                title: 'chore: dynamically discovered repo PR',
                url: 'https://github.com/myorg/myrepo/pull/101',
                state: 'OPEN',
                repository: {
                  name: 'myrepo',
                  owner: { login: 'myorg' },
                },
                author: { login: 'zepedrosilva' },
                createdAt: '2026-08-17T12:00:00Z',
                updatedAt: '2026-08-17T12:00:00Z',
                comments: { totalCount: 0 },
                reviews: { nodes: [] },
              },
            ],
          },
        },
      };

      const spy = vi.vi.spyOn(gh, 'runGraphQL').mockResolvedValueOnce(mockSearchData);

      const data = {
        repos: [],
        prs: new Map(),
        workers: new Map(),
        dryRun: false,
        currentUser: 'zepedrosilva',
      };

      const config = {
        defaults: {
          agent: 'claude',
          pollIntervalSecs: 90,
          worktrees_dir: './.overseer/worktrees',
          batch_size: 8,
          filter_user_only: true,
        },
        repos: [],
        agents: {},
        runtime: { dryRun: false },
        streamdeck: { enabled: false, port: 3210 },
      };

      await pollAllRepos(data, config);

      expect(data.prs.size).toBe(1);
      expect(data.prs.get('myorg/myrepo#101')?.title).toBe('chore: dynamically discovered repo PR');
      // Repos should be dynamically populated
      expect(data.repos).toHaveLength(1);
      expect(data.repos[0].owner).toBe('myorg');
      expect(data.repos[0].repo).toBe('myrepo');

      spy.mockRestore();
    });
  });
});
