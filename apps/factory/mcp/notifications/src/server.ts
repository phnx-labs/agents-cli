import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const execFileAsync = promisify(execFile);

// Find alerter binary - check multiple locations
function findAlerterBinary(): string | null {
  const candidates = [
    // Bundled with extension (set via ALERTER_PATH env var)
    process.env.ALERTER_PATH,
    // Common install locations
    '/usr/local/bin/alerter',
    path.join(os.homedir(), '.local', 'bin', 'alerter'),
    // Homebrew
    '/opt/homebrew/bin/alerter',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

interface NotificationResult {
  action: 'allow' | 'deny' | 'timeout' | 'closed';
  raw: string;
}

async function showNotification(
  title: string,
  message: string,
  timeout: number = 60
): Promise<NotificationResult> {
  const alerterPath = findAlerterBinary();

  if (!alerterPath) {
    throw new Error(
      'alerter binary not found. Set ALERTER_PATH environment variable or install alerter.'
    );
  }

  // Truncate message to fit in notification (roughly 200 chars visible)
  const truncatedMessage = message.length > 200
    ? message.slice(0, 197) + '...'
    : message;

  const args = [
    '-title', title,
    '-message', truncatedMessage,
    '-actions', 'Allow,Deny',
    '-closeLabel', 'Dismiss',
    '-timeout', timeout.toString(),
    '-sound', 'default',
  ];

  // Add app icon if Claude Code icon exists
  const claudeIconPath = process.env.CLAUDE_ICON_PATH;
  if (claudeIconPath && fs.existsSync(claudeIconPath)) {
    args.push('-appIcon', claudeIconPath);
  }

  try {
    const { stdout } = await execFileAsync(alerterPath, args);
    const response = stdout.trim();

    // Parse alerter response
    if (response === 'Allow') {
      return { action: 'allow', raw: response };
    } else if (response === 'Deny') {
      return { action: 'deny', raw: response };
    } else if (response === '@TIMEOUT') {
      return { action: 'timeout', raw: response };
    } else if (response === '@CLOSED' || response === '@CONTENTCLICKED') {
      return { action: 'closed', raw: response };
    } else {
      // Unknown response, treat as deny for safety
      return { action: 'deny', raw: response };
    }
  } catch (err: any) {
    // alerter returns non-zero exit code on timeout/close
    const stdout = err.stdout?.trim() || '';
    if (stdout === '@TIMEOUT') {
      return { action: 'timeout', raw: stdout };
    } else if (stdout === '@CLOSED' || stdout === '@CONTENTCLICKED') {
      return { action: 'closed', raw: stdout };
    }
    throw err;
  }
}

const server = new Server(
  {
    name: 'notifications',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'ask_permission',
        description: `Ask the user for permission via a native macOS notification.

Shows a notification in the top-right corner with Allow/Deny buttons.
Blocks until the user responds or the notification times out.

Use this for:
- Plan approvals before implementing changes
- Confirmation before destructive operations
- Any action that requires explicit user consent

Returns: { decision: "allow" | "deny" | "timeout" | "closed" }`,
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Short title for the notification (e.g., "Plan Approval Required")',
            },
            message: {
              type: 'string',
              description: 'Description of what you are asking permission for. First ~200 chars will be visible.',
            },
            timeout: {
              type: 'number',
              description: 'Seconds to wait before timing out. Default: 60',
            },
          },
          required: ['title', 'message'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'ask_permission') {
      if (!args) {
        throw new Error('Missing arguments for ask_permission');
      }

      const title = args.title as string;
      const message = args.message as string;
      const timeout = (args.timeout as number) || 60;

      const result = await showNotification(title, message, timeout);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              decision: result.action,
              message: result.action === 'allow'
                ? 'User approved the request'
                : result.action === 'deny'
                ? 'User denied the request'
                : result.action === 'timeout'
                ? 'Notification timed out - no response from user'
                : 'User dismissed the notification',
            }, null, 2),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: `Unknown tool: ${name}` }, null, 2),
        },
      ],
    };
  } catch (err: any) {
    console.error(`Error in tool ${name}:`, err);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: String(err.message || err) }, null, 2),
        },
      ],
    };
  }
});

export async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Starting notifications MCP server v0.1.0');

  const alerterPath = findAlerterBinary();
  if (alerterPath) {
    console.error(`Using alerter at: ${alerterPath}`);
  } else {
    console.error('WARNING: alerter binary not found. Set ALERTER_PATH env var.');
  }
}
