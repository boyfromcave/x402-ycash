//! The compact-block cache: `zcash_client_sqlite::BlockDb` (the SQLite block source, one table
//! `compactblocks(height, data)`) in one file beside `wallet.sqlite`, on both targets (yew/web
//! plan W0.2). On native it replaces `FsBlockDb` (`blocks/` + `blockmeta.sqlite`); in the browser
//! it is one more SQLite file on the OPFS sahpool VFS, where `std::fs` does not exist.
//!
//! `BlockDb` owns its connection privately and offers no write API, and the sahpool VFS allows
//! one connection per file name at a time (W0.1 finding 3). So this type holds only the path:
//! writes and truncation go through a short-lived `rusqlite::Connection`, and the `BlockSource`
//! impl opens the `BlockDb` per `with_blocks` call and drops it after. Opening is cheap on both
//! targets (sahpool pools the handle; natively it is one `open(2)` plus the header read).

use prost::Message;
use zcash_client_backend::data_api::chain::error::Error as ChainError;
use zcash_client_backend::data_api::chain::BlockSource;
use zcash_client_backend::proto::compact_formats::CompactBlock;
use zcash_client_sqlite::chain::init::init_cache_database;
use zcash_client_sqlite::error::SqliteClientError;
use zcash_client_sqlite::BlockDb;
use zcash_protocol::consensus::BlockHeight;

/// The cache file; `open` creates its table. Holds no connection between operations.
pub struct BlockCache {
    path: String,
}

impl BlockCache {
    /// Creates the `compactblocks` table if the file is new.
    pub fn open(path: &str) -> Result<Self, rusqlite::Error> {
        let db = BlockDb::for_path(path)?;
        init_cache_database(&db)?;
        Ok(BlockCache {
            path: path.to_owned(),
        })
    }

    /// The file.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Writes the blocks (encoded protobufs) under their heights, replacing any at the same
    /// height (a reorg re-fetch). One transaction.
    pub fn insert(&self, blocks: &[CompactBlock]) -> Result<(), rusqlite::Error> {
        let mut conn = rusqlite::Connection::open(&self.path)?;
        let tx = conn.transaction()?;
        {
            let mut stmt =
                tx.prepare("INSERT OR REPLACE INTO compactblocks (height, data) VALUES (?, ?)")?;
            for block in blocks {
                stmt.execute(rusqlite::params![
                    u32::from(block.height()),
                    block.encode_to_vec()
                ])?;
            }
        }
        tx.commit()
    }

    /// Drops every cached block (they are re-fetched on demand; keeping them is waste).
    pub fn truncate(&self) -> Result<(), rusqlite::Error> {
        let conn = rusqlite::Connection::open(&self.path)?;
        conn.execute("DELETE FROM compactblocks", [])?;
        Ok(())
    }
}

/// Runs the batch-decryption jobs `scan_cached_blocks` has handed to rayon.
///
/// `zcash_client_backend` trial-decrypts outputs in batches it `rayon::spawn_fifo`s and then
/// blocks on a channel for the results. Without threads (wasm32 without atomics) rayon falls back
/// to a one-worker pool on the current thread whose spawned jobs run only when something yields to
/// it — nothing in the scanner does, so the first `collect_results` would wait forever (W0.2
/// finding 2). Yielding from the block source, between rows, runs them on this thread instead.
/// Native builds have real worker threads and need nothing.
#[inline]
fn run_pending_batches() {
    #[cfg(target_arch = "wasm32")]
    while rayon::yield_now() == Some(rayon::Yield::Executed) {}
}

impl BlockSource for BlockCache {
    type Error = SqliteClientError;

    fn with_blocks<F, DbErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_row: F,
    ) -> Result<(), ChainError<DbErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<DbErrT, Self::Error>>,
    {
        let db = BlockDb::for_path(&self.path).map_err(|e| ChainError::BlockSource(e.into()))?;
        run_pending_batches();
        db.with_blocks(from_height, limit, |block| {
            let r = with_row(block);
            run_pending_batches();
            r
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_client_backend::proto::compact_formats::ChainMetadata;

    fn block(height: u32) -> CompactBlock {
        let mut hash = vec![0u8; 32];
        hash[..4].copy_from_slice(&height.to_le_bytes());
        CompactBlock {
            height: u64::from(height),
            hash,
            prev_hash: vec![0; 32],
            time: 1_600_000_000 + height,
            chain_metadata: Some(ChainMetadata {
                sapling_commitment_tree_size: 0,
                orchard_commitment_tree_size: 0,
            }),
            ..Default::default()
        }
    }

    fn read(cache: &BlockCache, from: u32, limit: usize) -> Result<Vec<CompactBlock>, String> {
        let mut out = Vec::new();
        cache
            .with_blocks::<_, ()>(Some(BlockHeight::from_u32(from)), Some(limit), |b| {
                out.push(b);
                Ok(())
            })
            .map_err(|e| format!("{e:?}"))?;
        Ok(out)
    }

    /// Blocks written in one session are read back byte-identical through the `BlockSource`
    /// API after the cache is dropped and reopened; a start height that is not cached is a
    /// miss, not a skip; truncation empties it.
    #[test]
    fn roundtrip_reopen_miss_truncate() {
        let dir = crate::fake_lwd::temp_data_dir("cache");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cache.sqlite").to_string_lossy().into_owned();
        let blocks: Vec<_> = (1..=3).map(block).collect();
        {
            let cache = BlockCache::open(&path).unwrap();
            cache.insert(&blocks).unwrap();
        }
        let cache = BlockCache::open(&path).unwrap();
        assert_eq!(read(&cache, 1, 10).unwrap(), blocks);
        assert_eq!(read(&cache, 2, 1).unwrap().len(), 1);
        assert!(read(&cache, 7, 1).is_err(), "cache miss");
        cache.truncate().unwrap();
        assert!(read(&cache, 1, 10).is_err(), "truncated");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
