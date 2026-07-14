import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { accountTokensFingerprint, buildDispatchBody, hasRushUploadConsent, RushCloudProvider } from './rush.js';
import { MAX_IMAGES_PER_DISPATCH, normalizeProviderStatus } from './types.js';
import type { ImageAttachment, SkillRef } from './types.js';

const ORIGINAL_UPLOAD_ENV = process.env.AGENTS_RUSH_UPLOAD_TOKENS;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rush-consent-test-'));
  delete process.env.AGENTS_RUSH_UPLOAD_TOKENS;
});

afterEach(() => {
  if (ORIGINAL_UPLOAD_ENV === undefined) {
    delete process.env.AGENTS_RUSH_UPLOAD_TOKENS;
  } else {
    process.env.AGENTS_RUSH_UPLOAD_TOKENS = ORIGINAL_UPLOAD_ENV;
  }
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

  it('multi-repo omits singular fields so old halo/proxy rejects cleanly', () => {
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

  it('includes account_manifest when supplied', () => {
    const manifest = {
      fp: 'aaaa',
      versions: [
        { version: '2.1.110', email: 'a@b.com', cred_fp: 'h1' },
        { version: '2.1.112', email: 'c@d.com', cred_fp: 'h2' },
      ],
    };
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      accountManifest: manifest,
    });
    expect(body.account_manifest).toEqual(manifest);
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

  it('passes through account_tokens verbatim when supplied (retry path)', () => {
    const tokens = [
      { version: '2.1.110', credentials_json: '{"accessToken":"abc"}' },
    ];
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      accountTokens: tokens,
    });
    expect(body.account_tokens).toEqual(tokens);
  });

  it('omits account_tokens when array is empty', () => {
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      accountTokens: [],
    });
    expect(body.account_tokens).toBeUndefined();
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

  it('treats Rush upload consent with a mismatched host as no consent', () => {
    const fingerprint = accountTokensFingerprint([
      { version: '2.1.110', credentials_json: '{"accessToken":"abc"}' },
    ]);
    const consentPath = path.join(tmpDir, 'rush-consent.json');
    fs.writeFileSync(consentPath, JSON.stringify({
      granted_at: '2026-05-16T00:00:00.000Z',
      granted_by: 'flag',
      host: 'other.example.com',
      account_fingerprint: fingerprint,
    }));

    expect(hasRushUploadConsent(fingerprint, undefined, consentPath)).toBe(false);
  });

  it('treats old Rush upload consent files without host/account scope as no consent', () => {
    const fingerprint = accountTokensFingerprint([
      { version: '2.1.110', credentials_json: '{"accessToken":"abc"}' },
    ]);
    const consentPath = path.join(tmpDir, 'rush-consent.json');
    fs.writeFileSync(consentPath, JSON.stringify({
      granted_at: '2026-05-16T00:00:00.000Z',
      granted_by: 'flag',
    }));

    expect(hasRushUploadConsent(fingerprint, undefined, consentPath)).toBe(false);
  });
});
