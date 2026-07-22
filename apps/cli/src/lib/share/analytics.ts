// Cloudflare Web Analytics injection for `agents share`.
//
// The beacon is cookieless and privacy-first, which matters because a lot of shared
// content (games, kid-facing pages) should avoid GA4-style tracking. The token is
// stored in the synced share config and injected into every published HTML page at
// publish time, so analytics work with zero user effort once setup is complete.

const BEACON_OPEN = '<!-- agents-share:analytics -->';
const BEACON_CLOSE = '<!-- /agents-share:analytics -->';

/** Cloudflare Web Analytics snippet for a given zone token. */
export function renderBeacon(token: string): string {
  const payload = JSON.stringify({ token });
  return (
    `${BEACON_OPEN}\n` +
    '<script defer ' +
    'src="https://static.cloudflareinsights.com/beacon.min.js" ' +
    `data-cf-beacon='${payload}'></script>\n` +
    `${BEACON_CLOSE}\n`
  );
}

/** Strip a previously-injected analytics block so re-publishing doesn't duplicate it. */
function stripPrevious(html: string): string {
  const re = new RegExp(`${BEACON_OPEN}[\\s\\S]*?${BEACON_CLOSE}\\n?`, 'g');
  return html.replace(re, '');
}

/**
 * Inject the CF Web Analytics beacon into an HTML page. Idempotent: any existing
 * agents-share analytics block is removed first. The snippet is appended before
 * `</body>` when present, otherwise before `</head>`, otherwise prepended to the
 * document so it still loads.
 */
export function injectAnalyticsBeacon(html: string, token: string): string {
  if (!token) return html;
  const cleaned = stripPrevious(html);
  const block = renderBeacon(token);

  const bodyClose = cleaned.search(/<\/body>/i);
  if (bodyClose !== -1) return cleaned.slice(0, bodyClose) + block + cleaned.slice(bodyClose);

  const headClose = cleaned.search(/<\/head>/i);
  if (headClose !== -1) return cleaned.slice(0, headClose) + block + cleaned.slice(headClose);

  return block + cleaned;
}

/** True if the share config has a non-empty analytics token. */
export function analyticsEnabled(cfg: { analyticsToken?: string } | undefined | null): boolean {
  return Boolean(cfg?.analyticsToken && cfg.analyticsToken.trim().length > 0);
}
