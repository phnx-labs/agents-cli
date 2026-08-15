import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildDispatchBody, RushCloudProvider } from './rush.js';
import { MAX_IMAGES_PER_DISPATCH, normalizeProviderStatus } from './types.js';
import type { ImageAttachment, SkillRef } from './types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rush-cloud-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Rush status normalization', () => {
  it('maps stopped-but-resumable Factory Floor states to idle', () => {
    expect(normalizeProviderStatus('rush', 'idle')).toBe('idle');
    expect(normalizeProviderStatus('rush', 'paused')).toBe('idle');
    expect(normalizeProviderStatus('rush', 'needs_review')).toBe('idle');
  });
});

describe('buildDispatchBody', () => {
  it('single repo sends both singular fields and repos[] for back-compat', () => {
    const body = buildDispatchBody({
      agent: 'claude',
      prompt: 'fix the bug',
      resolvedRepos: [
        { installation_id: 42, repo_owner: 'example-user', repo_name: 'agents' },
      ],
    });
    expect(body).toMatchObject({
      agent: 'claude',
      prompt: 'fix the bug',
      installation_id: 42,
      repo_owner: 'example-user',
      repo_name: 'agents',
      repos: [
        { installation_id: 42, repo_owner: 'example-user', repo_name: 'agents' },
      ],
    });
  });

  it('multi-repo omits singular fields so the old cloud proxy rejects cleanly', () => {
    const body = buildDispatchBody({
      agent: 'claude',
      prompt: 'refactor',
      resolvedRepos: [
        { installation_id: 1, repo_owner: 'example-user', repo_name: 'rush' },
        { installation_id: 1, repo_owner: 'example-user', repo_name: 'agents' },
      ],
    });
    expect(body.installation_id).toBeUndefined();
    expect(body.repo_owner).toBeUndefined();
    expect(body.repo_name).toBeUndefined();
    expect(body.repos).toEqual([
      { installation_id: 1, repo_owner: 'example-user', repo_name: 'rush' },
      { installation_id: 1, repo_owner: 'example-user', repo_name: 'agents' },
    ]);
  });

  it('defaults agent to claude when unspecified', () => {
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [
        { installation_id: 1, repo_owner: 'a', repo_name: 'b' },
      ],
    });
    expect(body.agent).toBe('claude');
  });

  it('forwards mode when set', () => {
    const body = buildDispatchBody({
      prompt: 'x',
      mode: 'plan',
      resolvedRepos: [
        { installation_id: 1, repo_owner: 'a', repo_name: 'b' },
      ],
    });
    expect(body.mode).toBe('plan');
  });

  it('throws when resolvedRepos is empty (guard against programmer error)', () => {
    expect(() =>
      buildDispatchBody({ prompt: 'x', resolvedRepos: [] }),
    ).toThrow(/at least one entry/);
  });

  it('includes account_manifest (version + email only, no credential material) when supplied', () => {
    // RUSH-2527 / SING-1b: the manifest carries no token hash — agents-cli never
    // reads the native OAuth login to build it. Only version + account email ride.
    const manifest = {
      fp: 'aaaa',
      versions: [
        { version: '2.1.110', email: 'a@b.com' },
        { version: '2.1.112', email: 'c@d.com' },
      ],
    };
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      accountManifest: manifest,
    });
    expect(body.account_manifest).toEqual(manifest);
    // No per-version credential fingerprint / token anywhere in the ordinary body.
    expect(JSON.stringify(body)).not.toContain('cred_fp');
    expect(body.account_tokens).toBeUndefined();
  });

  it('omits account_manifest when null (no signed-in claude versions)', () => {
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      accountManifest: null,
    });
    expect(body.account_manifest).toBeUndefined();
  });

  it('has no account_tokens surface at all — a native OAuth token is never uploaded (SING-1b)', () => {
    // The token-upload payload was removed: buildDispatchBody has no accountTokens
    // input, so the dispatch body can never carry Claude OAuth credentials.
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      // @ts-expect-error accountTokens was removed from the dispatch surface (RUSH-2527)
      accountTokens: [{ version: '2.1.110', credentials_json: '{"accessToken":"abc"}' }],
    });
    expect(body.account_tokens).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('credentials_json');
    expect(JSON.stringify(body)).not.toContain('accessToken');
  });

  it('includes strategy when balanced', () => {
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      strategy: 'balanced',
    });
    expect(body.strategy).toBe('balanced');
  });

  it('omits strategy when not set', () => {
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
    });
    expect(body.strategy).toBeUndefined();
  });

  it('includes skills[] verbatim when supplied', () => {
    const skills: SkillRef[] = [{ id: 'linear' }, { id: 'browser', version: '2.0.0' }];
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      skills,
    });
    expect(body.skills).toEqual(skills);
  });

  it('omits skills when not supplied or empty', () => {
    const none = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
    });
    expect(none.skills).toBeUndefined();
    const empty = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      skills: [],
    });
    expect(empty.skills).toBeUndefined();
  });

  it('includes images[] when supplied', () => {
    const images: ImageAttachment[] = [
      { data: 'aGVsbG8=', mimeType: 'image/png' },
      { data: 'd29ybGQ=', mimeType: 'image/jpeg' },
    ];
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      images,
    });
    expect(body.images).toEqual(images);
  });

  it('caps images at MAX_IMAGES_PER_DISPATCH, dropping the overflow', () => {
    const images: ImageAttachment[] = Array.from(
      { length: MAX_IMAGES_PER_DISPATCH + 3 },
      (_, i) => ({ data: `img${i}`, mimeType: 'image/png' as const }),
    );
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      images,
    });
    expect(Array.isArray(body.images)).toBe(true);
    expect((body.images as ImageAttachment[]).length).toBe(MAX_IMAGES_PER_DISPATCH);
    // The kept slice is the first MAX_IMAGES_PER_DISPATCH, in order.
    expect((body.images as ImageAttachment[])[0].data).toBe('img0');
    expect((body.images as ImageAttachment[])[MAX_IMAGES_PER_DISPATCH - 1].data).toBe(
      `img${MAX_IMAGES_PER_DISPATCH - 1}`,
    );
  });

  it('omits images when not supplied or empty', () => {
    const none = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
    });
    expect(none.images).toBeUndefined();
    const empty = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      images: [],
    });
    expect(empty.images).toBeUndefined();
  });

  it('includes runtime env when supplied for cloud agent injection', () => {
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      env: { SHARE_WRITE_TOKEN: 'write-token' },
    });
    expect(body.env).toEqual({ SHARE_WRITE_TOKEN: 'write-token' });
  });

  it('omits empty runtime env', () => {
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      env: {},
    });
    expect(body.env).toBeUndefined();
  });

  it('advertises skills + images support in capabilities', () => {
    const caps = new RushCloudProvider().capabilities();
    expect(caps.skills).toBe(true);
    expect(caps.images).toBe(true);
  });

  it('balanced strategy coexists with no account_manifest', () => {
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      strategy: 'balanced',
      accountManifest: null,
    });
    expect(body.strategy).toBe('balanced');
    expect(body.account_manifest).toBeUndefined();
  });

  it('has no upload-consent / token-upload surface anymore (SING-1b regression)', async () => {
    // The consent gate and the token-upload helpers were removed — a native OAuth
    // login can never be sent to the cloud, with or without consent. Assert the
    // module no longer exports any of them, so a future change can't re-introduce
    // the upload path unnoticed.
    const mod = (await import('./rush.js')) as Record<string, unknown>;
    expect(mod.hasRushUploadConsent).toBeUndefined();
    expect(mod.buildAccountTokensPayload).toBeUndefined();
    expect(mod.accountTokensFingerprint).toBeUndefined();
    expect(mod.RUSH_CONSENT_PATH).toBeUndefined();
    // readClaudeCredentialsBlob still exists (the --lease path imports it) but the
    // cloud dispatch never calls it: the module source has no call site outside its
    // own definition.
  });
});
