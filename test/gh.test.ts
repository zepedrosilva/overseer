import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import {
  mergePR,
  addComment,
  closePR,
  openInBrowser,
  getPRDiff,
  isGHAvailable,
  isGHAuthenticated,
  getCurrentUser,
} from '../src/watcher/gh.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

describe('GitHub CLI Wrapper Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks gh availability', async () => {
    vi.mocked(childProcess.execFile).mockImplementation((file, args, callback: any) => {
      callback(null, { stdout: 'gh version 2.50.0\n', stderr: '' });
      return {} as any;
    });

    expect(await isGHAvailable()).toBe(true);
  });

  it('checks gh auth status', async () => {
    vi.mocked(childProcess.execFile).mockImplementation((file, args, callback: any) => {
      callback(null, { stdout: 'Logged in to github.com\n', stderr: '' });
      return {} as any;
    });

    expect(await isGHAuthenticated()).toBe(true);
  });

  it('retrieves current user login', async () => {
    vi.mocked(childProcess.execFile).mockImplementation((file, args, callback: any) => {
      callback(null, { stdout: 'josesilva\n', stderr: '' });
      return {} as any;
    });

    expect(await getCurrentUser()).toBe('josesilva');
  });

  it('executes mergePR with squash and delete-branch flags', async () => {
    vi.mocked(childProcess.execFile).mockImplementation((file, args, callback: any) => {
      expect(file).toBe('gh');
      expect(args).toEqual([
        'pr', 'merge', '142',
        '--repo', 'MewsSystems/billing',
        '--squash',
        '--delete-branch',
      ]);
      callback(null, { stdout: 'Merged\n', stderr: '' });
      return {} as any;
    });

    const res = await mergePR('MewsSystems', 'billing', 142, true);
    expect(res).toBe('Merged');
  });

  it('executes addComment with body and repo flags', async () => {
    vi.mocked(childProcess.execFile).mockImplementation((file, args, callback: any) => {
      expect(file).toBe('gh');
      expect(args).toEqual([
        'pr', 'comment', '142',
        '--repo', 'MewsSystems/billing',
        '--body', 'LGTM! Great job.',
      ]);
      callback(null, { stdout: 'https://github.com/comment/1\n', stderr: '' });
      return {} as any;
    });

    const res = await addComment('MewsSystems', 'billing', 142, 'LGTM! Great job.');
    expect(res).toBe('https://github.com/comment/1');
  });

  it('executes closePR with repo flag', async () => {
    vi.mocked(childProcess.execFile).mockImplementation((file, args, callback: any) => {
      expect(file).toBe('gh');
      expect(args).toEqual([
        'pr', 'close', '142',
        '--repo', 'MewsSystems/billing',
      ]);
      callback(null, { stdout: 'Closed\n', stderr: '' });
      return {} as any;
    });

    const res = await closePR('MewsSystems', 'billing', 142);
    expect(res).toBe('Closed');
  });

  it('executes openInBrowser with --web flag', async () => {
    vi.mocked(childProcess.execFile).mockImplementation((file, args, callback: any) => {
      expect(file).toBe('gh');
      expect(args).toEqual([
        'pr', 'view', '142',
        '--repo', 'MewsSystems/billing',
        '--web',
      ]);
      callback(null, { stdout: '', stderr: '' });
      return {} as any;
    });

    await openInBrowser('MewsSystems', 'billing', 142);
  });

  it('executes getPRDiff', async () => {
    vi.mocked(childProcess.execFile).mockImplementation((file, args, callback: any) => {
      expect(file).toBe('gh');
      expect(args).toEqual([
        'pr', 'diff', '142',
        '--repo', 'MewsSystems/billing',
      ]);
      callback(null, { stdout: 'diff --git a/file b/file\n', stderr: '' });
      return {} as any;
    });

    const diff = await getPRDiff('MewsSystems', 'billing', 142);
    expect(diff).toContain('diff --git');
  });
});
