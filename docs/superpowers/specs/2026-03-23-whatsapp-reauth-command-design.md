# WhatsApp `!reauth` Command — Design Spec

**Date:** 2026-03-23
**Status:** Approved

## Problem

The NanoClaw credential proxy auto-refreshes Claude OAuth tokens proactively (5 min before expiry). If no requests pass through the proxy for an extended period and the token fully expires, the next refresh may fail if the refresh token has also expired or been revoked. Previously the proxy silently fell back to a stale `.env` token, forwarding an expired credential and producing a confusing 401 from downstream agents (e.g. Vilicus).

After the credential-proxy fix (return `null` on refresh failure instead of falling back to stale `.env` token), the error surfaces immediately — but the user still needs a way to re-authenticate without leaving WhatsApp.

## Goal

Allow any member of the main WhatsApp group to trigger a host-side `claude auth login` by sending `!reauth`, receive the OAuth URL in WhatsApp, complete auth in their browser, and get a confirmation message when the token is live.

## Architecture

### Module: `src/reauth.ts`

Standalone module with a single exported function `handleReauth`. Keeps `index.ts` clean — the same isolation pattern used by `remote-control.ts`.

**State managed internally:**
- `activeReauth`: a reference to the in-flight reauth process + timeout handle, or `null`. Prevents concurrent reauthentications.

**Exported surface:**
```ts
export async function handleReauth(
  sendMessage: (text: string) => Promise<void>
): Promise<void>
```

### Integration in `index.ts`

Intercept `!reauth` in `onMessage` before message storage — identical to the `/remote-control` interception pattern:

```ts
if (trimmed === '!reauth') {
  const group = registeredGroups[chatJid];
  if (!group?.isMain) return;           // main group only
  const channel = findChannel(channels, chatJid);
  if (!channel) return;
  handleReauth((text) => channel.sendMessage(chatJid, text)).catch(...)
  return;
}
```

### Token cache invalidation

On successful reauth, call `invalidateTokenCache()` — a new export from `credential-proxy.ts` that sets `tokenCache = null`. This ensures the proxy re-reads `~/.claude/.credentials.json` on the next request rather than serving a cached expired token.

## Detailed Flow

```
User sends "!reauth"
  → onMessage intercept (main group check)
  → handleReauth called

handleReauth:
  1. If activeReauth exists → send "Re-authentication already in progress." → return
  2. Spawn: claude auth login, env: { ...process.env, BROWSER: 'cat' }
  3. Read stdout line-by-line
  4. On line matching /visit: (https?:\/\/\S+)/
       → send URL to WhatsApp
       → start 5-min timeout
  5. On process exit (code 0)
       → clear timeout
       → invalidateTokenCache()
       → send "Authentication successful. New token is active."
  6. On process exit (non-zero) or timeout
       → kill process if still running
       → send "Authentication failed or timed out. Run `claude auth login` manually."
  7. activeReauth = null
```

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Second `!reauth` while one is in progress | Reply "already in progress", do nothing else |
| `claude` binary not found | Process spawn error → send failure message |
| URL never appears in stdout | Timeout fires after 5 min → failure message |
| User completes auth but process exits non-zero | Send failure message, cache not invalidated |
| Non-main group sends `!reauth` | Silently ignored (not stored, not processed) |

## Files Changed

| File | Change |
|------|--------|
| `src/reauth.ts` | New — reauth handler module |
| `src/credential-proxy.ts` | Add `invalidateTokenCache()` export |
| `src/index.ts` | Add `!reauth` intercept in `onMessage` |

## Out of Scope

- Scheduling automatic reauth checks
- Support for `--console` / `--sso` login variants (can be added later)
- Channels other than WhatsApp (the `onMessage` intercept is channel-agnostic; other channels work automatically)
