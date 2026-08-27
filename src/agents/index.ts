// ── Agent Registry & Dispatcher ──────────────────────────────────────────────
// Manages agent definitions, playbook interpolation, local worktree processes,
// remote bot comment dispatching, and durable telemetry recording.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
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
import { appendLog, setWorker, saveState, getRepoAgent, getRepoMode, loadAgentsConfig } from '../app/state.js';
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
import {
  addComment,
  fetchFailedCiLogs,
  fetchUnresolvedReviewComments,
  fetchPrDiffSummary,
} from '../watcher/gh.js';

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

const MAX_CONTEXT_LENGTH = 64 * 1024; // 64 KB cap per context snippet to avoid E2BIG on argv

function sanitizeContextSnippet(str?: string, fallback: string = ''): string {
  if (!str) return fallback;
  if (str.length > MAX_CONTEXT_LENGTH) {
    return str.slice(0, MAX_CONTEXT_LENGTH) + '\n... (truncated context)';
  }
  return str;
}

export function interpolateAgentCommand(
  template: string,
  params: CommandInterpolationParams
): string {
  const defaultPrompt = params.prompt || DEFAULT_AGENT_PROMPT;
  const map: Record<string, string> = {
    pr: String(params.pr),
    branch: params.branch,
    baseBranch: params.baseBranch || 'main',
    owner: params.owner,
    repo: params.repo,
    url: params.url,
    worktree: params.worktree || '',
    ciLogs: sanitizeContextSnippet(params.ciLogs, 'No CI logs provided.'),
    comments: sanitizeContextSnippet(params.comments, 'No unresolved comments.'),
    diffSummary: sanitizeContextSnippet(params.diffSummary, 'No diff summary provided.'),
    failingCheck: params.failingCheck || 'test',
    playbook: params.playbook || 'custom',
    prompt: defaultPrompt,
  };

  // Single-pass function replacer prevents cascading expansion and ignores $ sequences
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : match;
  });
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

  const cmdTemplate = definition.command || `${agentName} "{prompt}"`;
  const command = interpolateAgentCommand(cmdTemplate, {
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

export function parseShellArgs(commandStr: string): { bin: string; args: string[] } {
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(commandStr)) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1]);
    } else if (match[2] !== undefined) {
      tokens.push(match[2]);
    } else {
      tokens.push(match[0]);
    }
  }
  const bin = tokens[0] || 'echo';
  const args = tokens.slice(1);
  return { bin, args };
}

export const ALLOWED_ENV_VARS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'EDITOR',
  'NODE_ENV',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
];

export function buildSanitizedEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {
    CI: '1',
    TERM: 'dumb',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };

  for (const key of ALLOWED_ENV_VARS) {
    if (baseEnv[key] !== undefined) {
      sanitized[key] = baseEnv[key];
    }
  }

  return sanitized;
}

export function getSpawnExecution(
  agentName: string,
  commandStr: string,
  promptText: string,
  definition: AgentDefinition
): { bin: string; args: string[] } {
  const norm = agentName.toLowerCase();
  if (norm === 'claude') {
    return { bin: 'claude', args: ['--dangerously-skip-permissions', '-p', promptText] };
  }
  if (norm === 'agy' || norm === 'gemini') {
    return { bin: 'agy', args: ['--sandbox', '--dangerously-skip-permissions', '--add-dir', '.', '--print-timeout', '20m', '-p', promptText] };
  }
  if (norm === 'pi') {
    return { bin: 'pi', args: [promptText] };
  }

  if (definition.bin && definition.args) {
    const interpolatedArgs = definition.args.map((arg) =>
      arg.replace(/\{prompt\}/g, () => promptText)
    );
    return { bin: definition.bin, args: interpolatedArgs };
  }

  return parseShellArgs(commandStr);
}

