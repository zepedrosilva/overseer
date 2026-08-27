// ── Multi-Repo Watcher Coordinator ─────────────────────────────────────────
// Batches repository queries using GraphQL, handles timeouts with adaptive
// sub-chunk fallbacks, filters user-relevant PRs, and safely logs.

import fs from 'node:fs';
import path from 'node:path';
import type { AppState, AppConfig, RepoHandle, PrState } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { upsertPR, updatePRStatus, appendLog, saveState, resolveStateDir, recordHistoricalPr } from '../app/state.js';
import { runGraphQL, fetchTeamMembers, fetchTeamMemberProfiles, checkRateLimit } from './gh.js';
import { evaluateAutonomousPolicies } from './autonomous.js';
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

interface FetchSearchResult {
  prs: PrState[];
  error?: Error;
  isRateLimit?: boolean;
}

async function fetchSearchPrs(
  searchQuery: string,
  options?: ParseGraphQLBatchOptions,
  defaultAgent?: string
): Promise<FetchSearchResult> {
  try {
    const query = buildSearchPRQuery(searchQuery, 50);
    const rawResponse = await runGraphQL<Record<string, unknown>>(query);
    const prs = parseGraphQLSearchResponse(rawResponse, options, defaultAgent);
    return { prs };
  } catch (err) {
    const isRateLimit = Boolean((err as Record<string, unknown>).isRateLimit || /rate limit|RATE_LIMITED/i.test((err as Error).message));
    logWatcherMessage(`Search query [${searchQuery}] failed: ${(err as Error).message}`);
    return { prs: [], error: err as Error, isRateLimit };
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

let isPollInFlight = false;

export async function pollAllRepos(
  data: AppState,
  config: AppConfig,
  scope: 'all' | 'mine' | 'team' = 'all'
): Promise<void> {
  if (isPollInFlight) {
    return;
  }

  // 1. Check if we are currently rate-limited by GitHub API
  if (data.rateLimitedUntil) {
    if (Date.now() < data.rateLimitedUntil) {
      data.isPolling = false;
      return;
    }
    data.rateLimitedUntil = undefined;
  }

  isPollInFlight = true;
  data.isPolling = true;

  const filterOptions: ParseGraphQLBatchOptions = {
    currentUser: data.currentUser || config.defaults.user,
    filterUserOnly: config.defaults.filter_user_only,
  };

  const seenPrKeys = new Set<string>();
  const isSearchMode = Boolean(config.defaults.search_query) || config.repos.length === 0;
  let hasFetchErrors = false;
  let isRateLimited = false;

  try {
    if (isSearchMode) {
      const user = data.currentUser || config.defaults?.user;
      const teamSlug = data.settings?.team || config.defaults?.team;
      const recentWindowDays = data.settings?.recentPrWindowDays ?? config.defaults?.recent_pr_window_days ?? 7;
      const cutoffDate = new Date(Date.now() - recentWindowDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const stagedPrs = new Map<string, PrState>();
      const discoveredRepos = new Map<string, RepoHandle>();

      // 1. Personal Queries (Active open PRs + recently completed PRs within window)
      if (scope === 'all' || scope === 'mine') {
        const personalQueries: string[] = [];
        if (config.defaults.search_query) {
          personalQueries.push(config.defaults.search_query);
        } else {
          const userTerm = user && user !== 'unknown' ? `involves:${user}` : 'involves:@me';
          personalQueries.push(`is:pr is:open ${userTerm}`);
          personalQueries.push(`is:pr is:closed closed:>=${cutoffDate} ${userTerm}`);
        }

        const personalFetchResults = await Promise.all(
          personalQueries.map((q) => fetchSearchPrs(q, filterOptions, config.defaults.agent))
        );

        for (const res of personalFetchResults) {
          if (res.error) {
            hasFetchErrors = true;
            if (res.isRateLimit) isRateLimited = true;
          }
          for (const pr of res.prs) {
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
        }
      }

      // 2. Team Queries (Active open PRs + recently completed PRs within window)
      if ((scope === 'all' || scope === 'team') && teamSlug) {
        if (!data.teamMembers || data.teamMembers.length === 0) {
          const fetched = await fetchTeamMembers(teamSlug);
          if (fetched.length > 0) {
            data.teamMembers = fetched;
            try {
              const profiles = await fetchTeamMemberProfiles(data.teamMembers);
              data.teamProfiles = {
                ...(data.teamProfiles || {}),
                ...profiles,
              };
            } catch {
              // Non-critical
            }
          }
        }

        const teamFilterOpts: ParseGraphQLBatchOptions = {
          ...filterOptions,
          team: teamSlug,
          teamMembers: data.teamMembers,
          isTeamQuery: true,
        };

        const teamQueries: string[] = [];
        const allTeamMembers = data.teamMembers || [];
        const teamActiveDays = data.settings?.teamActiveWindowDays ?? config.defaults?.team_active_window_days ?? 30;
        const activeCutoffDate = teamActiveDays > 0
          ? new Date(Date.now() - teamActiveDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
          : '';
        const isInitialPoll = data.lastPolled === undefined;
        const shouldQueryClosed = scope === 'all' || isInitialPoll;

        // Query PRs strictly authored by each team member (active open + recently completed when full poll)
        for (const member of allTeamMembers) {
          const openQuery = activeCutoffDate
            ? `is:pr is:open author:${member} updated:>=${activeCutoffDate}`
            : `is:pr is:open author:${member}`;
          teamQueries.push(openQuery);
          if (shouldQueryClosed) {
            teamQueries.push(`is:pr is:closed closed:>=${cutoffDate} author:${member}`);
          }
        }

        // Fetch team member author queries concurrently in parallel
        const allTeamFetchPromises = teamQueries.map((q) =>
          fetchSearchPrs(q, teamFilterOpts, config.defaults.agent)
        );

        const fetchResults = await Promise.all(allTeamFetchPromises);
        const teamPrs: PrState[] = [];
        const seenTeamKeys = new Set<string>();

        for (const res of fetchResults) {
          if (res.error) {
            hasFetchErrors = true;
            if (res.isRateLimit) isRateLimited = true;
          }
          for (const pr of res.prs) {
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

      // If rate limited, record until timestamp
      if (isRateLimited) {
        try {
          const rateInfo = await checkRateLimit(isSearchMode ? 'search' : 'graphql');
          data.rateLimitedUntil = rateInfo.resetEpochMs || (Date.now() + 60 * 1000);
        } catch {
          data.rateLimitedUntil = Date.now() + 60 * 1000;
        }
      }

      // 3. Atomically apply all staged PRs to state after successful fetches
      for (const [keyStr, pr] of stagedPrs.entries()) {
        seenPrKeys.add(keyStr);

        const existing = data.prs.get(keyStr);
        const previousStatus = existing?.overallStatus;

        let finalScope = pr.scope;
        if (scope === 'mine' && existing && (existing.scope === 'team' || existing.scope === 'both')) {
          finalScope = 'both';
        } else if (scope === 'team' && existing && (existing.scope === 'mine' || existing.scope === 'both')) {
          finalScope = 'both';
        }

        const mergedPR: PrState = {
          ...pr,
          scope: finalScope,
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
      if (config.repos.length === 0 && discoveredRepos.size > 0) {
        const currentRepoMap = new Map(data.repos.map((r) => [`${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`, r]));
        for (const [k, r] of discoveredRepos) {
          currentRepoMap.set(k, r);
        }
        data.repos = Array.from(currentRepoMap.values());
      }

      // Detect PRs that are no longer in active scope and prune from table
      // CRITICAL: Only prune if fetches for this scope completed without any errors!
      if (!hasFetchErrors && seenPrKeys.size > 0) {
        for (const [keyStr, pr] of data.prs.entries()) {
          if (!seenPrKeys.has(keyStr)) {
            if (scope === 'mine') {
              if (pr.scope === 'mine') {
                recordHistoricalPr(data, { ...pr, state: 'CLOSED', overallStatus: 'Closed' });
                data.prs.delete(keyStr);
              } else if (pr.scope === 'both') {
                pr.scope = 'team';
              }
            } else if (scope === 'team') {
              if (pr.scope === 'team') {
                recordHistoricalPr(data, { ...pr, state: 'CLOSED', overallStatus: 'Closed' });
                data.prs.delete(keyStr);
              } else if (pr.scope === 'both') {
                pr.scope = 'mine';
              }
            } else {
              recordHistoricalPr(data, { ...pr, state: 'CLOSED', overallStatus: 'Closed' });
              data.prs.delete(keyStr);
            }
          }
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

    // Evaluate autonomous delegation policies on active PRs (runs for all modes)
    try {
      await evaluateAutonomousPolicies(data, config);
    } catch (err) {
      logWatcherMessage(`Autonomous policy evaluation error: ${(err as Error).message}`);
    }
  } finally {
    isPollInFlight = false;
    data.isPolling = false;
    data.lastPolled = Date.now();
    saveState(data);
  }
}
