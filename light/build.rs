//! Compiles the vendored `proto/yellowback.proto` (YellowbackStreamer, lightwalletd-dd) for
//! `GetChainInfo`, and server stubs for the unit tests' fake lightwalletd. Needs `protoc` on PATH
//! (brew install protobuf / apt install protobuf-compiler).
fn main() {
    println!("cargo:rerun-if-changed=proto/yellowback.proto");
    println!("cargo:rerun-if-changed=proto/service.proto");
    println!("cargo:rerun-if-changed=proto/compact_formats.proto");
    tonic_prost_build::configure()
        .build_server(false)
        .compile_protos(&["proto/yellowback.proto"], &["proto"])
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
