//! The lightwalletd connection.
//!
//! The server is lightwalletd-dd (zcash/lightwalletd 0.4.6 lineage, yodl fork + Yellowback). Its
//! `CompactTxStreamer` wire format is the one `zcash_client_backend::proto::service` was generated
//! from (same field tags; `TreeState.tree` is tag 5 like `saplingTree`, `CompactTx.hash` is tag 2
//! like `txid`), so the generated client is used as is. The three `.proto` files are vendored under
//! `proto/` for provenance, and `tests` checks the methods used here exist in them.

use std::time::Duration;

use futures_util::TryStreamExt;
use tonic::transport::{Channel, Endpoint};
use zcash_client_backend::proto::compact_formats::{CompactBlock, CompactTx};
use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;
use zcash_client_backend::proto::service::{
    BlockId, BlockRange, ChainSpec, Empty, GetMempoolTxRequest, LightdInfo, RawTransaction,
    SendResponse, TreeState,
};
use zcash_protocol::consensus::BlockHeight;

pub type Client = CompactTxStreamerClient<Channel>;

/// `YellowbackStreamer` from the vendored yellowback.proto (lightwalletd-dd), for `GetChainInfo`.
pub mod yb {
    tonic::include_proto!("cash.z.wallet.sdk.rpc");
}

/// What a transaction must be signed with: the NEXT block's branch id, from
/// `YellowbackStreamer.GetChainInfo` (lightwalletd-dd 0b3448e+). Older servers answer
/// UNIMPLEMENTED; then the chaintip's id from `GetLightdInfo` is the best available (X-F71: it is
/// wrong exactly on the block before an upgrade activates).
#[derive(Debug, Clone)]
pub struct BranchInfo {
    pub height: u32,
    pub branch_id_hex: String,
    pub next_block: bool,
}

pub async fn branch_info(client: &mut Client, channel: &Channel) -> Result<BranchInfo, Error> {
    let mut yb = yb::yellowback_streamer_client::YellowbackStreamerClient::new(channel.clone());
    match yb.get_chain_info(yb::Empty {}).await {
        Ok(resp) => {
            let info = resp.into_inner();
            Ok(BranchInfo {
                height: u32::try_from(info.block_height).unwrap_or(u32::MAX),
                branch_id_hex: info.next_block_branch_id,
                next_block: true,
            })
        }
        Err(status) if status.code() == tonic::Code::Unimplemented => {
            let info = client.get_lightd_info(Empty {}).await?.into_inner();
            Ok(BranchInfo {
                height: u32::try_from(info.block_height).unwrap_or(u32::MAX),
                branch_id_hex: info.consensus_branch_id,
                next_block: false,
            })
        }
        Err(status) => Err(status.into()),
    }
}

/// Normalises the address forms the SDK accepts (README "Light agents"): `grpc://h:p` is
/// plaintext, `grpcs://h:p` is TLS, a bare `h:p` is TLS unless the host is loopback.
pub fn endpoint_url(addr: &str) -> String {
    if let Some(rest) = addr.strip_prefix("grpc://") {
        return format!("http://{rest}");
    }
    if let Some(rest) = addr.strip_prefix("grpcs://") {
        return format!("https://{rest}");
    }
    if addr.starts_with("http://") || addr.starts_with("https://") {
        return addr.to_owned();
    }
    let host = addr.rsplit_once(':').map(|(h, _)| h).unwrap_or(addr);
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1");
    if loopback {
        format!("http://{addr}")
    } else {
        format!("https://{addr}")
    }
}

/// The root store a URL-path TLS connection trusts. A host that needs anything else (a pinned
/// certificate, a client certificate, a proxy) builds its own [`Channel`] and injects it
/// (`wallet::Options::channel`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsRoots {
    /// The platform's store (`rustls-native-certs`). It has no iOS backend: every handshake
    /// fails there.
    Native,
    /// The Mozilla bundle compiled in (`webpki-roots`); works on every target.
    Webpki,
}

impl Default for TlsRoots {
    /// `Webpki` on iOS and Android (no usable native store from Rust), `Native` elsewhere.
    fn default() -> Self {
        if cfg!(any(target_os = "ios", target_os = "android")) {
            TlsRoots::Webpki
        } else {
            TlsRoots::Native
        }
    }
}

impl std::str::FromStr for TlsRoots {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "native" => Ok(TlsRoots::Native),
            "webpki" => Ok(TlsRoots::Webpki),
            _ => Err(format!("{s}: expected native or webpki")),
        }
    }
}

/// The endpoint for an address in the SDK's forms, with TLS from `roots` when the scheme asks
/// for it. Not connected.
pub fn endpoint(addr: &str, roots: TlsRoots) -> Result<Endpoint, Error> {
    let url = endpoint_url(addr);
    let mut endpoint = Endpoint::from_shared(url.clone())
        .map_err(|e| Error::Address(format!("{url}: {e}")))?
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600));
    if url.starts_with("https://") {
        let tls = tonic::transport::ClientTlsConfig::new();
        let tls = match roots {
            TlsRoots::Native => tls.with_native_roots(),
            TlsRoots::Webpki => tls.with_webpki_roots(),
        };
        endpoint = endpoint
            .tls_config(tls)
            .map_err(|e| Error::Address(format!("tls: {e}")))?;
    }
    Ok(endpoint)
}

