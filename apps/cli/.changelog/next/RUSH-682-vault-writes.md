- **Harden synced vault writes (RUSH-682).** Synced secret mutations now lock the vault across the full read-modify-write cycle and persist through an atomic rename, preventing concurrent CLI processes from losing each other's bundle updates. Source: `apps/cli/src/lib/secrets/vault.ts`.

