/**
 * Windows secret storage via Windows Credential Manager (wincred).
 *
 * Primary backend: the Credential Manager `advapi32` API (CredReadW /
 * CredWriteW / CredDeleteW / CredEnumerateW), reached through a static
 * PowerShell script that P/Invokes the C# shim below. PowerShell (Windows
 * PowerShell 5.1) ships with every supported Windows, so there is no separate
 * install step. Items are stored as CRED_TYPE_GENERIC with
 * CRED_PERSIST_LOCAL_MACHINE — device-local, matching the biometry-bound model
 * on macOS (src/lib/secrets/index.ts).
 *
 * Zero injection surface: the PS script is a single STATIC constant. All
 * dynamic data rides in the child ENV (target name, list prefix) or STDIN (the
 * secret value) — nothing is string-interpolated into the script. The child is
 * spawned with a spawnSync ARGV ARRAY (`-EncodedCommand <base64>`), never a
 * shell string.
 *
 * Headless fallback: when Credential Manager is unreachable (no logon session —
 * ERROR_NO_SUCH_LOGON_SESSION 1312 — or powershell.exe missing from PATH), we
 * transparently switch to the AES-256-GCM encrypted-file store in
 * ./filestore.ts, exactly like the Linux locked-collection fallback. The
 * decision is cached per process; one stderr line is emitted the first time.
 *
 * Item names are stored VERBATIM as the credential TargetName
 * (`agents-cli.bundles.<name>` / `agents-cli.secrets.<bundle>.<key>` — the
 * scheme shared with the file store, see ./filestore.ts) so `list` returns item
 * names directly.
 */

import { spawnSync } from 'child_process';
import type { KeychainBackend } from './index.js';
import { encodePwshBase64 } from '../pwsh.js';
import {
  fileStore,
  fileDir,
  fileStoreHasItems,
  machinePassphraseExists,
  _resetFileStoreForTest,
} from './filestore.js';
import {
  noteNativeShadow,
  _resetFallbackNoticeForTest,
  type NativeImportReport,
  type NativeImportResult,
} from './fallback.js';

// Re-exported so importers (and tests) can keep reaching these via './windows.js'.
export {
  encryptForFallback,
  decryptForFallback,
  fileBackend,
  type EncFile,
} from './filestore.js';

const POWERSHELL = 'powershell.exe';

/**
 * CRED_MAX_CREDENTIAL_BLOB_SIZE — Credential Manager rejects a generic
 * credential blob larger than 2560 bytes with an opaque CredWrite failure. We
 * guard against it in `set` with a clear message. Only pathologically large
 * bundle metadata could hit this; such an item should live in a file-backed
 * bundle (AGENTS_SECRETS_PASSPHRASE) instead.
 */
export const CRED_MAX_CREDENTIAL_BLOB_SIZE = 2560;

