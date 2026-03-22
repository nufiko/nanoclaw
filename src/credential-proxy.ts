/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * OAuth token lifecycle:
 *   Tokens are read from ~/.claude/.credentials.json (kept fresh by Claude Code).
 *   If near expiry, the proxy auto-refreshes using the stored refresh token.
 *   Falls back to CLAUDE_CODE_OAUTH_TOKEN in .env if credentials file unavailable.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// Refresh 5 minutes before expiry to avoid races
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface ClaudeOAuthCreds {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
}

let credentialsPath = join(homedir(), '.claude', '.credentials.json');
let tokenCache: { token: string; expiresAt: number } | null = null;

/** Override credentials path — for tests only. */
export function _setCredentialsPathForTesting(path: string): void {
  credentialsPath = path;
  tokenCache = null;
}

export async function getValidOAuthToken(
  envToken?: string,
): Promise<string | null> {
  // Use cached token if still fresh
  if (
    tokenCache &&
    tokenCache.expiresAt - Date.now() > TOKEN_EXPIRY_BUFFER_MS
  ) {
    return tokenCache.token;
  }

  // Try ~/.claude/.credentials.json (kept fresh by Claude Code)
  try {
    const creds: ClaudeOAuthCreds = JSON.parse(
      readFileSync(credentialsPath, 'utf8'),
    );
    const oauth = creds.claudeAiOauth;

    if (oauth) {
      if (oauth.expiresAt - Date.now() > TOKEN_EXPIRY_BUFFER_MS) {
        tokenCache = { token: oauth.accessToken, expiresAt: oauth.expiresAt };
        return oauth.accessToken;
      }

      // Near expiry — try to refresh
      logger.info('OAuth token near expiry, attempting refresh');
      const refreshed = await refreshOAuthToken(oauth.refreshToken);
      if (refreshed) {
        const updated: ClaudeOAuthCreds = {
          ...creds,
          claudeAiOauth: { ...oauth, ...refreshed },
        };
        writeFileSync(credentialsPath, JSON.stringify(updated, null, 2));
        tokenCache = {
          token: refreshed.accessToken,
          expiresAt: refreshed.expiresAt,
        };
        logger.info('OAuth token refreshed successfully');
        return refreshed.accessToken;
      }
      logger.warn('OAuth token refresh failed, falling back to .env token');
    }
  } catch {
    // credentials file not found or unreadable — fall through
  }

  return envToken || null;
}

async function refreshOAuthToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: number;
} | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const req = httpsRequest(
      {
        hostname: 'claude.ai',
        path: '/api/auth/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (data.access_token) {
              resolve({
                accessToken: data.access_token,
                expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
              });
            } else {
              logger.warn(
                { status: res.statusCode, data },
                'OAuth refresh returned no access_token',
              );
              resolve(null);
            }
          } catch (err) {
            logger.warn({ err }, 'OAuth refresh response parse error');
            resolve(null);
          }
        });
      },
    );

    req.on('error', (err) => {
      logger.warn({ err }, 'OAuth refresh request error');
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const envOauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const body = Buffer.concat(chunks);
          const headers: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

          // Strip hop-by-hop headers that must not be forwarded by proxies
          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];

          if (authMode === 'api-key') {
            // API key mode: inject x-api-key on every request
            delete headers['x-api-key'];
            headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
          } else {
            // OAuth mode: replace placeholder Bearer token with the real one
            // only when the container actually sends an Authorization header
            // (exchange request + auth probes). Post-exchange requests use
            // x-api-key only, so they pass through without token injection.
            if (headers['authorization']) {
              delete headers['authorization'];
              const token = await getValidOAuthToken(envOauthToken);
              if (token) {
                headers['authorization'] = `Bearer ${token}`;
              }
            }
          }

          const upstream = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes) => {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            },
          );

          upstream.on('error', (err) => {
            logger.error(
              { err, url: req.url },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
        })();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
