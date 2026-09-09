import crypto from 'crypto';

/**
 * Verifies Telegram Web App initData according to the official algorithm:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
 *
 * Returns the parsed user object if valid, or null if invalid/expired.
 */
export function verifyTelegramWebAppData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || typeof initData !== 'string') return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');

    // Build the data-check-string: all fields sorted alphabetically as key=value, joined by \n
    const dataCheckArr = [];
    for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      dataCheckArr.push(`${key}=${value}`);
    }
    const dataCheckString = dataCheckArr.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computedHash !== hash) return null;

    // Check auth_date freshness
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (maxAgeSeconds > 0 && nowSeconds - authDate > maxAgeSeconds) return null;

    const userRaw = params.get('user');
    const user = userRaw ? JSON.parse(userRaw) : null;

    return { user, authDate };
  } catch (e) {
    return null;
  }
}
