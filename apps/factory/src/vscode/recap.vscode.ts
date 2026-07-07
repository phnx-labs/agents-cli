import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { getSessionPathBySessionId } from './sessions.vscode';
import { resolveAgentsBin, bootstrapPath } from '../core/agentsBin';

export type RecapAgentType = 'claude' | 'codex' | 'gemini' | 'cursor' | 'copilot';

const SUPPORTED: ReadonlySet<RecapAgentType> = new Set(['claude', 'codex', 'gemini', 'cursor', 'copilot']);

export function isRecapSupported(agentType: string | undefined): agentType is RecapAgentType {
  return !!agentType && SUPPORTED.has(agentType as RecapAgentType);
}

export interface RunRecapArgs {
  sessionId: string;
  agentType: RecapAgentType;
  version?: string;
  workspacePath: string;
  extensionPath: string;
}

export function recapSidecarPath(transcriptPath: string): string {
  const ext = path.extname(transcriptPath);
  return ext
    ? transcriptPath.slice(0, -ext.length) + '.recap.md'
    : transcriptPath + '.recap.md';
}

export function buildRecapPrompt(transcriptPath: string, template: string): string {
  const body = template.trim();
  return [
    `Read the session transcript at this path: ${transcriptPath}`,
    '',
    'Produce a recap following these guidelines:',
    '',
    body,
    '',
    'Output only the recap markdown. No preamble. No commentary about the task itself.',
  ].join('\n');
}

export function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n/, '');
}

export function stripGeminiToml(toml: string): string {
  const match = toml.match(/prompt\s*=\s*"""([\s\S]*?)"""/);
  if (match) return match[1];
  const singleQuoted = toml.match(/prompt\s*=\s*"([^"]*)"/);
  return singleQuoted ? singleQuoted[1] : toml;
}

export async function readRecapTemplate(
  extensionPath: string,
  agentType: RecapAgentType,
): Promise<string> {
  const agentDir = agentType === 'codex' ? 'prompts' : 'commands';
  const ext = agentType === 'gemini' ? 'toml' : 'md';
  const filePath = path.join(extensionPath, '..', 'prompts', agentType, agentDir, `recap.${ext}`);
  const raw = await fs.readFile(filePath, 'utf-8');
  return agentType === 'gemini' ? stripGeminiToml(raw) : stripFrontmatter(raw);
}

export function buildRecapArgv(
  agentType: RecapAgentType,
  version: string | undefined,
  workspacePath: string,
  prompt: string,
): string[] {
  const agentSpec = version ? `${agentType}@${version}` : agentType;
  return [
    'run',
    agentSpec,
    '--mode', 'plan',
    '--headless',
    '--quiet',
    '--cwd', workspacePath,
    prompt,
  ];
}

export async function runRecapHeadless(args: RunRecapArgs): Promise<string | null> {
  const transcriptPath = await getSessionPathBySessionId(
    args.sessionId,
    args.agentType,
    args.workspacePath,
  );
  if (!transcriptPath) {
    console.warn(`[recap] no transcript for session ${args.sessionId} (${args.agentType})`);
    return null;
  }

  const sidecar = recapSidecarPath(transcriptPath);
  let template = '';
  try {
    template = await readRecapTemplate(args.extensionPath, args.agentType);
  } catch (err) {
    console.warn(`[recap] failed reading template for ${args.agentType}:`, err);
  }

  const prompt = buildRecapPrompt(transcriptPath, template);
  const bin = await resolveAgentsBin();
  const augmented = bootstrapPath(bin);
  const argv = buildRecapArgv(args.agentType, args.version, args.workspacePath, prompt);

  const fh = await fs.open(sidecar, 'w');
  try {
    const child = spawn(bin, argv, {
      detached: true,
      stdio: ['ignore', fh.fd, 'ignore'],
      env: { ...process.env, PATH: `${augmented}:${process.env.PATH ?? ''}` },
    });
    child.unref();
  } finally {
    await fh.close();
  }

  console.log(`[recap] dispatched ${args.agentType}${args.version ? '@' + args.version : ''} -> ${sidecar}`);
  return sidecar;
}
