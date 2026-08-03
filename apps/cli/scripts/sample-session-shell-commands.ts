#!/usr/bin/env bun
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import type { ToolSearchEnvelope, ToolSessionEvidence } from '../src/lib/session/tool-index.js';
import { machineId, normalizeHost } from '../src/lib/session/sync/config.js';
import type { SessionMeta } from '../src/lib/session/types.js';

export interface SampleOptions {
  sessions: number;
  since: string;
  devices: string[];
  passes: number;
  output?: string;
}

export const SAMPLE_MAX_SERIALIZED_BYTES = 16 * 1024 * 1024;
const SAMPLE_PROJECTED_SESSION_BYTES = SAMPLE_MAX_SERIALIZED_BYTES - 1024 * 1024;

interface SampleEnvelope extends ToolSearchEnvelope {
  sampleTruncated?: boolean;
}

type AgentsRunner = (args: string[]) => string;

export function parseSampleOptions(argv: string[]): SampleOptions {
  const options: SampleOptions = { sessions: 100, since: '7d', devices: [], passes: 4 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--sessions' && value) {
      options.sessions = Number(value);
      i++;
    } else if (arg === '--since' && value) {
      options.since = value;
      i++;
    } else if (arg === '--device' && value) {
      options.devices.push(value);
      i++;
    } else if (arg === '--passes' && value) {
      options.passes = Number(value);
      i++;
    } else if (arg === '--output' && value) {
      options.output = value;
      i++;
    } else if (arg === '--help') {
      process.stdout.write([
        'Sample redacted shell commands from recent agent sessions.',
        '',
        'Usage: bun scripts/sample-session-shell-commands.ts [options]',
        '  --sessions <50-100>  Number of sessions to sample (default: 100)',
        '  --since <time>        Recency window (default: 7d)',
        '  --device <name>       Query only this device; repeatable',
        '  --passes <n>          Bounded cache passes before sampling (default: 4)',
        '  --output <path>       Write JSON to a file instead of stdout',
        '',
        'Output is redacted and capped at 16 MiB; truncation is recorded in the JSON.',
      ].join('\n') + '\n');
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }
  if (!Number.isInteger(options.sessions) || options.sessions < 50 || options.sessions > 100) {
    throw new Error('--sessions must be an integer from 50 to 100');
  }
  if (!Number.isInteger(options.passes) || options.passes < 1 || options.passes > 20) {
    throw new Error('--passes must be an integer from 1 to 20');
  }
  return options;
}

function sampleKey(session: ToolSessionEvidence): string {
  return createHash('sha256')
    .update(`${session.machine ?? 'local'}\0${session.id}`)
    .digest('hex');
}

/** Stable hash sampling makes two runs comparable without biasing to one host. */
export function deterministicSessionSample(
  sessions: ToolSessionEvidence[],
  count: number,
): ToolSessionEvidence[] {
  return [...sessions]
    .sort((a, b) => sampleKey(a).localeCompare(sampleKey(b)))
    .slice(0, count);
}

