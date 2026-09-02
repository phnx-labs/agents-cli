/**
 * Public library contract for portable-agent materialization (PHNX-3838).
 *
 * The CLI (`agents packages materialize`) is a thin caller of this function.
 * Writers may grow behind this signature; callers must not grow a second
 * execution path.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';
import * as yaml from 'yaml';
import { assertWithin } from '../paths.js';
import { VERSION_RE } from '../agent-spec/primitives.js';

export const PORTABLE_HARNESSES = ['claude', 'codex', 'opencode'] as const;
export type PortableHarness = (typeof PORTABLE_HARNESSES)[number];

export type MaterializeErrorCode =
  | 'invalid-package'
  | 'unsupported-capability'
  | 'path-escape'
  | 'invalid-version';

export class MaterializeError extends Error {
  readonly code: MaterializeErrorCode;
  constructor(message: string, code: MaterializeErrorCode) {
    super(message);
    this.name = 'MaterializeError';
    this.code = code;
  }
}

export interface MaterializePortableAgentInput {
  package: string;
  harness: string;
  version: string;
  outputHome: string;
}

export interface MaterializeTarget {
  kind: string;
  path: string;
  hash: string;
}

export interface MaterializeReceipt {
  package: string;
  packagePath: string;
  harness: PortableHarness;
  version: string;
  outputHome: string;
  targets: MaterializeTarget[];
  resourceHashes: Record<string, string>;
  warnings: string[];
}

function isPortableHarness(value: string): value is PortableHarness {
  return (PORTABLE_HARNESSES as readonly string[]).includes(value);
}

function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function liveHarnessHomes(home = os.homedir()): string[] {
  return ['.claude', '.codex', '.opencode'].map((name) => path.join(home, name));
}

/** True when `raw` still contains a `..` segment after splitting on both separators. */
export function outputHomeHasDotDot(raw: string): boolean {
  return raw.split(/[\\/]/).includes('..');
}

/**
 * Resolve `--output-home` without climbing out of cwd (relative) or using `..`
 * segments, and without targeting the live Claude/Codex/OpenCode homes.
 */
export function resolveOutputHome(raw: string, cwd = process.cwd(), home = os.homedir()): string {
  if (!raw || raw.includes('\0')) {
    throw new MaterializeError('Path escape: output home is empty or contains a null byte', 'path-escape');
  }
  if (outputHomeHasDotDot(raw)) {
    throw new MaterializeError(`Path escape: ${raw}`, 'path-escape');
  }
  const resolved = path.resolve(cwd, raw);
  if (!path.isAbsolute(raw)) {
    try {
      assertWithin(cwd, resolved);
    } catch {
      throw new MaterializeError(`Path escape: ${raw}`, 'path-escape');
    }
  }
  for (const live of liveHarnessHomes(home)) {
    if (resolved === live || resolved.startsWith(live + path.sep)) {
      throw new MaterializeError(
        `Path escape: output home must not target the live ${path.basename(live)} directory`,
        'path-escape',
      );
    }
  }
  return resolved;
}

function resolvePackageDir(raw: string, cwd = process.cwd()): { dir: string; specPath: string } {
  const resolved = path.resolve(cwd, raw);
  if (!fs.existsSync(resolved)) {
    throw new MaterializeError(
      `Invalid package: ${raw} (expected a directory containing agent.yaml)`,
      'invalid-package',
    );
  }
  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    if (path.basename(resolved) !== 'agent.yaml') {
      throw new MaterializeError(
        `Invalid package: ${raw} (expected a directory containing agent.yaml)`,
        'invalid-package',
      );
    }
    return { dir: path.dirname(resolved), specPath: resolved };
  }
  if (!stat.isDirectory()) {
    throw new MaterializeError(
      `Invalid package: ${raw} (expected a directory containing agent.yaml)`,
      'invalid-package',
    );
  }
  const specPath = path.join(resolved, 'agent.yaml');
  if (!fs.existsSync(specPath) || !fs.statSync(specPath).isFile()) {
    throw new MaterializeError(
      `Invalid package: ${raw} (expected a directory containing agent.yaml)`,
      'invalid-package',
    );
  }
  return { dir: resolved, specPath };
}

/**
 * Materialize a schema-v3 `agent.yaml` package into an ephemeral harness home.
 * Writes only under `outputHome`. Never copies secrets, never execs a harness,
 * never mutates the live user home.
 */
export function materializePortableAgent(input: MaterializePortableAgentInput): MaterializeReceipt {
  if (!isPortableHarness(input.harness)) {
    throw new MaterializeError(
      `Unsupported capability: '${input.harness}' is not a portable-agent harness (claude, codex, opencode).`,
      'unsupported-capability',
    );
  }
  if (!input.version || !VERSION_RE.test(input.version) || input.version === 'latest') {
    throw new MaterializeError(
      `Invalid version '${input.version}'. Pass an exact harness version (not @latest).`,
      'invalid-version',
    );
  }

  const { dir: packageDir, specPath } = resolvePackageDir(input.package);
  const outputHome = resolveOutputHome(input.outputHome);
  const specRaw = fs.readFileSync(specPath, 'utf8');
  let spec: { schemaVersion?: unknown; name?: unknown };
  try {
    spec = (yaml.parse(specRaw) ?? {}) as { schemaVersion?: unknown; name?: unknown };
  } catch {
    throw new MaterializeError('Invalid package: agent.yaml is not valid YAML', 'invalid-package');
  }
  if (spec.schemaVersion !== 3) {
    throw new MaterializeError(
      'Invalid package: agent.yaml must declare schemaVersion: 3',
      'invalid-package',
    );
  }
  const packageName = typeof spec.name === 'string' && spec.name.trim() ? spec.name.trim() : path.basename(packageDir);

  fs.mkdirSync(outputHome, { recursive: true });
  const destSpec = assertWithin(outputHome, path.join(outputHome, 'agent.yaml'));
  fs.copyFileSync(specPath, destSpec);
  const hash = sha256(specRaw);
  const receipt: MaterializeReceipt = {
    package: packageName,
    packagePath: packageDir,
    harness: input.harness,
    version: input.version,
    outputHome,
    targets: [{ kind: 'agent.yaml', path: destSpec, hash }],
    resourceHashes: { 'agent.yaml': hash },
    warnings: [],
  };
  const receiptPath = assertWithin(outputHome, path.join(outputHome, '.agents-materialize-receipt.json'));
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
