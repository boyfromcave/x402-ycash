//! `x402-ycash-light`: a Sapling light client core for agents on Ycash, on librustzcash6
//! (`zcash_client_backend` 0.22 / `zcash_client_sqlite` 0.20 with Ycash's branch ids and HRPs).
//!
//! - [`net`]: Ycash mainnet/testnet/regtest parameters.
//! - [`keys`]: Sapling key import (extended spending key or seed phrase), encodings, the USK wrapper.
//! - [`lwd`]: the lightwalletd-dd connection (`CompactTxStreamer` + `YellowbackStreamer.GetChainInfo`).
//! - [`sync`]: compact-block sync with overlapped download/scan and checkpoint reorgs.
//! - [`spend`]: v4 transaction assembly from a proposal with the caller's `nExpiryHeight`.
//! - [`wallet`]: the store, balances, build/prove/sign and broadcast.
//!
//! The spending key is injected by the embedding application (`wallet::Options::spending_key`,
//! `Wallet::register_key`), and so can the lightwalletd channel (`wallet::Options::channel`, for a
//! host with its own TLS: a pinned certificate, webpki roots on iOS). The `x402-light` binary adds
//! the JSON-RPC server and key file on top.

pub mod keys;
pub mod lwd;
pub mod net;
pub mod spend;
pub mod sync;
pub mod wallet;

#[cfg(test)]
mod fake_lwd;

pub use net::YcashNetwork;
pub use wallet::{Options, Wallet};
