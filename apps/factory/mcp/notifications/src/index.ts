#!/usr/bin/env node
import { runServer } from './server.js';

process.on('SIGTERM', () => {
  console.error('Notifications MCP server received SIGTERM');
  process.exit(128 + 15);
});

process.on('SIGINT', () => {
  console.error('Notifications MCP server received SIGINT');
  process.exit(128 + 2);
});

process.on('SIGPIPE', () => {
  // Ignore SIGPIPE
});

process.on('exit', () => {
  console.error('Notifications MCP server exiting');
});

runServer().catch((err) => {
  console.error('Fatal error in notifications-mcp:', err);
  process.exit(1);
});
