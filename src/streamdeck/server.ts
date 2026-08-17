// ── Stream Deck HTTP & SSE Server ──────────────────────────────────────────
// Exposes PR status, metadata, and actions via REST and Server-Sent Events (SSE).

import http from 'node:http';
import { URL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { AppState, StreamDeckStatus, StreamDeckPR, StreamDeckAction, PrState } from '../app/types.js';
import { prKeyToString, parsePrKey } from '../app/types.js';
import { countNeedsAttention } from '../app/state.js';

export const DEFAULT_STREAMDECK_PORT = 3210;

export interface SSEClient {
  id: string;
  response: http.ServerResponse;
}

export interface StreamDeckServerController {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
  broadcast: (type: string, data: unknown) => void;
}

export type StreamDeckActionHandler = (
  action: StreamDeckAction,
  payload: { id?: string; pr?: PrState | null }
) => void | Promise<void>;

export function startStreamDeckServer(
  data: AppState,
  port: number = DEFAULT_STREAMDECK_PORT,
  onAction?: StreamDeckActionHandler
): StreamDeckServerController {
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

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

    // ── GET /status ───────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/status') {
      const prList = Array.from(data.prs.values());
      const status: StreamDeckStatus = {
        reposCount: data.repos.length,
        prsCount: prList.length,
        needsAttentionCount: countNeedsAttention(data),
        items: prList.map((pr) => ({
          id: prKeyToString(pr.key),
          title: pr.title.length > 60 ? pr.title.slice(0, 57) + '…' : pr.title,
          status: pr.overallStatus,
          ci: pr.ciStatus,
          review: pr.reviewVerdict,
          agent: pr.agent,
        })),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    // ── GET /pr/:owner/:repo/:number ──────────────────────────────────────
    if (req.method === 'GET' && pathname.startsWith('/pr/')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length >= 4) {
        const owner = parts[1];
        const repo = parts[2];
        const number = parseInt(parts[3], 10);

        const pr = Array.from(data.prs.values()).find(
          (p) => p.key.owner.toLowerCase() === owner.toLowerCase() &&
                 p.key.repo.toLowerCase() === repo.toLowerCase() &&
                 p.key.number === number
        );

        if (!pr) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'PR not found' }));
          return;
        }

        const prData: StreamDeckPR = {
          id: prKeyToString(pr.key),
          title: pr.title,
          status: pr.overallStatus,
          ci: pr.ciStatus,
          review: pr.reviewVerdict,
          statusDetail: pr.statusDetail,
          agent: pr.agent,
          ciChecks: pr.ciChecks,
          log: pr.log.slice(-20),
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(prData));
        return;
      }
    }

    // ── POST /action/:type ────────────────────────────────────────────────
    if (req.method === 'POST' && pathname.startsWith('/action/')) {
      const actionType = pathname.split('/').pop() as StreamDeckAction;
      let dataStr = '';

      req.on('data', (chunk) => {
        dataStr += chunk;
      });

      req.on('end', () => {
        const body: { id?: string } = {};
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
            targetPR = Array.from(data.prs.values()).find(
              (p) => p.key.owner === parsed.owner && p.key.repo === parsed.repo && p.key.number === parsed.number
            ) || null;
          }
        }

        if (onAction) {
          onAction(actionType, { id: body.id, pr: targetPR });
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

  server.listen(port);

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
