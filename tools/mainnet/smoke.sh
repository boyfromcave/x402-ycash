#!/usr/bin/env bash
# X6 smoke test: one YEC `exact` payment and one short YEC channel against a configured merchant
# and facilitator, paid by the x402-ycash CLI. It spends real YEC on mainnet, so it refuses to run
# without --i-understand-this-spends-real-yec and refuses amounts above hard caps. The runbook is
# docs/mainnet-runbook.md.
#
#   tools/mainnet/smoke.sh --network ycash:mainnet --merchant https://merchant.example \
#       [--exact-path /exact/ticker] [--channel-path /channel/search] [--facilitator URL] \
#       [--requests N] [--max-payment-zat N] [--deposit-zat N] [--max-close-fee-zat N] \
#       [--state-dir DIR] [--skip-exact] [--skip-channel] [--dry-run] \
#       --i-understand-this-spends-real-yec
#
# The payer's node and key come from the environment, as the CLI reads them, so no secret is on the
# command line: X402_RPC_URL with X402_RPC_USER + X402_RPC_PASSWORD (or X402_RPC_COOKIE_FILE);
# X402_WIF for a local key (default: the node's wallet pays). On regtest only, X402_DEVNET_JSON
# (+ X402_DEVNET_NODE) may name a devnet's node instead.
#
# --dry-run stops after the read-only checks (node chain, the merchant's offers, the facilitator's
# kinds) and prints what the run would spend.
set -euo pipefail

# Hard caps: no flag raises them. A larger run is a code change someone has to review.
readonly HARD_MAX_PAYMENT_ZAT=1000000   # 0.01 YEC per exact payment / per channel request
readonly HARD_MAX_DEPOSIT_ZAT=10000000  # 0.1 YEC channel deposit
readonly HARD_MAX_CLOSE_FEE_ZAT=10000   # 0.0001 YEC server close fee the channel may lock
readonly HARD_MAX_REQUESTS=50
readonly ACK_FLAG=--i-understand-this-spends-real-yec

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
lib="$here/smoke-lib.mjs"

network="" merchant="" facilitator="" exact_path=/exact/ticker channel_path=/channel/search
requests=5 max_payment=100000 deposit=1000000 max_close_fee=5000 state_dir="" ack=0 dry=0
skip_exact=0 skip_channel=0 funding_timeout=900

usage() { sed -n '2,21p' "$0" >&2; exit 2; }
refuse() { echo "smoke: refused: $*" >&2; exit 2; }
die() { echo "smoke: FAILED: $*" >&2; exit 1; }
need_int() { [[ "$2" =~ ^[1-9][0-9]{0,15}$ ]] || refuse "$1 must be a positive whole number"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --network) network="$2"; shift 2 ;;
    --merchant) merchant="${2%/}"; shift 2 ;;
    --facilitator) facilitator="${2%/}"; shift 2 ;;
    --exact-path) exact_path="$2"; shift 2 ;;
    --channel-path) channel_path="$2"; shift 2 ;;
    --requests) requests="$2"; shift 2 ;;
    --max-payment-zat) max_payment="$2"; shift 2 ;;
    --deposit-zat) deposit="$2"; shift 2 ;;
    --max-close-fee-zat) max_close_fee="$2"; shift 2 ;;
    --funding-timeout) funding_timeout="$2"; shift 2 ;;
    --state-dir) state_dir="$2"; shift 2 ;;
    --skip-exact) skip_exact=1; shift ;;
    --skip-channel) skip_channel=1; shift ;;
    --dry-run) dry=1; shift ;;
    "$ACK_FLAG") ack=1; shift ;;
    -h|--help) usage ;;
    *) echo "smoke: unknown argument $1" >&2; usage ;;
  esac
done

