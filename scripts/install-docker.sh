#!/usr/bin/env bash
# One-time: install Docker Engine + Compose v2 from Ubuntu's archive (26.04 "resolute";
# Docker's own apt repo may not publish this release yet) and let adam use it without sudo.
set -euo pipefail
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker adam
docker --version
docker compose version
echo "OK — docker installed; adam added to the docker group (use 'sg docker -c ...' until next login)."
