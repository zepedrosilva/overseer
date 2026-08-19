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

export interface RateLimitInfo {
  isRateLimited: boolean;
  resetEpochMs?: number;
  remaining?: number;
  limit?: number;
}

export async function checkRateLimit(): Promise<RateLimitInfo> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', '/rate_limit']);
    const parsed = JSON.parse(stdout) as Record<string, { graphql?: { limit?: number; remaining?: number; reset?: number } }>;
    const graphql = parsed?.resources?.graphql;
    if (graphql && typeof graphql.remaining === 'number') {
      const isRateLimited = graphql.remaining <= 0;
      const resetEpochMs = typeof graphql.reset === 'number' ? graphql.reset * 1000 : undefined;
      return {
        isRateLimited,
        resetEpochMs,
        remaining: graphql.remaining,
        limit: graphql.limit,
      };
    }
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
