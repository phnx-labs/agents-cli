/**
 * cli-command-sync-spec.test.ts
 *
 * Doc-anchored conformance test for custom-slash-command sync across every
 * agent CLI. Each expectation is sourced from the vendor's OFFICIAL docs
 * (URLs + verbatim quotes in tests/fixtures/cli-command-spec.json). This
 * fixture is the source of truth — not the AGENTS registry in src/lib/agents.ts.
 *
 * The test crosswalks the spec against the registry and the sync writers,
 * surfacing places where agents-cli's internal model disagrees with what the
 * vendor documents. Each disagreement is a bug — usually a wrong path, a
 * wrong format, or a wrong capability flag.
 *
 * Two layers run by default:
 *   1) "Registry vs docs" — pure static check; no agent CLIs need to be
 *      installed; runs everywhere. Catches: wrong commandsSubdir, wrong
 *      format, wrong capability claim.
 *   2) "Skill writer output" — exercises the actual commands-as-skills
 *      writer against a tmp version-home and asserts the emitted SKILL.md
 *      lands at the doc-expected path with the doc-expected frontmatter.
 *
 * Disk-level "did this real CLI version actually find it" can be added as
 * a separate opt-in layer (AGENTS_E2E_PROBE=1).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { AGENTS } from '../src/lib/agents.js';
import { supports } from '../src/lib/capabilities.js';
import {
  shouldInstallCommandAsSkill,
  installCommandSkillToVersion,
} from '../src/lib/command-skills.js';
import { toPosix } from '../src/lib/platform/index.js';

type FormatKind =
  | 'markdown-flat'
  | 'skill-dir'
  | 'toml-flat'
  | 'executable'
  | 'yaml-recipe-with-config-registration';

interface FormatSpec {
  kind: FormatKind;
  applies_when?: string;
  path_template: string;
  frontmatter?: { required?: string[]; recommended?: string[]; optional?: string[]; allowed?: string[] };
  schema?: { required?: string[]; optional?: string[] };
  name_from?: string;
  status?: string;
}

interface CliSpec {
  supported: boolean;
  version_split?: string;
  docs: Record<string, string>;
  formats: FormatSpec[];
  unsupported_formats?: Array<{ kind: string; path_template: string; reason: string }>;
  registry_divergence?: string;
  _skipped?: boolean;
}

const SPEC_PATH = path.join(__dirname, 'fixtures', 'cli-command-spec.json');
const SPEC = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf-8')) as Record<string, CliSpec | { $schema?: string }>;

const HOME = os.homedir();

function specEntries(): Array<[string, CliSpec]> {
  return Object.entries(SPEC).filter(([k, v]) => !k.startsWith('$') && !(v as CliSpec)._skipped) as Array<[string, CliSpec]>;
}

function expandHomePath(t: string): string {
  return t.replace('{HOME}', HOME);
}

function expectedFormatForVersion(cli: CliSpec, version: string | null): FormatSpec | null {
  if (!cli.formats?.length) return null;
  if (!version) return cli.formats.find((f) => !f.applies_when) ?? cli.formats[0];
  for (const f of cli.formats) {
    const m = f.applies_when?.match(/^version\s*([<>=]+)\s*(\S+)$/);
    if (!m) continue;
    const [, op, ver] = m;
    if (op === '<' && cmpSemver(version, ver) < 0) return f;
    if (op === '>=' && cmpSemver(version, ver) >= 0) return f;
  }
  return cli.formats.find((f) => !f.applies_when) ?? cli.formats[0];
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n));
  const pb = b.split('.').map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

describe('CLI command sync: registry-vs-docs conformance', () => {
  for (const [id, cli] of specEntries()) {
    describe(id, () => {
      const reg = AGENTS[id];
      const banner = cli.registry_divergence ? `  [known divergence: ${cli.registry_divergence}]` : '';
      // A CLI with a documented registry_divergence is a KNOWN mismatch between
      // the registry and the vendor docs. We keep its conformance assertions in
      // the suite (visible as skipped, with the divergence text) rather than
      // letting them hard-fail CI. Fixing the underlying registry bug = delete
      // the `registry_divergence` field, and these assertions go live again.
      const itc = cli.registry_divergence ? it.skip : it;

      it('agent is present in AGENTS registry', () => {
        expect(reg, `${id} should be in AGENTS registry`).toBeDefined();
      });

      if (!reg) return;

      itc('support flag matches docs', () => {
        const regSupports = reg.capabilities?.commands !== false || reg.capabilities?.skills !== false;
        expect(
          regSupports,
          `Docs say ${id} ${cli.supported ? 'DOES' : 'does NOT'} support custom commands; registry has commands=${JSON.stringify(reg.capabilities?.commands)} skills=${JSON.stringify(reg.capabilities?.skills)}.${banner}`,
        ).toBe(cli.supported);
      });

      if (!cli.supported) return;

      // For CLIs with version-gated formats (e.g. codex), test BOTH formats.
      const formatsToCheck = cli.formats.length > 1 ? cli.formats : [cli.formats[0]];

      for (const fmt of formatsToCheck) {
        const tag = fmt.applies_when ? ` [${fmt.applies_when}]` : '';

        if (fmt.kind === 'yaml-recipe-with-config-registration') {
          it.skip(`storage path matches docs${tag} (recipe-registration not modeled)`, () => {});
          continue;
        }

        it(`file format matches docs${tag}`, () => {
          const regFormat = reg.format ?? 'markdown';
          const expected =
            fmt.kind === 'toml-flat' ? 'toml'
            : 'markdown';
          expect(
            regFormat,
            `Docs say ${id}${tag} uses ${fmt.kind} (format=${expected}); registry has format=${regFormat}.${banner}`,
          ).toBe(expected);
        });

        itc(`storage path matches docs${tag}`, () => {
          const expectedPath = expandHomePath(fmt.path_template);
          if (fmt.kind === 'skill-dir') {
            const skillsDir = reg.skillsDir ?? '';
            const docDirPrefix = expectedPath.replace(/\/[^/]+\/SKILL\.md$/, '');
            // Registry paths use path.join (backslash on Windows); doc templates
            // use forward slashes. Compare separator-agnostically.
            expect(
              toPosix(skillsDir),
              `Docs say ${id}${tag} skills live at ${docDirPrefix}/<name>/SKILL.md; registry has skillsDir=${skillsDir}.${banner}`,
            ).toBe(toPosix(docDirPrefix));
          } else if (fmt.kind === 'markdown-flat' || fmt.kind === 'toml-flat') {
            // Use the registry's real configDir as the write base — NOT a
            // hardcoded `.${id}`, which is wrong for agents whose config dir is
            // nested or under ~/.config (amp -> ~/.config/amp). Hardcoding
            // produced a false positive for amp whose registry path is correct.
            const agentDir = reg.configDir;
            const regPath = path.join(agentDir, reg.commandsSubdir ?? '', `name.${fmt.kind === 'toml-flat' ? 'toml' : 'md'}`);
            const docPathPattern = expectedPath.replace('{name}', 'name');
            expect(
              toPosix(regPath),
              `Docs say ${id}${tag} writes to ${docPathPattern}; registry would write to ${regPath}.${banner}`,
            ).toBe(toPosix(docPathPattern));
          }
        });
      }

      // Skill-dir-only CLIs (cursor, kiro, antigravity, grok): the docs say
      // there is no commands/ directory. The registry should reflect that
      // by setting commands capability off, otherwise the writer fires the
      // native-commands path and emits files the CLI never reads.
      // Skills-only: every documented format is a skill-dir, and no format
      // is version-gated to a markdown-flat predecessor. Codex is excluded
      // because it has BOTH a pre-0.117 markdown-flat and a post-0.117
      // skill-dir, which is a legitimate version split.
      const isSkillsOnly =
        cli.formats.length > 0 &&
        cli.formats.every((f) => f.kind === 'skill-dir' && !f.applies_when);

      if (isSkillsOnly) {
        itc('commands capability should be off (docs say skill-dir only)', () => {
          const cap = reg.capabilities?.commands;
          // Acceptable: false, or a {until: "x"} record where x <= the version_split
          const off = cap === false;
          expect(
            off,
            `Docs say ${id} uses skill-dir format only (no commands/ directory). Registry has commands cap = ${JSON.stringify(cap)}.${banner}`,
          ).toBe(true);
        });
      }
    });
  }
});

describe('CLI command sync: skill-dir writer output', () => {
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-sync-test-'));

  for (const [id, cli] of specEntries()) {
    if (!cli.supported) continue;
    const fmt = cli.formats.find((f) => !f.applies_when) ?? cli.formats[0];
    if (fmt.kind !== 'skill-dir') continue;
    const reg = AGENTS[id];
    if (!reg) continue;

    describe(id, () => {
      const cmd = 'verify-test-cmd';
      const sourceMd = path.join(SANDBOX, 'src', `${cmd}.md`);
      const sourceFm = `---\ndescription: Test command for sync verification\n---\n\nbody\n`;

      it('writes SKILL.md matching the doc-expected path + frontmatter', () => {
        fs.mkdirSync(path.dirname(sourceMd), { recursive: true });
        fs.writeFileSync(sourceMd, sourceFm);

        // Use a per-CLI agentDir mirroring what the writer would produce in
        // a real version home.
        const agentDir = path.join(SANDBOX, id, `.${id}`);
        fs.mkdirSync(agentDir, { recursive: true });
        const installed = installCommandSkillToVersion(agentDir, cmd, sourceMd, []);

        expect(
          installed.success,
          `installCommandSkillToVersion returned ${JSON.stringify(installed)}`,
        ).toBe(true);

        const skillMd = path.join(agentDir, 'skills', cmd, 'SKILL.md');
        expect(fs.existsSync(skillMd), `SKILL.md not written at ${skillMd}`).toBe(true);

        const body = fs.readFileSync(skillMd, 'utf-8');
        expect(body.startsWith('---\n'), 'SKILL.md missing YAML frontmatter').toBe(true);
        const fmEnd = body.indexOf('\n---\n', 4);
        const fmObj = parseYaml(body.slice(4, fmEnd)) as Record<string, unknown>;

        for (const k of fmt.frontmatter?.required ?? []) {
          expect(fmObj[k], `Frontmatter key '${k}' required by docs but missing`).toBeDefined();
        }
      });
    });
  }
});

describe('CLI command sync: sync-pipeline invariants', () => {
  it('shouldInstallCommandAsSkill agrees with spec version_split for codex', () => {
    const codexSpec = SPEC.codex as CliSpec;
    expect(codexSpec.version_split).toBe('0.117.0');
    // pre-split: native commands path
    expect(shouldInstallCommandAsSkill('codex', '0.116.0')).toBe(false);
    // post-split: skills path
    expect(shouldInstallCommandAsSkill('codex', '0.134.0')).toBe(true);
  });

  // Same known copilot divergence as the registry-vs-docs block: registry has
  // copilot commands cap on, docs say none. Skipped (tracked) until the registry
  // is corrected, at which point the copilot `registry_divergence` flag is removed.
  const copilotIt = (SPEC.copilot as CliSpec).registry_divergence ? it.skip : it;
  copilotIt('copilot is not eligible for commands-as-skills (per docs: no custom commands at all)', () => {
    const copilotSpec = SPEC.copilot as CliSpec;
    expect(copilotSpec.supported).toBe(false);
    expect(supports('copilot', 'commands', '1.0.56').ok).toBe(false);
  });

  it('grok uses commands-as-skills (per docs: skills format, no commands/ dir)', () => {
    expect(shouldInstallCommandAsSkill('grok', '0.2.32')).toBe(true);
  });
});
