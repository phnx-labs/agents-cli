/**
 * Shared types for the fleet profile-sync feature (`agents apply` / `ag apply`).
 *
 * `agents.yaml` gains an additive `fleet:` block that declares a *profile*: which
 * agents every device should have installed, which config scopes to reconcile,
 * and whether logins/tokens propagate. `apply` reconciles the live fleet to it.
 *
 * These types are the contract shared by the manifest parser (`manifest.ts`),
 * the reconcile engine (`apply.ts`), the auth propagation (`auth-sync.ts`), and
 * the command (`commands/apply.ts`). Runtime probe/diff shapes live here too so
 * the pure diff can be unit-tested without SSH.
 */

/**
 * How login/token state propagates to a device.
 * - `sync` (default): push portable credentials where possible, surface the rest
 *   as a manual login.
 * - `skip`: probe/report only; take no login action.
 * (A per-agent interactive `prompt` mode is intentionally not offered yet — it
 * was removed rather than accepted as a silent no-op that behaves like `skip`.)
 */
export type FleetLoginMode = 'sync' | 'skip';

/** Defaults applied to every targeted device unless a per-device entry overrides. */
export interface FleetDefaults {
  /** Agent specs to ensure installed, e.g. `['claude@latest', 'codex@latest']`. */
  agents?: string[];
  /** Config sync scopes to reconcile on each device, e.g. `['user']`. */
  sync?: string[];
  /** Login propagation strategy. Default `'sync'`. */
  login?: FleetLoginMode;
}

/** Per-device override; any omitted field inherits from `defaults`. */
export interface FleetDeviceOverride {
  agents?: string[];
  sync?: string[];
  login?: FleetLoginMode;
}

/**
 * The `fleet:` block as it appears in `agents.yaml` (or any `-f` file). `devices`
 * is either the literal string `'all'` (every online registered device minus the
 * source machine) or an explicit map of device-name -> override.
 */
export interface FleetManifest {
  defaults?: FleetDefaults;
  devices: 'all' | Record<string, FleetDeviceOverride>;
}

/**
 * A device's desired state after merging defaults with its override and
 * expanding `devices: all`. This is what the reconcile engine drives toward.
 */
export interface DeviceDesired {
  /** Registered device name (from `agents devices`). */
  device: string;
  /** Resolved agent specs to ensure installed. */
  agents: string[];
  /** Config sync scopes. */
  sync: string[];
  /** Login propagation strategy for this device. */
  login: FleetLoginMode;
}

/**
 * What a probe found on one device. Populated from `readyProbe` plus an
 * installed-agents listing; `reachable: false` short-circuits everything else.
 */
export interface DeviceProbe {
  device: string;
  reachable: boolean;
  /** Platform of the device (`linux` | `macos` | `windows`), for login classification. */
  platform?: string;
  /** agents-cli version present on the device (undefined if not installed). */
  cliVersion?: string;
  /** Agent ids currently installed on the device. */
  installedAgents: string[];
  /** Reason string when `reachable` is false or the probe partially failed. */
  note?: string;
}

/** One planned action against a device, in a single reconcile dimension. */
export type FleetActionKind =
  | 'install-cli'
  | 'upgrade-cli'
  | 'add-agent'
  | 'sync-config'
  | 'push-login'
  | 'needs-login';

export interface FleetAction {
  device: string;
  kind: FleetActionKind;
  /** Agent id for agent/login actions; undefined for cli/config actions. */
  agent?: string;
  /** Human, one-line description of the action. */
  detail: string;
}

/**
 * The full reconcile plan: per-device desired vs probed, plus the flat list of
 * actions. Pure output of `diffFleet(desired, probes)` — drives both `--plan`
 * rendering and the confirm prompt.
 */
export interface FleetPlan {
  devices: DeviceDiff[];
  actions: FleetAction[];
}

/** Per-device diff row rendered in the plan matrix. */
export interface DeviceDiff {
  device: string;
  desired: DeviceDesired;
  probe: DeviceProbe;
  actions: FleetAction[];
  /** Agents that must be logged in on the device but can't be propagated
   * (source token is device-bound, e.g. macOS keychain). Surfaced, not faked. */
  loginBlocked: string[];
}

/** A portable auth file captured from a source agent home, ready to propagate. */
export interface AuthFilePayload {
  /** Agent id this file belongs to. */
  agent: string;
  /** Path relative to the agent's config dir (or $HOME), reconstructed on target. */
  rel: string;
  /** File contents, base64. */
  contentB64: string;
  /** POSIX mode to restore (e.g. 0o600 for credentials). */
  mode: number;
}

/** The plaintext we encrypt before shipping auth over the wire. */
export interface AuthBundle {
  /** Schema version for forward-compat. */
  v: 1;
  /** Source machine name the snapshot was taken on. */
  source: string;
  files: AuthFilePayload[];
}

/** Result of classifying one source agent's auth for propagation. */
export interface AuthSnapshotResult {
  files: AuthFilePayload[];
  /** Agent ids whose auth is device-bound (keychain) and cannot be captured. */
  bound: string[];
}
