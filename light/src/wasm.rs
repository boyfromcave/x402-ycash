//! The browser (wasm32-unknown-unknown) storage setup: SQLite on OPFS through the sahpool VFS
//! (`sqlite-wasm-rs` + `sqlite-wasm-vfs`; yew/web plan W0.1). Must run once, in a dedicated
//! worker (OPFS sync access handles exist only there), before the first `Wallet::open` or any
//! `rusqlite::Connection::open`; later calls are no-ops.
//!
//! The pool is a fixed set of OPFS files SQLite's file names are mapped onto; its default
//! capacity is 6 (`OpfsSAHPoolCfg::default()`), and one wallet store holds three databases
//! (yew/web plan W3 finding), so [`install_opfs`] reserves [`POOL_CAPACITY`] and a store that
//! is forgotten must give its files back ([`delete_store`]) or the next restore cannot open.

use std::cell::Cell;

use sqlite_wasm_vfs::sahpool::{install, OpfsSAHPoolCfg, OpfsSAHPoolUtil};

/// The pool capacity [`install_opfs`] reserves: eight three-file stores (several wallets per
/// browser profile, a restore beside old ones, the import/export paths) plus journals.
pub const POOL_CAPACITY: u32 = 24;

thread_local! {
    static INSTALLED: Cell<bool> = const { Cell::new(false) };
}

/// The pool's management handle (`install` on the registered VFS returns it without
/// registering again).
async fn pool() -> Result<OpfsSAHPoolUtil, String> {
    install::<sqlite_wasm_rs::WasmOsCallback>(&OpfsSAHPoolCfg::default(), true)
        .await
        .map_err(|e| format!("{e:?}"))
}

/// Installs the OPFS sahpool VFS as SQLite's default VFS and reserves [`POOL_CAPACITY`]
/// files. Idempotent.
pub async fn install_opfs() -> Result<(), String> {
    if INSTALLED.with(|i| i.get()) {
        return Ok(());
    }
    let p = pool().await?;
    p.reserve_minimum_capacity(POOL_CAPACITY)
        .await
        .map_err(|e| format!("sahpool: capacity: {e:?}"))?;
    INSTALLED.with(|i| i.set(true));
    Ok(())
}

/// Grows the pool so that at least `free` files are unused (a restore beside full stores).
pub async fn ensure_free_files(free: u32) -> Result<(), String> {
    let p = pool().await?;
    p.reserve_minimum_capacity(p.count() + free)
        .await
        .map_err(|e| format!("sahpool: capacity: {e:?}"))
}

/// `(capacity, in use)` of the pool.
pub async fn capacity() -> Result<(u32, u32), String> {
    let p = pool().await?;
    Ok((p.get_capacity(), p.count()))
}

/// Every file name in the pool (the path strings the databases were opened with).
pub async fn list_files() -> Result<Vec<String>, String> {
    let mut v = pool().await?.list();
    v.sort();
    Ok(v)
}

/// Deletes every file under `dir/` from the pool (the directories of `list_stores`). The
/// store's connections must be closed first. Returns the number of files removed.
pub async fn delete_store(dir: &str) -> Result<u32, String> {
    let p = pool().await?;
    let prefix = format!("{}/", dir.trim_end_matches('/'));
    let mut n = 0;
    for f in p.list() {
        if f.starts_with(&prefix) && p.delete_db(&f).map_err(|e| format!("{f}: {e:?}"))? {
            n += 1;
        }
    }
    Ok(n)
}

/// Deletes one file from the pool (closed first); `false` when it was not there.
pub async fn delete_file(name: &str) -> Result<bool, String> {
    pool()
        .await?
        .delete_db(name)
        .map_err(|e| format!("{name}: {e:?}"))
}

/// The light library's own store directories: those holding a `wallet.sqlite`.
pub async fn list_stores() -> Result<Vec<String>, String> {
    let mut v: Vec<String> = list_files()
        .await?
        .into_iter()
        .filter_map(|f| f.strip_suffix("/wallet.sqlite").map(str::to_string))
        .collect();
    v.sort();
    Ok(v)
}
