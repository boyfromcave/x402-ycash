//! Compiles the vendored `proto/yellowback.proto` (YellowbackStreamer, lightwalletd-dd) for
//! `GetChainInfo`. Needs `protoc` on PATH (brew install protobuf / apt install protobuf-compiler).
fn main() {
    println!("cargo:rerun-if-changed=proto/yellowback.proto");
    println!("cargo:rerun-if-changed=proto/service.proto");
    println!("cargo:rerun-if-changed=proto/compact_formats.proto");
    tonic_prost_build::configure()
        .build_server(false)
        .compile_protos(&["proto/yellowback.proto"], &["proto"])
        .expect("protoc compiles proto/yellowback.proto");
}
