/**
 * Concrete Dispatcher for auto-dispatch — runs a ticket through agents-cli's own
 * cloud-provider abstraction (`resolveProvider().dispatch()`), the same layer as
 * `agents cloud run`. Rush (Prix) is one provider among rush/codex/factory; a
 * project pins its provider via `provider` in projects.json, else the delegate
 * agent's native cloud is used. This is what removes the hidden Prix coupling —
 * auto-dispatch no longer depends on the prix/api webhook.
 */

import { resolveProvider } from './cloud/registry.js';
import type { Dispatcher } from './auto-dispatch.js';

export function createProviderDispatcher(): Dispatcher {
  return {
    async dispatch({ agent, prompt, repo, provider }) {
      const p = resolveProvider(provider, agent);
      const caps = p.capabilities();
      if (!caps.available) {
        throw new Error(`cloud provider '${p.id}' is not available (auth/binary missing)`);
      }
      if (!caps.dispatch) {
        throw new Error(`cloud provider '${p.id}' does not support dispatch`);
      }
      const task = await p.dispatch({ agent, prompt, repo });
      return { id: task.id };
    },
  };
}
