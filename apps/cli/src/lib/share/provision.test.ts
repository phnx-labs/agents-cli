import { describe, expect, it } from 'vitest';
import {
  addCustomDomain,
  configureBucketLifecycle,
  createBucket,
  deployWorker,
  enableWorkersDev,
  findZoneId,
  setWorkerSecret,
  SHARE_LIFECYCLE_DELETE_AFTER_SECONDS,
  SHARE_LIFECYCLE_RULE_ID,
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

  it('merges the share lifecycle rule without dropping existing bucket rules', async () => {
    const seen: CloudflareRequest[] = [];
    const existingRule = {
      id: 'keep-logs',
      conditions: { prefix: 'logs/' },
      enabled: true,
      deleteObjectsTransition: { condition: { type: 'Age' as const, maxAge: 7 * 24 * 60 * 60 } },
    };
    const request: CloudflareRequester = async (req) => {
      seen.push(req);
      if (req.method === 'GET') {
        return {
          rules: [
            existingRule,
            {
              id: SHARE_LIFECYCLE_RULE_ID,
              conditions: { prefix: '' },
              enabled: false,
            },
          ],
        };
      }
      return {};
    };

    await configureBucketLifecycle('cf-token', 'acct_1', 'agents-share', { request });

    expect(seen).toEqual([
      {
        apiToken: 'cf-token',
        method: 'GET',
        pathname: '/accounts/acct_1/r2/buckets/agents-share/lifecycle',
      },
      {
        apiToken: 'cf-token',
        method: 'PUT',
        pathname: '/accounts/acct_1/r2/buckets/agents-share/lifecycle',
        body: {
          rules: [
            existingRule,
            {
              id: SHARE_LIFECYCLE_RULE_ID,
              conditions: { prefix: '' },
              enabled: true,
              deleteObjectsTransition: {
                condition: { type: 'Age', maxAge: SHARE_LIFECYCLE_DELETE_AFTER_SECONDS },
              },
            },
          ],
        },
      },
    ]);
  });

  it('deploys a module worker with the R2 bucket binding', async () => {
    let upload: CloudflareRequest | undefined;
    await deployWorker('cf-token', 'acct_1', 'worker-one', 'export default {}', 'bucket-one', {
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
      ],
    });
    expect(await (upload?.form?.get('worker.js') as File).text()).toBe('export default {}');
  });

  it('sets WRITE_TOKEN through the Workers Secrets API', async () => {
    const seen: CloudflareRequest[] = [];
    await setWorkerSecret('cf-token', 'acct_1', 'worker-one', 'write-token', {
      request: async (req) => {
        seen.push(req);
        return {};
      },
    });

    expect(seen).toEqual([
      {
        apiToken: 'cf-token',
        method: 'PUT',
        pathname: '/accounts/acct_1/workers/scripts/worker-one/secrets',
        body: { name: 'WRITE_TOKEN', text: 'write-token', type: 'secret_text' },
      },
    ]);
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
