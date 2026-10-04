//! `x402-light`: a Sapling light client for x402 agents on Ycash.
//!
//! `serve` runs the JSON-RPC server (schema.json) with a background sync loop; `once` runs one
//! method and prints its result, for scripts and the integration test.

mod rpc;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};
use serde_json::Value;
use tokio::sync::Mutex;

use x402_ycash_light::{keys, lwd, sync, Options, Wallet, YcashNetwork};

#[derive(Parser)]
#[command(
    name = "x402-light",
    version,
    about = "Sapling light client for x402 agents on Ycash"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args, Clone)]
struct Common {
    /// Wallet data directory (wallet.sqlite, cache/, spending.key)
    #[arg(long, env = "X402_LIGHT_DATA")]
    data: PathBuf,
    /// lightwalletd address: grpc://host:port, grpcs://host:port or host:port (TLS unless loopback)
    #[arg(long, env = "X402_LIGHT_LWD")]
    lwd: String,
    /// Directory holding sapling-spend.params and sapling-output.params (needed by build/send)
    #[arg(long, env = "X402_LIGHT_PARAMS")]
    params: Option<PathBuf>,
    /// mainnet, testnet or regtest
    #[arg(long, env = "X402_LIGHT_NETWORK", default_value = "mainnet")]
    network: YcashNetwork,
    /// TLS root store for grpcs:// and non-loopback host:port: native (the platform's) or webpki
    /// (the Mozilla bundle; the default on iOS and Android)
    #[arg(long, env = "X402_LIGHT_TLS_ROOTS")]
    tls_roots: Option<lwd::TlsRoots>,
    /// Regtest activation heights, e.g. "canopy=1,nu5=none" (default: every upgrade through Canopy at 1)
    #[arg(long, env = "X402_LIGHT_UPGRADES")]
    upgrades: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    /// Serve JSON-RPC 2.0 on loopback and keep syncing in the background
    Serve {
        #[command(flatten)]
        common: Common,
        /// Address to bind; port 0 picks a free one. The bound address is printed as "listening ADDR".
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,
        /// Seconds between background sync passes (0 disables the loop)
        #[arg(long, default_value_t = 15)]
        sync_every: u64,
    },
    /// Run one method (see schema.json) with JSON params and print the result
    Once {
        #[command(flatten)]
        common: Common,
        /// status | address | export_fvk | import_key | sync | list_notes | build | send | broadcast
        method: String,
        /// JSON object of parameters, e.g. '{"to":"ys1…","amountZat":1000}'
        #[arg(default_value = "null")]
        params_json: String,
    },
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("x402_ycash_light=info".parse().expect("directive")),
        )
        .with_writer(std::io::stderr)
        .init();
    if let Err(e) = run(Cli::parse()).await {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

async fn open(common: &Common) -> Result<Wallet, String> {
    let mut network = common.network;
    if let Some(spec) = &common.upgrades {
        network = network.with_upgrades(spec)?;
    }
    // The binary keeps the key in <data>/spending.key (rpc::import_key writes it, mode 0600).
    let spending_key = match std::fs::read_to_string(rpc::key_path(&common.data)) {
        Ok(s) => Some(keys::decode_extsk(&network, &s).map_err(|e| e.to_string())?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    Wallet::open(Options {
        data_dir: common.data.clone(),
        lwd: common.lwd.clone(),
        params: network,
        proving_params_dir: common.params.clone(),
        spending_key,
        channel: None,
        tls_roots: common.tls_roots.unwrap_or_default(),
    })
    .await
    .map_err(|e| e.to_string())
}

async fn run(cli: Cli) -> Result<(), String> {
    match cli.command {
        Command::Once {
            common,
            method,
            params_json,
        } => {
            let params: Value =
                serde_json::from_str(&params_json).map_err(|e| format!("params: {e}"))?;
            let shared = Arc::new(Mutex::new(open(&common).await?));
            match rpc::dispatch(&shared, &method, &params).await {
                Ok(v) => {
                    println!("{}", serde_json::to_string_pretty(&v).expect("json"));
                    Ok(())
                }
                Err((code, msg)) => Err(format!("{msg} (code {code})")),
            }
        }
        Command::Serve {
            common,
            listen,
            sync_every,
        } => {
            let shared = Arc::new(Mutex::new(open(&common).await?));
            if sync_every > 0 {
                let bg = shared.clone();
                tokio::spawn(async move {
                    loop {
                        {
                            let mut g = bg.lock().await;
                            if g.has_key() {
                                match g.sync(sync::DEFAULT_CHUNK_BLOCKS).await {
                                    Ok(r) if r.blocksScanned > 0 => tracing::info!(
                                        "sync: {} blocks to {}",
                                        r.blocksScanned,
                                        r.tipHeight
                                    ),
                                    Ok(_) => {}
                                    Err(e) => tracing::warn!("sync failed: {e}"),
                                }
                            }
                        }
                        tokio::time::sleep(Duration::from_secs(sync_every)).await;
                    }
                });
            }
            rpc::serve(shared, listen).await.map_err(|e| e.to_string())
        }
    }
}
