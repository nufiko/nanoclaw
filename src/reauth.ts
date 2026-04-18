import { spawn, ChildProcess } from 'child_process';

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
