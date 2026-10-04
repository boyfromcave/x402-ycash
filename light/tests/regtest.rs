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

    /// Mines on the devnet, then waits until lightwalletd has ingested the new tip: its ingestor
    /// polls the node every couple of seconds (0.4.6 lineage), and a sync issued before that
    /// simply stops at the old tip.
    fn mine(&self, n: u32, data: &PathBuf) {
        self.devnet(&["mine", &n.to_string()]);
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