function runAgents(args: string[]): string {
  const run = spawnSync('agents', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  if (run.status !== 0) {
    throw new Error((run.stderr || run.stdout || `agents exited ${run.status}`).trim());
  }
  return run.stdout;
}

function defaultDevices(runner: AgentsRunner): string[] {
  const parsed = JSON.parse(runner(['devices', 'list', '--json', '--no-stats'])) as Array<{
    name?: string;
    platform?: string;
    role?: string;
    tailscale?: { online?: boolean };
  }>;
  return parsed
    .filter((device) => device.name && device.tailscale?.online === true
      && device.role !== 'control'
      && ['linux', 'macos', 'windows'].includes(device.platform ?? ''))
    .map((device) => device.name!);
}

export function partitionSampleDevices(
  devices: string[],
  self: string,
  explicit: boolean,
): { includeLocal: boolean; remoteDevices: string[] } {
  const normalizedSelf = normalizeHost(self);
  const normalized = [...new Map(devices.map((device) => [normalizeHost(device), device])).entries()];
  return {
    includeLocal: !explicit || normalized.some(([device]) => device === normalizedSelf),
    remoteDevices: normalized.filter(([device]) => device !== normalizedSelf).map(([, original]) => original),
  };
}

function listArgs(options: SampleOptions, devices: string[], local: boolean): string[] {
  const args = [
    'sessions', '--since', options.since,
    '--limit', String(Math.max(200, options.sessions * 4)), '--all', '--json', '--no-interactive',
  ];
  if (local) args.push('--local');
  else for (const device of devices) args.push('--device', device);
  return args;
}

export function loadEnvelope(
  options: SampleOptions,
  runner: AgentsRunner = runAgents,
): ToolSearchEnvelope {
  const explicit = options.devices.length > 0;
  const devices = explicit ? options.devices : defaultDevices(runner);
  const self = machineId();
  const { includeLocal, remoteDevices } = partitionSampleDevices(devices, self, explicit);
  const listed: SessionMeta[] = [];
  if (includeLocal) listed.push(...JSON.parse(runner(listArgs(options, [], true))) as SessionMeta[]);
  if (remoteDevices.length > 0) {
    listed.push(...JSON.parse(runner(listArgs(options, remoteDevices, false))) as SessionMeta[]);
  }
  const unique = new Map<string, SessionMeta>();
  for (const candidate of listed) {
    const key = `${normalizeHost(candidate.machine ?? self)}\0${candidate.id}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  const candidates = [...unique.values()]
    .sort((a, b) => sampleKey({ ...a, calls: [] } as ToolSessionEvidence)
      .localeCompare(sampleKey({ ...b, calls: [] } as ToolSessionEvidence)));
  const sessions: ToolSessionEvidence[] = [];
  let retainedBytes = 0;
  let sampleTruncated = false;
  const coverage = {
    indexedFiles: 0,
    indexedCalls: 0,
    skippedFiles: 0,
    limitedFiles: 0,
    remainingFiles: 0,
    complete: true,
  };

  for (const candidate of candidates) {
    if (sessions.length >= options.sessions) break;
    const args = [
      'sessions', candidate.id, '--include', 'tools', '--all', '--limit', '1',
      '--json', '--no-interactive',
    ];
    if (candidate.machine) args.push('--device', candidate.machine);
    else args.push('--local');
    let envelope: ToolSearchEnvelope | undefined;
    try {
      for (let pass = 0; pass < options.passes; pass++) {
        envelope = JSON.parse(runner(args)) as ToolSearchEnvelope;
        if (envelope.schemaVersion !== 1) throw new Error(`Unsupported tool-search schema ${envelope.schemaVersion}`);
        if (envelope.coverage.complete) break;
      }
    } catch {
      coverage.skippedFiles++;
      coverage.complete = false;
      continue;
    }
    if (!envelope) continue;
    coverage.indexedFiles += envelope.coverage.indexedFiles;
    coverage.indexedCalls += envelope.coverage.indexedCalls;
    coverage.skippedFiles += envelope.coverage.skippedFiles;
    coverage.limitedFiles += envelope.coverage.limitedFiles;
    coverage.remainingFiles += envelope.coverage.remainingFiles;
    coverage.complete &&= envelope.coverage.complete;
    const hit = envelope.sessions.find((session) => session.id === candidate.id);
    if (!hit) continue;
    const shellCalls = hit.calls.filter((call) => call.programs.length > 0).map((call) => ({
      id: call.id,
      ordinal: call.ordinal,
      timestamp: call.timestamp,
      tool: call.tool,
      programs: call.programs,
      input: call.input,
      outcome: call.outcome,
      parseError: call.parseError,
    }));
    if (shellCalls.length === 0) continue;
    const projected: ToolSessionEvidence = {
      id: hit.id,
      shortId: hit.shortId,
      agent: hit.agent,
      machine: hit.machine,
      timestamp: hit.timestamp,
      calls: shellCalls,
    };
    const projectedBytes = Buffer.byteLength(JSON.stringify(projected));
    if (retainedBytes + projectedBytes > SAMPLE_PROJECTED_SESSION_BYTES) {
      coverage.complete = false;
      sampleTruncated = true;
      break;
    }
    retainedBytes += projectedBytes;
    sessions.push(projected);
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    query: { clauses: [] },
    coverage,
    sessions,
    sampleTruncated,
  } as SampleEnvelope;
}

export function buildSample(envelope: ToolSearchEnvelope, count: number) {
  const candidates = deterministicSessionSample(
    envelope.sessions.filter((session) => session.calls.some((call) => call.programs.length > 0)),
    count,
  );
  const sessions: Array<{
    id: string;
    machine?: string;
    agent: string;
    timestamp: string;
    commands: Array<{
      callId: string;
      tool: string;
      programs: string[];
      input: string;
      outcome: string;
      parseError?: string;
    }>;
  }> = [];
  let projectedBytes = 0;
  let truncated = (envelope as SampleEnvelope).sampleTruncated === true;
  for (const session of candidates) {
    const projected = {
      id: session.id,
      machine: session.machine,
      agent: session.agent,
      timestamp: session.timestamp,
      commands: session.calls
        .filter((call) => call.programs.length > 0)
        .map((call) => ({
          callId: call.id,
          tool: call.tool,
          programs: call.programs,
          input: call.input,
          outcome: call.outcome,
          parseError: call.parseError,
        })),
    };
    const bytes = Buffer.byteLength(JSON.stringify(projected));
    if (projectedBytes + bytes > SAMPLE_PROJECTED_SESSION_BYTES) {
      truncated = true;
      break;
    }
    projectedBytes += bytes;
    sessions.push(projected);
  }
  const coverage = { ...envelope.coverage, complete: envelope.coverage.complete && !truncated };
  const sample = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    requestedSessions: count,
    sampledSessions: sessions.length,
    coverage,
    truncation: truncated
      ? { reason: 'sample_byte_limit', maxBytes: SAMPLE_MAX_SERIALIZED_BYTES }
      : undefined,
    sessions,
  };
  while (sessions.length > 0 && Buffer.byteLength(JSON.stringify(sample, null, 2) + '\n') > SAMPLE_MAX_SERIALIZED_BYTES) {
    sessions.pop();
    sample.sampledSessions = sessions.length;
    sample.coverage.complete = false;
    sample.truncation = { reason: 'sample_byte_limit', maxBytes: SAMPLE_MAX_SERIALIZED_BYTES };
  }
  return sample;
}

if (import.meta.main) {
  try {
    const options = parseSampleOptions(process.argv.slice(2));
    const output = JSON.stringify(buildSample(loadEnvelope(options), options.sessions), null, 2) + '\n';
    if (options.output) fs.writeFileSync(options.output, output, { mode: 0o600 });
    else process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
