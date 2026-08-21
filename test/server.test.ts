import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import {
  startApiServer,
  type ApiServerController,
} from '../src/server/index.js';
import { createEmptyState, upsertPR } from '../src/app/state.js';
import type { AppState, PrState } from '../src/app/types.js';

describe('Local REST & SSE API Server', () => {
  let state: AppState;
  let serverController: ApiServerController;
  let serverPort: number;

  function createMockPR(): PrState {
    return {
      key: { owner: 'acme-corp', repo: 'web-frontend', number: 142 },
      title: 'Fix invoice rounding calculations',
      branch: 'fix/invoice-rounding',
      baseBranch: 'main',
      author: 'alice',
      url: 'https://github.com/acme-corp/web-frontend/pull/142',
      isDraft: false,
      state: 'OPEN',
      reviewVerdict: 'APPROVED',
      ciStatus: 'SUCCESS',
      overallStatus: 'Ready',
      statusDetail: 'Ready to merge',
      ciChecks: [{ name: 'unit-test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      agent: 'claude',
      commentsCount: 3,
      unresolvedThreadsCount: 0,
      additions: 10,
      deletions: 2,
      changedFiles: 2,
      commitsCount: 1,
      scope: 'mine',
      createdAt: '2026-08-17T10:00:00Z',
      updatedAt: '2026-08-17T11:00:00Z',
      log: ['[10:00:00] Initialized'],
    };
  }

  function makeRequest(
    method: string,
    path: string,
    port: number,
    body?: Record<string, unknown>
  ): Promise<{ status: number; body: string; parsed?: any }> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : undefined,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            let parsed: any;
            try {
              parsed = JSON.parse(data);
            } catch {
              // Ignore non-json
            }
            resolve({ status: res.statusCode || 0, body: data, parsed });
          });
        }
      );

      req.on('error', reject);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  beforeEach(() => {
    state = createEmptyState();
    state.repos = [{ owner: 'acme-corp', repo: 'web-frontend', url: 'https://github.com/acme-corp/web-frontend', agent: 'claude' }];
    upsertPR(state, createMockPR());
  });

  afterEach(async () => {
    if (serverController) {
      await serverController.close();
    }
  });

  it('serves GET /status endpoint with PR summaries and health metrics', async () => {
    serverController = startApiServer(state, 0);
    serverPort = serverController.port;

    const res = await makeRequest('GET', '/status', serverPort);
    expect(res.status).toBe(200);
    expect(res.parsed.reposCount).toBe(1);
    expect(res.parsed.prsCount).toBe(1);
    expect(res.parsed.needsAttentionCount).toBe(0);
    expect(res.parsed.passingCiCount).toBe(1);
    expect(res.parsed.reviewReadyCount).toBe(1);
    expect(res.parsed.items[0]).toEqual({
      id: 'acme-corp/web-frontend#142',
      title: 'Fix invoice rounding calculations',
      status: 'Ready',
      ci: 'SUCCESS',
      review: 'APPROVED',
      agent: 'claude',
      author: 'alice',
      url: 'https://github.com/acme-corp/web-frontend/pull/142',
    });
  });

  it('serves GET /prs endpoint with full PR lists and query filtering', async () => {
    serverController = startApiServer(state, 0);
    serverPort = serverController.port;

    const allRes = await makeRequest('GET', '/prs', serverPort);
    expect(allRes.status).toBe(200);
    expect(Array.isArray(allRes.parsed)).toBe(true);
    expect(allRes.parsed).toHaveLength(1);
    expect(allRes.parsed[0].id).toBe('acme-corp/web-frontend#142');

    const searchRes = await makeRequest('GET', '/prs?search=rounding', serverPort);
    expect(searchRes.status).toBe(200);
    expect(searchRes.parsed).toHaveLength(1);

    const emptySearchRes = await makeRequest('GET', '/prs?search=nonexistent', serverPort);
    expect(emptySearchRes.status).toBe(200);
    expect(emptySearchRes.parsed).toHaveLength(0);
  });

  it('serves GET /prs/:owner/:repo/:number and GET /pr/:owner/:repo/:number with PR details', async () => {
    serverController = startApiServer(state, 0);
    serverPort = serverController.port;

    const res = await makeRequest('GET', '/prs/acme-corp/web-frontend/142', serverPort);
    expect(res.status).toBe(200);
    expect(res.parsed.id).toBe('acme-corp/web-frontend#142');
    expect(res.parsed.title).toBe('Fix invoice rounding calculations');
    expect(res.parsed.status).toBe('Ready');
    expect(res.parsed.ciChecks).toHaveLength(1);

    const aliasRes = await makeRequest('GET', '/pr/acme-corp/web-frontend/142', serverPort);
    expect(aliasRes.status).toBe(200);
    expect(aliasRes.parsed.id).toBe('acme-corp/web-frontend#142');

    const notFound = await makeRequest('GET', '/prs/acme-corp/web-frontend/999', serverPort);
    expect(notFound.status).toBe(404);
  });

  it('serves GET /stats endpoint with historical statistics records', async () => {
    state.historicalStats = {
      records: [
        {
          key: { owner: 'acme-corp', repo: 'web-frontend', number: 100 },
          author: 'alice',
          title: 'Initial setup',
          createdAt: '2026-08-01T10:00:00Z',
          mergedAt: '2026-08-02T10:00:00Z',
          state: 'MERGED',
          additions: 50,
          deletions: 10,
          changedFiles: 5,
          commitsCount: 1,
          commentsCount: 2,
          unresolvedThreadsCount: 0,
          ciStatus: 'SUCCESS',
          scope: 'mine',
        },
      ],
    };

    serverController = startApiServer(state, 0);
    serverPort = serverController.port;

    const res = await makeRequest('GET', '/stats', serverPort);
    expect(res.status).toBe(200);
    expect(res.parsed.records).toHaveLength(1);
    expect(res.parsed.records[0].key.number).toBe(100);
  });

  it('handles POST /actions/:action and triggers callback', async () => {
    const actionCallback = vi.fn();
    serverController = startApiServer(state, 0, actionCallback);
    serverPort = serverController.port;

    const res = await makeRequest('POST', '/actions/recheck', serverPort, {
      id: 'acme-corp/web-frontend#142',
    });

    expect(res.status).toBe(200);
    expect(res.parsed.ok).toBe(true);
    expect(res.parsed.action).toBe('recheck');
    expect(actionCallback).toHaveBeenCalledWith('recheck', {
      id: 'acme-corp/web-frontend#142',
      pr: expect.objectContaining({ title: 'Fix invoice rounding calculations' }),
      prompt: undefined,
      comment: undefined,
    });
  });

  it('subscribes to GET /events SSE stream and receives broadcast messages', async () => {
    serverController = startApiServer(state, 0);
    serverPort = serverController.port;

    const receivedChunks: string[] = [];
    const ssePromise = new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: serverPort,
          path: '/events',
          method: 'GET',
        },
        (res) => {
          expect(res.headers['content-type']).toBe('text/event-stream');
          res.on('data', (chunk) => {
            receivedChunks.push(chunk.toString());
            if (receivedChunks.some((c) => c.includes('testEvent'))) {
              req.destroy();
              resolve();
            }
          });
        }
      );
      req.on('error', (err) => {
        // req.destroy can cause ECONNRESET on manual client close, which is expected
        if ((err as any).code === 'ECONNRESET') {
          resolve();
        } else {
          reject(err);
        }
      });
      req.end();
    });

    // Wait for connection to establish
    await new Promise((r) => setTimeout(r, 40));
    serverController.broadcast('testEvent', { hello: 'world' });

    await ssePromise;
    expect(receivedChunks.join('')).toContain('event: testEvent');
    expect(receivedChunks.join('')).toContain('{"hello":"world"}');
  });
});
