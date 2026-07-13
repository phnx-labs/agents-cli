/**
 * Feed store -- structured block records published by agents waiting on user
 * input (AskUserQuestion). The outbound counterpart to the inbound mailbox:
 * the mailbox delivers messages TO agents; the feed surfaces decisions agents
 * need FROM the user.
 *
 * Layout: <feedDir>/<blockId>.json
 *   Each file is one open block -- a question the agent asked. One block per
 *   session: a new AskUserQuestion in the same session replaces the previous
 *   block (an agent can only ask one question at a time). Removed when the
 *   session advances past the block.
 *
 * A block carries enough identity (sessionId, mailboxId, host, runtime) for
 * `agents feed` to aggregate across hosts and for `agents message` to route
 * a reply back to the right agent.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getFeedDir, getUserAgentsDir } from './state.js';

export interface BlockOption {
  label: string;
  description?: string;
}

export interface BlockQuestion {
  text: string;
  header?: string;
  options?: BlockOption[];
  multiSelect?: boolean;
}

export interface OpenBlock {
  blockId: string;
  sessionId: string;
  mailboxId: string;
  host: string;
  runtime: string;
  ts: string;
  questions: BlockQuestion[];
  ticket?: string;
  pr?: string;
}

/**
 * Stable block id for a session. One block per session -- a new question
 * replaces the previous one (the agent can only ask one question at a time).
 */
export function blockIdForSession(sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, '-');
  return `block-${safeSessionId}`;
}

function blockPath(root: string, blockId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(blockId)) {
    throw new Error(`Invalid feed block id: ${blockId}`);
  }
  return path.join(root, `${blockId}.json`);
}