export async function dispatchAgent(options: DispatchOptions): Promise<WorkerHandle> {
  const { data, pr, config, cwd } = options;
  const agentName = options.agentName || (pr ? getRepoAgent(data, pr.key) : config.defaults.agent);
  const playbookName = options.playbookName || 'custom';
  const trigger = options.trigger || 'manual';
  const sessionId = crypto.randomUUID();
  const startTime = Date.now();
  const startTimeIso = new Date(startTime).toISOString();

  // Reject dispatch if a worker process is already actively running on this PR
  const keyStr = prKeyToString(pr.key);
  const existingWorker = data.workers.get(keyStr);
  if (existingWorker && existingWorker.status === 'running') {
    let isAlive = false;
    if (existingWorker.pid) {
      try {
        process.kill(existingWorker.pid, 0);
        isAlive = true;
      } catch {
        isAlive = false;
      }
    }
    if (isAlive) {
      throw new Error(`A worker process is already running for PR #${pr.key.number}`);
    }
  }

  // Determine effective mode: global dryRun always takes precedence over live
  const repoMode = getRepoMode(data, pr.key);
  const isDryRun = Boolean(
    data.dryRun ||
    data.settings?.dryRun ||
    options.mode === 'dry-run' ||
    (options.mode === undefined && repoMode === 'dry-run')
  );
  const effectiveMode = isDryRun ? 'dry-run' : 'live';

  // 1. Resolve Playbook & Injected Context
  const agentsConfig = loadAgentsConfig(cwd);
  const playbookDef = getPlaybookDefinition(playbookName, agentsConfig);

  let ciLogs = options.ciLogs;
  let comments = options.comments;
  let diffSummary = options.diffSummary;
  let failingCheck = options.failingCheck;

  // Context injection for playbooks (runs for both manual and autonomous dispatch)
  if (playbookDef.includeCiLogs && !ciLogs) {
    try {
      ciLogs = await fetchFailedCiLogs(pr.key.owner, pr.key.repo, pr.key.number);
    } catch {
      ciLogs = 'CI failure detected.';
    }
    if (!failingCheck) {
      failingCheck = pr.ciChecks?.find((c) => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT')?.name || 'test';
    }
  }

  if (playbookDef.includeReviewComments && !comments) {
    try {
      comments = await fetchUnresolvedReviewComments(pr.key.owner, pr.key.repo, pr.key.number);
    } catch {
      comments = 'Reviewers provided comments and feedback.';
    }
  }

  if (playbookDef.includeDiff && !diffSummary) {
    try {
      diffSummary = await fetchPrDiffSummary(pr.key.owner, pr.key.repo, pr.key.number);
    } catch {
      diffSummary = `Changed files: ${pr.changedFiles || 0} (+${pr.additions || 0}, -${pr.deletions || 0})`;
    }
  }

  const basePrompt = options.prompt || playbookDef.promptTemplate;
  const worktreePath = resolveWorktreeDir(config, pr, agentName, playbookName, cwd);

  const { command, definition, promptText } = buildAgentCommand(
    agentName,
    pr,
    config,
    worktreePath,
    basePrompt,
    {
      ciLogs,
      comments,
      diffSummary,
      failingCheck,
      playbook: playbookName,
    }
  );

  const driver: AgentDriverType = definition.driver || 'local';

  // 2. Prepare Log File
  const logFile = resolveLogPath(pr, cwd);
  const logDir = path.dirname(logFile);
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  } catch {
    // Ignore if already created
  }

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
        `=== [${startTimeIso}] DRY-RUN SIMULATION: ${agentName} · ${playbookName} · 🟡 DRY-RUN ===\n` +
          `PR:       ${pr.key.owner}/${pr.key.repo}#${pr.key.number} (${pr.branch} -> ${pr.baseBranch || 'main'})\n` +
          `Playbook: ${playbookName}\n` +
          `--------------------------------------------------------------------------------\n` +
          `${promptText}\n\n` +
          `=== [${new Date().toISOString()}] END SIMULATION ===\n\n`
      );
      try {
        logStream.end();
      } catch {
        // Ignore
      }
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
      try {
        logStream.end();
      } catch {
        // Ignore
      }
    }

    let isRemoteSuccess = false;
    let remoteError: string | undefined;

    try {
      await addComment(pr.key.owner, pr.key.repo, pr.key.number, triggerBody);
      appendLog(data, pr.key, `Posted trigger comment for @${agentName}`);
      isRemoteSuccess = true;
    } catch (err) {
      remoteError = (err as Error).message;
      appendLog(data, pr.key, `Remote trigger comment failed: ${remoteError}`);
    }

    const workerStatus = isRemoteSuccess ? 'completed' : 'failed';
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
      finishedAt: Date.now(),
      logPath: logFile,
      status: workerStatus,
      error: remoteError,
    };

    setWorker(data, pr.key, worker);
    saveState(data, undefined, cwd);

    // Record remote dispatch telemetry
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
      status: workerStatus,
      error: remoteError,
      summary: isRemoteSuccess
        ? `Dispatched remote bot @${agentName}`
        : `Failed to dispatch remote bot @${agentName}: ${remoteError}`,
    };
    recordAgentExecution(execRecord, undefined, cwd);

    return worker;
  }

  // ── Handle LOCAL Worktree Process Dispatch ──────────────────────────────────
  appendLog(data, pr.key, `Provisioning worktree at ${worktreePath}...`);

  const allowPush = !playbookDef.readOnly && playbookName !== 'preflight-review';
  try {
    await provisionWorktree(pr, worktreePath, { allowPush });
  } catch (err) {
    const errorMsg = `Worktree provisioning failed: ${(err as Error).message}`;
    appendLog(data, pr.key, errorMsg);
    if (logStream) {
      try {
        logStream.write(`\n[ERROR] ${errorMsg}\n`);
        logStream.end();
      } catch {
        // Ignore
      }
    }
    const failedWorker: WorkerHandle = {
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
      finishedAt: Date.now(),
      logPath: logFile,
      status: 'failed',
      error: errorMsg,
    };
    setWorker(data, pr.key, failedWorker);
    saveState(data, undefined, cwd);

    const execRecord: AgentExecutionRecord = {
      sessionId,
      prKey: pr.key,
      agentName,
      playbookName,
      driver: 'local',
      mode: 'live',
      trigger,
      startedAt: startTimeIso,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      status: 'failed',
      error: errorMsg,
    };
    recordAgentExecution(execRecord, undefined, cwd);
    return failedWorker;
  }

  appendLog(data, pr.key, `Dispatching agent '${agentName}' (${playbookName})...`);
  appendLog(data, pr.key, `Command: ${command}`);

  if (logStream) {
    logStream.write(
      `=== [${startTimeIso}] DISPATCH: ${agentName} · ${playbookName} · 🟢 LIVE ===\n` +
        `PR:       ${pr.key.owner}/${pr.key.repo}#${pr.key.number} (${pr.branch} -> ${pr.baseBranch || 'main'})\n` +
        `Worktree: ${worktreePath}\n` +
        `--------------------------------------------------------------------------------\n`
    );
  }

  const { bin, args } = getSpawnExecution(agentName, command, promptText, definition);
  const child = spawn(bin, args, {
    shell: false,
    cwd: worktreePath,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildSanitizedEnvironment(process.env),
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
    touchedFiles: [],
  };

  setWorker(data, pr.key, worker);
  saveState(data, undefined, cwd);

  // Background Worktree Real-Time Activity Poller
  let previousTouched: string[] = [];
  const activityPoller = setInterval(async () => {
    if (worker.status !== 'running') {
      clearInterval(activityPoller);
      return;
    }
    try {
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath });
      const currentFiles = statusOut
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.slice(3).trim());

      const changed =
        currentFiles.length !== previousTouched.length ||
        currentFiles.some((f, idx) => f !== previousTouched[idx]);

      if (changed) {
        previousTouched = currentFiles;
        worker.touchedFiles = currentFiles;
        worker.lastActivity = `${currentFiles.length} file(s) modified`;
        worker.lastActivityAt = Date.now();
        saveState(data, undefined, cwd);

        if (currentFiles.length > 0 && logStream && !logStream.destroyed) {
          const sample = currentFiles.slice(0, 3).join(', ') + (currentFiles.length > 3 ? ` (+${currentFiles.length - 3} more)` : '');
          const timeStr = new Date().toISOString().substring(11, 19);
          logStream.write(`\n[${timeStr}] ⚡ File Activity: ${currentFiles.length} file(s) modified (${sample})\n`);
        }
      }
    } catch {
      // Ignore git polling errors during execution
    }
  }, 1500);

  let capturedOutput = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    capturedOutput += text;
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
    capturedOutput += text;
    try {
      logStream?.write(text);
    } catch {
      // Ignore write errors
    }
  });

  child.on('close', async (code, signal) => {
    clearInterval(activityPoller);
    if (worker.status !== 'running') {
      // Already cancelled or handled
      return;
    }
    const finishedAt = Date.now();
    const durationMs = finishedAt - startTime;
    const durationSec = (durationMs / 1000).toFixed(1);
    const durationMinSec =
      durationMs >= 60000
        ? `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`
        : `${durationSec}s`;

    try {
      if (logStream && !logStream.destroyed) {
        logStream.write(
          `\n--------------------------------------------------------------------------------\n` +
            `=== [${new Date(finishedAt).toISOString()}] COMPLETED in ${durationMinSec} · Exit Code: ${code ?? (signal ? `signal ${signal}` : 0)} ===\n\n`
        );
        logStream.end();
      }
    } catch {
      // Ignore end errors
    }
    worker.finishedAt = finishedAt;

    const isSuccess = code === 0;
    worker.status = isSuccess ? 'completed' : 'failed';

    if (isSuccess) {
      appendLog(data, pr.key, `Agent '${agentName}' (${playbookName}) completed successfully`);
    } else {
      appendLog(data, pr.key, `Agent '${agentName}' (${playbookName}) exited with code ${code ?? 'signal ' + signal}`);
    }

    // If preflight-review completed with findings, publish to GitHub PR
    if (playbookName === 'preflight-review' && isSuccess && capturedOutput.trim().length > 0) {
      try {
        await addComment(pr.key.owner, pr.key.repo, pr.key.number, capturedOutput.trim());
        appendLog(data, pr.key, `Published preflight review findings to GitHub PR #${pr.key.number}`);
      } catch (err) {
        appendLog(data, pr.key, `Failed to post review findings to GitHub: ${(err as Error).message}`);
      }
    }

    // For mutable playbooks, commit and push any uncommitted edits or unpushed commits on clean exit
    if (code === 0 && !playbookDef.readOnly && playbookName !== 'preflight-review') {
      try {
        const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath });
        if (statusOut.trim().length > 0) {
          await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
          await execFileAsync('git', ['commit', '-m', `fix: address ${playbookName} feedback`], { cwd: worktreePath });
        }

        // Check if local branch has commits to push
        let shouldPush = true;
        try {
          const { stdout: revOut } = await execFileAsync('git', ['rev-list', `origin/${pr.branch}..HEAD`, '--count'], { cwd: worktreePath });
          if (parseInt(revOut.trim(), 10) === 0) {
            shouldPush = false;
          }
        } catch {
          // If tracking branch check fails, attempt push directly
        }

        if (shouldPush) {
          await execFileAsync('git', ['push', 'origin', pr.branch], { cwd: worktreePath });
          appendLog(data, pr.key, `Fixer agent pushed fixes to branch '${pr.branch}'`);
          try {
            if (logStream && !logStream.destroyed) {
              logStream.write(`\n[Overseer]: Successfully pushed commits to origin/${pr.branch}\n`);
            }
          } catch {
            // Ignore logStream write errors
          }
        }
      } catch (pushErr) {
        const errMsg = (pushErr as Error).message;
        appendLog(data, pr.key, `Failed to push fixes to branch '${pr.branch}': ${errMsg}`);
        try {
          if (logStream && !logStream.destroyed) {
            logStream.write(`\n[Overseer Warning]: git push failed: ${errMsg}\n`);
          }
        } catch {
          // Ignore logStream write errors
        }
      }
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
      exitCode: code ?? undefined,
      signal: signal ?? undefined,
      touchedFiles: worker.touchedFiles,
    };
    recordAgentExecution(execRecord, undefined, cwd);
    saveState(data, undefined, cwd);
  });

  child.on('error', (err) => {
    if (worker.status !== 'running') {
      return;
    }
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
      touchedFiles: worker.touchedFiles,
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

  worker.status = 'cancelled';
  worker.finishedAt = Date.now();

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
