// ── Local REST & SSE API Server ──────────────────────────────────────────────
// Exposes PR status, filtering, metrics, and actions via HTTP and Server-Sent Events.

import http from 'node:http';
import { URL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type {
  AppState,
  ApiStatusResponse,
  ApiPrResponse,
  ApiActionType,
  ApiActionHandler,
  PrState,
} from '../app/types.js';
import { prKeyToString, parsePrKey } from '../app/types.js';
import { countNeedsAttention } from '../app/state.js';

export const DEFAULT_API_PORT = 3210;

export interface SSEClient {
  id: string;
  response: http.ServerResponse;
}

export interface ApiServerController {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
  broadcast: (type: string, data: unknown) => void;
}

export function prStateToApiResponse(pr: PrState): ApiPrResponse {
  return {
    id: prKeyToString(pr.key),
    title: pr.title,
    status: pr.overallStatus,
    ci: pr.ciStatus,
    review: pr.reviewVerdict,
    statusDetail: pr.statusDetail,
    agent: pr.agent,
    author: pr.author,
    branch: pr.branch,
    baseBranch: pr.baseBranch,
    url: pr.url,
    isDraft: pr.isDraft,
    state: pr.state,
    ciChecks: pr.ciChecks,
    log: pr.log.slice(-50),
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    commentsCount: pr.commentsCount,
    unresolvedThreadsCount: pr.unresolvedThreadsCount,
  };
}

export function startApiServer(
  data: AppState,
  port: number = DEFAULT_API_PORT,
  onAction?: ApiActionHandler
): ApiServerController {
  let sseClients: SSEClient[] = [];

  function broadcast(type: string, payload: unknown): void {
    const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    sseClients.forEach((client) => {
      try {
        client.response.write(message);
      } catch {
        // Client disconnected
      }
    });
  }

  const server = http.createServer((req, res) => {
    const effectivePort = (server.address() as AddressInfo)?.port || port;
    const url = new URL(req.url || '/', `http://localhost:${effectivePort}`);
    const pathname = url.pathname;

    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── GET /events (Server-Sent Events) ──────────────────────────────────
    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(':connected\n\n');

      const clientId = crypto.randomUUID();
      const client: SSEClient = { id: clientId, response: res };
      sseClients.push(client);

      req.on('close', () => {
        sseClients = sseClients.filter((c) => c.id !== clientId);
      });
      return;
    }

    // ── GET /status or GET /api/status ────────────────────────────────────
    if (req.method === 'GET' && (pathname === '/status' || pathname === '/api/status')) {
      const prList = Array.from(data.prs.values());
      const passingCi = prList.filter((p) => p.ciStatus === 'SUCCESS').length;
      const reviewReady = prList.filter((p) => p.reviewVerdict === 'APPROVED').length;

      const status: ApiStatusResponse = {
        reposCount: data.repos.length,
        prsCount: prList.length,
        needsAttentionCount: countNeedsAttention(data),
        passingCiCount: passingCi,
        reviewReadyCount: reviewReady,
        viewScope: data.viewScope || 'mine',
        currentUser: data.currentUser,
        rateLimitedUntil: data.rateLimitedUntil,
        items: prList.map((pr) => ({
          id: prKeyToString(pr.key),
          title: pr.title.length > 60 ? pr.title.slice(0, 57) + '…' : pr.title,
          status: pr.overallStatus,
          ci: pr.ciStatus,
          review: pr.reviewVerdict,
          agent: pr.agent,
          author: pr.author,
          url: pr.url,
        })),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
      return;
    }

    // ── GET /prs or GET /api/prs ──────────────────────────────────────────
    if (req.method === 'GET' && (pathname === '/prs' || pathname === '/api/prs')) {
      let prList = Array.from(data.prs.values());

      const scopeFilter = url.searchParams.get('scope');
      if (scopeFilter === 'mine') {
        prList = prList.filter((p) => p.scope === 'mine' || p.scope === 'both');
      } else if (scopeFilter === 'team') {
        prList = prList.filter((p) => p.scope === 'team' || p.scope === 'both');
      }

      const statusFilter = url.searchParams.get('status')?.toLowerCase();
      if (statusFilter) {
        prList = prList.filter((p) => p.overallStatus.toLowerCase() === statusFilter);
      }

      const searchFilter = url.searchParams.get('search')?.toLowerCase();
      if (searchFilter) {
        prList = prList.filter(
          (p) =>
            p.title.toLowerCase().includes(searchFilter) ||
            p.key.repo.toLowerCase().includes(searchFilter) ||
            p.author.toLowerCase().includes(searchFilter) ||
            p.branch.toLowerCase().includes(searchFilter)
        );
      }

      const response = prList.map(prStateToApiResponse);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response, null, 2));
      return;
    }

    // ── GET /prs/:owner/:repo/:number or GET /pr/:owner/:repo/:number ─────
    if (req.method === 'GET' && (pathname.startsWith('/prs/') || pathname.startsWith('/pr/'))) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length >= 4) {
        const owner = parts[1];
        const repo = parts[2];
        const number = parseInt(parts[3], 10);

        const pr = Array.from(data.prs.values()).find(
          (p) =>
            p.key.owner.toLowerCase() === owner.toLowerCase() &&
            p.key.repo.toLowerCase() === repo.toLowerCase() &&
            p.key.number === number
        );

        if (!pr) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'PR not found' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(prStateToApiResponse(pr), null, 2));
        return;
      }
    }

    // ── GET /stats or GET /api/stats ──────────────────────────────────────
    if (req.method === 'GET' && (pathname === '/stats' || pathname === '/api/stats')) {
      const stats = data.historicalStats || { records: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats, null, 2));
      return;
    }

    // ── POST /actions/:action or POST /action/:type ───────────────────────
    if (req.method === 'POST' && (pathname.startsWith('/actions/') || pathname.startsWith('/action/'))) {
      const rawAction = pathname.split('/').pop() as string;
      const validActions: ApiActionType[] = ['poll', 'recheck', 'merge', 'close', 'comment', 'agent', 'cancel-agent', 'open', 'backfill'];
      if (!validActions.includes(rawAction as ApiActionType)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid action: ${rawAction}` }));
        return;
      }
      const actionType = rawAction as ApiActionType;

      let dataStr = '';
      let isTooLarge = false;

      req.on('data', (chunk) => {
        dataStr += chunk;
        if (dataStr.length > 64 * 1024) { // 64 KB cap
          isTooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large (max 64 KB)' }));
          req.destroy();
        }
      });

      req.on('end', () => {
        if (isTooLarge) return;

        const body: {
          id?: string;
          prompt?: string;
          comment?: string;
          text?: string;
          agentName?: string;
          playbookName?: string;
          timeframeDays?: number;
          days?: number;
          forceRefresh?: boolean;
        } = {};
        try {
          if (dataStr) {
            Object.assign(body, JSON.parse(dataStr));
          }
        } catch {
          // Ignore parse errors
        }

        let targetPR: PrState | null = null;
        if (body.id) {
          const parsed = parsePrKey(body.id);
          if (parsed) {
            targetPR =
              Array.from(data.prs.values()).find(
                (p) =>
                  p.key.owner.toLowerCase() === parsed.owner.toLowerCase() &&
                  p.key.repo.toLowerCase() === parsed.repo.toLowerCase() &&
                  p.key.number === parsed.number
              ) || null;
          }
        }

        if (onAction) {
          onAction(actionType, {
            id: body.id,
            pr: targetPR,
            prompt: body.prompt,
            comment: body.comment || body.text,
            text: body.text || body.comment,
            agentName: body.agentName,
            playbookName: body.playbookName,
            timeframeDays: body.timeframeDays,
            days: body.days,
            forceRefresh: body.forceRefresh,
          });
        }

        broadcast('actionTriggered', { action: actionType, id: body.id });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, action: actionType, id: body.id }));
      });
      return;
    }

    // ── 404 Not Found ─────────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, '127.0.0.1');

  return {
    server,
    get port() {
      return (server.address() as AddressInfo)?.port || port;
    },
    close: () =>
      new Promise<void>((resolve) => {
        sseClients.forEach((c) => {
          try {
            c.response.end();
          } catch {
            // Ignore
          }
        });
        sseClients = [];
        server.close(() => resolve());
      }),
    broadcast,
  };
}
