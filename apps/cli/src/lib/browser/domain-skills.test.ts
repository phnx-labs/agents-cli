/**
 * Tests for browser domain-skill discovery.
 *
 * Uses a temp directory wired in via $AGENTS_BROWSER_DOMAIN_SKILLS_DIR so we
 * don't touch the user's real ~/.agents/skills tree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hostnameMatchCandidates, resolveDomainSkill } from './domain-skills.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-skills-test-'));
  process.env.AGENTS_BROWSER_DOMAIN_SKILLS_DIR = tmp;
});

afterEach(() => {
  delete process.env.AGENTS_BROWSER_DOMAIN_SKILLS_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seed(name: string, body: string) {
  fs.mkdirSync(path.join(tmp, name), { recursive: true });
  fs.writeFileSync(path.join(tmp, name, 'SKILL.md'), body);
}

describe('hostnameMatchCandidates', () => {
  it('returns the second-level label for a plain apex domain', () => {
    expect(hostnameMatchCandidates('perplexity.ai')).toContain('perplexity');
  });

  it('strips www. before deriving candidates', () => {
    expect(hostnameMatchCandidates('www.perplexity.ai')).toContain('perplexity');
    expect(hostnameMatchCandidates('www.perplexity.ai')).toContain('perplexity.ai');
  });

  it('yields progressive strips for nested subdomains', () => {
    const cs = hostnameMatchCandidates('app.slack.com');
    expect(cs).toContain('app.slack.com');
    expect(cs).toContain('slack.com');
    expect(cs).toContain('slack');
  });

  it('returns empty for an empty hostname', () => {
    expect(hostnameMatchCandidates('')).toEqual([]);
  });
});

describe('resolveDomainSkill', () => {
  it('matches by directory name on the second-level domain', () => {
    seed('perplexity', '---\ndescription: perplexity skill\n---\n# Perplexity\nbody');
    const r = resolveDomainSkill('https://www.perplexity.ai/computer/tasks/x');
    expect(r?.name).toBe('perplexity');
    expect(r?.content).toContain('# Perplexity');
    expect(r?.hostname).toBe('www.perplexity.ai');
  });

  it('matches subdomain-stripped form (app.slack.com -> slack)', () => {
    seed('slack', '---\ndescription: slack skill\n---\n# Slack');
    const r = resolveDomainSkill('https://app.slack.com/client/T1/C1');
    expect(r?.name).toBe('slack');
  });

  it('prefers an explicit domains: frontmatter override over the dir name', () => {
    // dir is `gmail` but a Google-properties skill pins itself to mail.google.com
    seed(
      'gmail',
      `---\ndescription: gmail\ndomains: [mail.google.com, gmail.com]\n---\n# Gmail`,
    );
    const r = resolveDomainSkill('https://mail.google.com/mail/u/0/');
    expect(r?.name).toBe('gmail');
  });

  it('supports the block-list domains: yaml form', () => {
    seed(
      'notion',
      `---\ndescription: notion\ndomains:\n  - notion.so\n  - www.notion.so\n---\n# Notion`,
    );
    const r = resolveDomainSkill('https://www.notion.so/workspace');
    expect(r?.name).toBe('notion');
  });

  it('returns null when no directory matches', () => {
    seed('perplexity', '---\ndescription: x\n---\nbody');
    expect(resolveDomainSkill('https://stripe.com/dashboard')).toBeNull();
  });

  it('returns null for invalid URLs without throwing', () => {
    seed('perplexity', '---\ndescription: x\n---\nbody');
    expect(resolveDomainSkill('not a url')).toBeNull();
  });

  it('returns null when the skills root does not exist', () => {
    process.env.AGENTS_BROWSER_DOMAIN_SKILLS_DIR = path.join(tmp, 'does-not-exist');
    expect(resolveDomainSkill('https://perplexity.ai')).toBeNull();
  });

  it('skips directories that lack a SKILL.md', () => {
    fs.mkdirSync(path.join(tmp, 'orphan'), { recursive: true });
    seed('perplexity', '---\ndescription: x\n---\nbody');
    const r = resolveDomainSkill('https://perplexity.ai');
    expect(r?.name).toBe('perplexity');
  });
});
