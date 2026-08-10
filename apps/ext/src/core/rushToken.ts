import * as fs from 'fs/promises';

interface TokenCacheEntry {
  mtimeMs: number;
  size: number;
  token: string | null;
}

let cache: TokenCacheEntry | undefined;

// Test seam: drop the cached token so each test starts from a cold read.
export function resetRushTokenCache(): void {
  cache = undefined;
}

// Read + parse the Rush access token from user.yaml, caching the parsed value
// keyed by the file's mtime+size. The floor tab polls every 10s (plus bursts on
// terminal open/close); without this the token file was read + regex-parsed
// synchronously on every call. Returns null when the file or token is absent.
export async function readRushTokenCached(filePath: string): Promise<string | null> {
  let st: { mtimeMs: number; size: number };
  try {
    st = await fs.stat(filePath);
  } catch {
    cache = undefined;
    return null;
  }

  if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache.token;
  }

  let token: string | null = null;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const match = content.match(/access_token:\s*(.+)/);
    token = match ? match[1].trim() : null;
  } catch {
    token = null;
  }

  cache = { mtimeMs: st.mtimeMs, size: st.size, token };
  return token;
}
