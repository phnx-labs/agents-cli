import type { DeviceDescriptor } from './types.js';

/**
 * Default viewport for newly-created profiles. Matches Safari's logical
 * resolution on a 14-inch MacBook Pro (M1/M2/M3 Pro/Max) — the most common
 * shape this CLI sees in practice. Shared with the `MacBook Pro` device
 * preset below so both surfaces agree.
 */
export const DEFAULT_VIEWPORT = {
  width: 1512,
  height: 982,
  deviceScaleFactor: 2,
} as const;

export const DEVICES: Record<string, DeviceDescriptor> = {
  'iPhone 14': {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  },
  'iPad': {
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    mobile: true,
  },
  'MacBook Pro': {
    width: DEFAULT_VIEWPORT.width,
    height: DEFAULT_VIEWPORT.height,
    deviceScaleFactor: DEFAULT_VIEWPORT.deviceScaleFactor,
    mobile: false,
  },
};

export function getDevice(name: string): DeviceDescriptor | undefined {
  const key = Object.keys(DEVICES).find(
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  return key ? DEVICES[key] : undefined;
}

export function listDevices(): string[] {
  return Object.keys(DEVICES);
}
