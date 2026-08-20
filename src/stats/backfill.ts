// ── Historical PR Stats Backfill Engine ─────────────────────────────────────
// Fast, robust backfill for 30-day historical PR metrics across personal and team scopes.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppState, HistoricalPrRecord, BackfillProgress } from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { saveState } from '../app/state.js';
import { fetchTeamMembers, fetchTeamMemberProfiles, checkRateLimit } from '../watcher/gh.js';

const execFileAsync = promisify(execFile);

interface SearchPrItem {
  author?: { login: string };
  number: number;
  title: string;
  url: string;
  state: string;
  createdAt: string;
  closedAt: string;
  updatedAt: string;
  commentsCount?: number;
  repository: {
    name: string;
    nameWithOwner: string;
  };
}

export const BACKFILL_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export async function backfillHistoricalStats(
  data: AppState,
  timeframeDays: number = 90,
  onProgress?: (progress: BackfillProgress) => void,
  forceRefresh: boolean = false
): Promise<{
  totalBackfilled: number;
  mineCount: number;
  teamCount: number;
}> {
  const cutoffMs = Date.now() - timeframeDays * 24 * 60 * 60 * 1000;
  const currentUser = (data.currentUser || 'user').toLowerCase();
  const teamSlug = (data.settings?.team || '').trim();

  const logLines: string[] = [];
  const emitProgress = (
    currentMember: string,
    memberIndex: number,
    totalMembers: number,
    prsFound: number,
    totalPRs: number,
    status: BackfillProgress['status']
  ) => {
    if (onProgress) {
      onProgress({
        currentMember,
        memberIndex,
        totalMembers,
        prsFound,
        totalPRs,
        timeframeDays,
        status,
        log: [...logLines],
      });
    }
  };

  let teamMembers = data.teamMembers || [];
  if (teamSlug) {
    logLines.push(`Resolving team members & profiles for ${teamSlug}...`);
    emitProgress(currentUser, 0, 0, 0, 0, 'starting');

    if (!teamMembers || teamMembers.length === 0) {
      teamMembers = await fetchTeamMembers(teamSlug);
      if (teamMembers.length > 0) {
        data.teamMembers = teamMembers;
      }
    }
  } else {
    logLines.push(`No team configured. Backfilling personal PR history for @${currentUser}...`);
    emitProgress(currentUser, 0, 0, 0, 0, 'starting');
  }

  // Unique list of authors to query
  const authorsToQuery = Array.from(
    new Set([currentUser, ...teamMembers.map((m) => m.toLowerCase())])
  );

  // Fetch full name profiles for all authors in one fast GraphQL query
  try {
    const profiles = await fetchTeamMemberProfiles(authorsToQuery);
    data.teamProfiles = {
      ...(data.teamProfiles || {}),
      ...profiles,
    };
  } catch {
    // Non-critical, fallback to logins
  }

  const memberSet = new Set(teamMembers.map((m) => m.toLowerCase()));

  if (!data.historicalStats) {
    data.historicalStats = { records: [], memberWatermarks: {} };
  }
  if (!data.historicalStats.memberWatermarks) {
    data.historicalStats.memberWatermarks = {};
  }
  const histStats = data.historicalStats;

  const existingMap = new Map<string, HistoricalPrRecord>();
  for (const rec of histStats.records) {
    existingMap.set(prKeyToString(rec.key), rec);
  }

  let totalBackfilled = 0;
  let mineCount = 0;
  let teamCount = 0;
  let nextAuthorIdx = 0;
  let completedCount = 0;

  const concurrency = Math.min(4, Math.max(1, authorsToQuery.length));
  const workers = Array.from({ length: concurrency }, async () => {
    while (nextAuthorIdx < authorsToQuery.length) {
      const idx = nextAuthorIdx++;
      const author = authorsToQuery[idx];
      const authorLower = author.toLowerCase();
      const profile = data.teamProfiles?.[authorLower];
      const displayName = profile?.name ? `${profile.name} (@${author})` : `@${author}`;

      // Check watermark cache
      const watermark = histStats.memberWatermarks?.[authorLower];
      const now = Date.now();
      const isFresh =
        watermark &&
        watermark.status === 'success' &&
        watermark.timeframeDays >= timeframeDays &&
        now - new Date(watermark.lastBackfilledAt).getTime() < BACKFILL_CACHE_TTL_MS;

      if (isFresh && !forceRefresh) {
        const minsAgo = Math.round((now - new Date(watermark.lastBackfilledAt).getTime()) / (60 * 1000));
        logLines.push(`  ⚡ ${displayName}: using cached ${timeframeDays}d history (${minsAgo}m ago, ${watermark.prCount} PRs)`);
        completedCount++;
        emitProgress(displayName, completedCount, authorsToQuery.length, watermark.prCount, totalBackfilled, 'in_progress');
        continue;
      }

      logLines.push(`[${idx + 1}/${authorsToQuery.length}] Querying ${timeframeDays}d PRs for ${displayName}...`);
      emitProgress(displayName, completedCount + 1, authorsToQuery.length, 0, totalBackfilled, 'in_progress');

      try {
        const createdDateStr = new Date(cutoffMs).toISOString().split('T')[0];
        const { stdout } = await execFileAsync('gh', [
          'search',
          'prs',
          '--author',
          author,
          `--created=>=${createdDateStr}`,
          '--limit',
          '1000',
          '--json',
          'author,closedAt,commentsCount,createdAt,number,repository,state,title,updatedAt,url',
        ]);

        const items = JSON.parse(stdout) as SearchPrItem[];
        let memberPrCount = 0;

        for (const item of items) {
          const createdMs = new Date(item.createdAt).getTime();
          if (isNaN(createdMs) || createdMs < cutoffMs) {
            continue;
          }

          const owner = item.repository?.nameWithOwner?.includes('/')
            ? item.repository.nameWithOwner.split('/')[0]
            : 'acme-corp';
          const repo = item.repository?.name || 'repo';
          const key = { owner, repo, number: item.number };
          const keyStr = prKeyToString(key);

          const authorLogin = (item.author?.login || author).toLowerCase();
          const isMine = authorLogin === currentUser;
          const isTeamMember = memberSet.has(authorLogin);

          const scope = isMine && isTeamMember ? 'both' : isMine ? 'mine' : 'team';
          const stateStr = (item.state || 'OPEN').toUpperCase();
          const state = stateStr === 'MERGED' ? 'MERGED' : stateStr === 'CLOSED' ? 'CLOSED' : 'OPEN';

          const mergedAt = state === 'MERGED' && item.closedAt ? item.closedAt : undefined;
          const closedAt = state === 'CLOSED' && item.closedAt ? item.closedAt : undefined;

          const record: HistoricalPrRecord = {
            key,
            author: item.author?.login || author,
            title: item.title,
            createdAt: item.createdAt,
            mergedAt,
            closedAt,
            state,
            additions: 0,
            deletions: 0,
            changedFiles: 0,
            commitsCount: 1,
            commentsCount: item.commentsCount || 0,
            unresolvedThreadsCount: 0,
            ciStatus: 'SUCCESS',
            scope,
          };

          existingMap.set(keyStr, record);
          totalBackfilled++;
          memberPrCount++;

          if (scope === 'mine' || scope === 'both') mineCount++;
          if (scope === 'team' || scope === 'both') teamCount++;
        }

        // Record successful watermark
        if (!histStats.memberWatermarks) {
          histStats.memberWatermarks = {};
        }
        histStats.memberWatermarks[authorLower] = {
          lastBackfilledAt: new Date().toISOString(),
          timeframeDays,
          prCount: memberPrCount,
          status: 'success',
        };

        // Update records in state and save immediately so progress is preserved
        histStats.records = Array.from(existingMap.values());
        saveState(data);

        logLines.push(`  ✔ ${displayName}: ${memberPrCount} PRs found in last ${timeframeDays}d`);
      } catch (err) {
        const errMsg = (err as Error).message || '';
        if (!histStats.memberWatermarks) {
          histStats.memberWatermarks = {};
        }

        if (/rate limit|RATE_LIMITED/i.test(errMsg)) {
          let resetEpochMs = Date.now() + 60 * 1000;
          try {
            const rateInfo = await checkRateLimit('search');
            if (rateInfo.resetEpochMs) {
              resetEpochMs = rateInfo.resetEpochMs;
            }
          } catch {
            // fallback to 60s
          }
          data.rateLimitedUntil = resetEpochMs;
          const secsLeft = Math.max(1, Math.ceil((resetEpochMs - Date.now()) / 1000));
          const resetTimeStr = new Date(resetEpochMs).toLocaleTimeString();
          logLines.push(`  ⚠️ Rate limit reached for ${displayName} (resets in ${secsLeft}s at ${resetTimeStr})`);
          histStats.memberWatermarks[authorLower] = {
            lastBackfilledAt: new Date().toISOString(),
            timeframeDays,
            prCount: 0,
            status: 'rate_limited',
          };
        } else {
          logLines.push(`  ✖ ${displayName}: query failed or timed out`);
          histStats.memberWatermarks[authorLower] = {
            lastBackfilledAt: new Date().toISOString(),
            timeframeDays,
            prCount: 0,
            status: 'error',
          };
        }
        saveState(data);
      } finally {
        completedCount++;
        emitProgress(displayName, completedCount, authorsToQuery.length, 0, totalBackfilled, 'in_progress');
      }
    }
  });

  await Promise.all(workers);

  // Filter out any stale records older than requested timeframe only if new records were found or empty
  if (totalBackfilled > 0 || histStats.records.length === 0) {
    histStats.records = Array.from(existingMap.values()).filter((r) => {
      const time = new Date(r.createdAt).getTime();
      return !isNaN(time) && time >= cutoffMs;
    });
  }

  saveState(data);

  logLines.push(`Backfill complete! ${totalBackfilled} total PR records stored for ${timeframeDays} days.`);
  emitProgress('Complete', authorsToQuery.length, authorsToQuery.length, 0, totalBackfilled, 'done');

  return { totalBackfilled, mineCount, teamCount };
}

// Aliases for convenience
export const backfill90DayStats = (data: AppState, onProgress?: (p: BackfillProgress) => void, forceRefresh: boolean = false) =>
  backfillHistoricalStats(data, 90, onProgress, forceRefresh);

export const backfill30DayStats = (data: AppState, onProgress?: (p: BackfillProgress) => void, forceRefresh: boolean = false) =>
  backfillHistoricalStats(data, 30, onProgress, forceRefresh);
