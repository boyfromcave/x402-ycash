#!/usr/bin/env python3
"""X4-M viewing-key split: can a merchant issue per-request addresses with no spending key on the
settlement host? (plan §5.10; docs/x4m-measurements.md "Viewing-key split").

  1. The merchant's spending-key wallet (devnet node 0) makes a Sapling key and exports its full
     viewing key; a settlement node (node 3) imports only that key.
  2. `divaddr` (tools/x4m/rust) derives diversified addresses from the viewing key, offline, at a
     ZIP-32 index range the node never walks to (both nodes walk up from the base address's index).
  3. The pool pays two of them; the settlement node sees both in its mempool and after a block.
  4. The spending-key wallet sees and spends the note at an offline-derived address.

  python viewkey_split.py --devnet <devnet.json> --line dd|6 --divaddr <path to divaddr>
"""
import argparse
import json
import subprocess
import time

from rpc import Rpc, RpcError
from sync_cost import finding, mine, zsend

OFFLINE_START = 1 << 40  # far above any index z_getnewdiversifiedaddress reaches


def wait_received(rpc, addr, minconf, txid, timeout=30):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        try:
            for n in rpc("z_listreceivedbyaddress", addr, minconf):
                if n["txid"] == txid:
                    return round(time.monotonic() - t0, 3), n
        except RpcError:
            pass
        time.sleep(0.05)
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--devnet", required=True)
    ap.add_argument("--line", choices=["dd", "6"], required=True)
    ap.add_argument("--divaddr", required=True)
    ap.add_argument("--watcher", type=int, default=3)
    a = ap.parse_args()
    line = a.line
    dn = json.load(open(a.devnet))
    merchant = Rpc.from_devnet(a.devnet, 0)
    watcher = Rpc.from_devnet(a.devnet, a.watcher)
    pool = Rpc.from_devnet(a.devnet, dn["auto_pools"][0])
    res = {}

    base = merchant("z_getnewaddress", "sapling")
    vk = merchant("z_exportviewingkey", base)
    imp = watcher("z_importviewingkey", vk, "no")
    res["import"] = imp

    # Offline derivation from the viewing key alone. Index 0 must reproduce the node's own base
    # address: a check that the tool and the node agree on ZIP-32.
    first = subprocess.check_output([a.divaddr, vk, "0", "1"], text=True).split()
    res["divaddr_index0_matches_node_base"] = first[1] == base
    rows = subprocess.check_output([a.divaddr, vk, str(OFFLINE_START), "2"], text=True).split("\n")
    derived = [r.split() for r in rows if r]
    res["derived"] = [{"index": int(i), "address": s} for i, s in derived]
    addrs = [s for _, s in derived]
    res["watcher_validate"] = {k: v for k, v in watcher("z_validateaddress", addrs[0]).items() if k in ("isvalid", "ismine", "type")}
    res["merchant_validate"] = {k: v for k, v in merchant("z_validateaddress", addrs[0]).items() if k in ("isvalid", "ismine", "type")}

    # The pool pays both offline addresses (t->z, with a memo on the first).
    t_from = pool("getnewaddress")
    fund = merchant("sendtoaddress", t_from, 1.0)
    while fund not in pool("getrawmempool"):
        time.sleep(0.1)
    while not pool("listunspent", 1, 9999999, [t_from]):
        mine(pool, 1)
    memo = "x402 offline-derived".encode().hex()
    txid = zsend(pool, line, t_from, [{"address": addrs[0], "amount": 0.25, "memo": memo},
                                      {"address": addrs[1], "amount": 0.125}], True)
    res["payment_txid"] = txid
    for who, rpc in (("watcher", watcher), ("merchant", merchant)):
        for i, ad in enumerate(addrs):
            s, note = wait_received(rpc, ad, 0, txid)
            res[f"{who}_mempool_addr{i}"] = {"seen_s": s, "amount": note and note["amount"],
                                             **({"memo_ok": bool(note) and note.get("memo", "").startswith(memo)} if i == 0 else {})}
    mine(pool, 1)
    for who, rpc in (("watcher", watcher), ("merchant", merchant)):
        s, note = wait_received(rpc, addrs[0], 1, txid)
        res[f"{who}_mined_addr0"] = {"seen_s": s, "confirmations": note and note.get("confirmations")}
    res["watcher_view"] = [{"address": o.get("address"), "value": o.get("value")}
                           for o in watcher("z_viewtransaction", txid)["outputs"]]

    # The spending-key wallet spends the note received at the offline-derived address.
    try:
        back = merchant("z_getnewaddress", "sapling")
        spend = zsend(merchant, line, addrs[0], [{"address": back, "amount": 0.2}], False)
        res["merchant_spends_offline_note"] = {"ok": True, "txid": spend}
    except RpcError as e:
        res["merchant_spends_offline_note"] = {"ok": False, "error": e.message}
    try:
        watcher_spend = zsend(watcher, line, addrs[0], [{"address": base, "amount": 0.1}], False)
        res["watcher_can_spend"] = {"ok": True, "txid": watcher_spend}
    except RpcError as e:
        res["watcher_can_spend"] = {"ok": False, "error": e.message}
    finding(line, "viewkey_split", res)


if __name__ == "__main__":
    main()
