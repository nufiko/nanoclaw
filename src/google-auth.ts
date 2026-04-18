import { logger } from './logger.js';

export async function getGoogleAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Google token refresh failed');
      return null;
    }
    const data = (await res.json()) as { access_token: string };
    return data.access_token ?? null;
  } catch (err) {
    logger.warn({ err }, 'Google token refresh error');
    return null;
  }
}
