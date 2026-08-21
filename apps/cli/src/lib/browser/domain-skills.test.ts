/**
 * Tests for browser domain-skill discovery.
 *
 * Single-root tests use a temp directory wired in via
 * $AGENTS_BROWSER_DOMAIN_SKILLS_DIR so we don't touch the user's real
 * ~/.agents/skills tree. The layered tests build REAL project/user/system
 * layers under a temp HOME and re-import the module fresh (state.ts resolves
 * HOME at import time) — no mocking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('layered resolution (project > user > system) — RUSH-2497', () => {
  let home: string;
  let savedHome: string | undefined;

  const SUB = ['skills', 'browser', 'domain-skills'];

  function userRoot() {
    return path.join(home, '.agents', ...SUB);
  }
  function systemRoot() {
    return path.join(home, '.agents', '.system', ...SUB);
  }
  function projectRoot(projectDir: string) {
    return path.join(projectDir, '.agents', ...SUB);
  }

  function seedIn(root: string, name: string, body: string) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'SKILL.md'), body);
  }

  /** Re-import with the temp HOME in effect — state.ts resolves HOME at import time. */
  async function freshModule() {
    vi.resetModules();
    return import('./domain-skills.js');
  }

  beforeEach(() => {
    // The outer suite's env override forces a single root; these tests exercise
    // the real layered roots, so it must be absent.
    delete process.env.AGENTS_BROWSER_DOMAIN_SKILLS_DIR;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-skills-layers-'));
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('resolves a skill that exists ONLY in the system layer', async () => {
    seedIn(systemRoot(), 'perplexity', '---\ndescription: system perplexity\n---\n# System Perplexity');
    const { resolveDomainSkill } = await freshModule();
    const r = resolveDomainSkill('https://www.perplexity.ai/', home);
    expect(r?.name).toBe('perplexity');
    expect(r?.path).toBe(path.join(systemRoot(), 'perplexity', 'SKILL.md'));
    expect(r?.content).toContain('# System Perplexity');
  });

  it('user layer beats system for the same skill name', async () => {
    seedIn(userRoot(), 'slack', '---\ndescription: user slack\n---\n# User Slack');
    seedIn(systemRoot(), 'slack', '---\ndescription: system slack\n---\n# System Slack');
    const { resolveDomainSkill } = await freshModule();
    const r = resolveDomainSkill('https://app.slack.com/client/T1/C1', home);
    expect(r?.path).toBe(path.join(userRoot(), 'slack', 'SKILL.md'));
    expect(r?.content).toContain('# User Slack');
  });

  it('project layer beats user and system', async () => {
    const projectDir = path.join(home, 'src', 'my-repo');
    seedIn(projectRoot(projectDir), 'linkedin', '---\ndescription: project\n---\n# Project LinkedIn');
    seedIn(userRoot(), 'linkedin', '---\ndescription: user\n---\n# User LinkedIn');
    seedIn(systemRoot(), 'linkedin', '---\ndescription: system\n---\n# System LinkedIn');
    const { resolveDomainSkill } = await freshModule();
    const r = resolveDomainSkill('https://www.linkedin.com/feed/', projectDir);
    expect(r?.path).toBe(path.join(projectRoot(projectDir), 'linkedin', 'SKILL.md'));
    expect(r?.content).toContain('# Project LinkedIn');
  });

  it('falls through a layer that has skills but no match for this hostname', async () => {
    seedIn(userRoot(), 'notion', '---\ndescription: user notion\n---\n# Notion');
    seedIn(systemRoot(), 'higgsfield', '---\ndescription: system higgsfield\n---\n# Higgsfield');
    const { resolveDomainSkill } = await freshModule();
    const r = resolveDomainSkill('https://higgsfield.ai/', home);
    expect(r?.name).toBe('higgsfield');
    expect(r?.path).toBe(path.join(systemRoot(), 'higgsfield', 'SKILL.md'));
  });

  it('$AGENTS_BROWSER_DOMAIN_SKILLS_DIR remains a SINGLE-root override — the system layer is not searched', async () => {
    seedIn(systemRoot(), 'perplexity', '---\ndescription: system\n---\nbody');
    const override = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-skills-override-'));
    process.env.AGENTS_BROWSER_DOMAIN_SKILLS_DIR = override;
    try {
      const { resolveDomainSkill } = await freshModule();
      expect(resolveDomainSkill('https://www.perplexity.ai/', home)).toBeNull();
    } finally {
      delete process.env.AGENTS_BROWSER_DOMAIN_SKILLS_DIR;
      fs.rmSync(override, { recursive: true, force: true });
    }
  });
});
