// ── Agent Registry & Dispatcher ──────────────────────────────────────────────
// Manages agent definitions, playbook interpolation, local worktree processes,
// remote bot comment dispatching, and durable telemetry recording.

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
  AgentDriverType,
  AgentExecutionRecord,
} from '../app/types.js';
import { prKeyToString } from '../app/types.js';
import { getAgentDefinition } from '../config.js';
import { appendLog, setWorker, saveState, getRepoAgent, getRepoMode } from '../app/state.js';
import {
  resolveWorktreeDir,
  provisionWorktree,
  cleanupWorktree,
  resolveLogPath,
  cleanupPRLogs,
  cleanupPRArtifacts,
} from './worktree.js';
import { DEFAULT_AGENT_PROMPT } from './presets.js';
import { getPlaybookDefinition } from './playbooks.js';
import { recordAgentExecution } from './stats.js';
import { addComment } from '../watcher/gh.js';

export interface CommandInterpolationParams {
  pr: number;
  branch: string;
  baseBranch?: string;
  owner: string;
  repo: string;
  url: string;
  worktree?: string;
  prompt?: string;
  ciLogs?: string;
  comments?: string;
  diffSummary?: string;
  failingCheck?: string;
  playbook?: string;
}

export function interpolateAgentCommand(
  template: string,
  params: CommandInterpolationParams
): string {
  const defaultPrompt = params.prompt || DEFAULT_AGENT_PROMPT;

  return template
    .replace(/\{pr\}/g, String(params.pr))
    .replace(/\{branch\}/g, params.branch)
    .replace(/\{baseBranch\}/g, params.baseBranch || 'main')
    .replace(/\{owner\}/g, params.owner)
    .replace(/\{repo\}/g, params.repo)
    .replace(/\{url\}/g, params.url)
    .replace(/\{worktree\}/g, params.worktree || '')
    .replace(/\{ciLogs\}/g, params.ciLogs || 'No CI logs provided.')
    .replace(/\{comments\}/g, params.comments || 'No unresolved comments.')
    .replace(/\{diffSummary\}/g, params.diffSummary || 'No diff summary provided.')
    .replace(/\{failingCheck\}/g, params.failingCheck || 'test')
    .replace(/\{playbook\}/g, params.playbook || 'custom')
    .replace(/\{prompt\}/g, defaultPrompt);
}

export function buildAgentCommand(
  agentName: string,
  pr: PrState,
  config: AppConfig,
  worktreePath?: string,
  prompt?: string,
  context?: Partial<CommandInterpolationParams>
): { command: string; definition: AgentDefinition; promptText: string } {
  const definition = getAgentDefinition(agentName, config);
  const promptText = interpolateAgentCommand(prompt || DEFAULT_AGENT_PROMPT, {
    pr: pr.key.number,
    branch: pr.branch,
    baseBranch: pr.baseBranch,
    owner: pr.key.owner,
    repo: pr.key.repo,
    url: pr.url,
    worktree: worktreePath,
    ...context,
  });

  const command = interpolateAgentCommand(definition.command, {
    pr: pr.key.number,
    branch: pr.branch,
    baseBranch: pr.baseBranch,
    owner: pr.key.owner,
    repo: pr.key.repo,
    url: pr.url,
    worktree: worktreePath,
    prompt: promptText,
    ...context,
  });

  return { command, definition, promptText };
}

export interface DispatchOptions {
  data: AppState;
  pr: PrState;
  config: AppConfig;
  agentName?: string;
  playbookName?: string;
  prompt?: string;
  mode?: 'live' | 'dry-run';
  trigger?: 'manual' | 'autonomous_ci' | 'autonomous_review' | 'api';
  ciLogs?: string;
  comments?: string;
  diffSummary?: string;
  failingCheck?: string;
  cwd?: string;
}

