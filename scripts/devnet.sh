#!/usr/bin/env bash
# Run a vault-upgrade regtest devnet of either node line for the x402 devnet suite.
#
#   scripts/devnet.sh {up|down|status} {dd|6} <seed>
#   scripts/devnet.sh cli {dd|6} <seed> [--node N] -- <rpc> [args…]   (e.g. -- getnewaddress)
#
# dd = the v4.5.0 line (ycash-dd, BITCOIND), 6 = the 6.21.0 line (ycash6, ZCASHD). The node tree must
# be built from upgrade/vault: its devnet activates the vault upgrade (branch ID 6d5b7a31) at the
# framework's activation height on every node and creates the YED attestor set, so the suite signs
# for the Vault branch. The devnet is the light five-node form (`up --no-attest --lean --no-viz`):
# node 0 the funded wallet (-insightexplorer -txindex), node 1 without the attestor set, nodes 2-4
# pools. Its devnet.json lands in $X402_SCRATCH/<line>-<seed>/; point X402_DEVNET_JSON at it to run
# `npm run test:devnet`.
#
# Environment: YELLOWBACK_WORKSPACE (default: found from this script's location), X402_SCRATCH
# (default: $YELLOWBACK_WORKSPACE/wt/scratch/x402), PYTHON (default: the workspace .venv), YCASH_DD /
# YCASH6 (the built node tree; default the workspace's ycash-dd / ycash6, which are NOT necessarily
# on upgrade/vault: point these at an upgrade/vault tree, e.g. an integration worktree under wt/).
# The script warns when the tree's devnet does not activate the vault upgrade.
set -euo pipefail

usage() {
  echo "usage: $0 {up|down|status} {dd|6} <seed>  |  $0 cli {dd|6} <seed> [--node N] -- <rpc> [args…]" >&2
  echo "  needs a node tree built from upgrade/vault: set YCASH_DD (dd) or YCASH6 (6) to it;" >&2
  echo "  the defaults, <workspace>/ycash-dd and <workspace>/ycash6, may be on another branch" >&2
  exit 2
}
[ $# -ge 3 ] || usage
action=$1 line=$2 seed=$3
shift 3
case $action in up|down|status) [ $# -eq 0 ] || usage ;; cli) ;; *) usage ;; esac
[[ $seed =~ ^[0-9]+$ ]] || usage

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workspace=${YELLOWBACK_WORKSPACE:-$(dirname "$here")}
# A worktree sits at <workspace>/wt/<name>: step out of wt/.
[ "$(basename "$workspace")" = wt ] && workspace=$(dirname "$workspace")

case $line in
  dd) repo=${YCASH_DD:-$workspace/ycash-dd}; binvar=BITCOIND ;;
  6)  repo=${YCASH6:-$workspace/ycash6};      binvar=ZCASHD ;;
  *)  usage ;;
esac
cli=$repo/contrib/yellowback/devnet/yellowback-devnet
[ -x "$repo/src/ycashd" ] || { echo "no ycashd at $repo/src/ycashd; build $line first" >&2; exit 1; }
[ -f "$cli" ] || { echo "no devnet CLI at $cli" >&2; exit 1; }
grep -qs '^VAULT_ACTIVATION' "$repo/qa/rpc-tests/test_framework/yellowback_util.py" ||
  echo "warning: $repo is not an upgrade/vault tree (its devnet does not activate the vault upgrade); set YCASH_DD / YCASH6" >&2

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
  cli)    [ -f "$dir/devnet.json" ] || { echo "no devnet in $dir" >&2; exit 1; }; "$python" "$cli" cli "$@" ;;
esac
