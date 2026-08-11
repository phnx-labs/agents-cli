/**
 * `agents artifacts` — the group that owns everything an agent publishes for a
 * human to open: HTML plans, reports, rendered visuals, screenshots.
 *
 * RUSH-2580 nested the former top-level `agents share` here. `artifacts` is the
 * noun, `share` is the action on it, so the surface reads noun-then-action like
 * the rest of the CLI:
 *
 *   agents artifacts share <file>          publish
 *   agents artifacts share list|delete|analytics|join|status|update
 *   agents artifacts setup                 provision (or join) the endpoint
 *
 * The subtree itself lives in commands/share.ts (publish + its subcommands) and
 * commands/artifacts-setup.ts (the provisioning door); this module only assembles
 * the group, so there is one place that says what `agents artifacts` contains.
 */

import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { registerShareCommands, registerUnshareCommand } from './share.js';
import { registerArtifactsSetupCommand } from './artifacts-setup.js';

export function registerArtifactsCommands(program: Command): void {
  const artifactsCmd = program
    .command('artifacts')
    .description('Publish agent-made artifacts (plans, reports, visuals) to your own Cloudflare R2 and get a shareable link (~$0).');

  registerArtifactsSetupCommand(artifactsCmd);
  registerShareCommands(artifactsCmd);

  setHelpSections(artifactsCmd, {
    examples: `
      # One-time: provision your own endpoint (or join a teammate's)
      agents artifacts setup
      agents artifacts share join https://share.agents-cli.sh

      # Publish — auto OG cover, default 30d expiry, shareable link
      agents artifacts share ./out/plan.html

      # What's live in your namespace, and taking one down
      agents artifacts share list
      agents unshare my-plan-a1b2

      # Endpoint health, and pushing a new Worker template to it
      agents artifacts share status
      agents artifacts share update
    `,
    notes: `
  agents artifacts share is the publish action; agents artifacts setup is the
  one-time endpoint provisioning (it runs a wizard on a TTY, and provisions
  directly when you pass --account/--token or run non-interactively).

  agents unshare <targets...> stays a top-level alias of
  agents artifacts share delete.

  Full reference: apps/cli/docs/share.md.
    `,
  });

  // Top-level, deliberately: see registerUnshareCommand in commands/share.ts.
  registerUnshareCommand(program);
}
