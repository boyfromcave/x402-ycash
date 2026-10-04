#!/usr/bin/env bash
# Run a Yellowback regtest devnet of either node line for the x402 devnet suite.
#
#   scripts/devnet.sh {up|down|status} {dd|6} <seed>
#
# dd = the v4.5.0 line (ycash-dd, BITCOIND), 6 = the 6.21.0 line (ycash6, ZCASHD). The devnet is the
# light five-node form (`up --no-attest --lean --no-viz`): node 0 funded wallet with -yellowback,
# node 1 stock, nodes 2-4 pools. Its devnet.json lands in $X402_SCRATCH/<line>-<seed>/; point
# X402_DEVNET_JSON at it to run `npm run test:devnet`.
#
# Environment: YELLOWBACK_WORKSPACE (default: found from this script's location), X402_SCRATCH
# (default: $YELLOWBACK_WORKSPACE/wt/scratch/x402), PYTHON (default: the workspace .venv).
set -euo pipefail

usage() { echo "usage: $0 {up|down|status} {dd|6} <seed>" >&2; exit 2; }
[ $# -eq 3 ] || usage
action=$1 line=$2 seed=$3
case $action in up|down|status) ;; *) usage ;; esac
[[ $seed =~ ^[0-9]+$ ]] || usage

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workspace=${YELLOWBACK_WORKSPACE:-$(dirname "$here")}
# A worktree sits at <workspace>/wt/<name>: step out of wt/.
[ "$(basename "$workspace")" = wt ] && workspace=$(dirname "$workspace")

case $line in
  dd) repo=$workspace/ycash-dd; binvar=BITCOIND ;;
  6)  repo=$workspace/ycash6;   binvar=ZCASHD ;;
  *)  usage ;;
esac
cli=$repo/contrib/yellowback/devnet/yellowback-devnet
[ -x "$repo/src/ycashd" ] || { echo "no ycashd at $repo/src/ycashd; build $line first" >&2; exit 1; }
[ -f "$cli" ] || { echo "no devnet CLI at $cli" >&2; exit 1; }

python=${PYTHON:-$workspace/.venv/bin/python}
scratch=${X402_SCRATCH:-$workspace/wt/scratch/x402}
dir=$scratch/$line-$seed
mkdir -p "$scratch"

export YELLOWBACK_DEVNET_DIR=$dir YELLOWBACK_DEVNET_PORTSEED=$seed
export "$binvar=$repo/src/ycashd"

case $action in
  up)
    # --force: rebuild a stopped devnet left in the same dir (the CLI refuses a running one).
    "$python" "$cli" up --no-attest --lean --no-viz --force
    echo "X402_DEVNET_JSON=$dir/devnet.json"
    ;;
  down)   [ -f "$dir/devnet.json" ] && "$python" "$cli" down || echo "no devnet in $dir" ;;
  status) [ -f "$dir/devnet.json" ] && "$python" "$cli" status || { echo "no devnet in $dir"; exit 1; } ;;
esac
