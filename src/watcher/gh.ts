// ── GitHub CLI Wrapper ──────────────────────────────────────────────────────
// High-performance interface to GitHub via official `gh` CLI.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitHubPRFallback {
  number: number;
  title: string;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  state: 'open' | 'closed';
  draft: boolean;
  created_at: string;
  updated_at: string;
  comments: number;
}

export async function isGHAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['--version']);
    return true;
  } catch {
    return false;
  }
}

export async function isGHAuthenticated(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}

export async function getCurrentUser(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login']);
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

function executeGraphQL<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const payload = JSON.stringify({
      query,
      variables: variables || {},
    });

    const child = spawn('gh', ['api', 'graphql', '--input', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const errorMsg = stderr || stdout;
        const isRateLimit = /rate limit|RATE_LIMITED/i.test(errorMsg);
        const err = new Error(`gh api graphql failed (code ${code}): ${errorMsg}`);
        (err as unknown as Record<string, unknown>).isRateLimit = isRateLimit;
        return reject(err);
      }

      try {
        const parsed = JSON.parse(stdout) as T;
        resolve(parsed);
      } catch (err) {
        reject(new Error(`Failed to parse GraphQL response: ${(err as Error).message}\nRaw: ${stdout}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn gh: ${err.message}`));
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

export type GitHubResource = 'graphql' | 'search' | 'core';

export interface RateLimitInfo {
  isRateLimited: boolean;
  resetEpochMs?: number;
  remaining?: number;
  limit?: number;
  resource?: GitHubResource;
}

export async function checkRateLimit(resource?: GitHubResource): Promise<RateLimitInfo> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', '/rate_limit']);
    const parsed = JSON.parse(stdout) as {
      resources?: {
        graphql?: { limit?: number; remaining?: number; reset?: number };
        search?: { limit?: number; remaining?: number; reset?: number };
        core?: { limit?: number; remaining?: number; reset?: number };
      };
    };

    const resources = parsed?.resources;
    if (!resources) {
      return { isRateLimited: false };
    }

    if (resource) {
      const res = resources[resource];
      if (res && typeof res.remaining === 'number') {
        return {
          isRateLimited: res.remaining <= 0,
          resetEpochMs: typeof res.reset === 'number' ? res.reset * 1000 : undefined,
          remaining: res.remaining,
          limit: res.limit,
          resource,
        };
      }
    }

    // If no specific resource requested, check if any resource is depleted
    const search = resources.search;
    const graphql = resources.graphql;
    const core = resources.core;

    if (search && typeof search.remaining === 'number' && search.remaining <= 0) {
      return {
        isRateLimited: true,
        resetEpochMs: typeof search.reset === 'number' ? search.reset * 1000 : undefined,
        remaining: search.remaining,
        limit: search.limit,
        resource: 'search',
      };
    }

    if (graphql && typeof graphql.remaining === 'number' && graphql.remaining <= 0) {
      return {
        isRateLimited: true,
        resetEpochMs: typeof graphql.reset === 'number' ? graphql.reset * 1000 : undefined,
        remaining: graphql.remaining,
        limit: graphql.limit,
        resource: 'graphql',
      };
    }

    if (core && typeof core.remaining === 'number' && core.remaining <= 0) {
      return {
        isRateLimited: true,
        resetEpochMs: typeof core.reset === 'number' ? core.reset * 1000 : undefined,
        remaining: core.remaining,
        limit: core.limit,
        resource: 'core',
      };
    }

    return {
      isRateLimited: false,
      resetEpochMs: typeof graphql?.reset === 'number' ? graphql.reset * 1000 : undefined,
      remaining: graphql?.remaining,
      limit: graphql?.limit,
      resource: 'graphql',
    };
  } catch {
    // Non-critical fallback
  }
  return { isRateLimited: false };
}

export async function runGraphQL<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
  retries: number = 2
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await executeGraphQL<T>(query, variables);
    } catch (err) {
      if ((err as unknown as Record<string, unknown>).isRateLimit || attempt >= retries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

export async function listOpenPRs(owner: string, repo: string): Promise<GitHubPRFallback[]> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'list',
    '--repo', `${owner}/${repo}`,
    '--state', 'open',
    '--json', 'number,title,state,headRefName,baseRefName,comments,isDraft,createdAt,updatedAt,url',
    '--limit', '50',
  ]);

  if (!stdout.trim()) return [];

  const parsed = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    state: string;
    headRefName: string;
    baseRefName: string;
    comments: number;
    isDraft: boolean;
    createdAt: string;
    updatedAt: string;
    url: string;
  }>;

  return parsed.map((p) => ({
    number: p.number,
    title: p.title,
    html_url: p.url,
    head: { ref: p.headRefName, sha: '' },
    base: { ref: p.baseRefName, sha: '' },
    state: p.state.toLowerCase() === 'open' ? 'open' : 'closed',
    draft: p.isDraft,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    comments: p.comments || 0,
  }));
}

