export type AgentId =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'cursor'
  | 'grok'
  | 'antigravity'
  | 'opencode';

export interface TrackSpawnInput {
  agent: AgentId;
  agentPid: number;
  shellPid?: number;
  cwd: string;
  terminalId?: string;
  launchId: string;
}

export type DetectionMethod = 'hook-stdin' | 'hook-env' | 'fs-watch' | 'stdout-banner';
export type DetectionConfidence = 'high' | 'medium' | 'low';

export interface DetectionResult {
  sessionId: string | null;
  method: DetectionMethod | null;
  latencyMs: number;
  confidence: DetectionConfidence;
}

export interface SessionState {
  session_id: string;
  agent: AgentId;
  cwd: string;
  pid: number;
  terminal_id?: string;
  launch_id?: string;
  ts: number;
  method: DetectionMethod;
}

export interface LookupInput {
  shellPid?: number;
  terminalId?: string;
  launchId?: string;
}
