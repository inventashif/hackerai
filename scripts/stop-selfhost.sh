#!/usr/bin/env bash
set -euo pipefail
echo "Stopping HackerAI self-host stack..."
docker compose -f docker-compose.prod.yml --profile local-convex --profile sandbox down "$@"
echo "Stopped."
