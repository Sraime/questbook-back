#!/usr/bin/env bash
#
# Build and (re)start the stack on the VPS. Run from /opt/questbook, where the
# repository has been cloned and a .env file created from .env.example.
#
#   ssh -p 2222 debian@<vps> 'cd /opt/questbook && ./deploy/deploy.sh'

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example and fill it in first." >&2
  exit 1
fi

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Building and starting containers"
docker compose up -d --build --remove-orphans

echo "==> Pruning dangling images"
docker image prune -f >/dev/null

echo "==> Status"
docker compose ps

echo
echo "==> Waiting for the API to become healthy"
for _ in $(seq 1 30); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "API is healthy."
    exit 0
  fi
  sleep 2
done

echo "API did not become healthy in time. Recent logs:" >&2
docker compose logs --tail 50 api >&2
exit 1
