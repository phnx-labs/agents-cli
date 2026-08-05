- **Daemon usage refresh is a fixed 5-minute per-host schedule, concurrency-safe, and Touch-ID-free.**
  Each machine's daemon still owns its own usage cache (no fleet-wide store). Account live
  fetches are now scheduled every **5 minutes** (was adaptive 90s–15m), with a 60s wake to
  notice due accounts after backoff ends. Cache writes use a file lock + atomic rename so a
  concurrent `agents view` background refresh cannot tear or drop rows. The daemon path
  loads Claude credentials with **`fileOnly`** (setup-token / no-ACL cache / `.credentials.json`
  only) and never opens the ACL-bound macOS keychain item, so a background tick cannot pop
  Touch ID. Refresh still skips a provider under 429 backoff and still never rotates
  single-use Claude refresh tokens.
