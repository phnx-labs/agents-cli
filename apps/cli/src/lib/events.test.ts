import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emit, emitStart, emitCommand, query, rotate, stats,
  redactPrompt, redactArgs, truncate,
  detectCaller,
  _resetForTest,
} from './events.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-events-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tempDirs.length = 0;
  delete process.env.AGENTS_DISABLE_EVENT_LOG;
  _resetForTest();
});

function setupLogsDir(): string {
  const dir = makeTempDir();
  const eventsPath = path.join(dir, 'events.jsonl');
  _resetForTest(eventsPath);
  return dir;
}

describe('events', () => {
  describe('emit', () => {
    it('writes a JSONL record with level and caller fields', () => {
      const logsDir = setupLogsDir();
      emit('info', { module: 'test', input: 'hello' });

      const files = fs.readdirSync(logsDir).filter(f => f === 'events.jsonl');
      expect(files).toEqual(['events.jsonl']);

      const content = fs.readFileSync(path.join(logsDir, 'events.jsonl'), 'utf-8');
      const record = JSON.parse(content.trim().split('\n').pop()!);
      expect(record.event).toBe('info');
      expect(record.level).toBe('info');
      expect(record.ts).toBeDefined();
      expect(record.hostname).toBeDefined();
      expect(record.pid).toBe(process.pid);
      expect(record.caller).toBe(detectCaller().kind);
      expect(record.osUser).toBeDefined();
      expect(['local', 'ssh']).toContain(record.transport);
    });

    it('assigns audit level to secrets events', () => {
      setupLogsDir();
      emit('secrets.get', { module: 'secrets', item: 'test-bundle' });

      const records = query({});
      const last = records[0];
      expect(last.level).toBe('audit');
      expect(last.event).toBe('secrets.get');
    });

    it('assigns warn level to warn events', () => {
      setupLogsDir();
      emit('warn', { module: 'test' });

      const records = query({});
      expect(records[0].level).toBe('warn');
    });

    it('assigns debug level to debug events', () => {
      setupLogsDir();
      emit('debug', { module: 'test' });

      const records = query({});
      expect(records[0].level).toBe('debug');
    });

    it('does not let payload metadata override the detected caller', () => {
      setupLogsDir();
      emit('info', { module: 'test', caller: 'forged' });

      const records = query({});
      expect(records[0].caller).toBe(detectCaller().kind);
    });

    it('respects AGENTS_DISABLE_EVENT_LOG', () => {
      const logsDir = setupLogsDir();
      process.env.AGENTS_DISABLE_EVENT_LOG = '1';
      emit('info', { module: 'test' });

      const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(logsDir, files[0]), 'utf-8').trim();
        expect(content).toBe('');
      } else {
        expect(files.length).toBe(0);
      }
    });
  });

  describe('redaction', () => {
    it('redactPrompt returns length and truncated sha256', () => {
      const result = redactPrompt('my secret prompt');
      expect(result.prompt_length).toBe(16);
      expect(result.prompt_sha256).toBeDefined();
      expect(result.prompt_sha256!.length).toBe(16);
    });

    it('redactPrompt returns empty for null', () => {
      expect(redactPrompt(null)).toEqual({});
      expect(redactPrompt(undefined)).toEqual({});
    });

    it('redactArgs masks token-like values', () => {
      const result = redactArgs(['--token', 'sk_live_abc123', '--name', 'safe']);
      expect(result).toEqual(['--token', '[REDACTED]', '--name', 'safe']);
    });

    it('redactArgs masks secret paths', () => {
      const result = redactArgs(['/home/user/.env']);
      expect(result).toEqual(['[REDACTED]']);
    });

    it('redactArgs masks GitHub tokens', () => {
      expect(redactArgs(['ghp_xxxxxxxxxxxx'])).toEqual(['[REDACTED]']);
    });

    it('redactArgs masks sensitive flag values regardless of token format', () => {
      const sentinel = 'plain-value-that-does-not-look-like-a-token';
      expect(redactArgs([
        '--value', sentinel,
        `--body=${sentinel}`,
        '--password', sentinel,
        `--api-key=${sentinel}`,
        '--auth', sentinel,
      ])).toEqual([
        '--value', '[REDACTED]',
        '--body=[REDACTED]',
        '--password', '[REDACTED]',
        '--api-key=[REDACTED]',
        '--auth', '[REDACTED]',
      ]);
    });

    it('redactArgs hashes long prompt values without retaining raw text', () => {
      const prompt = 'sensitive prompt '.repeat(20);
      const result = redactArgs(['--prompt', prompt])!;
      expect(result[1]).toMatch(/^\[REDACTED prompt length=340 sha256=[a-f0-9]{16}\]$/);
      expect(result.join(' ')).not.toContain(prompt);
    });

    it('emit strips raw secrets and prompts from arbitrary payload fields', () => {
      const dir = setupLogsDir();
      const sentinel = 'known-secret-sentinel-460';
      emit('secrets.get', {
        module: 'secrets',
        apiToken: sentinel,
        prompt: `decide using ${sentinel}`,
        nested: { auth: sentinel },
      });

      const raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8');
      expect(raw).not.toContain(sentinel);
      const record = JSON.parse(raw);
      expect(record.apiToken).toBe('[REDACTED]');
      expect(record.nested.auth).toBe('[REDACTED]');
      expect(record.prompt_length).toBeDefined();
      expect(record.prompt_sha256).toBeDefined();
    });
  });

  describe('caller detection', () => {
    it('detects Claude Code and preserves its short session', () => {
      expect(detectCaller({ CLAUDECODE: '1', AGENT_SESSION_ID: '12345678-rest' }, true))
        .toEqual({ kind: 'claude-code', session: '12345678' });
    });

    it.each([
      ['CX-123', 'codex'],
      ['GX-123', 'gemini'],
      ['CR-123', 'cursor'],
      ['CC-123', 'claude'],
    ])('maps swarmify terminal %s to %s', (terminalId, kind) => {
      expect(detectCaller({ AGENT_TERMINAL_ID: terminalId }, true)).toEqual({ kind });
    });

    it('distinguishes direct terminal and script invocations', () => {
      expect(detectCaller({}, true)).toEqual({ kind: 'terminal' });
      expect(detectCaller({}, false)).toEqual({ kind: 'script' });
    });
  });

  describe('truncate', () => {
    it('truncates long strings with ellipsis', () => {
      const long = 'a'.repeat(600);
      const result = truncate(long, 100);
      expect(result!.length).toBe(100);
      expect(result!.endsWith('...')).toBe(true);
    });

    it('returns short strings unchanged', () => {
      expect(truncate('short', 100)).toBe('short');
    });

    it('returns undefined for null', () => {
      expect(truncate(null)).toBeUndefined();
    });
  });

  describe('query', () => {
    it('reads and filters events by event type', () => {
      setupLogsDir();
      emit('info', { module: 'test', input: 'a' });
      emit('warn', { module: 'test', input: 'b' });
      emit('info', { module: 'test', input: 'c' });

      const results = query({ eventTypes: ['info'] });
      expect(results.length).toBe(2);
      for (const r of results) expect(r.event).toBe('info');
    });

    it('filters by level', () => {
      setupLogsDir();
      emit('secrets.get', { module: 'secrets' });
      emit('info', { module: 'test' });
      emit('warn', { module: 'test' });

      const audits = query({ level: 'audit' });
      expect(audits.length).toBe(1);
      expect(audits[0].event).toBe('secrets.get');

      const warns = query({ level: 'warn' });
      expect(warns.length).toBe(1);
    });

    it('filters by module', () => {
      setupLogsDir();
      emit('info', { module: 'secrets' });
      emit('info', { module: 'teams' });

      const results = query({ module: 'secrets' });
      expect(results.length).toBe(1);
      expect(results[0].module).toBe('secrets');
    });

    it('filters by environment-derived caller identity', () => {
      setupLogsDir();
      emit('info', { module: 'test' });

      expect(query({ caller: detectCaller().kind })).toHaveLength(1);
      expect(query({ caller: 'not-this-caller' })).toHaveLength(0);
    });

    it('filters by command prefix', () => {
      setupLogsDir();
      emit('command.start', { command: 'teams create', module: 'teams' });
      emit('command.start', { command: 'teams add', module: 'teams' });
      emit('command.start', { command: 'secrets get', module: 'secrets' });

      const results = query({ command: 'teams' });
      expect(results.length).toBe(2);
    });

    it('respects limit', () => {
      setupLogsDir();
      for (let i = 0; i < 10; i++) emit('info', { module: 'test', i });

      const results = query({ limit: 3 });
      expect(results.length).toBe(3);
    });

    it('reads gzipped log files', () => {
      const logsDir = setupLogsDir();
      const record = {
        ts: new Date().toISOString(),
        tz: '+00:00', tzName: 'UTC',
        hostname: 'test', platform: 'linux', arch: 'x64',
        pid: 1, ppid: 0,
        event: 'info', level: 'info',
        osUser: 'test', transport: 'local',
        module: 'gztest',
      };
      const gzPath = path.join(logsDir, 'events.1.jsonl.gz');
      fs.writeFileSync(gzPath, gzipSync(Buffer.from(JSON.stringify(record) + '\n')));

      const results = query({ module: 'gztest' });
      expect(results.length).toBe(1);
      expect(results[0].module).toBe('gztest');
    });
  });

  describe('rotation', () => {
    it('rotates repeatedly at 10 MB without overwriting older archives', () => {
      const logsDir = setupLogsDir();
      const active = path.join(logsDir, 'events.jsonl');
      const oversized = (marker: string) => JSON.stringify({ marker, padding: 'x'.repeat(10 * 1024 * 1024) }) + '\n';

      fs.writeFileSync(active, oversized('first'));
      emit('info', { module: 'rotation', marker: 'first-trigger' });
      expect(fs.existsSync(path.join(logsDir, 'events.1.jsonl.gz'))).toBe(true);

      fs.writeFileSync(active, oversized('second'));
      emit('info', { module: 'rotation', marker: 'second-trigger' });
      const newest = gunzipSync(fs.readFileSync(path.join(logsDir, 'events.1.jsonl.gz'))).toString('utf-8');
      const older = gunzipSync(fs.readFileSync(path.join(logsDir, 'events.2.jsonl.gz'))).toString('utf-8');
      expect(newest).toContain('second');
      expect(older).toContain('first');
      expect(fs.statSync(active).size).toBe(0);
    });

    it('removes archives older than the retention period', () => {
      const logsDir = setupLogsDir();
      const gzFile = path.join(logsDir, 'events.1.jsonl.gz');
      fs.writeFileSync(gzFile, gzipSync(Buffer.from('{"event":"info"}\n')));
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(gzFile, old, old);

      const removed = rotate(7);
      expect(removed).toBe(1);
      expect(fs.existsSync(gzFile)).toBe(false);
    });
  });

  describe('stats', () => {
    it('returns aggregate statistics', () => {
      setupLogsDir();
      emit('secrets.get', { module: 'secrets' });
      emit('info', { module: 'test' });
      emit('warn', { module: 'test' });

      const s = stats({ days: 1 });
      expect(s.totalEvents).toBe(3);
      expect(s.byLevel.audit).toBe(1);
      expect(s.byLevel.info).toBe(1);
      expect(s.byLevel.warn).toBe(1);
      expect(s.byEvent['secrets.get']).toBe(1);
      expect(s.byModule.secrets).toBe(1);
      expect(s.fileCount).toBe(1);
    });
  });

  describe('performance', () => {
    it('handles 10k records without excessive time', () => {
      setupLogsDir();
      const start = Date.now();
      for (let i = 0; i < 10_000; i++) {
        emit('info', { module: 'perf', i });
      }
      const writeMs = Date.now() - start;

      const qStart = Date.now();
      const results = query({ module: 'perf', limit: 10_000 });
      const readMs = Date.now() - qStart;

      expect(results.length).toBe(10_000);
      expect(writeMs).toBeLessThan(30_000);
      expect(readMs).toBeLessThan(10_000);
    });
  });

  describe('emitStart / emitCommand', () => {
    it('emitStart pairs start/end events with duration', () => {
      setupLogsDir();
      const done = emitStart('agent.run.start', { agent: 'claude' });
      done({ exitCode: 0 });

      const results = query({});
      const startRec = results.find(r => r.event === 'agent.run.start');
      const endRec = results.find(r => r.event === 'agent.run.end');
      expect(startRec).toBeDefined();
      expect(endRec).toBeDefined();
      expect(endRec!.durationMs).toBeGreaterThanOrEqual(0);
      expect(endRec!.exitCode).toBe(0);
    });

    it('emitCommand captures command name and args', () => {
      setupLogsDir();
      const done = emitCommand('run', ['claude', '-p', 'hi']);
      done({ exitCode: 0 });

      const results = query({ eventTypes: ['command.start'] });
      expect(results.length).toBe(1);
      expect(results[0].command).toBe('run');
      expect(results[0].args).toEqual(['claude', '-p', 'hi']);
    });
  });
});
