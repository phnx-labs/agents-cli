import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderTracesWorkerScript } from './worker-template.js';
import { provisionTraces } from './provision.js';

afterEach(() => vi.unstubAllGlobals());

describe('provisionTraces', () => {
  it('shapes the complete isolated Cloudflare deployment from the canonical Worker template', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const result = url.endsWith('/workers/subdomain')
        ? { subdomain: 'account-subdomain' }
        : url.includes('/zones?')
          ? [{ id: 'zone_1' }]
          : {};
      return new Response(JSON.stringify({ success: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(provisionTraces({
      apiToken: 'cf-token',
      accountId: 'acct_1',
      workerName: 'agents-traces',
      bucketName: 'agents-traces',
      phoenixIdBase: 'https://identity.example.test/',
    })).resolves.toEqual({ baseUrl: 'https://traces.agents-cli.sh' });

    expect(requests.map(({ url, init }) => `${init.method} ${new URL(url).pathname}${new URL(url).search}`)).toEqual([
      'POST /client/v4/accounts/acct_1/r2/buckets',
      'PUT /client/v4/accounts/acct_1/workers/scripts/agents-traces',
      'PUT /client/v4/accounts/acct_1/workers/scripts/agents-traces/secrets',
      'PUT /client/v4/accounts/acct_1/workers/scripts/agents-traces/secrets',
      'POST /client/v4/accounts/acct_1/workers/scripts/agents-traces/subdomain',
      'GET /client/v4/accounts/acct_1/workers/subdomain',
      'GET /client/v4/zones?name=traces.agents-cli.sh',
      'PUT /client/v4/accounts/acct_1/workers/domains',
    ]);
    expect(requests[0]?.init.headers).toEqual({
      authorization: 'Bearer cf-token',
      'content-type': 'application/json',
    });
    expect(JSON.parse(requests[0]?.init.body as string)).toEqual({ name: 'agents-traces' });

    const form = requests[1]?.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const metadata = JSON.parse(await (form?.get('metadata') as Blob).text());
    expect(metadata).toEqual({
      main_module: 'worker.js',
      compatibility_date: '2024-11-06',
      bindings: [{ type: 'r2_bucket', name: 'BUCKET', bucket_name: 'agents-traces' }],
    });
    expect(await (form?.get('worker.js') as Blob).text()).toBe(renderTracesWorkerScript());
    const writeSecret = JSON.parse(requests[2]?.init.body as string);
    expect(writeSecret).toMatchObject({ name: 'WRITE_TOKEN', type: 'secret_text' });
    expect(writeSecret.text).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(requests[3]?.init.body as string)).toEqual({
      name: 'PHOENIX_ID_BASE',
      text: 'https://identity.example.test',
      type: 'secret_text',
    });
    expect(JSON.parse(requests[4]?.init.body as string)).toEqual({ enabled: true, previews_enabled: false });
    expect(JSON.parse(requests[7]?.init.body as string)).toEqual({
      zone_id: 'zone_1',
      hostname: 'traces.agents-cli.sh',
      service: 'agents-traces',
      environment: 'production',
    });
  });

  it('keeps the workers.dev endpoint when the custom-domain zone is not visible', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const result = url.endsWith('/workers/subdomain') ? { subdomain: 'account-subdomain' } : [];
      return new Response(JSON.stringify({ success: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(provisionTraces({
      apiToken: 'cf-token',
      accountId: 'acct_1',
      workerName: 'agents-traces',
      bucketName: 'agents-traces',
      phoenixIdBase: 'https://identity.example.test',
    })).resolves.toEqual({
      baseUrl: 'https://agents-traces.account-subdomain.workers.dev',
    });
  });
});
