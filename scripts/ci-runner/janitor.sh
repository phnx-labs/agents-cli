#!/usr/bin/env bash
# janitor.sh — daily hygiene for ci-runner-fsn1 (runs on-box via root cron).
# Keeps the standing CI box from accumulating state: docker cruft, stale
# runner workdirs, logs, packages. Never touches runner registration state.
set -uo pipefail

log() { echo "[$(date -u +%FT%TZ)] $*"; }

# 1. Docker: dangling images/containers/build cache older than 24h.
if command -v docker >/dev/null; then
  docker system prune -af --filter "until=24h" >/dev/null 2>&1 && log "docker pruned"
fi

# 2. Runner workdirs: delete job workspaces older than 7 days (runners clean
#    per-job, but killed jobs leak). Only inside _work dirs we own.
for d in /opt/actions-runner-*/_work /opt/actions-runner-phnx-*/_work; do
  [ -d "$d" ] || continue
  find "$d" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null
done
log "workdirs swept"

# 3. Logs: journald capped at 500M.
journalctl --vacuum-size=500M >/dev/null 2>&1 && log "journal vacuumed"

# 4. Packages: security updates + autoremove (unattended-upgrades handles the
#    patching; this clears the residue).
apt-get autoremove -y >/dev/null 2>&1 && log "apt autoremoved"

# 5. Report disk.
df -h / | tail -1 | awk '{print "[janitor] disk: "$3" used of "$2" ("$5")"}'
