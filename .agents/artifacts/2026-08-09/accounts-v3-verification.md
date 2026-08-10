---
kind: report
title: Unified accounts verification
---

# Unified accounts verification

Audience: agents-cli maintainers and users reviewing RUSH-2470.

## Summary

One provider account is now one prompt-free secret bundle, while harness-native identities remain harness-owned. The installed CLI passed account creation, default selection, inspection, and cross-device sync with schema preservation.

## Findings

## What changed

Provider accounts are now one-to-one `agents secrets` bundles. Harness-native signed-in identities remain in harness-owned version homes. The account catalog presents provider bundles and local native identities as separate sections, while `--fleet` uses the existing stable native-identity aggregation across devices.

Each provider bundle contains `ACCOUNT_ID`, `PROVIDER`, `AUTH_TYPE`, optional `BASE_URL`, and either `API_KEY` or `TOKEN`. Its policy is always `never`. `--account` overrides a configured per-harness default; without either, the existing native/balanced selection remains in control.

## Evidence

## Automated results

The canonical remote test path completed successfully on a clean crabbox:

```text
Test Files  824 passed | 6 skipped (830)
Tests       11397 passed | 109 skipped (11506)
Duration    149.00s
exit        0
```

The latest account/storage/profile/push suites also passed independently after the final fixes: 13 account-registry tests, 8 profile tests, 39 harness tests, 21 push tests, and 47 account/exec command tests. TypeScript, documentation verification, and the generated command index all passed.

## Installed CLI result

The feature was installed through `scripts/install.sh --skip-tests` after the clean remote suite passed. The installed binary reported:

```text
0.0.0-dev.062e2dfbf
```

Creating a disposable OpenRouter account from an existing disposable bundle, setting its Claude default, and inspecting it returned:

```json
{
  "kind": "provider",
  "id": "e651dd62-0806-47af-b336-5ace687ca80d",
  "name": "rush-2470-demo",
  "provider": "openrouter",
  "auth": "api-key",
  "baseUrl": "https://openrouter.ai/api/v1",
  "policy": "never",
  "secretPresent": true
}
```

No credential value appeared in the output.

## Authenticated model result

The final acceptance run used the existing `deepseek` custom harness, not the disposable key. `agents harness view deepseek` resolved it to Claude + `deepseek/deepseek-chat-v3-0324` through OpenRouter with account `legacy-openrouter-45a642fc`. The installed feature then performed a real provider request:

```text
$ agents run deepseek "Reply with exactly: ACCOUNT_E2E_OK" --mode plan --timeout 2m
[agents] using the encrypted file store at /home/you/.agents/.cache/secrets
Resolved custom harness 'deepseek' -> claude
[agents] strategy balanced ignored: custom harness pins its own version/auth
Running: claude@2.1.219 --permission-mode plan --print ...
ACCOUNT_E2E_OK
exit 0
```

This confirms the account resolver supplied a valid OpenRouter credential to a real DeepSeek request. It also exercises the profile-isolation fix: the profile's declared account won instead of a native Claude default.

## Cross-device result

The installed CLI copied that disposable account to `yosemite-s0`:

```text
rush-2470-demo synced to yosemite-s0 (5 keys, file backend, policy never).
```

Remote inspection confirmed the intended schema survived transport:

```text
backend=file · policy=never · revealed=false
API_KEY=keychain/stored
ACCOUNT_ID=literal
PROVIDER=literal
AUTH_TYPE=literal
BASE_URL=literal
```

This run caught and fixed two real integration bugs before merge: the global host router initially intercepted `accounts sync --device`, and dotenv transport initially converted safe account metadata literals into secret references.

## Screenshots

The rendered report was opened on the interactive Mac and reviewed at full resolution:

![Rendered account verification report](https://share.agents-cli.sh/muqsitnawaz/account-core-best-accounts-review-c2c71df6c12ffe10)

## Security result

- Provider values remain inside the configured secrets backend.
- Account bundle metadata is safe to enumerate; values are stored separately.
- Account bundles use `policy: never`, which writes macOS values without a biometry ACL.
- Linux workers use the encrypted file backend with a machine-local key; Windows uses Credential Manager.
- Harness-native auth is discovered only; account sync does not copy it.
