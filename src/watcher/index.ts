// ── Multi-Repo Watcher Coordinator ─────────────────────────────────────────
// Batches repository queries using GraphQL, handles timeouts with adaptive
// sub-chunk fallbacks, filters user-relevant PRs, and safely logs.

import fs from 'node:fs';
import path from 'node:path';
import type { AppState, AppConfig, RepoHandle, PrState } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { upsertPR, updatePRStatus, appendLog, saveState, resolveStateDir, recordHistoricalPr } from '../app/state.js';
import { runGraphQL, fetchTeamMembers } from './gh.js';
import {
  buildBatchPRQuery,
  parseGraphQLBatchResponse,
  buildSearchPRQuery,
  parseGraphQLSearchResponse,
  type ParseGraphQLBatchOptions,
} from './graphql.js';

export function chunkRepos(repos: RepoHandle[], chunkSize: number): RepoHandle[][] {
  const chunks: RepoHandle[][] = [];
  const size = Math.max(1, chunkSize);
  for (let i = 0; i < repos.length; i += size) {
    chunks.push(repos.slice(i, i + size));
  }
  return chunks;
}

function logWatcherMessage(message: string): void {
  try {
    const logsDir = path.join(resolveStateDir(), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const logFile = path.join(logsDir, 'watcher.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`, 'utf-8');
  } catch {
    // Avoid crashing if filesystem logging fails
  }
}

async function fetchSearchPrs(
  searchQuery: string,
  options?: ParseGraphQLBatchOptions,
  defaultAgent?: string
): Promise<PrState[]> {
  try {
    const query = buildSearchPRQuery(searchQuery, 50);
    const rawResponse = await runGraphQL<Record<string, unknown>>(query);
    return parseGraphQLSearchResponse(rawResponse, options, defaultAgent);
  } catch (err) {
    logWatcherMessage(`Search query [${searchQuery}] failed: ${(err as Error).message}`);
    return [];
  }
}

async function fetchChunkPrs(
  chunk: RepoHandle[],
  options?: ParseGraphQLBatchOptions
): Promise<PrState[]> {
  try {
    const query = buildBatchPRQuery(chunk);
    const rawResponse = await runGraphQL<Record<string, unknown>>(query);
    return parseGraphQLBatchResponse(rawResponse, chunk, options);
  } catch (err) {
    const repoNames = chunk.map((r) => `${r.owner}/${r.repo}`).join(', ');
    logWatcherMessage(`Batch failed for [${repoNames}]: ${(err as Error).message}`);

    // If chunk has multiple repos and failed (e.g. 504 timeout), fallback to 1-by-1
    if (chunk.length > 1) {
      logWatcherMessage(`Falling back to 1-by-1 queries for [${repoNames}]`);
      const fallbackResults: PrState[] = [];
      for (const repo of chunk) {
        try {
          const singleQuery = buildBatchPRQuery([repo], 15);
          const singleResponse = await runGraphQL<Record<string, unknown>>(singleQuery);
          const singlePrs = parseGraphQLBatchResponse(singleResponse, [repo], options);
          fallbackResults.push(...singlePrs);
        } catch (singleErr) {
          logWatcherMessage(`Single repo poll failed for ${repo.owner}/${repo.repo}: ${(singleErr as Error).message}`);
        }
      }
      return fallbackResults;
    }

    return [];
  }
}

export async function pollAllRepos(
  data: AppState,
  config: AppConfig
): Promise<void> {
  data.isPolling = true;

  const filterOptions: ParseGraphQLBatchOptions = {
    currentUser: data.currentUser || config.defaults.user,
    filterUserOnly: config.defaults.filter_user_only,
  };

  const seenPrKeys = new Set<string>();
  const isSearchMode = Boolean(config.defaults.search_query) || config.repos.length === 0;

  try {
    if (isSearchMode) {
      const user = data.currentUser || config.defaults?.user;
      const teamSlug = data.settings?.team || config.defaults?.team;

      // 1. Personal Query
      const queryStr = config.defaults.search_query
        || (user && user !== 'unknown' ? `is:pr is:open involves:${user}` : 'is:pr is:open involves:@me');

      const parsedPrs = await fetchSearchPrs(queryStr, filterOptions, config.defaults.agent);
      const stagedPrs = new Map<string, PrState>();
      const discoveredRepos = new Map<string, RepoHandle>();

      for (const pr of parsedPrs) {
        const keyStr = prKeyToString(pr.key);
        stagedPrs.set(keyStr, pr);

        const repoKey = `${pr.key.owner.toLowerCase()}/${pr.key.repo.toLowerCase()}`;
        if (!discoveredRepos.has(repoKey)) {
          discoveredRepos.set(repoKey, {
            owner: pr.key.owner,
            repo: pr.key.repo,
            url: `https://github.com/${pr.key.owner}/${pr.key.repo}`,
            agent: config.defaults.agent,
          });
        }
      }

      // 2. Team Query (if team slug/members configured)
      if (teamSlug) {
        if (!data.teamMembers || data.teamMembers.length === 0) {
          const fetched = await fetchTeamMembers(teamSlug);
          if (fetched.length > 0) {
            data.teamMembers = fetched;
          }
        }

        const teamFilterOpts: ParseGraphQLBatchOptions = {
          ...filterOptions,
          team: teamSlug,
          isTeamQuery: true,
        };
        const teamQuery = teamSlug.includes('/') ? `is:pr is:open team:${teamSlug}` : `is:pr is:open ${teamSlug}`;

        // Also query PRs for team members (combined into chunked search queries for high throughput)
        const memberLogins = (data.teamMembers || []).filter(
          (m) => m.toLowerCase() !== (data.currentUser || '').toLowerCase()
        );

        const memberQueries: string[] = [];
        if (memberLogins.length > 0) {
          // Batch up to 12 members per involves: query
          for (let i = 0; i < memberLogins.length; i += 12) {
            const chunk = memberLogins.slice(i, i + 12);
            const chunkQuery = `is:pr is:open ${chunk.map((m) => `involves:${m}`).join(' ')}`;
            memberQueries.push(chunkQuery);
          }
        }

        // Fetch team query and member chunk queries concurrently in parallel
        const allTeamFetchPromises = [
          fetchSearchPrs(teamQuery, teamFilterOpts, config.defaults.agent),
          ...memberQueries.map((q) => fetchSearchPrs(q, teamFilterOpts, config.defaults.agent)),
        ];

        const fetchResults = await Promise.all(allTeamFetchPromises);
        const teamPrs: PrState[] = [];
        const seenTeamKeys = new Set<string>();

        for (const batch of fetchResults) {
          for (const pr of batch) {
            const keyStr = prKeyToString(pr.key);
            if (!seenTeamKeys.has(keyStr)) {
              seenTeamKeys.add(keyStr);
              teamPrs.push(pr);
            }
          }
        }

        for (const pr of teamPrs) {
          const keyStr = prKeyToString(pr.key);
          const existingStaged = stagedPrs.get(keyStr);
          if (existingStaged) {
            existingStaged.scope = 'both';
          } else {
            stagedPrs.set(keyStr, {
              ...pr,
              scope: 'team',
            });
          }

          const repoKey = `${pr.key.owner.toLowerCase()}/${pr.key.repo.toLowerCase()}`;
          if (!discoveredRepos.has(repoKey)) {
            discoveredRepos.set(repoKey, {
              owner: pr.key.owner,
              repo: pr.key.repo,
              url: `https://github.com/${pr.key.owner}/${pr.key.repo}`,
              agent: config.defaults.agent,
            });
          }
        }
      }

      // 3. Atomically apply all staged PRs to state after successful fetches
      for (const [keyStr, pr] of stagedPrs.entries()) {
        seenPrKeys.add(keyStr);

        const existing = data.prs.get(keyStr);
        const previousStatus = existing?.overallStatus;

        const mergedPR: PrState = {
          ...pr,
          scope: existing?.scope === 'mine' && pr.scope === 'team' ? 'both' : pr.scope,
          agent: existing?.agent || pr.agent || config.defaults.agent,
          log: existing?.log || [],
          logOffset: existing?.logOffset || 0,
        };

        upsertPR(data, mergedPR);
        recordHistoricalPr(data, mergedPR);

        if (!existing) {
          appendLog(
            data,
            pr.key,
            `Discovered PR: ${pr.overallStatus} (${pr.statusDetail || 'Initial poll'})`
          );
        } else if (previousStatus !== pr.overallStatus) {
          appendLog(
            data,
            pr.key,
            `Status changed: ${previousStatus} ➜ ${pr.overallStatus} (${pr.statusDetail || ''})`
          );
        }
      }

      // If repos were not explicitly configured in config.toml, update data.repos dynamically
      if (config.repos.length === 0) {
        data.repos = Array.from(discoveredRepos.values());
      }

      // Detect PRs that are no longer open and prune from active triage list
      for (const [keyStr, pr] of data.prs.entries()) {
        if (!seenPrKeys.has(keyStr)) {
          recordHistoricalPr(data, { ...pr, state: 'CLOSED', overallStatus: 'Closed' });
          data.prs.delete(keyStr);
        }
      }
    } else {
      const batchSize = config.defaults.batch_size || 8;
      const chunks = chunkRepos(data.repos, batchSize);

      for (const chunk of chunks) {
        try {
          const parsedPrs = await fetchChunkPrs(chunk, filterOptions);

          for (const pr of parsedPrs) {
            const keyStr = prKeyToString(pr.key);
            seenPrKeys.add(keyStr);

            const existing = data.prs.get(keyStr);
            const previousStatus = existing?.overallStatus;

            const mergedPR: PrState = {
              ...pr,
              agent: existing?.agent || pr.agent,
              log: existing?.log || [],
              logOffset: existing?.logOffset || 0,
            };

            upsertPR(data, mergedPR);
            recordHistoricalPr(data, mergedPR);

            // If status changed or this is first discovery, append log
            if (!existing) {
              appendLog(
                data,
                pr.key,
                `Discovered PR: ${pr.overallStatus} (${pr.statusDetail || 'Initial poll'})`
              );
            } else if (previousStatus !== pr.overallStatus) {
              appendLog(
                data,
                pr.key,
                `Status changed: ${previousStatus} ➜ ${pr.overallStatus} (${pr.statusDetail || ''})`
              );
            }
          }
        } catch (err) {
          logWatcherMessage(`Unexpected error processing chunk: ${(err as Error).message}`);
        }
      }

      // Detect PRs that are no longer open for the monitored repos
      const monitoredRepoKeys = new Set(data.repos.map((r) => `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`));

      for (const [keyStr, pr] of data.prs.entries()) {
        const repoIdentifier = `${pr.key.owner.toLowerCase()}/${pr.key.repo.toLowerCase()}`;
        if (monitoredRepoKeys.has(repoIdentifier) && !seenPrKeys.has(keyStr)) {
          recordHistoricalPr(data, { ...pr, state: 'CLOSED', overallStatus: 'Closed' });
          data.prs.delete(keyStr);
        }
      }
    }
  } finally {
    data.isPolling = false;
    data.lastPolled = Date.now();
    saveState(data);
  }
}
