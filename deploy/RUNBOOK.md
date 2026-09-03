# Deploying Ask Satoshi to your VPS (AlmaLinux 9)

This runs the whole app — Express API, built client, and the BSV-AIO-MCP knowledge
child — as one persistent Node process behind Caddy (automatic HTTPS). Unlike
serverless, the MCP child connects once at boot and stays warm, so technical
questions (BRCs, Teranode, Script) always reach the knowledge server.

## Prerequisites

- Root (or sudo) SSH access to the VPS.
- A domain whose DNS **A/AAAA record points at the VPS IP** (needed for HTTPS).
- Your API keys (Gemini, Groq, optionally OpenRouter).

## 1. Point DNS at the VPS

Create an `A` record for your domain (e.g. `ask-satoshi.example.com`) → your VPS's
public IP. Caddy cannot issue a certificate until DNS resolves.

## 2. Get the code onto the VPS

Either clone (public repo):

```bash
git clone https://github.com/BMX-Casey94/AskSatoshi.git /opt/ask-satoshi
```

or, for a private repo, use a deploy token / scp the project to `/opt/ask-satoshi`.

## 3. Create the environment file

```bash
cp /opt/ask-satoshi/.env.example /opt/ask-satoshi/.env
nano /opt/ask-satoshi/.env
```

Set:

```
GEMINI_API_KEY=…
GROQ_API_KEY=…
OPENROUTER_API_KEY=…        # optional third tier
PORT=8787
HOST=127.0.0.1              # app is only reachable via Caddy
ALLOWED_ORIGIN=https://ask-satoshi.example.com
TRUST_PROXY=1               # behind Caddy
BSV_AIO_DB_PATH=/var/lib/ask-satoshi/knowledge.sqlite
# Paid TTS is optional and self-disables when these are unset:
RESEMBLE_API_KEY=…          # Resemble AI API key
RESEMBLE_VOICE_UUID=…       # voice to synthesise with
# RESEMBLE_PROJECT_UUID=…   # optional Resemble project
TREASURY_WIF=…              # fresh treasury key; never a personal wallet
TTS_ADMIN_TOKEN=…           # Bearer token for POST /api/tts/admin/enable
# TTS_MAX_CHARS=12000
# TTS_MIN_BALANCE_USD=0.25
# BSV_USD_FALLBACK=15
```

## 4. Edit the domain in the Caddyfile

```bash
nano /opt/ask-satoshi/deploy/Caddyfile
# replace ask-satoshi.example.com with your domain
```

## 5. Run the setup script

```bash
sudo bash /opt/ask-satoshi/deploy/setup.sh
```

It installs Node 22 and Caddy, creates the `asksatoshi` user, builds the app,
installs the systemd unit and Caddyfile, and opens the firewall. Idempotent — safe
to re-run.

## 6. Verify

```bash
# Service up?
systemctl status ask-satoshi

# MCP child connected? (may take a minute on first boot while the index builds)
curl -s http://127.0.0.1:8787/api/health
# → {"ok":true,"mcp":true,"corpus":true,"mcpError":null}

# Public HTTPS?
curl -s https://ask-satoshi.example.com/api/health
```

Then open `https://ask-satoshi.example.com` and ask a technical question (e.g.
"What can you tell me about BRC-100?") — it should now answer from the spec corpus.

## Updating

```bash
cd /opt/ask-satoshi
sudo bash deploy/setup.sh      # pulls latest, rebuilds, restarts
```

## Useful commands

```bash
journalctl -u ask-satoshi -f   # live app logs
systemctl restart ask-satoshi  # restart the app
systemctl reload caddy         # after editing the Caddyfile
```

## Notes

- The MCP index lives at `BSV_AIO_DB_PATH` (`/var/lib/ask-satoshi/knowledge.sqlite`),
  so it persists across reboots. First boot builds it (a minute or two); later boots
  are warm.
- The app binds `127.0.0.1`, so port 8787 is not exposed publicly — all traffic
  enters through Caddy's TLS.
- The service runs as the unprivileged `asksatoshi` user with systemd hardening
  (no privilege escalation, private /tmp, read-only system/home except the index dir).
