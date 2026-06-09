import * as fs from 'fs';
import { stateFilePath, writeStateAtomic } from './state-file.js';
import type { AgentId, DetectionMethod, SessionState } from './types.js';

export interface RecordSessionArgs {
  sessionId: string;
  agent: AgentId;
  pid: number;
  cwd: string;
  terminalId?: string;
  launchId?: string;
  method: DetectionMethod;
}

export async function recordSession(args: RecordSessionArgs): Promise<void> {
  const state: SessionState = {
    session_id: args.sessionId,
    agent: args.agent,
    cwd: args.cwd,
    pid: args.pid,
    ts: Date.now(),
    method: args.method,
  };
  if (args.terminalId) state.terminal_id = args.terminalId;
  if (args.launchId) state.launch_id = args.launchId;
  await writeStateAtomic(state);
}

export async function clearSession(pid: number): Promise<void> {
  try {
    await fs.promises.unlink(stateFilePath(pid));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}
