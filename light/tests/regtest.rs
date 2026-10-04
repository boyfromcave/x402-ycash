//! Regtest integration test against a Yellowback devnet + lightwalletd-dd (ignored by default).
//!
//! Run through `scripts/regtest.sh {dd|6} <seed>`, which brings the devnet and lightwalletd up,
//! exports the environment below, runs `cargo test --release -- --ignored`, and tears down:
//!
//!   X402_LIGHT_LINE      dd | 6
//!   X402_LIGHT_SEED      devnet port seed
//!   X402_LIGHT_LWD       lightwalletd address (127.0.0.1:PORT)
//!   X402_LIGHT_PARAMS    directory with sapling-{spend,output}.params (default ~/.zcash-params)
//!   X402_SCRATCH         scratch root holding <line>-<seed>/devnet.json
//!
//! Flow: import a fresh key with the tip as birthday; fund it from node 0 (t → z, 1.5 YEC);
//! sync; build a 0.5 YEC payment with a memo to a merchant `yregtestsapling1…`; check the branch
//! id against `getblockchaininfo.consensus.nextblock`; broadcast via lightwalletd; see it in the
//! light wallet's mempool view; mine; confirm with `z_listreceivedbyaddress` (amount + memo);
//! sync again and check the balance. Timings land in `$X402_SCRATCH/lightcore-<line>.json`.
//!
//! `reorg_near_the_birthday_syncs_through` (YEW Z-9): reorgs within ten blocks of the birthday,
//! where the store refuses the ordinary ten-block rewind. Its record lands in
//! `$X402_SCRATCH/lightrewind-<line>.json`. The script runs the tests one at a time
//! (`--test-threads=1`): they share node 0's wallet; `X402_LIGHT_TEST=<name>` picks one.

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Env {
    line: String,
    seed: String,
    lwd: String,
    params: PathBuf,
    scratch: PathBuf,
    workspace: PathBuf,
    python: PathBuf,
}

impl Env {
    fn load() -> Env {
        let var = |k: &str| {
            std::env::var(k)
                .unwrap_or_else(|_| panic!("{k} not set; run through scripts/regtest.sh"))
        };
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        // A worktree sits at <workspace>/wt/<name>; the main tree at <workspace>/x402-ycash.
        let mut workspace = repo.parent().unwrap().to_path_buf();
        if workspace.file_name().is_some_and(|n| n == "wt") {
            workspace = workspace.parent().unwrap().to_path_buf();
        }
        let home = std::env::var("HOME").unwrap();
        Env {
            line: var("X402_LIGHT_LINE"),
            seed: var("X402_LIGHT_SEED"),
            lwd: var("X402_LIGHT_LWD"),
            params: std::env::var("X402_LIGHT_PARAMS")
                .map(PathBuf::from)
                .unwrap_or(PathBuf::from(home).join(".zcash-params")),
            scratch: std::env::var("X402_SCRATCH")
                .map(PathBuf::from)
                .unwrap_or(workspace.join("wt/scratch/x402")),
            python: std::env::var("PYTHON")
                .map(PathBuf::from)
                .unwrap_or(workspace.join(".venv/bin/python")),
            workspace,
        }
    }

    fn node_repo(&self) -> PathBuf {
        self.workspace.join(if self.line == "dd" {
            "ycash-dd"
        } else {
            "ycash6"
        })
    }

    fn devnet_dir(&self) -> PathBuf {
        self.scratch.join(format!("{}-{}", self.line, self.seed))
    }

