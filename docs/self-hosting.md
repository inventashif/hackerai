# HackerAI Self-Hosting (Agentic Sandbox)

One-command Docker setup for local agentic pentesting. The web app and the Kali sandbox share volumes so you have full access to your reports and data via the File Explorer side panel.

## Quick Start

```bash
git clone https://github.com/your-org/hackerai.git
cd hackerai
./scripts/setup-selfhost.sh              # local Convex (default)
# or
CONVEX_URL=https://your-convex.cloud ./scripts/setup-selfhost.sh --mode cloud
```

Open http://localhost:3000

## What Runs

| Service | Image | Port |
|---------|-------|------|
| web | Next.js (docker/Dockerfile.web) | 3000 |
| convex | ghcr.io/get-convex/convex-backend | 3210 |
| centrifugo | centrifugo/centrifugo:v5 | 8000 |
| sandbox (optional) | Kali (docker/Dockerfile) | — |

Sandbox is behind `--profile sandbox` so you can run `web + convex + centrifugo` without it, then add it:

```bash
docker compose -f docker-compose.prod.yml --profile sandbox up -d sandbox
```

## Volumes

- `workspace:/home/user/workspace` — your project, browsable via app File Explorer
- `reports:/home/user/reports` — agent-generated reports
- `data:/home/user/data` — persistent tool output

Mount your own directory by editing `docker-compose.prod.yml`:

```yaml
volumes:
  - /home/you/bugbounty:/home/user/workspace:rw
```

## Configuration

`scripts/setup-selfhost.sh` creates `.env.selfhost` from `docker/env.example` and generates:

- `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY`, `CENTRIFUGO_API_KEY`
- `.personal/jwt-private.pem` + `.personal/jwt-public.pem` (via `scripts/personal-setup.mjs`)

Edit `.env.selfhost`:

- `OPENCODE_ZEN_API_KEY` — free models
- `KIRO_GATEWAY_API_KEY` — Kiro models via the local Kiro Gateway (see below)
- `CONVEX_URL` — for `--mode cloud`

## File Explorer

Agent and your uploaded files are staged into the sandbox workspace. Browse them in the app via the **Files** button in the chat toolbar (right Sheet). PDFs open in a new tab; text previews inline; download available.

API: `GET /api/sandbox/files?path=/home/user/workspace`, `GET /api/sandbox/file?path=...`

## Stop / Clean

```bash
./scripts/stop-selfhost.sh              # stop
./scripts/stop-selfhost.sh -v           # stop + remove volumes
docker compose -f docker-compose.prod.yml --profile local-convex --profile sandbox logs -f
```

## Troubleshooting

- `port 3000 in use` — change `ports: ["3000:3000"]` in compose file
- Centrifugo not connecting — check `.env.selfhost` secrets match `docker/centrifugo/config.json` template
- Convex local health — `wget -qO- http://localhost:3210/health`
