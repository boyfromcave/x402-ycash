#!/usr/bin/env python3
"""X4-M agent (payer) sync cost on a full-node wallet (plan §5.10, X4 checklist).

On a running `scripts/devnet.sh` devnet this:

  1. creates an agent wallet on a fresh, offline node (one Sapling key, its birthday before the chain
     below exists);
  2. extends the devnet chain with a mainnet-like mix: mostly coinbase-only blocks, plus S blocks
     carrying one t->z transaction of K Sapling outputs each (one output pays the agent) and S z->z
     transactions (1 spend, 2 outputs);
  3. syncs fresh nodes from genesis over P2P from node 0 and times them:
       - "agent": the agent wallet (one Sapling key),
       - "nowallet": -disablewallet, for the wallet's share;
     and reads per-block connect times from each node's debug.log (UpdateTip lines);
  4. times the agent's first payment after a restart (process start -> RPC ready -> z_sendmany to a
     merchant ys address proved and accepted), and after being offline for B more blocks.

Every number is printed as a `FINDING <line> <item>: <json>` line and the whole result is written to
<work>/sync_cost.json.

  python sync_cost.py --devnet <devnet.json> --line dd|6 --work <dir> --p2p <port> --rpcport <port>
"""
import argparse
import atexit
import json
import os
import re
import shutil
import statistics
import subprocess
import time
from datetime import datetime

from rpc import Rpc, RpcError

AMT = 0.001  # each shielded output, YEC


def finding(line, item, value):
    print(f"FINDING {line} {item}: {json.dumps(value)}", flush=True)


def du_kib(path):
    if not os.path.exists(path):
        return 0
    return int(subprocess.check_output(["du", "-sk", path]).split()[0])


class Node:
    """A fresh ycashd outside the devnet, in its own datadir."""

    def __init__(self, binary, datadir, p2p, rpcport, args):
        self.binary, self.datadir, self.p2p, self.rpcport, self.args = binary, datadir, p2p, rpcport, args
        self.conf = os.path.join(datadir, "x4m.conf")
        self.proc = None
        os.makedirs(datadir, exist_ok=True)
        with open(self.conf, "w") as f:
            f.write(f"regtest=1\nrpcuser=x4m\nrpcpassword=x4m\nport={p2p}\nrpcport={rpcport}\n"
                    "listenonion=0\nshowmetrics=0\nprinttoconsole=0\n")
        self.rpc = Rpc(rpcport, "x4m", "x4m")
        atexit.register(self.stop)  # never leave a node behind when a run fails

    def start(self, extra=()):
        cmd = [self.binary, f"-datadir={self.datadir}", f"-conf={self.conf}", "-discover=0", "-dnsseed=0",
               "-listen=1", *self.args, *extra]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=open(os.path.join(self.datadir, "stderr.txt"), "ab"))
        return time.monotonic()

    def stop(self):
        if self.proc is None:
            return
        try:
            self.rpc("stop")
        except Exception:
            pass
        if self.proc:
            try:
                self.proc.wait(timeout=120)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.proc = None

    def log(self):
        return os.path.join(self.datadir, "regtest", "debug.log")


TS = re.compile(r"^(\w{3} \d{2} \d{2}:\d{2}:\d{2}\.\d{3}|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)")
TIP = re.compile(r"UpdateTip: new best[= ]hash=?(\w+).*?height=(\d+)")


