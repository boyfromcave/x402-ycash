"""Stratified random sample of mainnet block sizes from the public explorer (read-only).

  python mainnet_block_sizes.py <tip> <samples-per-stratum> [out.json]

The explorer cannot page through history (its /blocks listing returns the latest 10 only), so the
chain size is estimated from blocks/{height} at random heights below and above the Ycash fork."""
import json, random, sys, time, urllib.request
TIP = int(sys.argv[1]); N = int(sys.argv[2]); random.seed(4021)
strata = [(1, 570000), (570000, TIP + 1)]
out = []
for lo, hi in strata:
    for h in sorted(random.sample(range(lo, hi), N)):
        for attempt in range(3):
            try:
                with urllib.request.urlopen(f"https://explorer.ycash.xyz/api/v1/blocks/{h}", timeout=30) as r:
                    d = json.load(r)["data"]
                out.append({"stratum": f"{lo}-{hi-1}", "height": h, "size": d["size"], "tx": d["tx_count"]})
                break
            except Exception as e:
                time.sleep(1)
        time.sleep(0.05)
json.dump(out, open(sys.argv[3] if len(sys.argv) > 3 else "block_size_sample.json", "w"))
for lo, hi in strata:
    s = [o for o in out if o["stratum"] == f"{lo}-{hi-1}"]
    mean = sum(o["size"] for o in s) / len(s)
    print(f"{lo}-{hi-1}: n={len(s)} mean={mean:.0f} B, est {(hi-lo)*mean/1e9:.2f} GB, mean tx {sum(o['tx'] for o in s)/len(s):.2f}")
