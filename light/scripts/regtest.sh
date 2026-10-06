#!/usr/bin/env bash
# Run the light client's regtest integration test against a Yellowback devnet of one node line.
#
#   light/scripts/regtest.sh {dd|6} <seed> [lwd-port]
#
# Brings the devnet up (scripts/devnet.sh of this repo), builds lightwalletd-dd at its branch head
# into $X402_SCRATCH/lightwalletd (GetChainInfo needs 0b3448e+) and starts it with --yellowback on
# lwd-port (default 9067 + seed), runs `cargo test --release -- --ignored` with the environment
# tests/regtest.rs reads, and tears everything down. Set KEEP=1 to leave the devnet running.
# X402_LIGHT_UPGRADES (e.g. vault=103) reaches every `x402-light once` the test runs.
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: $0 {dd|6} <seed> [lwd-port]" >&2; exit 2; }
line=$1 seed=$2 port=${3:-$((9067 + seed))}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)        # light/
repo=$(dirname "$here")                                        # the x402-ycash checkout
workspace=${YELLOWBACK_WORKSPACE:-$(dirname "$repo")}
[ "$(basename "$workspace")" = wt ] && workspace=$(dirname "$workspace")
export X402_SCRATCH=${X402_SCRATCH:-$workspace/wt/scratch/x402}
python=${PYTHON:-$workspace/.venv/bin/python}
# YCASH_DD / YCASH6 select another node tree (scripts/devnet.sh and tests/regtest.rs read them too). On
# an upgrade/vault tree, whose devnet activates Vault itself, set X402_LIGHT_UPGRADES=vault=<h> too.
case $line in dd) noderepo=${YCASH_DD:-$workspace/ycash-dd}; binvar=BITCOIND ;; 6) noderepo=${YCASH6:-$workspace/ycash6}; binvar=ZCASHD ;; *) exit 2 ;; esac
devnet_cli=$noderepo/contrib/yellowback/devnet/yellowback-devnet
lwd_bin=${X402_LIGHT_LWD_BIN:-$X402_SCRATCH/lightwalletd}

if [ ! -x "$lwd_bin" ]; then
  echo "building lightwalletd-dd at $(git -C "$workspace/lightwalletd-dd" rev-parse --short HEAD) into $lwd_bin"
  (cd "$workspace/lightwalletd-dd" && CGO_ENABLED=0 go build -mod=vendor -o "$lwd_bin" .)
fi

export YELLOWBACK_DEVNET_DIR=$X402_SCRATCH/$line-$seed YELLOWBACK_DEVNET_PORTSEED=$seed
export "$binvar=$noderepo/src/ycashd"
down() {
  [ "${KEEP:-0}" = 1 ] && { echo "KEEP=1: devnet left running in $YELLOWBACK_DEVNET_DIR (lightwalletd on $port)"; return; }
  "$python" "$devnet_cli" lightwalletd stop || true
  "$repo/scripts/devnet.sh" down "$line" "$seed" || true
}
trap down EXIT

"$repo/scripts/devnet.sh" up "$line" "$seed"
"$python" "$devnet_cli" lightwalletd start --port "$port" --bin "$lwd_bin" --extra=--yellowback

export X402_LIGHT_LINE=$line X402_LIGHT_SEED=$seed X402_LIGHT_LWD=127.0.0.1:$port
export X402_LIGHT_PARAMS=${X402_LIGHT_PARAMS:-$HOME/.zcash-params}
cd "$here"
# One test at a time (they share node 0's wallet); X402_LIGHT_TEST=<name> runs one of them.
cargo test --release --test regtest -- --ignored --nocapture --test-threads=1 ${X402_LIGHT_TEST:-}
