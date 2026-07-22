// Cloudflare provisioning for `agents share setup` — plain `fetch` against the CF
// REST API (the repo has no CF wrapper). Creates the R2 bucket, configures its
// lifecycle, uploads the Worker (with an R2 binding), sets the WRITE_TOKEN secret,
// enables the free
// `*.workers.dev` subdomain, and — when the token owns the zone — maps a custom domain.

const CF_API = 'https://api.cloudflare.com/client/v4';
export const SHARE_LIFECYCLE_RULE_ID = 'agents-share-expire-90d';
export const SHARE_LIFECYCLE_DELETE_AFTER_SECONDS = 90 * 24 * 60 * 60;

interface CfError {
  code?: number;
  message?: string;
}

export interface CloudflareRequest {
  apiToken: string;
  method: string;
  pathname: string;
  body?: unknown;
  form?: FormData;
}

export type CloudflareRequester = <T = unknown>(request: CloudflareRequest) => Promise<T>;

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

const defaultCloudflareRequester: CloudflareRequester = <T = unknown>(request: CloudflareRequest) =>
  cf<T>(request.apiToken, request.method, request.pathname, request.body, request.form);

interface ProvisionOptions {
  request?: CloudflareRequester;
}

interface R2LifecycleRule {
  id: string;
  conditions: { prefix: string };
  enabled: boolean;
  abortMultipartUploadsTransition?: { condition?: { maxAge: number; type: 'Age' } };
  deleteObjectsTransition?: { condition?: { maxAge: number; type: 'Age' } | { date: string; type: 'Date' } };
  storageClassTransitions?: Array<{
    condition: { maxAge: number; type: 'Age' } | { date: string; type: 'Date' };
    storageClass: 'InfrequentAccess';
  }>;
}

/** True if the CF error looks like "the thing already exists" (idempotent create). */
function isAlreadyExists(e: unknown): boolean {
  return /already exists|duplicate|10004|10014/i.test(String(e));
}

/** Create the R2 bucket (idempotent). */
export async function createBucket(
  apiToken: string,
  accountId: string,
  name: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  try {
    await request({
      apiToken,
      method: 'POST',
      pathname: `/accounts/${accountId}/r2/buckets`,
      body: { name },
    });
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  }
}

/** Add/update the share bucket lifecycle rule while preserving unrelated rules. */
export async function configureBucketLifecycle(
  apiToken: string,
  accountId: string,
  bucketName: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  const existing = await request<{ rules?: R2LifecycleRule[] }>({
    apiToken,
    method: 'GET',
    pathname: `/accounts/${accountId}/r2/buckets/${bucketName}/lifecycle`,
  });
  const shareRule: R2LifecycleRule = {
    id: SHARE_LIFECYCLE_RULE_ID,
    conditions: { prefix: '' },
    enabled: true,
    deleteObjectsTransition: {
      condition: { type: 'Age', maxAge: SHARE_LIFECYCLE_DELETE_AFTER_SECONDS },
    },
  };
  const rules = [
    ...(existing.rules ?? []).filter((rule) => rule.id !== SHARE_LIFECYCLE_RULE_ID),
    shareRule,
  ];
  await request({
    apiToken,
    method: 'PUT',
    pathname: `/accounts/${accountId}/r2/buckets/${bucketName}/lifecycle`,
    body: { rules },
  });
}

/** Upload the module Worker with an R2 binding (`BUCKET`). Secrets are set via the Workers Secrets API. */
export async function deployWorker(
  apiToken: string,
  accountId: string,
  workerName: string,
  script: string,
  bucketName: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2024-11-06',
    bindings: [
      { type: 'r2_bucket', name: 'BUCKET', bucket_name: bucketName },
    ],
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set(
    'worker.js',
    new Blob([script], { type: 'application/javascript+module' }),
    'worker.js',
  );
  await request({
    apiToken,
    method: 'PUT',
    pathname: `/accounts/${accountId}/workers/scripts/${workerName}`,
    form,
  });
}

/** Add/update the WRITE_TOKEN binding using Cloudflare's Workers Secrets API. */
export async function setWorkerSecret(
  apiToken: string,
  accountId: string,
  workerName: string,
  writeToken: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  await request({
    apiToken,
    method: 'PUT',
    pathname: `/accounts/${accountId}/workers/scripts/${workerName}/secrets`,
    body: { name: 'WRITE_TOKEN', text: writeToken, type: 'secret_text' },
  });
}

/** Enable the free `*.workers.dev` route for the script, and return the account subdomain. */
export async function enableWorkersDev(
  apiToken: string,
  accountId: string,
  workerName: string,
  opts: ProvisionOptions = {},
): Promise<string> {
  const request = opts.request ?? defaultCloudflareRequester;
  await request({
    apiToken,
    method: 'POST',
    pathname: `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
    body: {
      enabled: true,
      previews_enabled: false,
    },
  });
  const sub = await request<{ subdomain?: string }>({
    apiToken,
    method: 'GET',
    pathname: `/accounts/${accountId}/workers/subdomain`,
  });
  if (!sub?.subdomain) {
    throw new Error(
      'No workers.dev subdomain on this account yet — register one at dash.cloudflare.com → Workers → Subdomain, then re-run.',
    );
  }
  return sub.subdomain;
}

/** Resolve a zone id for a domain the token can see, or null if not owned/visible. */
export async function findZoneId(
  apiToken: string,
  domain: string,
  opts: ProvisionOptions = {},
): Promise<string | null> {
  const request = opts.request ?? defaultCloudflareRequester;
  // Try the exact name, then the registrable parent (share.agents-cli.sh -> agents-cli.sh).
  const candidates = [domain, domain.split('.').slice(-2).join('.')];
  for (const name of candidates) {
    const zones = await request<Array<{ id: string; name: string }>>({
      apiToken,
      method: 'GET',
      pathname: `/zones?name=${encodeURIComponent(name)}`,
    }).catch(() => [] as Array<{ id: string; name: string }>);
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
  opts: ProvisionOptions = {},
): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  try {
    await request({
      apiToken,
      method: 'PUT',
      pathname: `/accounts/${accountId}/workers/domains`,
      body: {
        zone_id: zoneId,
        hostname,
        service: workerName,
        environment: 'production',
      },
    });
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  }
}
