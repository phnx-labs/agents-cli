import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as net from 'net';
import * as path from 'path';
import * as os from 'os';

const SOCKET_PATH = path.join(os.homedir(), '.agents', '.tmp', 'watchdog.sock');

const server = new Server(
  { name: 'watchdog', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_nudge',
      description: `Send a message to a stalled agent terminal to unstick it.

Before calling this tool, you should:
1. Run \`agents sessions --active\` to list active sessions
2. Run \`agents sessions tail <sessionId> --last 50\` to read session history
3. Use \`mq AGENTS.md .tree\` to understand project conventions
4. Use \`linear tasks\` to understand task context

Only nudge after you understand what the agent was doing and why it stalled.`,
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID from `agents sessions --active`',
          },
          text: {
            type: 'string',
            description: 'Short imperative message (under 120 chars, no emojis). Use project-specific commands when known.',
          },
          reason: {
            type: 'string',
            description: 'Why you are nudging - what the agent said it would do vs what happened. This is logged for transparency.',
          },
        },
        required: ['sessionId', 'text', 'reason'],
      },
    },
    {
      name: 'send_to_agent',
      description: `Send a message to a peer agent terminal. The recipient sees your text typed directly into its prompt as if a human typed it.

Use this to coordinate with another agent running in a swarmify terminal — for example, hand off work, ask a question, or pass a result.

Find peer session IDs with \`agents sessions --active\`. Sending to your own session is rejected.`,
      inputSchema: {
        type: 'object',
        properties: {
          targetSessionId: {
            type: 'string',
            description: 'Recipient session ID from `agents sessions --active`',
          },
          text: {
            type: 'string',
            description: 'Message body (max 2000 chars). Will be typed into the recipient terminal verbatim.',
          },
        },
        required: ['targetSessionId', 'text'],
      },
    },
  ],
}));

type ExtensionRequest =
  | { sessionId: string; text: string; reason: string }
  | { kind: 'peer'; senderSessionId: string; targetSessionId: string; text: string };

async function sendToExtension(
  msg: ExtensionRequest
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const client = net.createConnection(SOCKET_PATH, () => {
      client.write(JSON.stringify(msg));
    });

    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
    });

    client.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({ success: false, error: 'Invalid response from extension' });
      }
    });

    client.on('error', (err) => {
      resolve({ success: false, error: `Socket error: ${err.message}` });
    });

    setTimeout(() => {
      client.destroy();
      resolve({ success: false, error: 'Timeout connecting to extension' });
    }, 5000);
  });
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'send_nudge') {
    const { sessionId, text, reason } = args as {
      sessionId: string;
      text: string;
      reason: string;
    };

    if (!sessionId || !text || !reason) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: 'Missing required parameters: sessionId, text, reason' }),
          },
        ],
      };
    }

    if (text.length > 200) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: 'Text must be under 200 characters' }),
          },
        ],
      };
    }

    const result = await sendToExtension({ sessionId, text, reason });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  if (name === 'send_to_agent') {
    const { targetSessionId, text } = args as {
      targetSessionId: string;
      text: string;
    };

    if (!targetSessionId || !text) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: 'Missing required parameters: targetSessionId, text',
            }),
          },
        ],
      };
    }

    if (text.length > 2000) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: 'Text must be under 2000 characters' }),
          },
        ],
      };
    }

    // Sender's sessionId is propagated through the env by swarmify
    // (core/terminals.ts:159-160). MCP child inherits it from the agent CLI.
    const senderSessionId = process.env.AGENT_SESSION_ID ?? '';

    const result = await sendToExtension({
      kind: 'peer',
      senderSessionId,
      targetSessionId,
      text,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Watchdog MCP server failed:', err);
  process.exit(1);
});
