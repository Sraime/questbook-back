#!/usr/bin/env bash
#
# One-off provisioning of the OVH VPS: Docker, firewall, deploy directory.
# Safe to re-run.
#
#   ssh -p 2222 debian@<vps> 'bash -s' < deploy/provision-vps.sh

set -euo pipefail

APP_DIR=/opt/questbook
SSH_PORT=2222

echo "==> Base packages"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ca-certificates curl gnupg git

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Docker repository"
  . /etc/os-release
  codename="${VERSION_CODENAME}"
  # Docker publishes per-release suites; fall back to the previous stable if
  # this Debian release is too fresh to have its own.
  if ! curl -fsIL "https://download.docker.com/linux/debian/dists/${codename}/Release" >/dev/null 2>&1; then
    echo "    no Docker suite for '${codename}', falling back to bookworm"
    codename=bookworm
  fi

  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg |
    sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian ${codename} stable" |
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

  echo "==> Docker engine"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "==> Docker already installed, skipping"
fi

sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker

echo "==> Firewall"
# SSH first: locking ourselves out of a remote box is unrecoverable.
sudo ufw allow "${SSH_PORT}/tcp" comment 'ssh'
sudo ufw allow 80/tcp comment 'http (caddy, ACME challenge)'
sudo ufw allow 443/tcp comment 'https (caddy)'
sudo ufw --force enable
sudo ufw status verbose

echo "==> Deploy directory"
sudo mkdir -p "${APP_DIR}"
sudo chown "$USER:$USER" "${APP_DIR}"

echo
echo "Provisioning done."
echo "Note: PostgreSQL and the API are never published to the host, they stay on"
echo "the internal Docker network. Only Caddy binds 80/443, so those are the only"
echo "ports the firewall needs beyond SSH."
