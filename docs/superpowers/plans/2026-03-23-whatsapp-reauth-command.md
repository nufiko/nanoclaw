# WhatsApp `!reauth` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `!reauth` WhatsApp command that triggers `claude auth login` on the host, sends the OAuth URL back to WhatsApp, waits for completion, then invalidates the proxy token cache so the fresh token is used immediately.

**Architecture:** Three focused changes: (1) add `invalidateTokenCache()` export to `credential-proxy.ts`; (2) create `src/reauth.ts` — a self-contained module that manages a single in-flight `claude auth login` process, streams stdout for the URL, and handles timeout/cleanup; (3) intercept `!reauth` in `onMessage` in `index.ts` (main group only), exactly mirroring the existing `/remote-control` pattern.

**Tech Stack:** Node.js `child_process.spawn`, vitest mocks, TypeScript

---

## File Map

| File | Change |
|------|--------|
| `src/credential-proxy.ts` | Add `invalidateTokenCache()` export (sets `tokenCache = null`) |
| `src/credential-proxy.test.ts` | Add test: cache is cleared and re-read after `invalidateTokenCache()` |
| `src/reauth.ts` | New — reauth handler module |
| `src/reauth.test.ts` | New — tests for reauth handler |
| `src/index.ts` | Add `!reauth` intercept in `onMessage` |

---

## Task 1: Add `invalidateTokenCache()` to `credential-proxy.ts`

**Files:**
- Modify: `src/credential-proxy.ts`
- Modify: `src/credential-proxy.test.ts`

- [ ] **Step 1: Write the failing test**

Open `src/credential-proxy.test.ts`. Find the `describe('credential-proxy')` block. Import `invalidateTokenCache` alongside the existing imports. Add a new `describe` block for it:

```ts
// At the top import (update existing import):
import {
  startCredentialProxy,
  getValidOAuthToken,
  invalidateTokenCache,
  _setCredentialsPathForTesting,
} from './credential-proxy.js';

// New describe block, inside describe('credential-proxy'):
describe('invalidateTokenCache', () => {
  it('forces re-read of credentials file on next getValidOAuthToken call', async () => {
    const credFile = join(tmpdir(), `creds-invalidate-${Date.now()}.json`);
    const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour from now
    writeFileSync(
      credFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'token-a',
          refreshToken: 'refresh-a',
          expiresAt,
        },
      }),
    );

    _setCredentialsPathForTesting(credFile);

    // Populate the cache
    const first = await getValidOAuthToken();
    expect(first).toBe('token-a');

    // Write a new token to disk
    writeFileSync(
      credFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'token-b',
          refreshToken: 'refresh-b',
          expiresAt,
        },
      }),
    );

    // Without invalidation, cache returns old token
    const cached = await getValidOAuthToken();
    expect(cached).toBe('token-a');

    // After invalidation, re-reads disk
    invalidateTokenCache();
    const fresh = await getValidOAuthToken();
    expect(fresh).toBe('token-b');

    try { unlinkSync(credFile); } catch { /* ignore */ }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/credential-proxy.test.ts 2>&1 | tail -20
```

Expected: FAIL — `invalidateTokenCache` is not exported.

- [ ] **Step 3: Add `invalidateTokenCache()` export to `credential-proxy.ts`**

Add after the `_setCredentialsPathForTesting` function (around line 52):

```ts
/** Invalidate the in-memory token cache, forcing re-read on the next request. */
export function invalidateTokenCache(): void {
  tokenCache = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- src/credential-proxy.test.ts 2>&1 | tail -20
```

Expected: all credential-proxy tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/credential-proxy.ts src/credential-proxy.test.ts
git commit -m "feat: add invalidateTokenCache() export to credential-proxy"
```

---

## Task 2: Create `src/reauth.ts`

**Files:**
- Create: `src/reauth.ts`
- Create: `src/reauth.test.ts`

### 2a — Test scaffolding and happy path

- [ ] **Step 1: Write the failing test**

Create `src/reauth.test.ts`:

```ts
import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock child_process
const spawnMock = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

