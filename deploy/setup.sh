#!/usr/bin/env bash
#
# Ask Satoshi — one-shot, idempotent setup for AlmaLinux 9 (RHEL-compatible).
#
# What it does (safe to re-run):
#   1. Installs Node.js 22 (NodeSource) and Caddy (official copr) if missing.
#   2. Creates an unprivileged 'asksatoshi' user and the app + index directories.
#   3. Installs dependencies and builds the app (server + client) as that user.
#   4. Installs and starts the systemd unit and the Caddy reverse proxy.
#   5. Opens HTTP/HTTPS in firewalld (only if firewalld is active).
#
# It does NOT touch your API keys: create /opt/ask-satoshi/.env yourself (see the
# runbook) BEFORE the final step, or re-run this script after adding it.
#
# Usage:
#   sudo bash deploy/setup.sh [REPO_URL]
#
#   REPO_URL  Optional. If /opt/ask-satoshi has no code yet, clone from here.
#             For a private repo use a deploy token:
#             https://<TOKEN>@github.com/BMX-Casey94/AskSatoshi.git
#             If the code is already present (e.g. copied via scp), omit it.

set -euo pipefail

APP_DIR=/opt/ask-satoshi
DATA_DIR=/var/lib/ask-satoshi
APP_USER=asksatoshi
SERVICE_NAME=ask-satoshi
REPO_URL="${1:-}"

log() { printf '\033[1;32m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[setup] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo bash deploy/setup.sh)."

# --- 1. Node.js 22 -----------------------------------------------------------
if command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" = "22" ]; then
  log "Node $(node -v) already installed."
else
  log "Installing Node.js 22 via NodeSource…"
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  dnf install -y nodejs
fi
command -v node >/dev/null 2>&1 || die "node not found after install."
log "Node $(node -v) at $(command -v node)"

# --- 2. Caddy ----------------------------------------------------------------
if command -v caddy >/dev/null 2>&1; then
  log "Caddy $(caddy version | awk '{print $1}') already installed."
else
  log "Installing Caddy…"
  dnf install -y 'dnf-command(copr)'
  dnf copr enable @caddy/caddy -y
  dnf install -y caddy
fi

# --- 3. App user + directories ----------------------------------------------
if id "$APP_USER" >/dev/null 2>&1; then
  log "User '$APP_USER' already exists."
else
  log "Creating unprivileged user '$APP_USER'…"
  useradd --system --shell /sbin/nologin --home-dir "$APP_DIR" "$APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"

# --- 4. Application code -----------------------------------------------------
if [ -f "$APP_DIR/package.json" ]; then
  log "Code already present at $APP_DIR."
  if [ -d "$APP_DIR/.git" ]; then
    log "Pulling latest…"
    sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only || warn "git pull failed; continuing with existing code."
  fi
elif [ -n "$REPO_URL" ]; then
  log "Cloning $REPO_URL into $APP_DIR…"
  git clone "$REPO_URL" "$APP_DIR"
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
else
  die "No code at $APP_DIR and no REPO_URL given. Clone the repo there or pass its URL."
fi

# --- 5. Dependencies + build (as the app user) -------------------------------
# Ensure the app user owns the tree regardless of how the code arrived (git clone as
# root, or scp) — otherwise the build below cannot write node_modules/dist.
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
log "Installing dependencies (npm workspaces)…"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm install"
log "Building server + client…"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm run build"

# The MCP child needs the bsv-aio-mcp server build. Verify it landed (a clean Linux
# install pulls the complete tarball; this catches a partial/hoisted copy).
MCP_ENTRY="$APP_DIR/server/node_modules/bsv-aio-mcp/server/dist/index.mjs"
[ -f "$MCP_ENTRY" ] || MCP_ENTRY="$APP_DIR/node_modules/bsv-aio-mcp/server/dist/index.mjs"
if [ -f "$MCP_ENTRY" ]; then
  log "MCP entry found: $MCP_ENTRY"
else
  warn "MCP entry not found — technical answers will fall back to the corpus."
fi

# --- 6. Environment file -----------------------------------------------------
if [ -f "$APP_DIR/.env" ]; then
  # 0640 root:asksatoshi — systemd (root) injects it via EnvironmentFile, and the app
  # (group asksatoshi) can also read it via dotenv. Not world-readable.
  chmod 640 "$APP_DIR/.env"
  chown root:"$APP_USER" "$APP_DIR/.env"
  log ".env present (permissions tightened to 0640 root:$APP_USER)."
else
  warn ".env NOT found at $APP_DIR/.env — the service will start with no API keys."
  warn "Create it (see deploy/RUNBOOK.md) then: sudo systemctl restart $SERVICE_NAME"
fi

# --- 7. systemd unit ---------------------------------------------------------
log "Installing systemd unit…"
install -m 0644 "$APP_DIR/deploy/ask-satoshi.service" "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
# enable --now only starts a stopped unit; a rebuild must replace the running process.
systemctl restart "$SERVICE_NAME"

# --- 8. Caddy reverse proxy --------------------------------------------------
# This VPS may already serve other sites from Caddy. Never overwrite an existing
# Caddyfile — append our site block (with a timestamped backup) so other sites keep
# working. Caddy supports multiple site blocks in one file.
CADDY_MAIN=/etc/caddy/Caddyfile
if [ -f "$CADDY_MAIN" ] && grep -q 'ask-satoshi' "$CADDY_MAIN" 2>/dev/null; then
  log "Caddyfile already has an ask-satoshi block."
elif [ -f "$CADDY_MAIN" ]; then
  warn "Existing Caddyfile found — appending the ask-satoshi site block."
  warn "Backup at $CADDY_MAIN.bak.$(date +%Y%m%d%H%M%S). Edit the domain if you have not."
  cp -a "$CADDY_MAIN" "$CADDY_MAIN.bak.$(date +%Y%m%d%H%M%S)"
  printf '\n' >> "$CADDY_MAIN"
  cat "$APP_DIR/deploy/Caddyfile" >> "$CADDY_MAIN"
else
  log "Installing Caddyfile (edit the domain first if you have not)…"
  install -m 0644 "$APP_DIR/deploy/Caddyfile" "$CADDY_MAIN"
fi
systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy

# --- 9. Firewall (only if firewalld is in use) -------------------------------
if systemctl is-active --quiet firewalld; then
  log "Opening HTTP/HTTPS in firewalld…"
  firewall-cmd --permanent --add-service=http >/dev/null
  firewall-cmd --permanent --add-service=https >/dev/null
  firewall-cmd --reload
else
  log "firewalld not active — ensure ports 80/443 are open in your provider's firewall."
fi

log "Done. Status:"
systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,12p' || true
log "Health check (expect mcp:true once the child has built its index):"
log "  curl -s http://127.0.0.1:8787/api/health"
log "Logs:  journalctl -u $SERVICE_NAME -f"
