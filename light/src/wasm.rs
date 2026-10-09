//! The browser (wasm32-unknown-unknown) storage setup: SQLite on OPFS through the sahpool VFS
//! (`sqlite-wasm-rs` + `sqlite-wasm-vfs`; yew/web plan W0.1). Must run once, in a dedicated
//! worker (OPFS sync access handles exist only there), before the first `Wallet::open` or any
//! `rusqlite::Connection::open`; later calls are no-ops.

use std::cell::Cell;

thread_local! {
    static INSTALLED: Cell<bool> = const { Cell::new(false) };
}

/// Installs the OPFS sahpool VFS as SQLite's default VFS. Idempotent.
pub async fn install_opfs() -> Result<(), String> {
    if INSTALLED.with(|i| i.get()) {
        return Ok(());
    }
    use sqlite_wasm_vfs::sahpool::{install, OpfsSAHPoolCfg};
    install::<sqlite_wasm_rs::WasmOsCallback>(&OpfsSAHPoolCfg::default(), true)
        .await
        .map_err(|e| format!("{e:?}"))?;
    INSTALLED.with(|i| i.set(true));
    Ok(())
}