# ---------------------------------------------------------------- refusals before anything runs
[ "$ack" = 1 ] || refuse "this spends real YEC on mainnet; pass $ACK_FLAG to run it"
case "$network" in ycash:mainnet|ycash:testnet|ycash:regtest) ;; *) refuse "--network must be ycash:mainnet, ycash:testnet or ycash:regtest" ;; esac
[ -n "$merchant" ] || refuse "--merchant URL is required"
need_int --requests "$requests"; need_int --max-payment-zat "$max_payment"; need_int --deposit-zat "$deposit"
need_int --max-close-fee-zat "$max_close_fee"; need_int --funding-timeout "$funding_timeout"
[ "$max_payment" -le "$HARD_MAX_PAYMENT_ZAT" ] || refuse "--max-payment-zat $max_payment is above the hard cap $HARD_MAX_PAYMENT_ZAT"
[ "$deposit" -le "$HARD_MAX_DEPOSIT_ZAT" ] || refuse "--deposit-zat $deposit is above the hard cap $HARD_MAX_DEPOSIT_ZAT"
[ "$max_close_fee" -le "$HARD_MAX_CLOSE_FEE_ZAT" ] || refuse "--max-close-fee-zat $max_close_fee is above the hard cap $HARD_MAX_CLOSE_FEE_ZAT"
[ "$requests" -ge 2 ] && [ "$requests" -le "$HARD_MAX_REQUESTS" ] || refuse "--requests must be 2..$HARD_MAX_REQUESTS"
if [ -n "${X402_DEVNET_JSON:-}" ] && [ "$network" != ycash:regtest ]; then
  refuse "X402_DEVNET_JSON names a regtest devnet; unset it for $network"
fi
[ -n "${X402_DEVNET_JSON:-}" ] || [ -n "${X402_RPC_URL:-}" ] || refuse "no node: set X402_RPC_URL (+ X402_RPC_USER/X402_RPC_PASSWORD or X402_RPC_COOKIE_FILE)"
command -v node >/dev/null || refuse "node is required"
[ -d "$repo/node_modules" ] || refuse "run npm install in $repo first"

state_dir="${state_dir:-$HOME/.x402-ycash/smoke-${network#ycash:}}"
mkdir -p "$state_dir"
chmod 700 "$state_dir"
report="$state_dir/report-$(date -u +%Y%m%dT%H%M%SZ).jsonl"

export X402_NETWORK="$network"
export X402_CHANNEL_STORE="$state_dir/channels.json"
export X402_RESERVATIONS="$state_dir/reservations.json"
export X402_MAX_PAYMENT_ZAT="$max_payment"
export X402_MAX_DEPOSIT_ZAT="$deposit"
export X402_MAX_CLOSE_FEE_ZAT="$max_close_fee"

say() { printf '%s\n' "$*" >&2; }
record() { printf '%s\n' "$1" >> "$report"; }
field() { node "$lib" field "$1" "$2"; }
# The CLI, from this checkout; every JSON line it prints is also kept in the report.
cli() {
  local out
  out="$(cd "$repo" && npm start -s -w x402-ycash-cli -- "$@")" || { printf '%s\n' "$out" >> "$report"; printf '%s\n' "$out" >&2; return 1; }
  printf '%s\n' "$out" >> "$report"
  printf '%s\n' "$out"
}

# ---------------------------------------------------------------- read-only checks
say "== preflight ($network, state in $state_dir)"
chain_json="$(node "$lib" chain)"
record "{\"step\":\"chain\",\"node\":$chain_json}"
chain="$(field "$chain_json" chain)"
case "$network:$chain" in ycash:mainnet:main|ycash:testnet:test|ycash:regtest:regtest) ;; *) die "the payer's node runs chain '$chain', not $network" ;; esac
say "   payer node: chain $chain, height $(field "$chain_json" blocks)"

if [ -n "$facilitator" ]; then
  kinds="$(node "$lib" supported "$facilitator")"
  record "{\"step\":\"supported\",\"kinds\":$kinds}"
  case "$kinds" in *'"exact"'*) ;; *) die "the facilitator lists no exact kind on $network" ;; esac
  say "   facilitator: $(printf '%s' "$kinds" | tr -d '\n' | cut -c1-200)"
fi

exact_amount=0
if [ "$skip_exact" = 0 ]; then
  offer="$(node "$lib" offer "$merchant$exact_path" exact)"
  record "{\"step\":\"offer\",\"route\":\"$exact_path\",\"offer\":$offer}"
  exact_amount="$(field "$offer" amount)"
  [ "$exact_amount" -le "$max_payment" ] || refuse "$exact_path asks $exact_amount zatoshis, above --max-payment-zat $max_payment"
  say "   exact: $exact_path asks $exact_amount zat, payTo $(field "$offer" payTo), policy $(field "$offer" extra.confirmationPolicy)"
fi