/// Dials `addr` (the URL path, used by the `x402-light` binary).
pub async fn connect(addr: &str, roots: TlsRoots) -> Result<(Client, Channel), Error> {
    let channel = endpoint(addr, roots)?
        .connect()
        .await
        .map_err(|e| Error::Connect(endpoint_url(addr), e.to_string()))?;
    Ok((client(channel.clone()), channel))
}

/// The `CompactTxStreamer` client over a channel, dialed here or injected by the host.
pub fn client(channel: Channel) -> Client {
    // Compact blocks are small; raw transactions and tree states are too. 64 MiB like lwdprobe.
    CompactTxStreamerClient::new(channel).max_decoding_message_size(64 << 20)
}

pub async fn info(client: &mut Client) -> Result<LightdInfo, Error> {
    Ok(client.get_lightd_info(Empty {}).await?.into_inner())
}

pub async fn latest_height(client: &mut Client) -> Result<BlockHeight, Error> {
    let id = client.get_latest_block(ChainSpec {}).await?.into_inner();
    u32::try_from(id.height)
        .map(BlockHeight::from_u32)
        .map_err(|_| Error::Server("tip height does not fit u32".into()))
}

pub async fn tree_state(client: &mut Client, height: BlockHeight) -> Result<TreeState, Error> {
    Ok(client
        .get_tree_state(BlockId {
            height: u64::from(height),
            hash: vec![],
        })
        .await?
        .into_inner())
}

/// `[start, end]` inclusive, in height order.
pub async fn block_range(
    client: &mut Client,
    start: BlockHeight,
    end: BlockHeight,
) -> Result<Vec<CompactBlock>, Error> {
    let range = BlockRange {
        start: Some(BlockId {
            height: u64::from(start),
            hash: vec![],
        }),
        end: Some(BlockId {
            height: u64::from(end),
            hash: vec![],
        }),
        pool_types: vec![],
    };
    Ok(client
        .get_block_range(range)
        .await?
        .into_inner()
        .try_collect()
        .await?)
}

/// The raw `GetBlockRange` stream, for a producer that scans while downloading.
pub async fn block_stream(
    client: &mut Client,
    start: BlockHeight,
    end: BlockHeight,
) -> Result<tonic::Streaming<CompactBlock>, Error> {
    let range = BlockRange {
        start: Some(BlockId {
            height: u64::from(start),
            hash: vec![],
        }),
        end: Some(BlockId {
            height: u64::from(end),
            hash: vec![],
        }),
        pool_types: vec![],
    };
    Ok(client.get_block_range(range).await?.into_inner())
}

/// Shielded transactions in the server's mempool (X-F70: lightwalletd streams only transactions
/// with Sapling parts, which is exactly what a Sapling wallet wants).
pub async fn mempool(client: &mut Client) -> Result<Vec<CompactTx>, Error> {
    let txs: Vec<CompactTx> = client
        .get_mempool_tx(GetMempoolTxRequest::default())
        .await?
        .into_inner()
        .try_collect()
        .await?;
    Ok(txs)
}

pub async fn send(client: &mut Client, raw: Vec<u8>) -> Result<SendResponse, Error> {
    Ok(client
        .send_transaction(RawTransaction {
            data: raw,
            height: 0,
        })
        .await?
        .into_inner())
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("bad lightwalletd address: {0}")]
    Address(String),
    #[error("cannot connect to lightwalletd at {0}: {1}")]
    Connect(String, String),
    #[error("lightwalletd: {0}")]
    Grpc(#[from] tonic::Status),
    #[error("lightwalletd misbehaved: {0}")]
    Server(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_forms_follow_the_sdk() {
        assert_eq!(
            endpoint_url("grpc://127.0.0.1:9067"),
            "http://127.0.0.1:9067"
        );
        assert_eq!(
            endpoint_url("grpcs://lwd.example:9067"),
            "https://lwd.example:9067"
        );
        assert_eq!(endpoint_url("127.0.0.1:9067"), "http://127.0.0.1:9067");
        assert_eq!(endpoint_url("localhost:9067"), "http://localhost:9067");
        assert_eq!(endpoint_url("lwd.example:9067"), "https://lwd.example:9067");
        assert_eq!(endpoint_url("http://x:1"), "http://x:1");
    }

    /// The vendored lightwalletd-dd service.proto must offer every RPC this client calls.
    #[test]
    fn vendored_proto_has_the_methods_we_use() {
        let proto = include_str!("../proto/service.proto");
        for rpc in [
            "GetLightdInfo",
            "GetLatestBlock",
            "GetTreeState",
            "GetBlockRange",
            "GetMempoolTx",
            "SendTransaction",
            "GetTransaction",
        ] {
            assert!(
                proto.contains(&format!("rpc {rpc}(")),
                "{rpc} missing from proto/service.proto"
            );
        }
        // Absent in the 0.4.6 lineage; sync.rs works around both (see README "Findings").
        assert!(!proto.contains("rpc GetSubtreeRoots("));
        assert!(include_str!("../proto/yellowback.proto").contains("rpc GetChainInfo("));
        assert!(!include_str!("../proto/compact_formats.proto").contains("ChainMetadata"));
    }
}