def parse_ts(s):
    for fmt in ("%b %d %H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(("2026 " + s) if fmt.startswith("%b") else s, ("%Y " + fmt) if fmt.startswith("%b") else fmt).timestamp()
        except ValueError:
            pass
    raise ValueError(s)


def tip_times(logfile, since_offset=0):
    """height -> wall time of its UpdateTip line (the last one, after reorgs) from byte offset on."""
    out = {}
    with open(logfile, errors="replace") as f:
        f.seek(since_offset)
        for line in f:
            m = TIP.search(line)
            t = TS.match(line)
            if m and t:
                out[int(m.group(2))] = parse_ts(t.group(1))
    return out


def connect_profile(times, shielded_heights, lo, hi):
    """Median seconds per block for plain vs shielded blocks in (lo, hi], from successive tips."""
    plain, sh = [], []
    for h in range(lo + 1, hi + 1):
        if h in times and h - 1 in times:
            dt = times[h] - times[h - 1]
            (sh if h in shielded_heights else plain).append(dt)
    stat = lambda xs: {"n": len(xs), "median_ms": round(statistics.median(xs) * 1e3, 3) if xs else None,
                       "mean_ms": round(statistics.mean(xs) * 1e3, 3) if xs else None,
                       "sum_s": round(sum(xs), 3)}
    return {"plain": stat(plain), "shielded": stat(sh)}


def mine(rpc, n):
    """generate n blocks, then wait until the wallet has processed the last one (both lines notify
    the wallet asynchronously; spending before that double-spends, see harness.ts syncWallets)."""
    hashes = rpc("generate", n)
    for txid in rpc("getblock", hashes[-1])["tx"]:
        while True:
            try:
                if rpc("gettransaction", txid)["confirmations"] > 0:
                    break
            except RpcError as e:
                if e.code == -5:
                    break
            time.sleep(0.02)
    return hashes


def zsend(rpc, line, frm, amounts, transparent_source):
    params = [frm, amounts, 1]
    if line == "6":
        params += [None, "AllowFullyTransparent" if transparent_source else "FullPrivacy"]
    return rpc.wait_op(rpc("z_sendmany", *params))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--devnet", required=True)
    ap.add_argument("--line", choices=["dd", "6"], required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--p2p", type=int, required=True)
    ap.add_argument("--rpcport", type=int, required=True)
    ap.add_argument("--plain", type=int, default=2000, help="coinbase-only blocks in the extension")
    ap.add_argument("--shielded-blocks", type=int, default=20)
    ap.add_argument("--outputs", type=int, default=50, help="Sapling outputs per t->z transaction")
    ap.add_argument("--offline-blocks", type=int, default=200)
    a = ap.parse_args()
    line = a.line
    dn = json.load(open(a.devnet))
    binary = dn["bitcoind"]
    # The stock node 1's own command line, minus its datadir and ZMQ: devnet.json's node_args omit the
    # CLI's common prefix (Overwinter/Sapling heights; 6.21.0's zebrad acknowledgement flag).
    node1_dir = os.path.join(dn["dir"], "node1")
    pid = subprocess.check_output(["pgrep", "-f", "--", f"-datadir={node1_dir}( |$)"], text=True).split()[0]
    cmdline = subprocess.check_output(["ps", "-ww", "-o", "command=", "-p", pid], text=True).split()
    base_args = [x for x in cmdline[1:] if not x.startswith(("-datadir=", "-zmq", "-rest"))]
    node0 = Rpc.from_devnet(a.devnet, 0)
    pool = Rpc.from_devnet(a.devnet, dn["auto_pools"][0])
    with open(os.path.join(dn["dir"], "node0", next(f for f in os.listdir(os.path.join(dn["dir"], "node0")) if f.endswith(".conf")))) as f:
        p2p0 = int(re.search(r"^port=(\d+)", f.read(), re.M).group(1))
    shutil.rmtree(a.work, ignore_errors=True)
    os.makedirs(a.work)
    result = {"line": line, "binary": binary}

    # 1. The agent's wallet, created offline before the chain extension (its birthday).
    agent = Node(binary, os.path.join(a.work, "agent"), a.p2p, a.rpcport, base_args)
    agent.start(["-connect=127.0.0.1:9"])
    agent.rpc.wait_ready()
    agent_z = agent.rpc("z_getnewaddress", "sapling")
    agent.stop()

    # 2. Extend the chain on the pool: coinbase-only blocks with S shielded blocks spread among them.
    start_height = node0("getblockcount")
    t_from = pool("getnewaddress")
    per_tx = a.outputs * AMT + 1.1
    fund = [node0("sendtoaddress", t_from, round(per_tx, 8)) for _ in range(a.shielded_blocks + 1)]
    while not set(fund) <= set(pool("getrawmempool")):
        time.sleep(0.1)
    mine(pool, 1)
    while len(pool("listunspent", 1, 9999999, [t_from])) < len(fund):
        time.sleep(0.1)
    z_base = pool("z_getnewaddress", "sapling")
    recipients = [z_base] + [pool("z_getnewdiversifiedaddress", z_base) for _ in range(a.outputs - 2)]
    gap = a.plain // a.shielded_blocks
    shielded_heights, prove_s = set(), []
    for i in range(a.shielded_blocks):
        amounts = [{"address": r, "amount": AMT} for r in recipients]
        amounts.append({"address": agent_z, "amount": 1.0})  # the agent's spendable note
        t0 = time.monotonic()
        zsend(pool, line, t_from, amounts, True)
        prove_s.append(time.monotonic() - t0)
        if i > 0:  # a z->z: one note of z_base, which has i notes confirmed by now
            zsend(pool, line, z_base, [{"address": recipients[1], "amount": AMT / 2}], False)
        h = mine(pool, 1)
        shielded_heights.add(pool("getblock", h[0])["height"])
        mine(pool, gap)
    # Wait for node 0 to have the whole extension.
    target_hash = pool("getbestblockhash")
    while node0("getbestblockhash") != target_hash:
        time.sleep(0.2)
    target = node0("getblockcount")
    outputs = a.shielded_blocks * a.outputs + (a.shielded_blocks - 1) * 2  # z->z: payment + change
    result["chain"] = {"height": target, "extension_blocks": target - start_height,
                       "shielded_blocks": len(shielded_heights), "sapling_outputs_in_extension": outputs,
                       "z_to_z_txs": a.shielded_blocks - 1,
                       "outputs_per_block": round(outputs / (target - start_height), 3),
                       "prove_s_per_tx_median": round(statistics.median(prove_s), 2)}
    finding(line, "chain", result["chain"])

    # 3. Sync from genesis over P2P.
    def ibd(node, extra, wallet_check):
        t0 = node.start([f"-connect=127.0.0.1:{p2p0}", *extra])
        node.rpc.wait_ready()
        t_rpc = time.monotonic()
        while True:
            if node.proc.poll() is not None:
                raise RuntimeError(f"{node.datadir}: ycashd exited with {node.proc.returncode}")
            try:
                if node.rpc("getblockcount") >= target:
                    break
            except (RpcError, OSError):
                pass
            time.sleep(0.05)
        t_tip = time.monotonic()
        t_wallet = None
        if wallet_check:
            while True:
                try:
                    if float(node.rpc("z_getbalance", agent_z, 1)) >= a.shielded_blocks * 1.0:
                        break
                except (RpcError, OSError):
                    pass
                time.sleep(0.05)
            t_wallet = time.monotonic()
        times = tip_times(node.log())
        node.stop()
        reg = os.path.join(node.datadir, "regtest")
        disk = {"blocks_kib": du_kib(os.path.join(reg, "blocks")), "chainstate_kib": du_kib(os.path.join(reg, "chainstate")),
                "wallet_kib": du_kib(os.path.join(reg, "wallet.dat")), "total_kib": du_kib(reg)}
        r = {"rpc_ready_s": round(t_rpc - t0, 3), "tip_s": round(t_tip - t0, 3),
             "wallet_balance_s": round(t_wallet - t0, 3) if t_wallet else None,
             "connect_genesis_to_start": connect_profile(times, set(), 0, start_height),
             "connect_extension": connect_profile(times, shielded_heights, start_height, target),
             "disk": disk}
        return r

    result["ibd_agent"] = ibd(agent, [], True)
    finding(line, "ibd_agent", result["ibd_agent"])
    nowallet = Node(binary, os.path.join(a.work, "nowallet"), a.p2p + 1, a.rpcport + 1, base_args)
    result["ibd_nowallet"] = ibd(nowallet, ["-disablewallet"], False)
    finding(line, "ibd_nowallet", result["ibd_nowallet"])
    shutil.rmtree(nowallet.datadir, ignore_errors=True)

    # 4. Time to first payment after a restart, then after B blocks offline.
    merchant_base = node0("z_getnewaddress", "sapling")
    merchant = node0("z_getnewdiversifiedaddress", merchant_base)

    def restart_and_pay(label, prev_txid=None):
        """Start the agent, wait for its node and wallet to reach the tip, pay the merchant; time each
        step until the merchant's node sees the payment in its mempool."""
        log_off = os.path.getsize(agent.log())
        t0 = agent.start([f"-connect=127.0.0.1:{p2p0}"])
        agent.rpc.wait_ready()
        t_rpc = time.monotonic()
        tip_hash = node0("getbestblockhash")
        while agent.rpc("getbestblockhash") != tip_hash:
            time.sleep(0.05)
        t_tip = time.monotonic()
        if prev_txid:  # the wallet has caught up when its last payment shows the right depth
            want = node0("getrawtransaction", prev_txid, 1)["confirmations"]
            while agent.rpc("gettransaction", prev_txid)["confirmations"] < want:
                time.sleep(0.02)
        t_wallet = time.monotonic()
        txid = zsend(agent.rpc, line, agent_z, [{"address": merchant, "amount": 0.01}], False)
        t_done = time.monotonic()
        seen = None
        while time.monotonic() - t_done < 120:
            if any(n.get("txid") == txid for n in node0("z_listreceivedbyaddress", merchant, 0)):
                seen = time.monotonic()
                break
            time.sleep(0.05)
        while txid not in pool("getrawmempool"):
            time.sleep(0.05)
        times = tip_times(agent.log(), log_off)
        agent.stop()
        r = {"rpc_ready_s": round(t_rpc - t0, 3), "node_at_tip_s": round(t_tip - t0, 3),
             "wallet_at_tip_s": round(t_wallet - t0, 3), "z_sendmany_s": round(t_done - t_wallet, 3),
             "payment_accepted_by_own_node_s": round(t_done - t0, 3),
             "merchant_sees_0conf_s": round(seen - t0, 3) if seen else None, "blocks_caught_up": len(times)}
        finding(line, label, r)
        return r, txid

    result["restart_at_tip"], pay1 = restart_and_pay("restart_at_tip")
    mine(pool, 1)  # confirm the payment so the next one has a confirmed note
    for i in range(a.offline_blocks // 50):
        mine(pool, 50)
    while node0("getbestblockhash") != pool("getbestblockhash"):
        time.sleep(0.2)
    result["restart_after_offline"], _ = restart_and_pay(f"restart_after_{a.offline_blocks}_blocks", pay1)
    result["agent_disk_final_kib"] = du_kib(os.path.join(agent.datadir, "regtest"))
    json.dump(result, open(os.path.join(a.work, "sync_cost.json"), "w"), indent=2)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
