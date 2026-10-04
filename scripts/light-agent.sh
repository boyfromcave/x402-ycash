#!/usr/bin/env bash
# Start the Rust light client as an agent's whole shielded wallet: `x402-light serve` against a
# lightwalletd, the spending key imported, and the URL the agent and CLI take as
# AGENT_SAPLING_BUILDER / --sapling-builder (README "Private agents").
#
#   scripts/light-agent.sh start --data DIR --lwd ADDR [--network regtest|testnet|mainnet]
#                                [--params DIR] [--birthday H] [--listen 127.0.0.1:0] [--sync-every S]
#   scripts/light-agent.sh stop  --data DIR
#
# The key is read from X402_LIGHT_KEY or from the file named by X402_LIGHT_KEY_FILE (a
# `secret-extended-key-…` from z_exportkey, or a BIP-39 phrase), never from the command line. It is
# imported once (x402-light keeps it as DIR/spending.key, mode 0600); later starts reuse it.
# `start` returns once the server is listening and the key is in, printing
#   AGENT_SAPLING_BUILDER=http://127.0.0.1:PORT
# The server runs in the background (log DIR/serve.log, pid DIR/serve.pid) until `stop`.
#
# Binary: X402_LIGHT_BIN, else $CARGO_TARGET_DIR (or light/target)/release/x402-light, else PATH.
set -euo pipefail

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
[ $# -ge 1 ] || usage
action=$1; shift
data="" lwd="" network=regtest params="" birthday="" listen=127.0.0.1:0 sync_every=15
while [ $# -gt 0 ]; do
  case $1 in
    --data) data=$2; shift 2 ;;
    --lwd) lwd=$2; shift 2 ;;
    --network) network=$2; shift 2 ;;
    --params) params=$2; shift 2 ;;
    --birthday) birthday=$2; shift 2 ;;
    --listen) listen=$2; shift 2 ;;
    --sync-every) sync_every=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$data" ] || usage

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
pidfile=$data/serve.pid log=$data/serve.log

case $action in
  stop)
    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      kill "$(cat "$pidfile")"
      echo "stopped x402-light ($(cat "$pidfile"))"
    else
      echo "no x402-light running for $data"
    fi
    rm -f "$pidfile"
    exit 0
    ;;
  start) ;;
  *) usage ;;
esac

[ -n "$lwd" ] || usage
bin=${X402_LIGHT_BIN:-${CARGO_TARGET_DIR:-$here/light/target}/release/x402-light}
[ -x "$bin" ] || bin=$(command -v x402-light || true)
[ -n "$bin" ] && [ -x "$bin" ] || { echo "no x402-light binary: build light/ (cargo build --release) or set X402_LIGHT_BIN" >&2; exit 1; }
if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  echo "x402-light already running for $data (pid $(cat "$pidfile"))" >&2; exit 1
fi
if [ -z "$params" ]; then
  for d in "$HOME/.zcash-params" "$HOME/Library/Application Support/ZcashParams"; do
    [ -f "$d/sapling-spend.params" ] && { params=$d; break; }
  done
fi

mkdir -p "$data"
args=(serve --data "$data" --lwd "$lwd" --network "$network" --listen "$listen" --sync-every "$sync_every")
[ -n "$params" ] && args+=(--params "$params")
: > "$log"
"$bin" "${args[@]}" >> "$log" 2>&1 &
echo $! > "$pidfile"

# The server prints "listening 127.0.0.1:PORT" once bound.
url=""
for _ in $(seq 1 100); do
  kill -0 "$(cat "$pidfile")" 2>/dev/null || { echo "x402-light exited:" >&2; tail -20 "$log" >&2; rm -f "$pidfile"; exit 1; }
  addr=$(sed -n 's/^listening \(.*\)$/\1/p' "$log" | head -1)
  [ -n "$addr" ] && { url=http://$addr; break; }
  sleep 0.1
done
[ -n "$url" ] || { echo "x402-light did not start listening; see $log" >&2; exit 1; }

rpc() { curl -fsS -X POST -H 'content-type: application/json' --data "$1" "$url"; }

key=${X402_LIGHT_KEY:-}
[ -z "$key" ] && [ -n "${X402_LIGHT_KEY_FILE:-}" ] && key=$(tr -d '\n' < "$X402_LIGHT_KEY_FILE")
if [ -n "$key" ] && [ ! -f "$data/spending.key" ]; then
  # JSON-escape the key through python-free means: keys and phrases are [a-z0-9 -] only.
  case $key in *[!a-z0-9\ -]*) echo "X402_LIGHT_KEY has unexpected characters" >&2; exit 1 ;; esac
  params_json="{\"key\":\"$key\"${birthday:+,\"birthday\":$birthday}}"
  reply=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"import_key\",\"params\":$params_json}")
  case $reply in *'"error"'*) echo "import_key failed: $reply" >&2; exit 1 ;; esac
  echo "imported: $(printf '%s' "$reply" | sed -n 's/.*"address":"\([^"]*\)".*/\1/p')" >&2
elif [ ! -f "$data/spending.key" ]; then
  echo "warning: no key imported (set X402_LIGHT_KEY or X402_LIGHT_KEY_FILE)" >&2
fi
echo "AGENT_SAPLING_BUILDER=$url"
