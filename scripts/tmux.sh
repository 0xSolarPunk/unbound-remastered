#!/bin/sh
# Run Unbound Remastered + Tailscale (userspace mode) in a detached tmux session.
# Each window auto-restarts its process if it exits. Attach with: tmux attach -t ubr
# Restart the web server after code changes: tmux respawn-window -k -t ubr:web
set -e
cd "$(dirname "$0")/.."
PORT="${PORT:-8777}"
case "$PORT" in ''|*[!0-9]*) echo "PORT must be a number" >&2; exit 1;; esac
tmux has-session -t ubr 2>/dev/null && { echo "tmux session 'ubr' already running"; exit 0; }
mkdir -p /var/lib/tailscale /var/run/tailscale
tmux new-session -d -s ubr -n tailscale \
  "while true; do tailscaled --tun=userspace-networking --statedir=/var/lib/tailscale --socket=/var/run/tailscale/tailscaled.sock; sleep 3; done"
tmux new-window -t ubr -n web "while true; do HOST=127.0.0.1 SECURE_COOKIES=1 PORT=$PORT node server.js; echo 'server exited, restarting…'; sleep 2; done"
sleep 4
tailscale serve --bg "$PORT" >/dev/null 2>&1 || true
tailscale serve status
