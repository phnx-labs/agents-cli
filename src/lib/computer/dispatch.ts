// Verb dispatcher for the `computer run` loop.
//
// Maps a loop VerbCall (CLI-verb name + friendly input) onto the EXISTING
// computer-helper RPC methods over the daemon socket. It reimplements no verb —
// it names the same RPC methods the explicit `agents computer <verb>` commands
// call, so the external-agent verb surface is untouched. The daemon stays the
// single authority on permissions and targeting.

import type { ComputerClient } from '../computer-rpc.js';
import { resolveTargetPidDecision, type AppInfo } from '../../commands/computer-actions.js';
import type { VerbCall, VerbResult, VerbDispatcher } from './loop.js';

// CLI verb -> daemon RPC method. Only the rename cases need listing; the rest
// pass through by name.
const RPC_METHOD: Record<string, string> = {
  apps: 'list_apps',
  'get-text': 'get_text',
  'type-text': 'type_text',
  'ax-action': 'ax_action',
  'right-click': 'right_click',
  launch: 'launch_app',
  focus: 'set_focus',
  raise: 'focus_window',
};

// Verbs that do not need a resolved target pid.
const NO_TARGET = new Set(['apps', 'launch']);

function rpcMethodFor(verb: string): string {
  return RPC_METHOD[verb] ?? verb;
}

// Translate the model's friendly input keys into the daemon's param names.
// pid is injected by the caller after target resolution.
function toRpcParams(verb: string, input: Record<string, unknown>, pid?: number): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (pid != null) p.pid = pid;

  const copyIf = (from: string, to: string) => {
    if (input[from] != null) p[to] = input[from];
  };

  switch (verb) {
    case 'describe':
      copyIf('depth', 'max_depth');
      break;
    case 'screenshot':
      copyIf('quality', 'quality');
      break;
    case 'get-text':
      copyIf('id', 'element_id');
      copyIf('maxChars', 'max_chars');
      break;
    case 'click':
    case 'right-click':
    case 'scroll':
      copyIf('id', 'element_id');
      copyIf('x', 'x');
      copyIf('y', 'y');
      copyIf('count', 'count');
      copyIf('dx', 'dx');
      copyIf('dy', 'dy');
      break;
    case 'type':
      copyIf('id', 'element_id');
      copyIf('x', 'x');
      copyIf('y', 'y');
      copyIf('text', 'text');
      copyIf('commit', 'commit');
      break;
    case 'type-text':
      copyIf('text', 'text');
      copyIf('commit', 'commit');
      break;
    case 'key':
      copyIf('keys', 'keys');
      break;
    case 'ax-action':
      copyIf('id', 'element_id');
      copyIf('action', 'action');
      break;
    case 'focus':
      copyIf('id', 'element_id');
      break;
    case 'launch':
      copyIf('bundle', 'bundle_id');
      copyIf('path', 'path');
      copyIf('name', 'name');
      break;
    case 'wait': {
      if (input.duration != null) p.duration_ms = input.duration;
      copyIf('id', 'element_id');
      copyIf('until', 'until');
      const locator: Record<string, unknown> = {};
      for (const k of ['role', 'label', 'identifier'] as const) {
        if (input[k] != null) locator[k] = input[k];
      }
      if (Object.keys(locator).length > 0) p.locator = locator;
      break;
    }
    default:
      break;
  }
  return p;
}

// Build a dispatcher bound to a live client. Every call is a single daemon
// round-trip; errors are returned (never thrown) so the loop can feed them
// back to the model as a tool_result.
export function makeVerbDispatcher(client: ComputerClient): VerbDispatcher {
  return async (call: VerbCall): Promise<VerbResult> => {
    const verb = call.name;
    const input = call.input ?? {};

    let pid: number | undefined;
    if (!NO_TARGET.has(verb) && !(verb === 'wait' && input.duration != null)) {
      const resolved = await resolveTargetPidDecision(
        client,
        { pid: input.pid as number | undefined, bundle: input.bundle as string | undefined },
      );
      if (!resolved.ok) return { ok: false, error: resolved.error };
      pid = resolved.pid;
    }

    const method = rpcMethodFor(verb);
    const params = toRpcParams(verb, input, pid);
    const res = await client.call(method, params);
    if (res.error) return { ok: false, error: `${res.error.code}: ${res.error.message}` };
    return { ok: true, result: res.result ?? {} };
  };
}

// Exposed for tests/diagnostics.
export { rpcMethodFor, toRpcParams };
export type { AppInfo };
