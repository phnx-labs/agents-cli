import { describe, expect, it } from 'vitest';
import {
  addCustomDomain,
  createBucket,
  deployWorker,
  enableWorkersDev,
  findZoneId,
  type CloudflareRequest,
  type CloudflareRequester,
} from './provision.js';

describe('share Cloudflare provisioning request shape', () => {
  it('creates the R2 bucket with account scope and bucket name', async () => {
    const seen: CloudflareRequest[] = [];
    await createBucket('cf-token', 'acct_1', 'agents-share', {
      request: async (req) => {
        seen.push(req);
        return {};
      },
    });

    expect(seen).toEqual([
      {
        apiToken: 'cf-token',
        method: 'POST',
        pathname: '/accounts/acct_1/r2/buckets',
        body: { name: 'agents-share' },
      },
    ]);
  });

  it('deploys a module worker with R2 and WRITE_TOKEN bindings', async () => {
    let upload: CloudflareRequest | undefined;
    await deployWorker('cf-token', 'acct_1', 'worker-one', 'export default {}', 'bucket-one', 'write-token', {
      request: async (req) => {
        upload = req;
        return {};
      },
    });

    expect(upload?.apiToken).toBe('cf-token');
    expect(upload?.method).toBe('PUT');
    expect(upload?.pathname).toBe('/accounts/acct_1/workers/scripts/worker-one');
    const metadata = JSON.parse(await (upload?.form?.get('metadata') as Blob).text());
    expect(metadata).toEqual({
      main_module: 'worker.js',
      compatibility_date: '2024-11-06',
      bindings: [
        { type: 'r2_bucket', name: 'BUCKET', bucket_name: 'bucket-one' },
        { type: 'secret_text', name: 'WRITE_TOKEN', text: 'write-token' },
      ],
    });
    expect(await (upload?.form?.get('worker.js') as File).text()).toBe('export default {}');
  });

  it('enables workers.dev and returns the account subdomain', async () => {
    const seen: CloudflareRequest[] = [];
    const request: CloudflareRequester = async (req) => {
      seen.push(req);
      if (req.method === 'GET') return { subdomain: 'agent-share' };
      return {};
    };

    await expect(enableWorkersDev('cf-token', 'acct_1', 'worker-one', { request })).resolves.toBe('agent-share');
    expect(seen).toEqual([
      {
        apiToken: 'cf-token',
        method: 'POST',
        pathname: '/accounts/acct_1/workers/scripts/worker-one/subdomain',
        body: { enabled: true, previews_enabled: false },
      },
      {
        apiToken: 'cf-token',
        method: 'GET',
        pathname: '/accounts/acct_1/workers/subdomain',
      },
    ]);
  });

  it('checks the exact hostname before the parent zone and returns the first visible zone', async () => {
    const paths: string[] = [];
    const request: CloudflareRequester = async (req) => {
      paths.push(req.pathname);
      if (req.pathname === '/zones?name=agents-cli.sh') return [{ id: 'zone_1', name: 'agents-cli.sh' }];
      return [];
    };

    await expect(findZoneId('cf-token', 'share.agents-cli.sh', { request })).resolves.toBe('zone_1');
    expect(paths).toEqual(['/zones?name=share.agents-cli.sh', '/zones?name=agents-cli.sh']);
  });

  it('maps a custom domain through Workers Custom Domains', async () => {
    const seen: CloudflareRequest[] = [];
    await addCustomDomain('cf-token', 'acct_1', 'worker-one', 'zone_1', 'share.example.com', {
      request: async (req) => {
        seen.push(req);
        return {};
      },
    });

    expect(seen).toEqual([
      {
        apiToken: 'cf-token',
        method: 'PUT',
        pathname: '/accounts/acct_1/workers/domains',
        body: {
          zone_id: 'zone_1',
          hostname: 'share.example.com',
          service: 'worker-one',
          environment: 'production',
        },
      },
    ]);
  });
});
