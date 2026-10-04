//! `x402-ycash-light`: a Sapling light client core for agents on Ycash, on librustzcash6
//! (`zcash_client_backend` 0.22 / `zcash_client_sqlite` 0.20 with Ycash's branch ids and HRPs).
//!
//! - [`net`]: Ycash mainnet/testnet/regtest parameters.
//! - [`keys`]: Sapling key import (extended spending key or seed phrase), encodings, the USK wrapper.
//! - [`lwd`]: the lightwalletd-dd connection (`CompactTxStreamer` + `YellowbackStreamer.GetChainInfo`).
//! - [`sync`]: compact-block sync with overlapped download/scan and checkpoint reorgs.
//! - [`wallet`]: the store, balances, build/prove/sign and broadcast.
//!
//! The spending key is injected by the embedding application (`wallet::Options::spending_key`,
//! `Wallet::register_key`); the `x402-light` binary adds the JSON-RPC server and key file on top.

pub mod keys;
pub mod lwd;
pub mod net;
pub mod sync;
pub mod wallet;

pub use net::YcashNetwork;
pub use wallet::{Options, Wallet};
