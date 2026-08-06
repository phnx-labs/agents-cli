import { spawnSync } from 'child_process';

export interface WindowsSshEnrollment {
  administrator: boolean;
  expectedPath: string;
  configuredPaths: string[];
  fileExists: boolean;
  hasPublicKey: boolean;
  owner: string | null;
  systemFullControl: boolean;
  administratorsFullControl: boolean;
  unexpectedAclPrincipals: string[];
}

export type WindowsSshEnrollmentAudit = { status: WindowsSshEnrollment } | { error: string };

export function diagnoseWindowsSshFailure(stderr: string, timedOut: boolean): string {
  if (timedOut || /connection timed out|operation timed out/i.test(stderr)) {
    return 'Windows SSH unreachable: port 22 did not answer before the timeout';
  }
  if (/host key verification failed|remote host identification has changed/i.test(stderr)) {
    return 'Windows OpenSSH host-key verification failed; verify and re-pin the device host key';
  }
  if (/permission denied.*publickey|permission denied \(publickey/i.test(stderr)) {
    return 'port 22 and OpenSSH are reachable, but the public key was rejected; recover through the Windows console or password-auth profile, then run agents doctor on that box to inspect its effective AuthorizedKeysFile and ACL';
  }
  if (/connection refused/i.test(stderr)) {
    return 'Windows host is reachable but OpenSSH is not listening on port 22';
  }
  return stderr.trim() || 'Windows SSH probe failed';
}

const AUDIT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$administratorSid = 'S-1-5-32-544'
$administrator = @($identity.Groups | Where-Object { $_.Value -eq $administratorSid }).Count -gt 0
$expected = if ($administrator) { Join-Path $env:ProgramData 'ssh\administrators_authorized_keys' } else { Join-Path $env:USERPROFILE '.ssh\authorized_keys' }
$sshd = Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'
$effective = (& $sshd -T -C "user=$env:USERNAME,host=$env:COMPUTERNAME,addr=127.0.0.1" 2>$null | Select-String '^authorizedkeysfile ' | Select-Object -First 1).Line
$configured = if ($effective) { @($effective.Substring('authorizedkeysfile '.Length).Split(' ', [StringSplitOptions]::RemoveEmptyEntries)) } else { @() }
$exists = Test-Path -LiteralPath $expected -PathType Leaf
$acl = if ($exists) { Get-Acl -LiteralPath $expected } else { $null }
$rules = if ($acl) { @($acl.Access | Where-Object AccessControlType -eq Allow) } else { @() }
$full = [Security.AccessControl.FileSystemRights]::FullControl
$system = @($rules | Where-Object { $_.IdentityReference.Value -in @('NT AUTHORITY\SYSTEM', 'S-1-5-18') -and ($_.FileSystemRights -band $full) -eq $full }).Count -gt 0
$admins = @($rules | Where-Object { $_.IdentityReference.Value -in @('BUILTIN\Administrators', 'S-1-5-32-544') -and ($_.FileSystemRights -band $full) -eq $full }).Count -gt 0
$allowed = @('NT AUTHORITY\SYSTEM', 'S-1-5-18', 'BUILTIN\Administrators', 'S-1-5-32-544')
$unexpected = if ($administrator) { @($rules | ForEach-Object { $_.IdentityReference.Value } | Where-Object { $_ -notin $allowed } | Sort-Object -Unique) } else { @() }
$hasKey = $exists -and [bool](Select-String -LiteralPath $expected -Pattern '^\s*(ssh-(rsa|ed25519)|ecdsa-sha2-)' -Quiet)
[ordered]@{ administrator=$administrator; expectedPath=$expected; configuredPaths=$configured; fileExists=$exists; hasPublicKey=$hasKey; owner=if($acl){$acl.Owner}else{$null}; systemFullControl=$system; administratorsFullControl=$admins; unexpectedAclPrincipals=$unexpected } | ConvertTo-Json -Compress
`;

export function parseWindowsSshEnrollment(stdout: string): WindowsSshEnrollment {
  const raw = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string' ? [value] : [];
  if (typeof raw.administrator !== 'boolean' || typeof raw.expectedPath !== 'string') {
    throw new Error('Windows SSH enrollment audit returned an invalid payload');
  }
  return {
    administrator: raw.administrator,
    expectedPath: raw.expectedPath,
    configuredPaths: strings(raw.configuredPaths),
    fileExists: raw.fileExists === true,
    hasPublicKey: raw.hasPublicKey === true,
    owner: typeof raw.owner === 'string' ? raw.owner : null,
    systemFullControl: raw.systemFullControl === true,
    administratorsFullControl: raw.administratorsFullControl === true,
    unexpectedAclPrincipals: strings(raw.unexpectedAclPrincipals),
  };
}

export function auditWindowsSshEnrollment(platform = process.platform): WindowsSshEnrollmentAudit | null {
  if (platform !== 'win32') return null;
  const encoded = Buffer.from(AUDIT_SCRIPT, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0) return { error: (result.stderr || 'audit command failed').trim() };
  try {
    return { status: parseWindowsSshEnrollment(result.stdout) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function windowsSshEnrollmentProblem(audit: WindowsSshEnrollmentAudit): string | null {
  if ('error' in audit) return `Windows OpenSSH enrollment audit failed: ${audit.error}`;
  const status = audit.status;
  const normalize = (path: string): string => path.replace(/\//g, '\\').toLowerCase();
  const expected = normalize(status.expectedPath);
  const effective = status.configuredPaths.map((path) => normalize(path)
    .replace('__programdata__', normalize(process.env.ProgramData ?? 'C:\\ProgramData'))
    .replace(/^\.ssh\\/, `${normalize(process.env.USERPROFILE ?? '')}\\.ssh\\`));
  if (effective.length > 0 && !effective.includes(expected)) {
    return `OpenSSH AuthorizedKeysFile resolves to ${status.configuredPaths.join(', ')}, not ${status.expectedPath}`;
  }
  if (!status.fileExists) return `SSH public-key file missing: ${status.expectedPath}`;
  if (!status.hasPublicKey) return `no public key enrolled in ${status.expectedPath}`;
  if (status.administrator && (!status.systemFullControl || !status.administratorsFullControl)) {
    return `${status.expectedPath} ACL must grant FullControl to SYSTEM and Administrators`;
  }
  if (status.administrator && status.unexpectedAclPrincipals.length > 0) {
    return `${status.expectedPath} ACL grants access to unexpected principals: ${status.unexpectedAclPrincipals.join(', ')}`;
  }
  return null;
}
