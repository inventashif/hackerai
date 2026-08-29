#!/usr/bin/env bash
set -euo pipefail

MODE="local"
SKIP_BUILD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--mode local|cloud] [--skip-build]"
      echo "  --mode local  Run Convex locally (default)"
      echo "  --mode cloud  Use Convex Cloud (requires CONVEX_URL env)"
      exit 0
      ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ "$MODE" != "local" && "$MODE" != "cloud" ]]; then
  echo "Invalid --mode: $MODE (use local or cloud)"; exit 1
fi

# Check deps
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Install Docker first."; exit 1
fi
if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  echo "Docker Compose not found. Install Docker Compose v2."; exit 1
fi

# Generate secrets if missing
GEN_SECRETS=false
if [[ ! -f .env.selfhost ]]; then
  GEN_SECRETS=true
fi

rand_hex() { openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
rand_b64() { openssl rand -base64 24 2>/dev/null | tr -d '\n' || head -c 24 /dev/urandom | base64 | tr -d '\n'; }

if [[ "$GEN_SECRETS" == "true" ]]; then
  echo "Generating .env.selfhost..."
  cp docker/env.example .env.selfhost
  CENTRIFUGO_SECRET=$(rand_hex | cut -c1-32)
  CENTRIFUGO_API=$(rand_hex | cut -c1-32)
  JWT_SECRET=$(rand_b64)
  # Replace placeholders
  sed -i "s/^CENTRIFUGO_TOKEN_HMAC_SECRET_KEY=.*/CENTRIFUGO_TOKEN_HMAC_SECRET_KEY=${CENTRIFUGO_SECRET}/" .env.selfhost
  sed -i "s/^CENTRIFUGO_API_KEY=.*/CENTRIFUGO_API_KEY=${CENTRIFUGO_API}/" .env.selfhost
  # Generate personal JWT keys if missing
  if [[ ! -f .personal/jwt-private.pem ]]; then
    echo "Generating personal JWT keys..."
    mkdir -p .personal
    if command -v node >/dev/null 2>&1; then
      node scripts/personal-setup.mjs --force 2>/dev/null || true
    fi
  fi
  echo ".env.selfhost created. Edit it to set OPENCODE_ZEN_API_KEY and KIRO_API_KEY if needed."
fi

if [[ "$MODE" == "cloud" ]]; then
  if [[ -z "${CONVEX_URL:-}" && -z "$(grep -E '^CONVEX_URL=' .env.selfhost | cut -d= -f2 | tr -d ' ')" ]]; then
    echo "Cloud mode requires CONVEX_URL. Set it in .env.selfhost or env."; exit 1
  fi
  echo "Starting self-host stack in CLOUD mode (web + centrifugo)..."
  docker compose -f docker-compose.prod.yml up -d web centrifugo
else
  echo "Starting self-host stack in LOCAL mode (web + convex + centrifugo)..."
  docker compose -f docker-compose.prod.yml --profile local-convex up -d
fi

echo ""
echo "Waiting for health checks..."
sleep 5
docker compose -f docker-compose.prod.yml ps

echo ""
echo "✓ HackerAI self-host ready"
echo "  Web:        http://localhost:3000"
echo "  Convex:     http://localhost:3210"
echo "  Centrifugo: http://localhost:8000"
echo "  Workspace:  docker volume 'workspace' mounted at /home/user/workspace"
echo "  Reports:    docker volume 'reports' at /home/user/reports"
echo ""
echo "To add sandbox container (agentic tools):"
echo "  docker compose -f docker-compose.prod.yml --profile sandbox up -d sandbox"
echo ""
echo "To stop: ./scripts/stop-selfhost.sh"
