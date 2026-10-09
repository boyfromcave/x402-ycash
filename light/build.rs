//! Compiles the vendored protos (lightwalletd-dd) into the two clients `src/lwd.rs` uses —
//! `CompactTxStreamer` and `YellowbackStreamer` — over `zcash_client_backend`'s message types
//! (`extern_path`, the way librustzcash generates its own client: the scanner's `CompactBlock`
//! and `TreeState::to_chain_state` stay the backend's), and server stubs for the unit tests'
//! fake lightwalletd. Needs `protoc` on PATH (brew install protobuf / apt install
//! protobuf-compiler).
//!
//! The client is generated here rather than taken from `zcash_client_backend`'s
//! `lightwalletd-tonic` feature because that one carries a `connect` over
//! `tonic::transport::Channel`, which the wasm32 build (gRPC-web, no tonic transport; yew/web
//! plan W0.4) has no feature for. The channel is injected on both targets.
fn main() {
    println!("cargo:rerun-if-changed=proto/yellowback.proto");
    println!("cargo:rerun-if-changed=proto/service.proto");
    println!("cargo:rerun-if-changed=proto/compact_formats.proto");
    const BACKEND_SERVICE: &[(&str, &str)] = &[
        ("BlockID", "BlockId"),
        ("BlockRange", "BlockRange"),
        ("TxFilter", "TxFilter"),
        ("RawTransaction", "RawTransaction"),
        ("SendResponse", "SendResponse"),
        ("ChainSpec", "ChainSpec"),
        ("Empty", "Empty"),
        ("LightdInfo", "LightdInfo"),
        (
            "TransparentAddressBlockFilter",
            "TransparentAddressBlockFilter",
        ),
        ("Duration", "Duration"),
        ("PingResponse", "PingResponse"),
        ("Address", "Address"),
        ("AddressList", "AddressList"),
        ("Balance", "Balance"),
        // Same wire shape (tag 1: repeated bytes); upstream renamed it.
        ("Exclude", "GetMempoolTxRequest"),
        ("TreeState", "TreeState"),
        ("GetAddressUtxosArg", "GetAddressUtxosArg"),
        ("GetAddressUtxosReply", "GetAddressUtxosReply"),
        ("GetAddressUtxosReplyList", "GetAddressUtxosReplyList"),
    ];
    const BACKEND_COMPACT: &[(&str, &str)] = &[
        ("CompactBlock", "CompactBlock"),
        ("CompactTx", "CompactTx"),
        ("CompactSpend", "CompactSaplingSpend"),
        ("CompactOutput", "CompactSaplingOutput"),
    ];
    let mut clients = tonic_prost_build::configure()
        .build_server(false)
        // No `connect` on the generated clients (it names `tonic::transport::Channel`).
        .build_transport(false);
    for (proto, rust) in BACKEND_SERVICE {
        clients = clients.extern_path(
            format!(".cash.z.wallet.sdk.rpc.{proto}"),
            format!("::zcash_client_backend::proto::service::{rust}"),
        );
    }
    for (proto, rust) in BACKEND_COMPACT {
        clients = clients.extern_path(
            format!(".cash.z.wallet.sdk.rpc.{proto}"),
            format!("::zcash_client_backend::proto::compact_formats::{rust}"),
        );
    }
    clients
        .compile_protos(
            &["proto/service.proto", "proto/yellowback.proto"],
            &["proto"],
        )
        .expect("protoc compiles proto/yellowback.proto");
    // Server stubs of both services, for the in-process fake lightwalletd of the unit tests
    // (`src/lwd.rs` tests); included only under cfg(test).
    let fake = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("fake");
    std::fs::create_dir_all(&fake).expect("create OUT_DIR/fake");
    tonic_prost_build::configure()
        .build_client(false)
        .build_server(true)
        .generate_default_stubs(true)
        .out_dir(&fake)
        .compile_protos(
            &["proto/service.proto", "proto/yellowback.proto"],
            &["proto"],
        )
        .expect("protoc compiles the fake server stubs");
}
