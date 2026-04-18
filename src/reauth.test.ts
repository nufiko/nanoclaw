import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// spawnMock: lazy arrow so the const is only read when the mock is called (not at hoist time)
const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleReauth, _resetForTesting } from './reauth.js';

// Helper: build a mock ChildProcess
function createMockProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe('reauth', () => {
  beforeEach(() => {
    _resetForTesting();
    spawnMock.mockReset();
  });

  afterEach(() => {
    _resetForTesting();
    vi.restoreAllMocks();
  });

  it('sends URL to WhatsApp when it appears in stdout', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    const messages: string[] = [];

    const promise = handleReauth(async (text) => {
      messages.push(text);
    });

    proc.stdout.emit(
      'data',
      Buffer.from(
        "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&x=1\n",
      ),
    );
    proc.emit('close', 0);

    await promise;

    expect(messages[0]).toBe('https://claude.ai/oauth/authorize?code=true&x=1');
    expect(messages[1]).toBe('Authentication successful. New token is active.');
  });

  it('spawns claude auth login with BROWSER=cat', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    const promise = handleReauth(async () => {});
    proc.stdout.emit('data', Buffer.from('visit: https://claude.ai/x\n'));
    proc.emit('close', 0);
    await promise;

    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      ['auth', 'login'],
      expect.objectContaining({
        env: expect.objectContaining({ BROWSER: 'cat' }),
      }),
    );
  });

  it('sends failure message on non-zero exit code', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    const messages: string[] = [];

    const promise = handleReauth(async (text) => {
      messages.push(text);
    });
    proc.emit('close', 1);
    await promise;

    expect(messages[0]).toContain('Authentication failed');
  });

  it('prevents concurrent reauths', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    const messages: string[] = [];

    // First reauth in flight (not yet resolved)
    handleReauth(async (text) => {
      messages.push(text);
    });

    // Second reauth should be rejected immediately
    const secondMessages: string[] = [];
    await handleReauth(async (text) => {
      secondMessages.push(text);
    });

    expect(secondMessages[0]).toBe('Re-authentication already in progress.');
    expect(spawnMock).toHaveBeenCalledOnce();

    // Clean up first reauth
    proc.emit('close', 0);
  });

  it('sends error message if spawn throws', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const messages: string[] = [];

    await handleReauth(async (text) => {
      messages.push(text);
    });

    expect(messages[0]).toContain('Re-authentication failed');
    expect(messages[0]).toContain('ENOENT');
  });

  it('times out after 5 minutes if process does not exit', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    const messages: string[] = [];

    const promise = handleReauth(async (text) => {
      messages.push(text);
    });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

    await promise;

    expect(messages[0]).toContain('timed out');
    expect(proc.kill).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('does not send duplicate message when timeout fires and close follows', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    const messages: string[] = [];

    const promise = handleReauth(async (text) => {
      messages.push(text);
    });

    // Timeout fires first
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    // Then process emits close
    proc.emit('close', 1);

    await promise;

    // Only one message — the timeout message
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('timed out');

    vi.useRealTimers();
  });
});