/** Atomic write a block record to the feed store. */
export function publishBlock(block: OpenBlock, root?: string): void {
  const dir = root ?? getFeedDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = blockPath(dir, block.blockId);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(block, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

/** Read all block records. Returns them sorted by stable block filename. */
export function listBlocks(root?: string): OpenBlock[] {
  const dir = root ?? getFeedDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const blocks: OpenBlock[] = [];
  for (const name of names.filter(n => n.endsWith('.json')).sort()) {
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<OpenBlock>;
      if (parsed.blockId && parsed.sessionId && parsed.questions?.length) {
        blocks.push(parsed as OpenBlock);
      }
    } catch {
      // skip corrupt / partial files
    }
  }
  return blocks;
}

/** Remove a block record. Returns true if the file was deleted. */
export function removeBlock(blockId: string, root?: string): boolean {
  const dir = root ?? getFeedDir();
  try {
    fs.unlinkSync(blockPath(dir, blockId));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hook installation
// ---------------------------------------------------------------------------

/**
 * The feed-publish PreToolUse hook script (Python, mirroring 09-mailbox-inject.py).
 * Embedded so it ships with the compiled CLI and can be installed to the
 * CLI-writable user hooks dir without a separate file in the npm tarball.
 */
export const FEED_PUBLISH_HOOK_SCRIPT = `#!/usr/bin/env python3
"""PreToolUse hook: publish an open-block record when the agent calls
AskUserQuestion, so \`agents feed\` can aggregate pending decisions.

Outbound counterpart to the inbound mailbox-inject hook. Fires only on
AskUserQuestion (matcher-gated in agents.yaml). Writes one block per session
to ~/.agents/.history/feed/. A new question replaces the previous block.

Sub-agent gate: when the PreToolUse payload carries \`agent_type\`, this is a
Task/Agent subagent -- skip. Only the top-level agent publishes. Verified on
Claude Code 2.1.170 (2026-07).

Fail-open: ANY error is swallowed so a feed hiccup never blocks a tool call.
"""
import os
import sys
import json
import re
import socket
import tempfile
from datetime import datetime, timezone


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        return

    # Sub-agent gate.
    if payload.get("agent_type"):
        return

    tool_input = payload.get("tool_input", {})
    questions = tool_input.get("questions", [])
    if not questions:
        return

    session_id = payload.get("session_id", "")
    if not session_id:
        return

    normalized_questions = []
    for q in questions:
        if not isinstance(q, dict):
            continue
        question = {
            "text": q.get("question", q.get("header", "")),
            "header": q.get("header"),
            "multiSelect": q.get("multiSelect", False),
        }
        raw_opts = q.get("options", [])
        if raw_opts:
            question["options"] = [
                {"label": o.get("label", ""), "description": o.get("description")}
                for o in raw_opts
                if isinstance(o, dict)
            ]
        normalized_questions.append(question)
    if not normalized_questions:
        return

    # Identity from env (set by agents-cli at spawn).
    mailbox_id = os.path.basename(
        os.environ.get("AGENTS_MAILBOX_DIR", "").rstrip("/")
    ) or session_id

    hostname = os.environ.get("AGENTS_SYNC_MACHINE_ID") or socket.gethostname()
    host = hostname.split(".")[0].strip().lower()
    host = re.sub(r"[^a-z0-9_-]", "-", host) or "unknown"

    runtime = os.environ.get("AGENTS_RUNTIME", "headless")

    safe_session_id = re.sub(r"[^A-Za-z0-9._-]", "-", session_id)
    block_id = f"block-{safe_session_id}"
    block = {
        "blockId": block_id,
        "sessionId": session_id,
        "mailboxId": mailbox_id,
        "host": host,
        "runtime": runtime,
        "ts": datetime.now(timezone.utc).isoformat(),
        "questions": normalized_questions,
    }

    # Python's expanduser() ignores HOME on Windows, while agents-cli honors a
    # HOME override on every platform. Use the same anchor so hooks and the CLI
    # always read/write one feed store (including temp-home and sandbox runs).
    home = os.environ.get("HOME") or os.path.expanduser("~")
    feed_dir = os.path.join(home, ".agents", ".history", "feed")
    os.makedirs(feed_dir, exist_ok=True)

    target = os.path.join(feed_dir, f"{block_id}.json")
    fd, tmp = tempfile.mkstemp(dir=feed_dir, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(block, f, indent=2)
        os.rename(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # fail open
`;

/** Manifest entry for the feed-publish hook, matching the ManifestHook shape. */
export const FEED_PUBLISH_HOOK_MANIFEST = {
  name: 'feed-publish',
  events: ['PreToolUse'],
  matcher: 'AskUserQuestion',
  script: '10-feed-publish.py',
  timeout: 5,
};

/**
 * Install the feed-publish hook script into the user hooks dir and add its
 * manifest entry to the user agents.yaml. The system repo is an auto-pulled,
 * read-only mirror, so runtime-managed hooks must never write there.
 * Idempotent -- skips if the script is already present and up to date.
 */
export function ensureFeedPublishHook(userAgentsDir: string = getUserAgentsDir()): { installed: boolean; error?: string } {
  try {
    const hooksDir = path.join(userAgentsDir, 'hooks');
    const scriptPath = path.join(hooksDir, '10-feed-publish.py');

    fs.mkdirSync(hooksDir, { recursive: true });
    let installed = false;
    if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, 'utf-8') !== FEED_PUBLISH_HOOK_SCRIPT) {
      const tmpScript = `${scriptPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpScript, FEED_PUBLISH_HOOK_SCRIPT, { mode: 0o755 });
      fs.renameSync(tmpScript, scriptPath);
      installed = true;
    }

    const agentsYamlPath = path.join(userAgentsDir, 'agents.yaml');
    const yamlDoc = fs.existsSync(agentsYamlPath)
      ? yaml.parseDocument(fs.readFileSync(agentsYamlPath, 'utf-8'))
      : new yaml.Document({});
    if (yamlDoc.errors.length > 0) {
      throw new Error(`Cannot install feed hook: ${agentsYamlPath} is invalid YAML`);
    }
    if (!yamlDoc.getIn(['hooks', 'feed-publish'])) {
      yamlDoc.setIn(['hooks', 'feed-publish'], {
        agents: ['claude'],
        events: ['PreToolUse'],
        matcher: 'AskUserQuestion',
        script: '10-feed-publish.py',
        timeout: 5,
      });
      const tmpYaml = `${agentsYamlPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpYaml, String(yamlDoc));
      fs.renameSync(tmpYaml, agentsYamlPath);
      installed = true;
    }

    return { installed };
  } catch (err) {
    return { installed: false, error: (err as Error).message };
  }
}
