import { describe, test, expect } from 'bun:test';
import { getSessionPathBySessionId, getSessionPreviewInfo, getOpenCodeSessionPreviewInfo, getCursorSessionPreviewInfo } from '../vscode/sessions.vscode';
import { homedir } from 'os';
import * as fs from 'fs';
import * as path from 'path';

describe('Session Reading - Real Sessions', () => {
  test('Claude: can read first user message', async () => {
    // Find a real Claude session
    const claudeRoot = path.join(homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeRoot)) {
      console.log('No Claude sessions directory found, skipping');
      return;
    }
    
    // Find any .jsonl file
    const projects = fs.readdirSync(claudeRoot);
    let sessionPath: string | undefined;
    for (const proj of projects) {
      const projPath = path.join(claudeRoot, proj);
      if (!fs.statSync(projPath).isDirectory()) continue;
      const files = fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl'));
      if (files.length > 0) {
        sessionPath = path.join(projPath, files[0]);
        break;
      }
    }
    
    if (!sessionPath) {
      console.log('No Claude session files found, skipping');
      return;
    }
    
    console.log('Testing Claude session:', sessionPath);
    const preview = await getSessionPreviewInfo(sessionPath);
    console.log('Claude preview:', preview);
    expect(preview.messageCount).toBeGreaterThan(0);
  });

  test('OpenCode: can read first user message', async () => {
    const messageRoot = path.join(homedir(), '.local', 'share', 'opencode', 'storage', 'message');
    if (!fs.existsSync(messageRoot)) {
      console.log('No OpenCode sessions directory found, skipping');
      return;
    }
    
    const sessions = fs.readdirSync(messageRoot).filter(d => d.startsWith('ses_'));
    if (sessions.length === 0) {
      console.log('No OpenCode session files found, skipping');
      return;
    }
    
    const sessionDir = path.join(messageRoot, sessions[0]);
    console.log('Testing OpenCode session:', sessionDir);
    const preview = await getOpenCodeSessionPreviewInfo(sessionDir);
    console.log('OpenCode preview:', preview);
    expect(preview.messageCount).toBeGreaterThan(0);
    if (preview.firstUserMessage) {
      console.log('First user message:', preview.firstUserMessage);
    }
  });

  test('Cursor: can read first user message from SQLite', async () => {
    const chatsRoot = path.join(homedir(), '.cursor', 'chats');
    if (!fs.existsSync(chatsRoot)) {
      console.log('No Cursor chats directory found, skipping');
      return;
    }
    
    // Find any store.db file
    let dbPath: string | undefined;
    const workspaces = fs.readdirSync(chatsRoot);
    outer: for (const ws of workspaces) {
      const wsPath = path.join(chatsRoot, ws);
      if (!fs.statSync(wsPath).isDirectory()) continue;
      const chats = fs.readdirSync(wsPath);
      for (const chat of chats) {
        const storePath = path.join(wsPath, chat, 'store.db');
        if (fs.existsSync(storePath)) {
          dbPath = storePath;
          break outer;
        }
      }
    }
    
    if (!dbPath) {
      console.log('No Cursor store.db files found, skipping');
      return;
    }
    
    console.log('Testing Cursor session:', dbPath);
    const preview = await getCursorSessionPreviewInfo(dbPath);
    console.log('Cursor preview:', preview);
    expect(preview.messageCount).toBeGreaterThan(0);
    if (preview.firstUserMessage) {
      console.log('First user message:', preview.firstUserMessage);
    }
  });
});
