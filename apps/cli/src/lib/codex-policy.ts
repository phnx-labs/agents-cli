import { getUserAgentsDir } from './state.js';
import { codexDefaultWritableRoots } from './permissions.js';

export type CodexPolicyMode = 'plan' | 'edit' | 'skip';

export const CODEX_PLAN_PROFILE = 'agents-plan';
export const CODEX_EDIT_PROFILE = 'agents-edit';

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function codexEditWritableRoots(): string[] {
  return unique([getUserAgentsDir(), ...codexDefaultWritableRoots()]);
}

function inlineWorkspaceRoots(roots: string[]): string {
  return roots.map((root) => `${JSON.stringify(root)} = true`).join(', ');
}

export function codexPermissionProfileConfig(
  mode: Exclude<CodexPolicyMode, 'skip'>,
  writableRoots: string[] = codexEditWritableRoots(),
): string {
  const parent = mode === 'plan' ? ':read-only' : ':workspace';
  const roots = mode === 'edit'
    ? `, workspace_roots = { ${inlineWorkspaceRoots(unique(writableRoots))} }`
    : '';
  return `{ extends = ${JSON.stringify(parent)}${roots}, network = { enabled = true, allow_local_binding = true } }`;
}

/**
 * Canonical Codex safety policy used by every native launch path.
 *
 * Config overrides are deliberately used instead of the legacy `--sandbox`
 * flags: named permission profiles are the only Codex surface that can keep a
 * plan run filesystem-read-only while independently enabling network access.
 */
export function codexPolicyArgs(
  mode: CodexPolicyMode,
  writableRoots: string[] = codexEditWritableRoots(),
): string[] {
  if (mode === 'skip') return ['--dangerously-bypass-approvals-and-sandbox'];

  const profile = mode === 'plan' ? CODEX_PLAN_PROFILE : CODEX_EDIT_PROFILE;
  return [
    '-c',
    'approval_policy="on-request"',
    '-c',
    `default_permissions=${JSON.stringify(profile)}`,
    '-c',
    `permissions.${profile}=${codexPermissionProfileConfig(mode, writableRoots)}`,
  ];
}