export async function mergePR(
  owner: string,
  repo: string,
  number: number,
  deleteBranch: boolean = true
): Promise<string> {
  const args = [
    'pr', 'merge', String(number),
    '--repo', `${owner}/${repo}`,
    '--squash',
  ];

  if (deleteBranch) {
    args.push('--delete-branch');
  }

  const { stdout } = await execFileAsync('gh', args);
  return stdout.trim();
}

export async function addComment(
  owner: string,
  repo: string,
  number: number,
  body: string
): Promise<string> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'comment', String(number),
    '--repo', `${owner}/${repo}`,
    '--body', body,
  ]);
  return stdout.trim();
}

export async function closePR(
  owner: string,
  repo: string,
  number: number
): Promise<string> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'close', String(number),
    '--repo', `${owner}/${repo}`,
  ]);
  return stdout.trim();
}

export async function openInBrowser(
  owner: string,
  repo: string,
  number: number
): Promise<string> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'view', String(number),
    '--repo', `${owner}/${repo}`,
    '--web',
  ]);
  return stdout.trim();
}

export async function getPRDiff(
  owner: string,
  repo: string,
  number: number
): Promise<string> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'diff', String(number),
    '--repo', `${owner}/${repo}`,
  ]);
  return stdout;
}

export async function viewPRDiffInteractive(
  owner: string,
  repo: string,
  number: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('gh', ['pr', 'diff', String(number), '--repo', `${owner}/${repo}`], {
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      if (code === 0 || code === 130) {
        resolve();
      } else {
        reject(new Error(`gh pr diff exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

export async function fetchTeamMembers(teamSlug: string): Promise<string[]> {
  try {
    const cleanSlug = teamSlug.trim();
    if (!cleanSlug) return [];

    // If comma-separated usernames or space-separated
    if (cleanSlug.includes(',') || (!cleanSlug.includes('/') && cleanSlug.includes(' '))) {
      return cleanSlug
        .split(/[, ]+/)
        .map((s) => s.trim().replace(/^@/, ''))
        .filter(Boolean);
    }

    // If GitHub org/team slug (e.g. "acme-corp/core-team")
    if (cleanSlug.includes('/')) {
      const [org, team] = cleanSlug.split('/');
      const { stdout } = await execFileAsync('gh', [
        'api',
        `orgs/${org}/teams/${team}/members`,
        '--paginate',
        '--jq',
        '.[].login',
      ]);
      return stdout
        .split('\n')
        .map((s) => s.trim().replace(/^@/, ''))
        .filter(Boolean);
    }

    // If slug without org (e.g. "core-team"), search authenticated user's orgs
    try {
      const { stdout: orgsOut } = await execFileAsync('gh', [
        'api',
        'user/memberships/orgs',
        '--jq',
        '.[].organization.login',
      ]);
      const orgs = orgsOut
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

      for (const org of orgs) {
        try {
          const { stdout: teamMembersOut } = await execFileAsync('gh', [
            'api',
            `orgs/${org}/teams/${cleanSlug.replace(/^@/, '')}/members`,
            '--paginate',
            '--jq',
            '.[].login',
          ]);
          const members = teamMembersOut
            .split('\n')
            .map((s) => s.trim().replace(/^@/, ''))
            .filter(Boolean);
          if (members.length > 0) return members;
        } catch {
          // Continue to next org
        }
      }
    } catch {
      // Non-critical fallback
    }

    return [cleanSlug.replace(/^@/, '')];
  } catch {
    return [];
  }
}

export async function fetchTeamMemberProfiles(
  logins: string[]
): Promise<Record<string, { login: string; name?: string }>> {
  if (!logins || logins.length === 0) return {};

  const profiles: Record<string, { login: string; name?: string }> = {};
  const uniqueLogins = Array.from(new Set(logins.map((l) => l.trim().replace(/^@/, '')))).filter(Boolean);

  if (uniqueLogins.length === 0) return {};

  // Build a single batched GraphQL query
  const queryFields = uniqueLogins
    .map((login, idx) => `u${idx}: user(login: ${JSON.stringify(login)}) { login name }`)
    .join('\n');
  const query = `query {\n${queryFields}\n}`;

  try {
    const res = await runGraphQL<{ data?: Record<string, { login: string; name?: string | null }> }>(query);
    if (res?.data) {
      for (const userObj of Object.values(res.data)) {
        if (userObj && userObj.login) {
          profiles[userObj.login.toLowerCase()] = {
            login: userObj.login,
            name: userObj.name || undefined,
          };
        }
      }
    }
  } catch {
    // Fallback: map with login
    for (const login of uniqueLogins) {
      profiles[login.toLowerCase()] = { login };
    }
  }

  return profiles;
}

// ── Autonomous Context Extractors ──────────────────────────────────────────

export async function fetchFailedCiLogs(
  owner: string,
  repo: string,
  number: number
): Promise<string> {
  try {
    const { stdout: checksOut } = await execFileAsync('gh', [
      'pr',
      'checks',
      String(number),
      '--repo',
      `${owner}/${repo}`,
      '--json',
      'name,state,bucket,description,link',
    ]);
    const checks = JSON.parse(checksOut) as Array<{
      name: string;
      state: string;
      bucket: string;
      description?: string;
      link?: string;
    }>;

    const failed = checks.filter(
      (c) => c.bucket === 'fail' || c.state === 'FAILURE' || c.state === 'TIMED_OUT'
    );

    if (failed.length === 0) {
      return 'No specific failed check runs detected.';
    }

    const lines: string[] = [];
    for (const f of failed) {
      lines.push(`- Check: ${f.name} (Status: ${f.state})`);
      if (f.description) lines.push(`  Description: ${f.description}`);
      if (f.link) lines.push(`  Log Link: ${f.link}`);
    }

    return lines.join('\n');
  } catch (err) {
    return `Unable to fetch detailed CI logs: ${(err as Error).message}`;
  }
}

export async function fetchUnresolvedReviewComments(
  owner: string,
  repo: string,
  number: number
): Promise<string> {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 30) {
            nodes {
              isResolved
              path
              line
              comments(first: 10) {
                nodes {
                  author { login }
                  body
                  createdAt
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const res = await runGraphQL<{
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: Array<{
                isResolved: boolean;
                path: string;
                line?: number;
                comments?: {
                  nodes?: Array<{
                    author?: { login: string };
                    body: string;
                    createdAt: string;
                  }>;
                };
              }>;
            };
          };
        };
      };
    }>(query, { owner, repo, number });

    const threads = res?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
    const unresolved = threads.filter((t) => !t.isResolved);

    if (unresolved.length === 0) {
      return 'No unresolved review comment threads found.';
    }

    const lines: string[] = [];
    for (let i = 0; i < unresolved.length; i++) {
      const t = unresolved[i];
      const comments = t.comments?.nodes || [];
      const location = t.line ? `${t.path}:${t.line}` : t.path;
      lines.push(`--- Thread #${i + 1} at ${location} ---`);
      for (const c of comments) {
        const author = c.author?.login || 'reviewer';
        lines.push(`@${author}: ${c.body.trim()}`);
      }
    }

    return lines.join('\n\n');
  } catch (err) {
    return `Unable to fetch review comment threads: ${(err as Error).message}`;
  }
}

export async function fetchPrDiffSummary(
  owner: string,
  repo: string,
  number: number
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr',
      'view',
      String(number),
      '--repo',
      `${owner}/${repo}`,
      '--json',
      'files,additions,deletions',
    ]);
    const parsed = JSON.parse(stdout) as {
      additions?: number;
      deletions?: number;
      files?: { path: string; additions: number; deletions: number; changeType: string }[];
    };
    const fileList = (parsed.files || [])
      .slice(0, 15)
      .map((f) => `  • ${f.path} (+${f.additions}, -${f.deletions})`)
      .join('\n');
    const remainingCount = (parsed.files?.length || 0) - 15;
    const remainingStr = remainingCount > 0 ? `\n  • ... and ${remainingCount} more files` : '';

    return `Total Volume: +${parsed.additions || 0} lines, -${parsed.deletions || 0} lines across ${parsed.files?.length || 0} files:\n${fileList}${remainingStr}`;
  } catch (err) {
    return `Unable to fetch diff summary: ${(err as Error).message}`;
  }
}
