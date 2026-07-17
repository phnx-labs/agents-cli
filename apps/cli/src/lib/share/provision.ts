// Cloudflare provisioning for `agents share setup` — plain `fetch` against the CF
// REST API (the repo has no CF wrapper). Creates the R2 bucket, uploads the Worker
// (with an R2 binding + the WRITE_TOKEN as an inline secret), enables the free
// `*.workers.dev` subdomain, and — when the token owns the zone — maps a custom domain.

const CF_API = 'https://api.cloudflare.com/client/v4';

interface CfError {
  code?: number;
  message?: string;
}

async function cf<T = unknown>(
  apiToken: string,
  method: string,
  pathname: string,
  body?: unknown,
  form?: FormData,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${apiToken}` };
  let payload: FormData | string | undefined;
  if (form) {
    payload = form; // fetch sets multipart boundary
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${CF_API}${pathname}`, { method, headers, body: payload });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: CfError[];
    result?: T;
  };
  if (!res.ok || json.success === false) {
    const msg =
      (json.errors ?? []).map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') ||
      res.statusText;
    throw new Error(`Cloudflare ${method} ${pathname} failed (${res.status}): ${msg}`);
  }
  return json.result as T;
}

/** True if the CF error looks like "the thing already exists" (idempotent create). */
function isAlreadyExists(e: unknown): boolean {
  return /already exists|duplicate|10004|10014/i.test(String(e));
}

/** Create the R2 bucket (idempotent). */
export async function createBucket(apiToken: string, accountId: string, name: string): Promise<void> {
  try {
    await cf(apiToken, 'POST', `/accounts/${accountId}/r2/buckets`, { name });
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  }
}

/** Upload the module Worker with an R2 binding (`BUCKET`) + inline `WRITE_TOKEN` secret. */
export async function deployWorker(
  apiToken: string,
  accountId: string,
  workerName: string,
  script: string,
  bucketName: string,
  writeToken: string,
): Promise<void> {
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2024-11-06',
    bindings: [
      { type: 'r2_bucket', name: 'BUCKET', bucket_name: bucketName },
      { type: 'secret_text', name: 'WRITE_TOKEN', text: writeToken },
    ],
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set(
    'worker.js',
    new Blob([script], { type: 'application/javascript+module' }),
    'worker.js',
  );
  await cf(apiToken, 'PUT', `/accounts/${accountId}/workers/scripts/${workerName}`, undefined, form);
}

/** Enable the free `*.workers.dev` route for the script, and return the account subdomain. */
export async function enableWorkersDev(
  apiToken: string,
  accountId: string,
  workerName: string,
): Promise<string> {
  await cf(apiToken, 'POST', `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
    enabled: true,
    previews_enabled: false,
  });
  const sub = await cf<{ subdomain?: string }>(
    apiToken,
    'GET',
    `/accounts/${accountId}/workers/subdomain`,
  );
  if (!sub?.subdomain) {
    throw new Error(
      'No workers.dev subdomain on this account yet — register one at dash.cloudflare.com → Workers → Subdomain, then re-run.',
    );
  }
  return sub.subdomain;
}

/** Resolve a zone id for a domain the token can see, or null if not owned/visible. */
export async function findZoneId(apiToken: string, domain: string): Promise<string | null> {
  // Try the exact name, then the registrable parent (share.agents-cli.sh -> agents-cli.sh).
  const candidates = [domain, domain.split('.').slice(-2).join('.')];
  for (const name of candidates) {
    const zones = await cf<Array<{ id: string; name: string }>>(
      apiToken,
      'GET',
      `/zones?name=${encodeURIComponent(name)}`,
    ).catch(() => [] as Array<{ id: string; name: string }>);
    if (zones?.length) return zones[0].id;
  }
  return null;
}

/** Map a custom hostname (e.g. `share.agents-cli.sh`) to the Worker via Workers Custom Domains. */
export async function addCustomDomain(
  apiToken: string,
  accountId: string,
  workerName: string,
  zoneId: string,
  hostname: string,
): Promise<void> {
  try {
    await cf(apiToken, 'PUT', `/accounts/${accountId}/workers/domains`, {
      zone_id: zoneId,
      hostname,
      service: workerName,
      environment: 'production',
    });
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  }
}
