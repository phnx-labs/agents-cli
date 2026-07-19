/**
 * Serialize the live environment into a `fleet:` manifest.
 *
 * `captureFleet` is PURE — it takes the previous manifest plus already-gathered
 * inputs (device names, per-device agent specs, browser profiles, secret-bundle
 * names, routine names) and returns the new manifest. All I/O (registry read,
 * `agents secrets`/`routines` enumeration, YAML write) happens in the command
 * (`commands/fleet-capture.ts`); keeping this pure makes the privacy contract —
 * NAMES ONLY, never IPs/usernames — trivially unit-testable.
 *
 * Additive by design: it merges OVER an existing manifest and never clobbers a
 * hand-authored per-device override (`agents:` you set by hand wins over a
 * captured one). The captured roster reflects live state, so it becomes the
 * source of truth for WHICH devices exist.
 */

import type {
  FleetManifest,
  FleetDefaults,
  FleetDeviceOverride,
} from './types.js';

export interface CaptureInputs {
  /** Registered, non-control device names to record (the roster — names only). */
  devices: string[];
  /** Optional per-device agent specs (e.g. from `--from-pins`), keyed by name. */
  agentsByDevice?: Record<string, string[]>;
  /** Fleet defaults to seed when the manifest has none (source's own agents). */
  defaults?: FleetDefaults;
  /** Secrets-bundle NAMES to ensure exist (values stay in the keychain). */
  secretsBundles?: string[];
  /** Routine NAMES that should be active on the fleet. */
  routines?: string[];
}

/**
 * Build the new `fleet:` manifest from the previous one and captured inputs.
 * Pure — no SSH, no filesystem, no registry. The returned object carries device
 * names + desired state only; a caller that serializes it to YAML can assert no
 * address/username ever appears.
 */
export function captureFleet(prev: FleetManifest | undefined, inputs: CaptureInputs): FleetManifest {
  const prevDevices = prev && prev.devices !== 'all' && typeof prev.devices === 'object'
    ? prev.devices
    : {};

  // Roster: explicit map of the captured names. A hand-authored override for a
  // device that still exists is preserved; a captured agent list only fills in
  // when the manifest didn't already pin one for that device.
  const devices: Record<string, FleetDeviceOverride> = {};
  for (const name of inputs.devices) {
    const prevOverride = prevDevices[name] ?? {};
    const override: FleetDeviceOverride = { ...prevOverride };
    const captured = inputs.agentsByDevice?.[name];
    if (override.agents === undefined && captured && captured.length > 0) {
      override.agents = captured;
    }
    devices[name] = override;
  }

  const manifest: FleetManifest = {
    // Keep hand-authored defaults; otherwise seed from the source snapshot.
    defaults: prev?.defaults ?? inputs.defaults ?? {},
    devices,
  };

  const bundles = inputs.secretsBundles ?? prev?.secrets?.bundles;
  if (bundles && bundles.length > 0) manifest.secrets = { bundles: [...bundles].sort() };

  const routines = inputs.routines ?? prev?.routines;
  if (routines && routines.length > 0) manifest.routines = [...routines].sort();

  return manifest;
}