/**
 * The static PowerShell driver. Dispatches on $env:AGENTS_CRED_OP; reads the
 * target name from $env:AGENTS_CRED_TARGET, the list prefix from
 * $env:AGENTS_CRED_PREFIX, and (for `set`) the raw secret value from stdin.
 * Nothing dynamic is interpolated into this string.
 *
 * Exit codes: 0 = success, 3 = clean "not found", 1 = error (message on stderr,
 * carrying the Win32 code so the Node side can detect an unavailable store).
 * `get` emits the blob as base64 (dodges PowerShell CRLF/encoding corruption);
 * `list` prints one target name per line.
 */
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
# Output must not depend on the console codepage: a windowsHide child owns a
# fresh hidden console whose codepage is the OEM default (cp437), not the
# terminal's UTF-8 — the Node side always decodes stdout/stderr as UTF-8.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class AgentsCred {
    const uint CRED_TYPE_GENERIC = 1;
    const uint CRED_PERSIST_LOCAL_MACHINE = 2;
    const int ERROR_NOT_FOUND = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredReadW(string target, uint type, uint flags, out IntPtr cred);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredWriteW(ref CREDENTIAL cred, uint flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredDeleteW(string target, uint type, uint flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredEnumerateW(string filter, uint flags, out uint count, out IntPtr creds);
    [DllImport("advapi32.dll", SetLastError = false)]
    static extern void CredFree(IntPtr buffer);

    public static bool Has(string target) {
        IntPtr p;
        if (CredReadW(target, CRED_TYPE_GENERIC, 0, out p)) { CredFree(p); return true; }
        int err = Marshal.GetLastWin32Error();
        if (err == ERROR_NOT_FOUND) return false;
        throw new Exception("CredMan error " + err);
    }

    public static byte[] Get(string target) {
        IntPtr p;
        if (!CredReadW(target, CRED_TYPE_GENERIC, 0, out p)) {
            int err = Marshal.GetLastWin32Error();
            if (err == ERROR_NOT_FOUND) throw new Exception("NOTFOUND");
            throw new Exception("CredMan error " + err);
        }
        try {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            byte[] blob = new byte[cred.CredentialBlobSize];
            if (cred.CredentialBlobSize > 0)
                Marshal.Copy(cred.CredentialBlob, blob, 0, (int)cred.CredentialBlobSize);
            return blob;
        } finally { CredFree(p); }
    }

    public static void Set(string target, byte[] blob) {
        CREDENTIAL cred = new CREDENTIAL();
        cred.Type = CRED_TYPE_GENERIC;
        cred.TargetName = Marshal.StringToCoTaskMemUni(target);
        cred.CredentialBlobSize = (uint)blob.Length;
        cred.CredentialBlob = (blob.Length > 0) ? Marshal.AllocCoTaskMem(blob.Length) : IntPtr.Zero;
        if (blob.Length > 0) Marshal.Copy(blob, 0, cred.CredentialBlob, blob.Length);
        cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
        cred.UserName = Marshal.StringToCoTaskMemUni(Environment.UserName);
        try {
            if (!CredWriteW(ref cred, 0)) {
                int err = Marshal.GetLastWin32Error();
                throw new Exception("CredMan error " + err);
            }
        } finally {
            Marshal.FreeCoTaskMem(cred.TargetName);
            if (cred.CredentialBlob != IntPtr.Zero) Marshal.FreeCoTaskMem(cred.CredentialBlob);
            Marshal.FreeCoTaskMem(cred.UserName);
        }
    }

    public static bool Delete(string target) {
        if (CredDeleteW(target, CRED_TYPE_GENERIC, 0)) return true;
        int err = Marshal.GetLastWin32Error();
        if (err == ERROR_NOT_FOUND) return false;
        throw new Exception("CredMan error " + err);
    }

    public static List<string> List(string filter) {
        uint count;
        IntPtr credsPtr;
        List<string> results = new List<string>();
        string f = string.IsNullOrEmpty(filter) ? null : filter;
        if (!CredEnumerateW(f, 0, out count, out credsPtr)) {
            int err = Marshal.GetLastWin32Error();
            if (err == ERROR_NOT_FOUND) return results;
            throw new Exception("CredMan error " + err);
        }
        try {
            for (int i = 0; i < count; i++) {
                IntPtr credPtr = Marshal.ReadIntPtr(credsPtr, i * IntPtr.Size);
                CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
                if (cred.TargetName != IntPtr.Zero)
                    results.Add(Marshal.PtrToStringUni(cred.TargetName));
            }
        } finally { CredFree(credsPtr); }
        return results;
    }
}
'@

try {
    $op = $env:AGENTS_CRED_OP
    $target = $env:AGENTS_CRED_TARGET
    switch ($op) {
        'has' {
            if ([AgentsCred]::Has($target)) { exit 0 } else { exit 3 }
        }
        'get' {
            $blob = [AgentsCred]::Get($target)
            [Console]::Out.Write([Convert]::ToBase64String($blob))
            exit 0
        }
        'set' {
            # Raw bytes, not [Console]::In text — text decoding runs through the
            # console codepage and corrupts non-ASCII UTF-8 from the Node side.
            $stdin = [Console]::OpenStandardInput()
            $ms = New-Object System.IO.MemoryStream
            $stdin.CopyTo($ms)
            [AgentsCred]::Set($target, $ms.ToArray())
            exit 0
        }
        'delete' {
            if ([AgentsCred]::Delete($target)) { exit 0 } else { exit 3 }
        }
        'list' {
            $prefix = $env:AGENTS_CRED_PREFIX
            $filter = ''
            if (-not [string]::IsNullOrEmpty($prefix)) { $filter = $prefix + '*' }
            foreach ($n in [AgentsCred]::List($filter)) { [Console]::Out.WriteLine($n) }
            exit 0
        }
        default {
            [Console]::Error.Write('unknown op: ' + $op)
            exit 1
        }
    }
} catch {
    $m = $_.Exception.Message
    if ($m -match 'NOTFOUND') { exit 3 }
    [Console]::Error.Write($m)
    exit 1
}
`;

const ENCODED_SCRIPT = encodePwshBase64(PS_SCRIPT);

// ---------- spawn ----------

interface CredResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** True when powershell.exe could not be spawned at all (ENOENT etc.). */
  spawnError: boolean;
}

function runCred(
  op: 'has' | 'get' | 'set' | 'delete' | 'list',
  opts: { target?: string; prefix?: string; input?: string },
): CredResult {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTS_CRED_OP: op };
  if (opts.target !== undefined) env.AGENTS_CRED_TARGET = opts.target;
  if (opts.prefix !== undefined) env.AGENTS_CRED_PREFIX = opts.prefix;
  // ARGV ARRAY — never a shell string. -EncodedCommand rides base64 of the
  // UTF-16LE script with zero escaping hazards.
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT], {
    env,
    input: opts.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    // Never flash a console window when the caller has no console of its own
    // (the scheduler daemon resolves bundles through here every sync cycle).
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
    spawnError: !!result.error,
  };
}

// ---------- powershell availability ----------

function powershellAvailable(): boolean {
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

let checkedAvailability = false;
let isAvailable = false;

// ---------- file fallback state ----------

let useFileFallback = false;
let warnedFallback = false;
// Set once Credential Manager is observed unreachable in this process, so the
// read-through in get/has stops re-probing it (and re-emitting notices).
let nativeUnreachable = false;

function activateFileFallback(): void {
  if (useFileFallback) return;
  useFileFallback = true;
  if (!warnedFallback) {
    warnedFallback = true;
    process.stderr.write(
      `[agents] using the encrypted file store at ${fileDir()}\n`
    );
  }
}

/**
 * Credential Manager is "unavailable" (as opposed to a plain not-found or a
 * malformed item) when there's no logon session to hold credentials
 * (ERROR_NO_SUCH_LOGON_SESSION 1312 — common under a service account / SSH
 * session with no interactive logon) or powershell.exe can't be spawned at all.
 * Those cases route to the encrypted-file fallback, exactly like the Linux
 * locked-collection error.
 */
function isCredManUnavailableError(r: CredResult): boolean {
  if (r.spawnError) return true; // powershell.exe not found
  return /\b1312\b/.test(r.stderr) || /NO_SUCH_LOGON_SESSION/i.test(r.stderr);
}

/**
 * Decide which backend a given op should use. Activates the file fallback if a
 * previous run already committed to it (encrypted items on disk), or if
 * powershell.exe is missing and a passphrase source exists (explicit
 * AGENTS_SECRETS_PASSPHRASE, a provisioned machine-local key, or a headless
 * context). The disk-items check makes the fallback persistent across the many
 * short-lived `agents secrets ...` Node processes.
 */
function preflight(): 'file' | 'credman' {
  if (useFileFallback) return 'file';
  if (fileStoreHasItems()) {
    activateFileFallback();
    return 'file';
  }
  if (!checkedAvailability) {
    isAvailable = powershellAvailable();
    checkedAvailability = true;
  }
  if (!isAvailable) {
    if (process.env.AGENTS_SECRETS_PASSPHRASE || machinePassphraseExists() || !process.stdin.isTTY) {
      activateFileFallback();
      return 'file';
    }
    throw new Error(
      'powershell.exe not found on PATH; cannot reach Windows Credential Manager.\n' +
      'Set AGENTS_SECRETS_PASSPHRASE to use the encrypted-file fallback.'
    );
  }
  return 'credman';
}

/**
 * True when secret operations currently route to the encrypted-file store
 * instead of Windows Credential Manager. Mirrors linux.ts:usesFileFallback so
 * `listBundles()` doesn't double-count file-backed bundles under the fallback.
 */
export function usesFileFallback(): boolean {
  try {
    return preflight() === 'file';
  } catch {
    return false;
  }
}

// ---------- Credential Manager ops with fallback ----------

export function hasCredManToken(item: string): boolean {
  if (preflight() === 'file') {
    if (fileStore.has(item)) return true;
    // Read through to Credential Manager so an item that predates the fallback
    // isn't silently shadowed by the file store.
    const probe = readNativeCredItemRaw(item);
    if (probe.value !== undefined) { noteNativeShadow('shadowed', fileDir()); return true; }
    if (probe.unavailable) noteNativeShadow('locked', fileDir());
    return false;
  }
  const r = runCred('has', { target: item });
  if (r.status === 0) return true;
  if (r.status === 3) return false;
  if (isCredManUnavailableError(r)) {
    nativeUnreachable = true;
    activateFileFallback();
    return fileStore.has(item);
  }
  return false;
}

export function getCredManToken(item: string): string {
  if (preflight() === 'file') {
    if (fileStore.has(item)) return fileStore.get(item);
    const probe = readNativeCredItemRaw(item);
    if (probe.value !== undefined) { noteNativeShadow('shadowed', fileDir()); return probe.value; }
    if (probe.unavailable) noteNativeShadow('locked', fileDir());
    throw new Error(`Secret '${item}' not found in the file store or Credential Manager.`);
  }
  const r = runCred('get', { target: item });
  if (r.status === 0) {
    // stdout is base64 of the raw UTF-8 blob (dodges PowerShell encoding corruption).
    return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
  }
  if (r.status === 3) throw new Error(`Secret '${item}' not found in Credential Manager.`);
  if (isCredManUnavailableError(r)) {
    nativeUnreachable = true;
    activateFileFallback();
    return fileStore.get(item);
  }
  throw new Error(`Failed to read secret '${item}': ${r.stderr.trim() || 'unknown error'}`);
}

export function setCredManToken(item: string, value: string): void {
  if (!value || !value.trim()) throw new Error('Secret value is empty.');
  if (preflight() === 'file') { fileStore.set(item, value); return; }
  const byteLen = Buffer.byteLength(value, 'utf8');
  if (byteLen > CRED_MAX_CREDENTIAL_BLOB_SIZE) {
    throw new Error(
      `Secret '${item}' is ${byteLen} bytes, exceeding the Windows Credential Manager limit of ` +
      `${CRED_MAX_CREDENTIAL_BLOB_SIZE} bytes (CRED_MAX_CREDENTIAL_BLOB_SIZE). ` +
      'Use a file-backed bundle (set AGENTS_SECRETS_PASSPHRASE) for values this large.'
    );
  }
  const r = runCred('set', { target: item, input: value });
  if (r.status === 0) return;
  if (isCredManUnavailableError(r)) {
    nativeUnreachable = true;
    activateFileFallback();
    fileStore.set(item, value);
    return;
  }
  throw new Error(`Failed to store secret '${item}': ${r.stderr.trim() || 'unknown error'}`);
}

export function deleteCredManToken(item: string): boolean {
  if (preflight() === 'file') return fileStore.delete(item);
  const r = runCred('delete', { target: item });
  if (r.status === 0) return true;
  if (r.status === 3) return false;
  if (isCredManUnavailableError(r)) {
    nativeUnreachable = true;
    activateFileFallback();
    return fileStore.delete(item);
  }
  return false;
}

export function listCredManItems(prefix: string): string[] {
  if (preflight() === 'file') return fileStore.list(prefix);
  const r = runCred('list', { prefix });
  if (r.status === 0) return parseWindowsCredList(r.stdout, prefix);
  if (isCredManUnavailableError(r)) {
    nativeUnreachable = true;
    activateFileFallback();
    return fileStore.list(prefix);
  }
  return [];
}

/**
 * Parse the target names printed by the `list` op (one per line), keeping only
 * those starting with `prefix` and deduping. Same contract as
 * parseSecretToolItems (linux.ts). Exported for tests.
 */
export function parseWindowsCredList(output: string, prefix: string): string[] {
  const items = output
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => s.startsWith(prefix));
  return [...new Set(items)]; // dedupe
}

// ---------- native-direct helpers (bypass preflight routing) ----------
//
// Always talk to Credential Manager regardless of the file fallback. They power
// (a) the read-through that keeps the file store from shadowing credman items,
// and (b) `import-keyring`.

/**
 * Read one item straight from Credential Manager. `{value}` on hit,
 * `{unavailable:true}` when the store is unreachable, `{}` on a plain miss.
 * Never throws, never emits.
 */
function readNativeCredItemRaw(item: string): { value?: string; unavailable?: boolean } {
  if (nativeUnreachable) return { unavailable: true };
  if (!powershellAvailable()) return {};
  const r = runCred('get', { target: item });
  if (r.status === 0) return { value: Buffer.from(r.stdout.trim(), 'base64').toString('utf8') };
  if (r.status === 3) return {};
  if (isCredManUnavailableError(r)) { nativeUnreachable = true; return { unavailable: true }; }
  return {};
}

/**
 * Enumerate agents-cli credentials under `prefix`. Windows credentials have no
 * service scoping — the target IS the identifier — so we NEVER enumerate with an
 * empty filter (that returns unrelated machine credentials). The filter is
 * floored to the `agents-cli.` namespace; bare items (unprefixed targets) are
 * therefore out of scope for auto-discovery on Windows.
 */
function listNativeCredItemsRaw(prefix: string): { items: string[]; locked: boolean; available: boolean } {
  if (!powershellAvailable()) return { items: [], locked: false, available: false };
  const floor = prefix && prefix.startsWith('agents-cli.') ? prefix : 'agents-cli.';
  const r = runCred('list', { prefix: floor });
  if (r.status === 0) return { items: parseWindowsCredList(r.stdout, floor), locked: false, available: true };
  if (isCredManUnavailableError(r)) { nativeUnreachable = true; return { items: [], locked: true, available: true }; }
  return { items: [], locked: false, available: true };
}

/**
 * Copy agents-cli credentials from Credential Manager into the file store (the
 * `import-keyring` backend for Windows). Requires a reachable store; items
 * already in the file store are left untouched.
 */
export function importNativeCredManItems(prefix: string, commit: boolean): NativeImportReport {
  const { items, locked, available } = listNativeCredItemsRaw(prefix);
  if (!available || locked) return { available, locked, results: [] };
  const results: NativeImportResult[] = [];
  for (const item of items) {
    if (fileStore.has(item)) { results.push({ item, status: 'exists' }); continue; }
    const probe = readNativeCredItemRaw(item);
    if (probe.value === undefined) {
      results.push({ item, status: 'failed', detail: probe.unavailable ? 'credential manager unavailable' : 'unreadable' });
      continue;
    }
    if (commit) fileStore.set(item, probe.value);
    results.push({ item, status: commit ? 'imported' : 'would-import' });
  }
  return { available, locked, results };
}

/**
 * KeychainBackend implementation for Windows. Routes through Windows Credential
 * Manager (via PowerShell P/Invoke) with a transparent encrypted-file fallback
 * when the credential store is unreachable.
 */
export const windowsBackend: KeychainBackend = {
  has(item: string): boolean {
    return hasCredManToken(item);
  },
  get(item: string): string {
    return getCredManToken(item);
  },
  set(item: string, value: string): void {
    setCredManToken(item, value);
  },
  delete(item: string): boolean {
    return deleteCredManToken(item);
  },
  list(prefix: string): string[] {
    return listCredManItems(prefix);
  },
};

/**
 * Test-only: reset module state so independent test cases don't bleed
 * availability / fallback decisions across each other. Pass `forceAvailable` to
 * pin the powershell-availability probe (skips the real spawn); pass `fileDir`
 * to redirect the encrypted-file store to a temp dir. File-store state lives in
 * ./filestore.ts and is reset there.
 */
export function _resetForTest(opts: {
  fileDir?: string | null;
  forceFileFallback?: boolean;
  passphrase?: string | null;
  forceAvailable?: boolean | null;
} = {}): void {
  _resetFileStoreForTest({ fileDir: opts.fileDir ?? null, passphrase: opts.passphrase ?? null });
  useFileFallback = opts.forceFileFallback ?? false;
  warnedFallback = false;
  nativeUnreachable = false;
  _resetFallbackNoticeForTest();
  if (opts.forceAvailable === undefined || opts.forceAvailable === null) {
    checkedAvailability = false;
    isAvailable = false;
  } else {
    checkedAvailability = true;
    isAvailable = opts.forceAvailable;
  }
}
