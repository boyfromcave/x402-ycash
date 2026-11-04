#!/usr/bin/env bash
# The kogany leg (workspace kogany plan W9-c; report-only): the x402 verifier and the RPC wallet
# signer against a regtest kogany node (the third node line) and its ycash6 test rig.
#
#   scripts/kogany-leg.sh
#
# scripts/kogany-rig.py starts kogany (koganyd --features ycash) and a ycash6 sidecar `connect=`
# kogany, which holds the wallet and mines past the Vault activation (the YED module live on both
# with one attestor set id), then `vitest` runs packages/ycash/test/devnet/kogany.devnet.test.ts
# with X402_KOGANY_JSON pointing at the rig's devnet.json. The rig goes down on exit.
#
# Environment: KOGANYD (kogany's koganyd: kogany's koganyd-bin artifact), YCASHD (ycash6's ycashd:
# ycash6's node-bin), KOGANY_RIG_DIR (default: a temporary directory), PYTHON (default: python3).
# `npm ci` first. Exit: vitest's status.
set -euo pipefail
# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PYTHON:-python3}"
# ZAKURAD: the variable's name before kogany's daemon became koganyd (kogany dd834da8b).
KOGANYD="${KOGANYD:-${ZAKURAD:-}}"
: "${KOGANYD:?KOGANYD: kogany koganyd (--features ycash)}"
: "${YCASHD:?YCASHD: ycash6 ycashd}"
DIR="${KOGANY_RIG_DIR:-$(mktemp -d)/rig}"
rig() { "$PY" "$ROOT/scripts/kogany-rig.py" --dir "$DIR" "$@"; }
trap 'rig down || true' EXIT
rig up --koganyd "$KOGANYD" --ycashd "$YCASHD"
cd "$ROOT/packages/ycash"
X402_KOGANY_JSON="$DIR/devnet.json" npx vitest run test/devnet/kogany.devnet.test.ts \
  --no-file-parallelism --testTimeout=600000 --hookTimeout=300000
