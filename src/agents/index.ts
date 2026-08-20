// ── Agent Registry & Dispatcher ──────────────────────────────────────────────
// Manages agent definitions, template interpolation, and worktree process execution.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AppState,
  PrState,
  PrKey,
  AppConfig,
  WorkerHandle,
  AgentDefinition,
} from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { getAgentDefinition } from '../config.js';
import { appendLog, setWorker, saveState, getRepoAgent } from '../app/state.js';
import {
  resolveWorktreeDir,
  provisionWorktree,
  cleanupWorktree,
  resolveLogPath,
  cleanupPRLogs,
  cleanupPRArtifacts,
} from './worktree.js';
import { DEFAULT_AGENT_PROMPT } from './presets.js';

export interface CommandInterpolationParams {
  pr: number;
  branch: string;
  owner: string;
  repo: string;
  url: string;
  worktree?: string;
  prompt?: string;
}

export function interpolateAgentCommand(
  template: string,
  params: CommandInterpolationParams
): string {
  const defaultPrompt = params.prompt || DEFAULT_AGENT_PROMPT;

  return template
    .replace(/\{pr\}/g, String(params.pr))
    .replace(/\{branch\}/g, params.branch)
    .replace(/\{owner\}/g, params.owner)
    .replace(/\{repo\}/g, params.repo)
    .replace(/\{url\}/g, params.url)
    .replace(/\{worktree\}/g, params.worktree || '')
    .replace(/\{prompt\}/g, defaultPrompt);
}

export function buildAgentCommand(
  agentName: string,
  pr: PrState,
  config: AppConfig,
  worktreePath?: string,
  prompt?: string
): { command: string; definition: AgentDefinition } {
  const definition = getAgentDefinition(agentName, config);
  const command = interpolateAgentCommand(definition.command, {
    pr: pr.key.number,
    branch: pr.branch,
    owner: pr.key.owner,
    repo: pr.key.repo,
    url: pr.url,
    worktree: worktreePath,
    prompt,
  });

  return { command, definition };
}

export interface DispatchOptions {
  data: AppState;
  pr: PrState;
  config: AppConfig;
  agentName?: string;
  prompt?: string;
  cwd?: string;
}

export async function dispatchAgent(options: DispatchOptions): Promise<WorkerHandle> {
  const { data, pr, config, prompt, cwd } = options;
  const agentName = options.agentName || (pr ? getRepoAgent(data, pr.key) : config.defaults.agent);
  const sessionId = crypto.randomUUID();

  // 1. Resolve & Provision Worktree
  const worktreePath = resolveWorktreeDir(config, pr, cwd);
  appendLog(data, pr.key, `Provisioning worktree at ${worktreePath}...`);

  try {
    await provisionWorktree(pr, worktreePath);
  } catch (err) {
    appendLog(data, pr.key, `Worktree provisioning note: ${(err as Error).message}`);
  }

  // 2. Build command string
  const { command } = buildAgentCommand(agentName, pr, config, worktreePath, prompt);

  // 3. Prepare Log File
  const logDir = path.join(path.dirname(worktreePath), '..', 'logs');
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  } catch {
    // Ignore if already created
  }

  const logFile = path.join(logDir, `${pr.key.owner}-${pr.key.repo}-${pr.key.number}.log`);
  let logStream: fs.WriteStream | null = null;
  try {
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.on('error', () => {
      logStream = null;
    });
  } catch {
    logStream = null;
  }

  appendLog(data, pr.key, `Dispatching agent '${agentName}'...`);
  appendLog(data, pr.key, `Command: ${command}`);

  // 4. Spawn Agent CLI Process in worktree directory with headless isolation
  const child = spawn(command, {
    shell: true,
    cwd: worktreePath,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CI: '1',
      TERM: 'dumb',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });

  const worker: WorkerHandle = {
    sessionId,
    prKey: pr.key,
    agentName,
    command,
    worktreePath,
    originalPrompt: prompt,
    branch: pr.branch,
    startedAt: Date.now(),
    pid: child.pid,
    logPath: logFile,
    status: 'running',
  };

  setWorker(data, pr.key, worker);
  saveState(data, undefined, options.cwd);

  // 5. Stream Output
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    try {
      logStream?.write(text);
    } catch {
      // Ignore write errors
    }
    const firstLine = text.trim().split('\n')[0];
    if (firstLine) {
      appendLog(data, pr.key, `[${agentName}] ${firstLine}`);
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    try {
      logStream?.write(text);
    } catch {
      // Ignore write errors
    }
  });

  child.on('close', (code) => {
    try {
      logStream?.end();
    } catch {
      // Ignore end errors
    }
    worker.finishedAt = Date.now();
    if (code === 0) {
      worker.status = 'completed';
      appendLog(data, pr.key, `Agent '${agentName}' completed successfully`);
    } else {
      worker.status = 'failed';
      appendLog(data, pr.key, `Agent '${agentName}' exited with code ${code}`);
    }
    saveState(data, undefined, options.cwd);
  });

  child.on('error', (err) => {
    try {
      logStream?.end();
    } catch {
      // Ignore end errors
    }
    worker.status = 'failed';
    appendLog(data, pr.key, `Agent '${agentName}' process error: ${err.message}`);
    saveState(data, undefined, options.cwd);
  });

  return worker;
}

export function cancelWorker(data: AppState, prKey: PrKey, cwd?: string): boolean {
  const keyStr = prKeyToString(prKey);
  const worker = data.workers.get(keyStr);
  if (!worker || worker.status !== 'running') {
    return false;
  }

  if (worker.pid) {
    try {
      process.kill(-worker.pid, 'SIGTERM');
    } catch {
      try {
        process.kill(worker.pid, 'SIGTERM');
      } catch {
        // Ignore if already exited
      }
    }
  }

  worker.status = 'cancelled';
  appendLog(data, prKey, `Worker session ${worker.sessionId} cancelled`);
  saveState(data, undefined, cwd);
  return true;
}

export {
  resolveWorktreeDir,
  provisionWorktree,
  cleanupWorktree,
  resolveLogPath,
  cleanupPRLogs,
  cleanupPRArtifacts,
};
