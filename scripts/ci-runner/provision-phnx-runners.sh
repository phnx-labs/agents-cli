#!/usr/bin/env bash
# Fresh-install two persistent phnx-labs org runner instances on ci-runner-fsn1.
# Usage: REG_TOKEN=<org registration token> bash provision-phnx-runners.sh
set -euo pipefail

: "${REG_TOKEN:?REG_TOKEN (org registration token for phnx-labs) must be set}"

URL=$(curl -sf https://api.github.com/repos/actions/runner/releases/latest \
  | python3 -c "import sys,json; r=json.load(sys.stdin); print([a['browser_download_url'] for a in r['assets'] if 'linux-x64' in a['name']][0])")
echo "runner tarball: $URL"

for i in 1 2; do
  D="/opt/actions-runner-phnx-$i"
  rm -rf "$D"
  mkdir -p "$D"
  curl -sfL "$URL" | tar -xz -C "$D"
  chown -R runner:runner "$D"
  (cd "$D" && sudo -u runner ./config.sh \
    --url "https://github.com/phnx-labs" \
    --token "$REG_TOKEN" \
    --name "ci-runner-fsn1-phnx-$i" \
    --labels "self-hosted,linux,x64,crabbox-ci,tailnet" \
    --runnergroup "crabbox-ci" \
    --work "_work" \
    --unattended \
    --replace)
done

cat > /etc/systemd/system/runner-phnx@.service <<'UNIT'
[Unit]
Description=GitHub Actions persistent runner (phnx-labs org) %i
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=runner
Group=runner
WorkingDirectory=/opt/actions-runner-phnx-%i
ExecStart=/opt/actions-runner-phnx-%i/run.sh
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now runner-phnx@1 runner-phnx@2
sleep 8
systemctl --no-pager status runner-phnx@1 runner-phnx@2 2>&1 | grep -E '●|Active:' || true
echo "provision-phnx-done"
