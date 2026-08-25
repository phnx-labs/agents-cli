// Cloudflare provisioning for the private agents-traces store. This is an
// isolated Worker and R2 bucket; it does not share a deployment or key prefix
// with agents-share.

import { randomBytes } from 'node:crypto';
import { DEFAULT_TRACES_DOMAIN } from './backend.js';
import { renderTracesWorkerScript } from './worker-template.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

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

async function cf<T = unknown>(request: CloudflareRequest): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${request.apiToken}` };
  let payload: FormData | string | undefined;
  if (request.form) {
    payload = request.form;
  } else if (request.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(request.body);
  }
  const res = await fetch(`${CF_API}${request.pathname}`, {
    method: request.method,
    headers,
    body: payload,
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: CfError[];
    result?: T;
  };
  if (!res.ok || json.success === false) {
    const message =
      (json.errors ?? []).map((error) => `${error.code ?? ''} ${error.message ?? ''}`.trim()).join('; ') ||
      res.statusText;
    throw new Error(`Cloudflare ${request.method} ${request.pathname} failed (${res.status}): ${message}`);
  }
  return json.result as T;
}

interface ProvisionOptions {
  request?: CloudflareRequester;
}

const defaultCloudflareRequester: CloudflareRequester = cf;

function isAlreadyExists(error: unknown): boolean {
  return /already exists|duplicate|10004|10014/i.test(String(error));
}

export async function createBucket(apiToken: string, accountId: string, name: string, opts: ProvisionOptions = {}): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  try {
    await request({ apiToken, method: 'POST', pathname: `/accounts/${accountId}/r2/buckets`, body: { name } });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

export async function deployWorker(apiToken: string, accountId: string, workerName: string, script: string, bucketName: string, opts: ProvisionOptions = {}): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2024-11-06',
    bindings: [{ type: 'r2_bucket', name: 'BUCKET', bucket_name: bucketName }],
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set('worker.js', new Blob([script], { type: 'application/javascript+module' }), 'worker.js');
  await request({ apiToken, method: 'PUT', pathname: `/accounts/${accountId}/workers/scripts/${workerName}`, form });
}

export async function setWorkerSecret(apiToken: string, accountId: string, workerName: string, name: string, value: string, opts: ProvisionOptions = {}): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  await request({
    apiToken,
    method: 'PUT',
    pathname: `/accounts/${accountId}/workers/scripts/${workerName}/secrets`,
    body: { name, text: value, type: 'secret_text' },
  });
}

export async function enableWorkersDev(apiToken: string, accountId: string, workerName: string, opts: ProvisionOptions = {}): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  await request({
    apiToken,
    method: 'POST',
    pathname: `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
    body: { enabled: true, previews_enabled: false },
  });
}

export async function findZoneId(apiToken: string, domain: string, opts: ProvisionOptions = {}): Promise<string> {
  const request = opts.request ?? defaultCloudflareRequester;
  const parent = domain.split('.').slice(-2).join('.');
  const zones = await request<Array<{ id: string }>>({
    apiToken,
    method: 'GET',
    pathname: `/zones?name=${encodeURIComponent(parent)}`,
  });
  if (!zones[0]?.id) throw new Error(`Cloudflare zone for ${domain} is not visible to this API token.`);
  return zones[0].id;
}

export async function addCustomDomain(apiToken: string, accountId: string, workerName: string, zoneId: string, domain: string, opts: ProvisionOptions = {}): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  try {
    await request({
      apiToken,
      method: 'PUT',
      pathname: `/accounts/${accountId}/workers/domains`,
      body: { zone_id: zoneId, hostname: domain, service: workerName, environment: 'production' },
    });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

export interface ProvisionTracesOptions extends ProvisionOptions {
  apiToken: string;
  accountId: string;
  workerName: string;
  bucketName: string;
  phoenixIdBase: string;
  domain?: string;
}

/** Provision the complete isolated traces deployment using the canonical Worker template. */
export async function provisionTraces(opts: ProvisionTracesOptions): Promise<{ baseUrl: string }> {
  const domain = opts.domain ?? DEFAULT_TRACES_DOMAIN;
  const requestOpts = opts.request ? { request: opts.request } : {};
  const phoenixIdBase = opts.phoenixIdBase.replace(/\/+$/, '').trim();
  if (!phoenixIdBase) throw new Error('PHOENIX_ID_BASE is required to verify trace requests.');

  await createBucket(opts.apiToken, opts.accountId, opts.bucketName, requestOpts);
  await deployWorker(opts.apiToken, opts.accountId, opts.workerName, renderTracesWorkerScript(), opts.bucketName, requestOpts);
  await setWorkerSecret(opts.apiToken, opts.accountId, opts.workerName, 'WRITE_TOKEN', randomBytes(32).toString('hex'), requestOpts);
  await setWorkerSecret(opts.apiToken, opts.accountId, opts.workerName, 'PHOENIX_ID_BASE', phoenixIdBase, requestOpts);
  await enableWorkersDev(opts.apiToken, opts.accountId, opts.workerName, requestOpts);
  const zoneId = await findZoneId(opts.apiToken, domain, requestOpts);
  await addCustomDomain(opts.apiToken, opts.accountId, opts.workerName, zoneId, domain, requestOpts);
  return { baseUrl: `https://${domain}` };
}