export async function dispatchAgent(options: DispatchOptions): Promise<WorkerHandle> {
  const { data, pr, config, cwd } = options;
  const agentName = options.agentName || (pr ? getRepoAgent(data, pr.key) : config.defaults.agent);
  const playbookName = options.playbookName || 'custom';
  const trigger = options.trigger || 'manual';
  const sessionId = crypto.randomUUID();
  const startTime = Date.now();
  const startTimeIso = new Date(startTime).toISOString();

  // Determine effective mode: options override -> repo policy -> global dryRun
  const repoMode = getRepoMode(data, pr.key);
  const isDryRun =
    options.mode === 'dry-run' ||
    (options.mode === undefined && (repoMode === 'dry-run' || data.dryRun));
  const effectiveMode = isDryRun ? 'dry-run' : 'live';

  // 1. Resolve Playbook & Build Command
  const playbookDef = getPlaybookDefinition(playbookName);
  const basePrompt = options.prompt || playbookDef.promptTemplate;
  const worktreePath = resolveWorktreeDir(config, pr, cwd);

  const { command, definition, promptText } = buildAgentCommand(
    agentName,
    pr,
    config,
    worktreePath,
    basePrompt,
    {
      ciLogs: options.ciLogs,
      comments: options.comments,
      diffSummary: options.diffSummary,
      failingCheck: options.failingCheck,
      playbook: playbookName,
    }
  );

  const driver: AgentDriverType = definition.driver || 'local';

  // 2. Prepare Log File
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

  // ── Handle DRY-RUN Simulation ───────────────────────────────────────────────
  if (isDryRun) {
    appendLog(data, pr.key, `[DRY-RUN] Would dispatch ${driver} agent '${agentName}' (${playbookName})`);
    appendLog(data, pr.key, `[DRY-RUN] Command: ${command}`);
    if (logStream) {
      logStream.write(
        `\n=== [DRY-RUN SIMULATION ${startTimeIso}] ===\n` +
          `Agent: ${agentName} (${driver})\n` +
          `Playbook: ${playbookName}\n` +
          `Prompt:\n${promptText}\n` +
          `Command: ${command}\n` +
          `=== [END DRY-RUN] ===\n\n`
      );
      logStream.end();
    }

    const dryRecord: AgentExecutionRecord = {
      sessionId,
      prKey: pr.key,
      agentName,
      playbookName,
      driver,
      mode: 'dry-run',
      trigger,
      startedAt: startTimeIso,
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      status: 'dry-run',
      summary: `Simulated ${playbookName} with ${agentName}`,
    };
    recordAgentExecution(dryRecord, undefined, cwd);

    const worker: WorkerHandle = {
      sessionId,
      prKey: pr.key,
      agentName,
      playbookName,
      driver,
      mode: 'dry-run',
      command,
      worktreePath,
      originalPrompt: promptText,
      branch: pr.branch,
      startedAt: startTime,
      finishedAt: Date.now(),
      logPath: logFile,
      status: 'dry-run',
    };
    setWorker(data, pr.key, worker);
    saveState(data, undefined, cwd);
    return worker;
  }

  // ── Handle REMOTE Driver Dispatch ───────────────────────────────────────────
  if (driver === 'remote') {
    appendLog(data, pr.key, `Dispatching remote bot agent '${agentName}' (${playbookName})...`);
    const triggerBody = definition.triggerTemplate
      ? interpolateAgentCommand(definition.triggerTemplate, {
          pr: pr.key.number,
          branch: pr.branch,
          owner: pr.key.owner,
          repo: pr.key.repo,
          url: pr.url,
          prompt: promptText,
          playbook: playbookName,
        })
      : `@${agentName} ${promptText}`;

    if (logStream) {
      logStream.write(
        `\n=== [REMOTE DISPATCH: ${agentName} at ${startTimeIso}] ===\n` +
          `Trigger Body:\n${triggerBody}\n\n`
      );
    }

    try {
      await addComment(pr.key.owner, pr.key.repo, pr.key.number, triggerBody);
      appendLog(data, pr.key, `Posted trigger comment for @${agentName}`);
    } catch (err) {
      appendLog(data, pr.key, `Remote trigger comment failed: ${(err as Error).message}`);
    }

    const worker: WorkerHandle = {
      sessionId,
      prKey: pr.key,
      agentName,
      playbookName,
      driver: 'remote',
      mode: 'live',
      command: triggerBody,
      worktreePath: '',
      originalPrompt: promptText,
      branch: pr.branch,
      startedAt: startTime,
      logPath: logFile,
      status: 'running',
    };

    setWorker(data, pr.key, worker);
    saveState(data, undefined, cwd);

    // Record initial dispatch telemetry
    const execRecord: AgentExecutionRecord = {
      sessionId,
      prKey: pr.key,
      agentName,
      playbookName,
      driver: 'remote',
      mode: 'live',
      trigger,
      startedAt: startTimeIso,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      status: 'completed',
      summary: `Dispatched remote bot @${agentName}`,
    };
    recordAgentExecution(execRecord, undefined, cwd);

    return worker;
  }

  // ── Handle LOCAL Worktree Process Dispatch ──────────────────────────────────
  appendLog(data, pr.key, `Provisioning worktree at ${worktreePath}...`);

  const allowPush = playbookName !== 'preflight-review';
  try {
    await provisionWorktree(pr, worktreePath, { allowPush });
  } catch (err) {
    appendLog(data, pr.key, `Worktree provisioning note: ${(err as Error).message}`);
  }

  appendLog(data, pr.key, `Dispatching agent '${agentName}' (${playbookName})...`);
  appendLog(data, pr.key, `Command: ${command}`);

  if (logStream) {
    logStream.write(
      `\n=== [LOCAL AGENT DISPATCH: ${agentName} (${playbookName}) at ${startTimeIso}] ===\n` +
        `Command: ${command}\n` +
        `Worktree: ${worktreePath}\n\n`
    );
  }

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
    playbookName,
    driver: 'local',
    mode: 'live',
    command,
    worktreePath,
    originalPrompt: promptText,
    branch: pr.branch,
    startedAt: startTime,
    pid: child.pid,
    logPath: logFile,
    status: 'running',
  };

  setWorker(data, pr.key, worker);
  saveState(data, undefined, cwd);

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
    const finishedAt = Date.now();
    const durationMs = finishedAt - startTime;
    worker.finishedAt = finishedAt;

    const isSuccess = code === 0;
    worker.status = isSuccess ? 'completed' : 'failed';

    if (isSuccess) {
      appendLog(data, pr.key, `Agent '${agentName}' (${playbookName}) completed successfully`);
    } else {
      appendLog(data, pr.key, `Agent '${agentName}' (${playbookName}) exited with code ${code}`);
    }

    const execRecord: AgentExecutionRecord = {
      sessionId,
      prKey: pr.key,
      agentName,
      playbookName,
      driver: 'local',
      mode: 'live',
      trigger,
      startedAt: startTimeIso,
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs,
      status: worker.status,
      exitCode: code || 0,
    };
    recordAgentExecution(execRecord, undefined, cwd);
    saveState(data, undefined, cwd);
  });

  child.on('error', (err) => {
    try {
      logStream?.end();
    } catch {
      // Ignore end errors
    }
    const finishedAt = Date.now();
    worker.finishedAt = finishedAt;
    worker.status = 'failed';
    appendLog(data, pr.key, `Agent '${agentName}' process error: ${err.message}`);

    const execRecord: AgentExecutionRecord = {
      sessionId,
      prKey: pr.key,
      agentName,
      playbookName,
      driver: 'local',
      mode: 'live',
      trigger,
      startedAt: startTimeIso,
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startTime,
      status: 'failed',
      error: err.message,
    };
    recordAgentExecution(execRecord, undefined, cwd);
    saveState(data, undefined, cwd);
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
  worker.finishedAt = Date.now();
  appendLog(data, prKey, `Worker session ${worker.sessionId} cancelled`);

  const execRecord: AgentExecutionRecord = {
    sessionId: worker.sessionId,
    prKey,
    agentName: worker.agentName,
    playbookName: worker.playbookName || 'custom',
    driver: worker.driver || 'local',
    mode: worker.mode || 'live',
    trigger: 'manual',
    startedAt: new Date(worker.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - worker.startedAt,
    status: 'cancelled',
  };
  recordAgentExecution(execRecord, undefined, cwd);

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
