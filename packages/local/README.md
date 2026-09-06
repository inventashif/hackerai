# @hackerai/local

HackerAI Local Sandbox Client - Execute commands on your local machine from HackerAI.

## Installation

```bash
npx @hackerai/local@latest --token YOUR_TOKEN
```

Or install globally:

```bash
npm install -g @hackerai/local
hackerai-local --token YOUR_TOKEN
```

## Usage

```bash
npx @hackerai/local@latest --token hsb_abc123
```

Commands run directly on your host OS. The client connects to HackerAI and relays commands in real-time.

## Options

| Option             | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `--token TOKEN`    | Authentication token from HackerAI Settings (required) |
| `--name NAME`      | Optional connection name fallback (default: hostname)  |
| `--convex-url URL` | Override backend URL (for development)                 |
| `--centrifugo-url URL` | Override relay URL — remote machines must use the public `wss://` URL from Settings → Remote Control (localhost only works on the same machine) |
| `--help, -h`       | Show help message                                      |

## Connecting a remote machine

A machine other than the one running HackerAI cannot reach `localhost`. In
HackerAI go to Settings → Remote Control and copy the **Remote machine**
command — it points both `--convex-url` and `--centrifugo-url` at the public
cloudflared callback. Without `--centrifugo-url` the client still recovers by
falling back to the server-provided public relay URL on early failure.

## Getting Your Token

1. Go to [HackerAI Settings](https://hackerai.co/settings)
2. Navigate to the "Agents" tab
3. Click "Generate Token" or copy your existing token

## Security

Commands run directly on your OS without any isolation. Only connect machines you trust and control. The client auto-terminates after 1 hour of inactivity.

## License

MIT
