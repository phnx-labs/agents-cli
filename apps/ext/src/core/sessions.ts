export interface AgentSession {
  agentType: 'claude' | 'codex' | 'gemini';
  sessionId: string;
  timestamp: Date;
  path: string;
  preview?: string;
}