    /// `yellowback-devnet <args>` with this devnet's environment.
    fn devnet(&self, args: &[&str]) -> String {
        let cli = self
            .node_repo()
            .join("contrib/yellowback/devnet/yellowback-devnet");
        let binvar = if self.line == "dd" {
            "BITCOIND"
        } else {
            "ZCASHD"
        };
        let out = Command::new(&self.python)
            .arg(&cli)
            .args(args)
            .env("YELLOWBACK_DEVNET_DIR", self.devnet_dir())
            .env("YELLOWBACK_DEVNET_PORTSEED", &self.seed)
            .env(binvar, self.node_repo().join("src/ycashd"))
            .output()
            .expect("run yellowback-devnet");
        assert!(
            out.status.success(),
            "yellowback-devnet {args:?} failed:\n{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    /// A node 0 RPC through the devnet CLI; JSON when the node prints JSON, else the bare string.
    fn rpc(&self, args: &[&str]) -> Value {
        let mut full = vec!["cli", "--node", "0", "--"];
        full.extend_from_slice(args);
        let out = self.devnet(&full);
        serde_json::from_str(&out).unwrap_or(Value::String(out))
    }

    /// An RPC on node `n`.
    fn rpc_on(&self, n: usize, args: &[&str]) -> Value {
        let node = n.to_string();
        let mut full = vec!["cli", "--node", node.as_str(), "--"];
        full.extend_from_slice(args);
        let out = self.devnet(&full);
        serde_json::from_str(&out).unwrap_or(Value::String(out))
    }

    fn devnet_json(&self) -> Value {
        let s = std::fs::read_to_string(self.devnet_dir().join("devnet.json")).unwrap();
        serde_json::from_str(&s).unwrap()
    }

    fn nodes(&self) -> Vec<usize> {
        (0..self.devnet_json()["num_nodes"].as_u64().unwrap() as usize).collect()
    }

    fn best(&self, n: usize) -> String {
        self.rpc_on(n, &["getbestblockhash"])
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// Node `n`'s P2P address (`port=` in its `ycash.conf`).
    fn p2p_addr(&self, n: usize) -> String {
        let conf =
            std::fs::read_to_string(self.devnet_dir().join(format!("node{n}/ycash.conf"))).unwrap();
        let port = conf
            .lines()
            .find_map(|l| l.strip_prefix("port="))
            .unwrap()
            .trim()
            .to_owned();
        format!("127.0.0.1:{port}")
    }

    /// Re-adds every missing pair of peers: v4.5.0 drops a peer that relays a transaction
    /// expired by two blocks (X-F105), and a reorg can split the mesh that way.
    fn heal_mesh(&self) {
        let nodes = self.nodes();
        let peers: Vec<Vec<String>> = nodes
            .iter()
            .map(|&n| {
                self.rpc_on(n, &["getpeerinfo"])
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|p| p["addr"].as_str().map(str::to_owned))
                    .collect()
            })
            .collect();
        for &a in &nodes {
            for &b in nodes.iter().filter(|&&b| b > a) {
                if !peers[a].contains(&self.p2p_addr(b)) && !peers[b].contains(&self.p2p_addr(a)) {
                    self.rpc_on(a, &["addnode", &self.p2p_addr(b), "onetry"]);
                }
            }
        }
    }

    /// `invalidateblock` at `height` on every node, as a competing branch from there would do;
    /// waits until every node stands on the block below. Returns the invalidated hash.
    fn invalidate_from(&self, height: u64) -> String {
        let hash = self.rpc(&["getblockhash", &height.to_string()]);
        let hash = hash.as_str().unwrap().to_owned();
        for n in self.nodes() {
            self.rpc_on(n, &["invalidateblock", &hash]);
        }
        let below = self.rpc(&["getblockhash", &(height - 1).to_string()]);
        wait_for(
            "every node below the invalidated block",
            Duration::from_secs(60),
            || {
                self.nodes()
                    .iter()
                    .all(|&n| self.best(n) == below.as_str().unwrap())
            },
        );
        hash
    }

    /// Waits until every node's mempool holds `txids` (they were resurrected by the disconnect).
    fn wait_mempools(&self, txids: &[&str]) {
        wait_for(
            "the resurrected transactions in every mempool",
            Duration::from_secs(60),
            || {
                self.nodes().iter().all(|&n| {
                    let pool = self.rpc_on(n, &["getrawmempool"]);
                    txids
                        .iter()
                        .all(|t| pool.as_array().unwrap().iter().any(|p| p == t))
                })
            },
        );
    }

    /// The height of the block holding `txid` on node 0's best chain.
    fn mined_height(&self, txid: &str) -> u64 {
        let tx = self.rpc(&["gettransaction", txid]);
        let block = tx["blockhash"].as_str().expect("mined");
        self.rpc(&["getblock", block])["height"].as_u64().unwrap()
    }

    /// Mines on the devnet, then waits until lightwalletd has ingested the new tip: its ingestor
    /// polls the node every couple of seconds (0.4.6 lineage), and a sync issued before that
    /// simply stops at the old tip.
    fn mine(&self, n: u32, data: &PathBuf) {
        self.devnet(&["mine", &n.to_string()]);
        self.wait_lwd(data);
    }

    /// Mines a whole competing branch of `n` blocks on pool node 2 alone, then waits until every
    /// node stands on it. Block by block (`mine`) does not work for a branch shorter than one
    /// just invalidated: 6.21.0 peers keep such blocks headers-only until the branch outweighs
    /// the invalidated tip (v4.5.0 fetches them), so the devnet's per-block sync never finishes.
    fn mine_branch(&self, n: u32, data: &PathBuf) {
        self.rpc_on(2, &["generate", &n.to_string()]);
        let tip = self.best(2);
        wait_for(
            "every node on the new branch",
            Duration::from_secs(120),
            || self.nodes().iter().all(|&m| self.best(m) == tip),
        );
        self.wait_lwd(data);
    }

    fn wait_lwd(&self, data: &PathBuf) {
        let height = self.rpc(&["getblockcount"]).as_u64().unwrap();
        wait_for(
            "lightwalletd to reach the node's tip",
            Duration::from_secs(60),
            || {
                self.light(data, "status", &json!({}))
                    .map(|s| s["lwdLatestHeight"].as_u64().unwrap() >= height)
                    .unwrap_or(false)
            },
        );
    }

    /// `x402-light once <method> <params>` against `data`.
    fn light(&self, data: &PathBuf, method: &str, params: &Value) -> Result<Value, String> {
        let out = Command::new(env!("CARGO_BIN_EXE_x402-light"))
            .args(["once", "--data"])
            .arg(data)
            .args(["--lwd", &self.lwd, "--network", "regtest", "--params"])
            .arg(&self.params)
            .arg(method)
            .arg(params.to_string())
            .output()
            .expect("run x402-light");
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
        }
        Ok(serde_json::from_slice(&out.stdout).expect("x402-light prints JSON"))
    }
}

fn wait_for(what: &str, timeout: Duration, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(start.elapsed() < timeout, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Mines until node 0's wallet sees `txid` confirmed: a block mined right after a send can miss
/// the transaction (mempool propagation to the pool races the block), and both lines notify the
/// wallet of a block asynchronously.
fn confirm(env: &Env, txid: &str, data: &PathBuf) {
    for _ in 0..4 {
        env.mine(1, data);
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(8) {
            if env.rpc(&["gettransaction", txid])["confirmations"]
                .as_i64()
                .unwrap_or(0)
                > 0
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    panic!("{txid} not confirmed after four blocks");
}

fn wait_operation(env: &Env, opid: &str) -> String {
    let mut txid = None;
    wait_for("z_sendmany operation", Duration::from_secs(120), || {
        let res = env.rpc(&["z_getoperationresult", &json!([opid]).to_string()]);
        if let Some(op) = res.as_array().and_then(|a| a.first()) {
            assert_eq!(op["status"], "success", "z_sendmany failed: {op}");
            txid = op["result"]["txid"].as_str().map(str::to_owned);
            return true;
        }
        false
    });
    txid.unwrap()
}

#[test]
#[ignore = "needs a devnet and lightwalletd: scripts/regtest.sh {dd|6} <seed>"]
fn pays_a_merchant_through_lightwalletd() {
    let env = Env::load();
    let data = env.scratch.join(format!("light-{}-{}", env.line, env.seed));
    let _ = std::fs::remove_dir_all(&data);
    let mut record = json!({ "line": env.line, "seed": env.seed, "lwd": env.lwd });

    // A fresh key; birthday = the current tip so the funding block is the first one scanned.
    let tip = env.rpc(&["getblockcount"]).as_u64().unwrap() as u32;
    let extsk = sapling::zip32::ExtendedSpendingKey::master(&rand::random::<[u8; 32]>());
    let key =
        zcash_keys::encoding::encode_extended_spending_key("secret-extended-key-regtest", &extsk);
    let info = env
        .light(&data, "import_key", &json!({ "key": key, "birthday": tip }))
        .unwrap();
    let address = info["address"].as_str().unwrap().to_owned();
    assert!(address.starts_with("yregtestsapling1"), "{address}");
    assert!(info["fvk"]
        .as_str()
        .unwrap()
        .starts_with("zxviewregtestsapling1"));
    // The node agrees on the address for this key: import the viewing key and compare.
    let fvk = info["fvk"].as_str().unwrap();
    env.rpc(&["z_importviewingkey", fvk, "no"]);
    let addrs = env.rpc(&["z_listaddresses", "true"]);
    assert!(
        addrs.as_array().unwrap().iter().any(|a| a == &address),
        "node derives {address} from the fvk too"
    );

    // Fund it: 1.5 YEC t → z from node 0. 6.21.0 needs the privacy policy for transparent change (X-F12).
    let taddr = env.rpc(&["getnewaddress"]).as_str().unwrap().to_owned();
    let coin = env
        .rpc(&["sendtoaddress", &taddr, "2.0"])
        .as_str()
        .unwrap()
        .to_owned();
    confirm(&env, &coin, &data);
    let amounts = json!([{ "address": address, "amount": 1.5 }]).to_string();
    let opid = if env.line == "dd" {
        env.rpc(&["z_sendmany", &taddr, &amounts, "1", "0.0001"])
    } else {
        env.rpc(&[
            "z_sendmany",
            &taddr,
            &amounts,
            "1",
            "null",
            "AllowFullyTransparent",
        ])
    };
    let fund_txid = wait_operation(&env, opid.as_str().unwrap());
    confirm(&env, &fund_txid, &data);
    let funded_height = env.rpc(&["getblockcount"]).as_u64().unwrap();

    // Initial sync from the birthday.
    let t = Instant::now();
    let sync = env.light(&data, "sync", &json!({})).unwrap();
    record["initialSync"] = json!({ "millis": t.elapsed().as_millis() as u64, "report": sync });
    assert_eq!(sync["tipHeight"].as_u64().unwrap(), funded_height, "{sync}");
    assert_eq!(sync["receivedNotes"], 1, "{sync}");
    assert!(sync["branchIdChecked"].as_bool().unwrap());
    let status = env.light(&data, "status", &json!({})).unwrap();
    assert_eq!(
        status["balance"]["spendableZat"], 150_000_000u64,
        "{status}"
    );
    assert_eq!(status["synced"], true);
    assert_eq!(status["height"].as_u64().unwrap(), funded_height);
    let notes = env.light(&data, "list_notes", &json!({})).unwrap();
    assert_eq!(notes.as_array().unwrap().len(), 1);
    assert_eq!(notes[0]["txid"], fund_txid);

    // Build (prove + sign, no broadcast) a 0.5 YEC payment with a memo to the merchant.
    let merchant = env
        .rpc(&["z_getnewaddress", "sapling"])
        .as_str()
        .unwrap()
        .to_owned();
    let memo = "x402 lightcore: invoice 42";
    // Exactly the SDK's builder contract: amountZat a decimal string, nExpiryHeight the spec's
    // tip + 3 + ⌈maxTimeoutSeconds/75⌉ (900 s here).
    let expiry = funded_height + 3 + 12;
    let t = Instant::now();
    let built = env.light(&data, "build", &json!({ "to": merchant, "amountZat": "50000000", "memoHex": hex::encode(memo), "expiryHeight": expiry })).unwrap();
    record["build"] = json!({ "millis": t.elapsed().as_millis() as u64, "feeZat": built["feeZat"], "branchId": built["branchId"], "branchIdSource": built["branchIdSource"], "version": built["version"] });
    let tx_hex = built["txHex"].as_str().unwrap();
    let chain = env.rpc(&["getblockchaininfo"]);
    assert_eq!(
        built["branchId"], chain["consensus"]["nextblock"],
        "signed with the next block's branch id"
    );
    assert_eq!(built["branchIdSource"], "GetChainInfo.nextBlockBranchId");
    let decoded = env.rpc(&["decoderawtransaction", tx_hex]);
    assert_eq!(decoded["txid"], built["txid"]);
    assert_eq!(
        decoded["vin"].as_array().unwrap().len(),
        0,
        "fully shielded"
    );
    assert_eq!(
        decoded["vout"].as_array().unwrap().len(),
        0,
        "fully shielded"
    );
    assert_eq!(
        decoded["vShieldedOutput"].as_array().unwrap().len(),
        2,
        "payment + change"
    );
    assert!(!decoded["vShieldedSpend"].as_array().unwrap().is_empty());
    assert_eq!(decoded["version"], 4);
    assert_eq!(decoded["expiryheight"].as_u64().unwrap(), expiry);
    assert_eq!(built["expiryHeight"].as_u64().unwrap(), expiry);
    assert!(
        built["feeZat"].as_u64().unwrap() >= 1000,
        "at or above the x402 floor"
    );
    // Not broadcast: the node has never seen it.
    let pool = env.rpc(&["getrawmempool"]);
    assert!(!pool.as_array().unwrap().iter().any(|t| t == &built["txid"]));

    // Broadcast through lightwalletd, see it 0-conf in our mempool view, then mine.
    let sent = env
        .light(&data, "broadcast", &json!({ "txHex": tx_hex }))
        .unwrap();
    assert_eq!(sent["txid"], built["txid"]);
    wait_for(
        "the payment in node 0's mempool",
        Duration::from_secs(20),
        || {
            env.rpc(&["getrawmempool"])
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t == &built["txid"])
        },
    );
    let status = env.light(&data, "status", &json!({})).unwrap();
    assert!(
        status["mempool"]["spendingTxids"]
            .as_array()
            .unwrap()
            .contains(&built["txid"]),
        "{status}"
    );
    // The merchant node sees the 0-conf note with the memo (X-F11: `z_listreceivedbyaddress <addr> 0`).
    wait_for(
        "the merchant's 0-conf note",
        Duration::from_secs(20),
        || {
            !env.rpc(&["z_listreceivedbyaddress", &merchant, "0"])
                .as_array()
                .unwrap()
                .is_empty()
        },
    );
    confirm(&env, built["txid"].as_str().unwrap(), &data);
    let received = env.rpc(&["z_listreceivedbyaddress", &merchant, "1"]);
    let note = received
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["txid"] == built["txid"])
        .expect("merchant received the payment");
    assert_eq!(note["amount"].as_f64().unwrap(), 0.5);
    assert!(
        note["memo"]
            .as_str()
            .unwrap()
            .starts_with(&hex::encode(memo)),
        "memo {}",
        note["memo"]
    );

    // Sync again: our note is spent, change arrived.
    let t = Instant::now();
    let sync2 = env.light(&data, "sync", &json!({})).unwrap();
    record["secondSync"] = json!({ "millis": t.elapsed().as_millis() as u64, "report": sync2 });
    assert_eq!(sync2["spentNotes"], 1, "{sync2}");
    let status = env.light(&data, "status", &json!({})).unwrap();
    let fee = built["feeZat"].as_u64().expect("fee known");
    assert_eq!(
        status["balance"]["spendableZat"].as_u64().unwrap(),
        150_000_000 - 50_000_000 - fee,
        "{status}"
    );
    assert!(status["mempool"]["spendingTxids"]
        .as_array()
        .unwrap()
        .is_empty());

    // `send` (build + broadcast) with an explicit fee; the node's acceptance is line-specific.
    let t = Instant::now();
    let send = env.light(
        &data,
        "send",
        &json!({ "to": merchant, "amountZat": 10_000_000u64, "memo": "second", "fee": 5000 }),
    );
    record["sendFixedFee5000"] = json!({ "millis": t.elapsed().as_millis() as u64, "result": match &send { Ok(v) => json!({ "txid": v["txid"], "feeZat": v["feeZat"], "expiryHeight": v["expiryHeight"] }), Err(e) => json!({ "error": e }) } });
    if let Ok(v) = &send {
        confirm(&env, v["txid"].as_str().unwrap(), &data);
        let received = env.rpc(&["z_listreceivedbyaddress", &merchant, "1"]);
        assert!(received
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["txid"] == v["txid"]));
    }

    // Per-block scan cost: mine 20 empty-ish blocks and time the catch-up.
    env.mine(20, &data);
    let t = Instant::now();
    let sync3 = env.light(&data, "sync", &json!({})).unwrap();
    let blocks = sync3["blocksScanned"].as_u64().unwrap().max(1);
    record["catchUp20"] = json!({ "millis": t.elapsed().as_millis() as u64, "blocks": blocks, "millisPerBlock": t.elapsed().as_millis() as u64 / blocks, "report": sync3 });

    let path = env.scratch.join(format!("lightcore-{}.json", env.line));
    std::fs::write(&path, serde_json::to_string_pretty(&record).unwrap()).unwrap();
    println!("{}", serde_json::to_string_pretty(&record).unwrap());
    println!("record written to {}", path.display());
}

/// `z_sendmany` from `from` (a funded transparent address of node 0) to `to`, with a memo; returns
/// the txid once the operation succeeded. 6.21.0 needs the privacy policy for transparent change
/// (X-F12).
fn z_send(env: &Env, from: &str, to: &str, amount: f64, memo: &str) -> String {
    let amounts =
        json!([{ "address": to, "amount": amount, "memo": hex::encode(memo) }]).to_string();
    let opid = if env.line == "dd" {
        env.rpc(&["z_sendmany", from, &amounts, "1", "0.0001"])
    } else {
        env.rpc(&[
            "z_sendmany",
            from,
            &amounts,
            "1",
            "null",
            "AllowFullyTransparent",
        ])
    };
    wait_operation(env, opid.as_str().unwrap())
}

fn spendable(env: &Env, data: &PathBuf) -> u64 {
    env.light(data, "status", &json!({})).unwrap()["balance"]["spendableZat"]
        .as_u64()
        .unwrap()
}

/// (txid, minedHeight) of every note, sorted.
fn notes(env: &Env, data: &PathBuf) -> Vec<(String, Option<u64>)> {
    let mut v: Vec<_> = env
        .light(data, "list_notes", &json!({ "minConfirmations": 0 }))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|n| {
            (
                n["txid"].as_str().unwrap().to_owned(),
                n["minedHeight"].as_u64(),
            )
        })
        .collect();
    v.sort();
    v
}

#[test]
#[ignore = "needs a devnet and lightwalletd: scripts/regtest.sh {dd|6} <seed>"]
fn reorg_near_the_birthday_syncs_through() {
    let env = Env::load();
    let data = env
        .scratch
        .join(format!("rewind-{}-{}", env.line, env.seed));
    let _ = std::fs::remove_dir_all(&data);
    let mut record = json!({ "line": env.line, "seed": env.seed });

    // A fresh key born at the tip; two funded transparent addresses of node 0, one per receipt.
    let birthday = env.rpc(&["getblockcount"]).as_u64().unwrap();
    let extsk = sapling::zip32::ExtendedSpendingKey::master(&rand::random::<[u8; 32]>());
    let key =
        zcash_keys::encoding::encode_extended_spending_key("secret-extended-key-regtest", &extsk);
    let info = env
        .light(
            &data,
            "import_key",
            &json!({ "key": key, "birthday": birthday }),
        )
        .unwrap();
    let address = info["address"].as_str().unwrap().to_owned();
    let (t1, t2) = (
        env.rpc(&["getnewaddress"]).as_str().unwrap().to_owned(),
        env.rpc(&["getnewaddress"]).as_str().unwrap().to_owned(),
    );
    let c1 = env
        .rpc(&["sendtoaddress", &t1, "2.0"])
        .as_str()
        .unwrap()
        .to_owned();
    let c2 = env
        .rpc(&["sendtoaddress", &t2, "0.5"])
        .as_str()
        .unwrap()
        .to_owned();
    confirm(&env, &c1, &data);
    confirm(&env, &c2, &data);

    // The receipt, a few blocks above the birthday; the wallet syncs it.
    let z1 = z_send(&env, &t1, &address, 1.5, "lightrewind: r1");
    confirm(&env, &z1, &data);
    let h1 = env.mined_height(&z1);
    assert!(
        h1 < birthday + 10,
        "the receipt ({h1}) must lie within ten blocks of the birthday ({birthday})"
    );
    let sync = env.light(&data, "sync", &json!({})).unwrap();
    assert_eq!(sync["receivedNotes"], 1, "{sync}");
    assert_eq!(spendable(&env, &data), 150_000_000);
    record["birthday"] = json!(birthday);
    record["r1"] = json!({ "receiptHeight": h1 });

    // ---- R1: the block holding the receipt is invalidated on every node; a sync while the
    // chain stands below it; the receipt is re-mined in a competing block at the same height.
    let old = env.invalidate_from(h1);
    let during = env.light(&data, "sync", &json!({}));
    assert!(
        during.is_ok(),
        "a sync below the receipt must not fail: {during:?}"
    );
    record["r1"]["duringSync"] = json!(during.unwrap());
    env.heal_mesh();
    env.wait_mempools(&[&z1]);
    env.mine(2, &data);
    let new = env.rpc(&["getblockhash", &h1.to_string()]);
    assert_ne!(new.as_str().unwrap(), old, "a competing block at {h1}");
    assert_eq!(env.mined_height(&z1), h1, "re-mined at the same height");
    std::thread::sleep(Duration::from_secs(2));
    let t = Instant::now();
    let after = env
        .light(&data, "sync", &json!({}))
        .expect("Z-9: the sync goes through");
    record["r1"]["afterSync"] =
        json!({ "millis": t.elapsed().as_millis() as u64, "report": after });
    assert!(after["reorgs"].as_u64().unwrap() >= 1, "{after}");
    assert_eq!(
        after["birthdayRewinds"], 1,
        "rewound to the birthday: {after}"
    );
    assert_eq!(after["receivedNotes"], 1, "{after}");
    assert_eq!(
        spendable(&env, &data),
        150_000_000,
        "nothing lost or doubled"
    );
    assert_eq!(notes(&env, &data), [(z1.clone(), Some(h1))]);
    let again = env.light(&data, "sync", &json!({})).unwrap();
    assert_eq!(
        (again["reorgs"].as_u64(), again["blocksScanned"].as_u64()),
        (Some(0), Some(0))
    );

    // ---- R2: a deeper branch. A second receipt; then the chain is replaced from the birthday
    // block itself by a longer branch carrying both receipts again.
    let z2 = z_send(&env, &t2, &address, 0.25, "lightrewind: r2");
    confirm(&env, &z2, &data);
    let sync = env.light(&data, "sync", &json!({})).unwrap();
    assert_eq!(sync["receivedNotes"], 1, "{sync}");
    assert_eq!(spendable(&env, &data), 175_000_000);
    let old_tip = env.rpc(&["getblockcount"]).as_u64().unwrap();
    let old_birthday_block = env.invalidate_from(birthday);
    let during = env.light(&data, "sync", &json!({}));
    assert!(
        during.is_ok(),
        "a sync below the birthday block must not fail: {during:?}"
    );
    env.heal_mesh();
    env.wait_mempools(&[&z1, &z2]);
    let depth = old_tip - birthday + 1;
    env.mine_branch(depth as u32 + 1, &data);
    assert_ne!(
        env.rpc(&["getblockhash", &birthday.to_string()])
            .as_str()
            .unwrap(),
        old_birthday_block
    );
    let (n1, n2) = (env.mined_height(&z1), env.mined_height(&z2));
    assert!(
        n1 >= birthday && n2 >= birthday,
        "both receipts above the birthday: {n1} {n2}"
    );
    std::thread::sleep(Duration::from_secs(2));
    let t = Instant::now();
    let after = env
        .light(&data, "sync", &json!({}))
        .expect("the deeper branch syncs through");
    record["r2"] = json!({
        "replacedFrom": birthday, "replacedBlocks": depth, "newTip": old_tip + 1,
        "receiptHeights": [n1, n2],
        "afterSync": { "millis": t.elapsed().as_millis() as u64, "report": after },
    });
    assert!(after["reorgs"].as_u64().unwrap() >= 1, "{after}");
    assert_eq!(after["birthdayRewinds"], 1, "{after}");
    assert_eq!(
        spendable(&env, &data),
        175_000_000,
        "nothing lost or doubled"
    );
    let mut expected = vec![(z1.clone(), Some(n1)), (z2.clone(), Some(n2))];
    expected.sort();
    assert_eq!(notes(&env, &data), expected);

    // The rewound tree yields valid witnesses: spend 0.5 YEC and see the node accept and mine it.
    let merchant = env
        .rpc(&["z_getnewaddress", "sapling"])
        .as_str()
        .unwrap()
        .to_owned();
    let sent = env
        .light(
            &data,
            "send",
            &json!({ "to": merchant, "amountZat": 50_000_000u64, "memo": "after the rewind" }),
        )
        .expect("send after the rewind");
    let txid = sent["txid"].as_str().unwrap().to_owned();
    confirm(&env, &txid, &data);
    let received = env.rpc(&["z_listreceivedbyaddress", &merchant, "1"]);
    assert!(received
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["txid"] == txid));
    record["spendAfterRewind"] = json!({ "txid": txid, "feeZat": sent["feeZat"] });

    let path = env.scratch.join(format!("lightrewind-{}.json", env.line));
    std::fs::write(&path, serde_json::to_string_pretty(&record).unwrap()).unwrap();
    println!("{}", serde_json::to_string_pretty(&record).unwrap());
    println!("record written to {}", path.display());
}