channel_amount=0 close_fee=0
if [ "$skip_channel" = 0 ]; then
  offer="$(node "$lib" offer "$merchant$channel_path" batch-settlement)"
  record "{\"step\":\"offer\",\"route\":\"$channel_path\",\"offer\":$offer}"
  channel_amount="$(field "$offer" amount)"
  close_fee="$(field "$offer" extra.closeFee)"
  [ "$channel_amount" -le "$max_payment" ] || refuse "$channel_path asks $channel_amount zatoshis per request, above --max-payment-zat $max_payment"
  [ -z "$close_fee" ] || [ "$close_fee" -le "$max_close_fee" ] || refuse "$channel_path's closeFee $close_fee is above --max-close-fee-zat $max_close_fee"
  [ $((channel_amount * requests)) -le "$deposit" ] || refuse "$requests requests at $channel_amount zat need a deposit of at least $((channel_amount * requests)); --deposit-zat is $deposit"
  say "   channel: $channel_path asks $channel_amount zat per request, closeFee ${close_fee:-?}, refund after $(field "$offer" extra.minLockBlocks) blocks"
fi

# What can leave the payer's wallet, at most: the exact amount, the deposit and close fee (the
# unspent part of the deposit returns at close), and the network fees the client pays.
worst=$((exact_amount + deposit + ${close_fee:-0} + 20000))
say "   at most $worst zatoshis ($(node -e "console.log((Number(process.argv[1])/1e8).toFixed(8))" "$worst") YEC) leave the payer's wallet; about $((exact_amount + channel_amount * requests)) are spent"
record "{\"step\":\"budget\",\"worstCaseZat\":$worst,\"spentZat\":$((exact_amount + channel_amount * requests))}"
if [ "$dry" = 1 ]; then say "== dry run: nothing paid"; exit 0; fi

# ---------------------------------------------------------------- exact
if [ "$skip_exact" = 0 ]; then
  say "== exact: one payment to $exact_path"
  line="$(cli pay "$merchant$exact_path" --asset YEC --count 1 | tail -1)" || die "exact payment"
  [ "$(field "$line" status)" = 200 ] || die "exact: the merchant answered $(field "$line" status): $line"
  [ "$(field "$line" settlement.success)" = true ] || die "exact: no successful settlement: $line"
  say "   paid: txid $(field "$line" settlement.transaction) ($(field "$line" settlement.extra.status), $(field "$line" ms) ms)"
fi

# ---------------------------------------------------------------- channel
if [ "$skip_channel" = 0 ]; then
  say "== channel: open with $deposit zat, $requests requests, close"
  deadline=$(( $(date +%s) + funding_timeout ))
  channel_id="" status=""
  while :; do
    # The first open broadcasts the funding; while it waits for the merchant's funding depth the
    # client keeps the channel "opening" and a rerun resends the same open, never a second funding.
    out="$(cli channel open "$merchant$channel_path" --asset YEC --deposit "$deposit")" || true
    st="$(printf '%s\n' "$out" | grep '"msg":"channel"' | tail -1 || true)"
    if [ -n "$st" ]; then
      channel_id="$(field "$st" channelId)"; status="$(field "$st" status)"
      [ "$status" = open ] && break
    fi
    [ "$(date +%s)" -lt "$deadline" ] || die "channel ${channel_id:-?} still '${status:-not opened}' after ${funding_timeout}s (run: x402-ycash channel status / refund)"
    say "   waiting for the funding depth (channel ${channel_id:-?}: ${status:-no channel yet})"
    sleep 20
  done
  say "   open: $channel_id"
  line="$(cli pay "$merchant$channel_path" --asset YEC --count $((requests - 1)) | tail -1)" || die "channel requests"
  [ "$(field "$line" status)" = 200 ] || die "channel: request answered $(field "$line" status): $line"
  line="$(cli channel close "$merchant$channel_path" "$channel_id" --asset YEC | tail -1)" || die "channel close refused"
  [ "$(field "$line" msg)" = closed ] || die "channel close: $line"
  say "   closed: txid $(field "$line" transaction), charged $(field "$line" charged) zat"
  st="$(cli channel status "$channel_id" | tail -1)"
  [ "$(field "$st" unspent)" = false ] || die "the channel output is still unspent after the close: $st"
fi

say "== smoke passed; the JSON lines are in $report"