// Mock credential-proxy
const invalidateTokenCacheMock = vi.fn();
vi.mock('./credential-proxy.js', () => ({
  invalidateTokenCache: invalidateTokenCacheMock,
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
    invalidateTokenCacheMock.mockReset();
  });

  afterEach(() => {
    _resetForTesting();
    vi.restoreAllMocks();
  });

  it('sends URL to WhatsApp when it appears in stdout', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    const messages: string[] = [];

    const promise = handleReauth(async (text) => { messages.push(text); });

    // Simulate stdout with URL line
    proc.stdout.emit(
      'data',
      Buffer.from(
        'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.ai/oauth/authorize?code=true&x=1\n',
      ),
    );
    proc.emit('close', 0);

    await promise;

    expect(messages[0]).toBe('https://claude.ai/oauth/authorize?code=true&x=1');
    expect(messages[1]).toBe('Authentication successful. New token is active.');
  });

  it('calls invalidateTokenCache() on success', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    const promise = handleReauth(async () => {});
    proc.stdout.emit('data', Buffer.from('visit: https://claude.ai/oauth/authorize?x=1\n'));
    proc.emit('close', 0);
    await promise;

    expect(invalidateTokenCacheMock).toHaveBeenCalledOnce();
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/reauth.test.ts 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/reauth.ts`**

```ts
import { spawn, ChildProcess } from 'child_process';

import { invalidateTokenCache } from './credential-proxy.js';
import { logger } from './logger.js';

const URL_REGEX = /visit: (https?:\/\/\S+)/;
const REAUTH_TIMEOUT_MS = 5 * 60 * 1000;

interface ActiveReauth {
  proc: ChildProcess;
  timeout: ReturnType<typeof setTimeout>;
}

let activeReauth: ActiveReauth | null = null;

/** @internal — exported for testing only */
export function _resetForTesting(): void {
  activeReauth = null;
}

export async function handleReauth(
  sendMessage: (text: string) => Promise<void>,
): Promise<void> {
  if (activeReauth) {
    await sendMessage('Re-authentication already in progress.');
    return;
  }

  let proc: ChildProcess;
  try {
    proc = spawn('claude', ['auth', 'login'], {
      env: { ...process.env, BROWSER: 'cat' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    await sendMessage(`Re-authentication failed: ${err.message}`);
    return;
  }

  let finished = false;

  const finish = async (success: boolean, message: string): Promise<void> => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    try {
      proc.kill();
    } catch {
      // already dead
    }
    activeReauth = null;
    if (success) invalidateTokenCache();
    try {
      await sendMessage(message);
    } catch (err) {
      logger.warn({ err }, 'reauth: sendMessage error in finish');
    }
  };

  const timeout = setTimeout(() => {
    logger.warn('reauth timed out after 5 minutes');
    finish(
      false,
      'Re-authentication timed out. Run `claude auth login` manually.',
    ).catch((err) => logger.warn({ err }, 'reauth: timeout handler error'));
  }, REAUTH_TIMEOUT_MS);

  activeReauth = { proc, timeout };

  let urlSent = false;
  let stdoutBuf = '';

  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    if (!urlSent) {
      const match = stdoutBuf.match(URL_REGEX);
      if (match) {
        urlSent = true;
        sendMessage(match[1]).catch((err) =>
          logger.warn({ err }, 'reauth: sendMessage error sending URL'),
        );
      }
    }
  });

  proc.on('close', (code: number | null) => {
    if (code === 0) {
      logger.info('reauth: claude auth login succeeded');
      finish(true, 'Authentication successful. New token is active.').catch(
        (err) => logger.warn({ err }, 'reauth: close handler error'),
      );
    } else {
      logger.warn({ code }, 'reauth: claude auth login exited non-zero');
      finish(
        false,
        'Authentication failed. Run `claude auth login` manually.',
      ).catch((err) => logger.warn({ err }, 'reauth: close handler error'));
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- src/reauth.test.ts 2>&1 | tail -20
```

Expected: first 3 tests PASS.

### 2b — Remaining test cases

- [ ] **Step 5: Add remaining tests**

Append inside the `describe('reauth')` block in `src/reauth.test.ts`:

```ts
  it('sends failure message on non-zero exit code', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    const messages: string[] = [];

    const promise = handleReauth(async (text) => { messages.push(text); });
    proc.emit('close', 1);
    await promise;

    expect(messages[0]).toContain('Authentication failed');
    expect(invalidateTokenCacheMock).not.toHaveBeenCalled();
  });

  it('prevents concurrent reauths', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    const messages: string[] = [];

    // First reauth in flight (not yet resolved)
    handleReauth(async (text) => { messages.push(text); });

    // Second reauth should be rejected immediately
    const secondMessages: string[] = [];
    await handleReauth(async (text) => { secondMessages.push(text); });

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

    await handleReauth(async (text) => { messages.push(text); });

    expect(messages[0]).toContain('Re-authentication failed');
    expect(messages[0]).toContain('ENOENT');
  });

  it('times out after 5 minutes if process does not exit', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    const messages: string[] = [];

    const promise = handleReauth(async (text) => { messages.push(text); });

    // Advance past 5-minute timeout
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

    await promise;

    expect(messages[0]).toContain('timed out');
    expect(proc.kill).toHaveBeenCalled();
    expect(invalidateTokenCacheMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('does not send duplicate message when timeout fires and close follows', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    const messages: string[] = [];

    const promise = handleReauth(async (text) => { messages.push(text); });

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
```

- [ ] **Step 6: Run all reauth tests to verify they pass**

```bash
npm test -- src/reauth.test.ts 2>&1 | tail -30
```

Expected: all reauth tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/reauth.ts src/reauth.test.ts
git commit -m "feat: add reauth module for !reauth WhatsApp command"
```

---

## Task 3: Wire `!reauth` intercept in `index.ts`

**Files:**
- Modify: `src/index.ts`

No new tests needed — `index.ts` is an orchestration layer and the unit logic is fully tested in `reauth.test.ts`. The integration is a two-line change mirroring the existing `/remote-control` pattern.

- [ ] **Step 1: Add import**

In `src/index.ts`, find the existing remote-control import:

```ts
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
```

Add `handleReauth` import below it:

```ts
import { handleReauth } from './reauth.js';
```

- [ ] **Step 2: Add `!reauth` intercept in `onMessage`**

In `src/index.ts`, find the `onMessage` callback (around line 611). The existing remote-control intercept looks like:

```ts
const trimmed = msg.content.trim();
if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
  handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
    logger.error({ err, chatJid }, 'Remote control command error'),
  );
  return;
}
```

Add the `!reauth` intercept immediately after (before the sender allowlist check):

```ts
if (trimmed === '!reauth') {
  const group = registeredGroups[chatJid];
  if (group?.isMain) {
    const channel = findChannel(channels, chatJid);
    if (channel) {
      handleReauth((text) => channel.sendMessage(chatJid, text)).catch(
        (err) => logger.error({ err, chatJid }, 'Reauth command error'),
      );
    }
  }
  return;
}
```

Note: `return` is unconditional — `!reauth` from non-main groups is silently dropped (not stored, not processed).

- [ ] **Step 3: Build to check for type errors**

```bash
npm run build 2>&1 | tail -20
```

Expected: build succeeds with no errors.

- [ ] **Step 4: Run full test suite**

```bash
npm test 2>&1 | tail -30
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: add !reauth host command for WhatsApp OAuth re-authentication"
```
