//! Compact-block sync against lightwalletd-dd.
//!
//! `zcash_client_backend::sync::run` reduced to what the 0.4.6 lineage serves, with the three
//! techniques of hhanh00's zcash-sync (YWallet's Ycash wallet) that matter here:
//!
//! 1. **Download and scan overlap.** `GetBlockRange` is streamed by a producer task into a bounded
//!    channel of chunks cut by *output count* (Ycash blocks average 0.14 Sapling outputs, so a
//!    chunk of a few hundred outputs spans thousands of blocks; a block cap bounds memory), and the
//!    wallet scans each chunk while the next downloads.
//! 2. **Bootstrap from a `GetTreeState` checkpoint** at birthday − 1; nothing before the birthday
//!    is ever scanned. No `GetSubtreeRoots` exists on Ycash (`z_getsubtreesbyindex` is absent on
//!    4.5.0), so the shard tree is frontier-only, fed by scanned blocks: a note is spendable only
//!    once the wallet is fully synced from its birthday, never from a partial scan.
//! 3. **Reorg by checkpoint.** Each chunk's first `prev_hash` is compared with the wallet's stored
//!    hash for the block before it; on a mismatch (or a continuity error inside the scanner) the
//!    wallet truncates to the previous checkpoint and resumes from the suggested ranges in the
//!    same pass. A rewind the store refuses (no checkpoint at or below it since the birthday:
//!    a reorg within [`REORG_REWIND`] blocks of the birthday, YEW Z-9) goes instead to the block
//!    before the birthday with the server's chain state for it (`Wallet::rewind_for_reorg`).
//!
//! Two gaps in the 0.4.6 wire format are bridged locally: `CompactBlock.chainMetadata` is absent,
//! so the Sapling tree size after each block (needed for note positions and nullifiers) is
//! computed from the checkpoint's frontier plus each block's outputs and attached before caching.

use std::fs;
use std::time::Instant;

use futures_util::StreamExt;
use prost::Message;
use serde::Serialize;
use tokio::sync::mpsc;
use zcash_client_backend::data_api::chain::{
    error::Error as ChainError, scan_cached_blocks, ChainState,
};
use zcash_client_backend::data_api::scanning::{ScanPriority, ScanRange};
use zcash_client_backend::data_api::{WalletCommitmentTrees, WalletRead, WalletWrite};
use zcash_client_backend::proto::compact_formats::{ChainMetadata, CompactBlock};
use zcash_client_sqlite::chain::BlockMeta;
use zcash_client_sqlite::error::SqliteClientError;
use zcash_primitives::block::BlockHash;
use zcash_protocol::consensus::BlockHeight;

use crate::lwd;
use crate::net::parse_branch_id;
use crate::wallet::{Error, Wallet};

/// Chunking: cut a chunk once it holds this many Sapling outputs, or this many blocks.
pub const CHUNK_OUTPUTS: u32 = 1_000;
pub const DEFAULT_CHUNK_BLOCKS: u32 = 2_000;
/// Blocks to rewind below a mismatch, as `sync::run` does.
pub const REORG_REWIND: u32 = 10;
/// Refused rewinds answered from the birthday per sync, after which the refusal is returned: a
/// bound for a server whose chain keeps changing under the birthday (each one rescans from it).
pub const MAX_BIRTHDAY_REWINDS: u32 = 3;
/// The deepest reorg either node line accepts: `MAX_REORG_LENGTH = COINBASE_MATURITY - 1`
/// (ycash-dd `src/main.h:62`, ycash6 `src/main.h:66`), rounded up.
const MAX_REORG_DEPTH: u32 = 100;

#[allow(non_snake_case)]
#[derive(Debug, Default, Serialize)]
pub struct SyncReport {
    pub tipHeight: u32,
    pub scannedHeight: Option<u32>,
    pub blocksScanned: u32,
    pub chunksScanned: u32,
    pub outputsScanned: u64,
    pub reorgs: u32,
    /// Reorgs whose rewind the store refused (no checkpoint at or below it, e.g. within
    /// [`REORG_REWIND`] blocks of the birthday), answered by rewinding to the block before the
    /// birthday and rescanning from there; also counted in `reorgs`.
    pub birthdayRewinds: u32,
    pub receivedNotes: u32,
    pub spentNotes: u32,
    pub downloadMillis: u128,
    pub scanMillis: u128,
    pub millis: u128,
    pub branchIdChecked: bool,
}

impl Wallet {
    /// One pass: tip, suggested ranges, stream + scan each, until nothing is left to scan.
    pub async fn sync(&mut self, chunk_blocks: u32) -> Result<SyncReport, Error> {
        let started = Instant::now();
        let mut report = SyncReport::default();
        self.account()?;
        let chunk_blocks = chunk_blocks.max(1);

        // X-F71: lightwalletd's GetLightdInfo reports the chaintip's branch id. We check our
        // parameters agree with the server at the tip, which catches a wrong --network or
        // --upgrades before any transaction is built with the wrong branch id.
        let info = lwd::info(&mut self.client).await?;
        if let Some(server_branch) = parse_branch_id(&info.consensus_branch_id) {
            let tip = BlockHeight::from_u32(u32::try_from(info.block_height).unwrap_or(0));
            let ours = self.params.branch_id_at(tip);
            if ours != server_branch {
                return Err(Error::Server(format!(
                    "branch id mismatch at height {tip}: lightwalletd says {:?} ({}), our parameters say {:?}; check --network/--upgrades",
                    server_branch, info.consensus_branch_id, ours
                )));
            }
            report.branchIdChecked = true;
        }
        // lightwalletd prints "main", "test" or "regtest".
        if info.chain_name != self.params.name().trim_end_matches("net") {
            return Err(Error::Server(format!(
                "lightwalletd serves chain {:?}, this wallet is {}",
                info.chain_name,
                self.params.name()
            )));
        }

        let tip = lwd::latest_height(&mut self.client).await?;
        report.tipHeight = u32::from(tip);
        self.db.update_chain_tip(tip)?;

        'outer: loop {
            let ranges: Vec<ScanRange> = self
                .db
                .suggest_scan_ranges()?
                .into_iter()
                .filter(|r| r.priority() != ScanPriority::Ignored && !r.is_empty())
                .collect();
            let Some(range) = ranges.into_iter().next() else {
                break;
            };
            tracing::info!("scan range {range}");

            match self.scan_range(&range, chunk_blocks, &mut report).await? {
                RangeOutcome::Done => {}
                RangeOutcome::Reorg(at) => {
                    report.reorgs += 1;
                    if self.rewind_for_reorg(at, report.birthdayRewinds).await? == Rewind::Birthday
                    {
                        report.birthdayRewinds += 1;
                    }
                    // The rewind trimmed the scan queue, and the chain tip with it, to the rewound
                    // height: restore the tip so this pass rescans the new branch.
                    let tip = lwd::latest_height(&mut self.client).await?;
                    report.tipHeight = u32::from(tip);
                    self.db.update_chain_tip(tip)?;
                }
                RangeOutcome::HigherPriority => {}
            }
            self.clear_cache()?;
            continue 'outer;
        }

        report.scannedHeight = self
            .db
            .get_wallet_summary(crate::wallet::default_policy())?
            .map(|s| u32::from(s.fully_scanned_height()));
        report.millis = started.elapsed().as_millis();
        Ok(report)
    }

    /// Rewinds the store for a reorg detected at `at`: to the latest checkpoint at or below
    /// `at - REORG_REWIND`, as `sync::run` does. The store refuses (`RequestedRewindInvalid`) when
    /// it has no such checkpoint among the blocks it scanned, which start at the birthday and are
    /// checkpointed only where they hold a note commitment: every reorg within ten blocks of the
    /// birthday (a new or freshly restored wallet's first blocks), and any reorg on a chain with no
    /// Sapling output between the birthday and the rewind height. Without an answer the sync
    /// would fail at that refusal on this and every later call (YEW Z-9).
    ///
    /// The answer is the block before the birthday, where scanning starts anyway (no note of this
    /// account predates it): the store is truncated to the chain state the server reports for that
    /// height (`GetTreeState`), not the one saved at import, so it is right even when the reorg
    /// replaced the birthday block itself. Only the refusal is handled this way, and at most
    /// `MAX_BIRTHDAY_REWINDS` times per sync (`done` so far); any other error is returned.
    pub(crate) async fn rewind_for_reorg(
        &mut self,
        at: BlockHeight,
        done: u32,
    ) -> Result<Rewind, Error> {
        let rewind = at.saturating_sub(REORG_REWIND);
        tracing::warn!("chain reorg at {at}, rewinding to checkpoint {rewind}");
        match self.db.truncate_to_height(rewind) {
            Ok(_) => Ok(Rewind::Checkpoint),
            Err(SqliteClientError::RequestedRewindInvalid {
                safe_rewind_height,
                requested_height,
            }) if done < MAX_BIRTHDAY_REWINDS => {
                let birthday = self.db.get_account_birthday(self.account()?)?;
                let below = birthday - 1;
                tracing::warn!(
                    "rewind to {requested_height} refused (oldest checkpoint {safe_rewind_height:?}); rewinding to {below}, the block before the birthday"
                );
                let state = self.chain_state_at(below).await?;
                match self.db.truncate_to_chain_state(state) {
                    Ok(()) => {}
                    // The branch also replaced note commitments below the birthday, so the
                    // server's frontier there conflicts with the leaves saved at import. Go to
                    // a height below any reorg the node accepts (MAX_REORG_LENGTH), whose
                    // frontier both chains share, and drop every leaf after it. One
                    // transaction: the store either keeps its old state or has the new one.
                    // Scanning still starts at the birthday, from the server's state there.
                    Err(SqliteClientError::CommitmentTree(e)) => {
                        let deeper = below.saturating_sub(MAX_REORG_DEPTH);
                        tracing::warn!(
                            "the tree state at {below} changed ({e}); rewinding the tree to {deeper}"
                        );
                        let state = self.chain_state_at(deeper).await?;
                        self.db.transactionally(|wdb| {
                            wdb.truncate_to_chain_state(state)?;
                            wdb.with_sapling_tree_mut(|tree| {
                                tree.truncate_to_checkpoint(&deeper)?;
                                Ok::<_, SqliteClientError>(())
                            })
                        })?;
                    }
                    Err(e) => return Err(e.into()),
                }
                Ok(Rewind::Birthday)
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Streams `range` from lightwalletd in a producer task, chunking by outputs/blocks, and scans
    /// each chunk as it lands. Stops early on a reorg or when scanning raised a higher-priority range.
    async fn scan_range(
        &mut self,
        range: &ScanRange,
        chunk_blocks: u32,
        report: &mut SyncReport,
    ) -> Result<RangeOutcome, Error> {
        let start = range.block_range().start;
        let end = range.block_range().end - 1;

        // The checkpoint: the chain state at the block before the range (one GetTreeState call).
        let t0 = Instant::now();
        let mut prior: ChainState = self.chain_state_at(start - 1).await?;
        report.downloadMillis += t0.elapsed().as_millis();

        // Reorg by checkpoint, before any scanning: does the wallet's stored hash for start-1
        // still match what the server says? (The scanner re-checks prev_hash per block.)
        if let Some(stored) = self.db.get_block_hash(start - 1)? {
            if stored != prior.block_hash() {
                return Ok(RangeOutcome::Reorg(start - 1));
            }
        }

        let (tx, mut rx) = mpsc::channel::<Result<Vec<CompactBlock>, lwd::Error>>(2);
        let mut client = self.client.clone();
        let producer = tokio::spawn(async move {
            let mut stream = match lwd::block_stream(&mut client, start, end).await {
                Ok(s) => s,
                Err(e) => {
                    let _ = tx.send(Err(e)).await;
                    return;
                }
            };
            let mut chunk: Vec<CompactBlock> = Vec::new();
            let mut outputs = 0u32;
            while let Some(item) = stream.next().await {
                match item {
                    Ok(block) => {
                        outputs += block
                            .vtx
                            .iter()
                            .map(|t| t.outputs.len() as u32)
                            .sum::<u32>();
                        chunk.push(block);
                        if outputs >= CHUNK_OUTPUTS || chunk.len() as u32 >= chunk_blocks {
                            if tx.send(Ok(std::mem::take(&mut chunk))).await.is_err() {
                                return;
                            }
                            outputs = 0;
                        }
                    }
                    Err(status) => {
                        let _ = tx.send(Err(status.into())).await;
                        return;
                    }
                }
            }
            if !chunk.is_empty() {
                let _ = tx.send(Ok(chunk)).await;
            }
        });

        let mut outcome = RangeOutcome::Done;
        let mut expected = start;
        while let Some(item) = rx.recv().await {
            let blocks = item?;
            let Some(first) = blocks.first() else {
                continue;
            };
            if first.height() != expected {
                producer.abort();
                return Err(Error::Server(format!(
                    "block stream jumped from {expected} to {}",
                    first.height()
                )));
            }
            if first.prev_hash() != prior.block_hash() {
                outcome = RangeOutcome::Reorg(first.height());
                break;
            }
            let t1 = Instant::now();
            let (next_state, summary) = match self.scan_chunk(blocks, &prior) {
                Ok(ok) => ok,
                Err(ChainError::Scan(err)) if err.is_continuity_error() => {
                    outcome = RangeOutcome::Reorg(err.at_height());
                    break;
                }
                Err(e) => {
                    producer.abort();
                    return Err(e.into());
                }
            };
            report.scanMillis += t1.elapsed().as_millis();
            report.blocksScanned += summary.blocks;
            report.outputsScanned += u64::from(summary.outputs);
            report.chunksScanned += 1;
            report.receivedNotes += summary.received;
            report.spentNotes += summary.spent;
            expected = next_state.block_height() + 1;
            prior = next_state;

            // A found note may have raised a Verify/FoundNote range above this one: let the
            // outer loop re-ask for ranges.
            if let Some(top) = self.db.suggest_scan_ranges()?.first() {
                if top.priority() > range.priority() {
                    outcome = RangeOutcome::HigherPriority;
                    break;
                }
            }
        }
        producer.abort();
        Ok(outcome)
    }

    /// Attaches the synthesized tree sizes, caches the chunk, scans it, and returns the chain
    /// state at its last block (the next chunk's checkpoint) with counts.
    fn scan_chunk(
        &mut self,
        mut blocks: Vec<CompactBlock>,
        prior: &ChainState,
    ) -> Result<
        (ChainState, ChunkSummary),
        ChainError<
            zcash_client_sqlite::error::SqliteClientError,
            zcash_client_sqlite::FsBlockDbError,
        >,
    > {
        let start = blocks[0].height();
        let mut size = prior.final_sapling_tree().tree_size();
        let mut outputs_total = 0u32;
        let mut metas = Vec::with_capacity(blocks.len());
        for block in &mut blocks {
            let outputs: u32 = block.vtx.iter().map(|tx| tx.outputs.len() as u32).sum();
            size += u64::from(outputs);
            outputs_total += outputs;
            block.chain_metadata = Some(ChainMetadata {
                sapling_commitment_tree_size: u32::try_from(size)
                    .expect("Sapling tree size fits u32"),
                orchard_commitment_tree_size: 0,
            });
            let meta = BlockMeta {
                height: block.height(),
                block_hash: BlockHash::from_slice(&block.hash),
                block_time: block.time,
                sapling_outputs_count: outputs,
                orchard_actions_count: 0,
            };
            fs::write(
                meta.block_file_path(&self.blocks_dir),
                block.encode_to_vec(),
            )
            .map_err(|e| ChainError::BlockSource(zcash_client_sqlite::FsBlockDbError::Fs(e)))?;
            metas.push(meta);
        }
        self.cache
            .write_block_metadata(&metas)
            .map_err(ChainError::BlockSource)?;
        let last_height = blocks.last().expect("non-empty").height();

        let summary = scan_cached_blocks(
            &self.params,
            &self.cache,
            &mut self.db,
            start,
            prior,
            blocks.len(),
        )?;
        let _ = self.clear_cache();

        // The next checkpoint is computed locally: the prior frontier plus this chunk's note
        // commitments, in block order. No further GetTreeState round trip.
        let mut frontier = prior.final_sapling_tree().clone();
        for block in &blocks {
            for tx in &block.vtx {
                for out in &tx.outputs {
                    let cmu = sapling::note::ExtractedNoteCommitment::from_bytes(
                        out.cmu
                            .as_slice()
                            .try_into()
                            .map_err(|_| bad_cmu(block.height()))?,
                    );
                    let cmu = Option::from(cmu).ok_or_else(|| bad_cmu(block.height()))?;
                    frontier.append(sapling::Node::from_cmu(&cmu));
                }
            }
        }
        let last = blocks.last().expect("non-empty");
        let next_state = ChainState::new(last_height, last.hash(), frontier);
        tracing::info!(
            "scanned {start}..={last_height} ({} blocks, {outputs_total} outputs) received {} spent {}",
            blocks.len(),
            summary.received_sapling_note_count(),
            summary.spent_sapling_note_count()
        );
        Ok((
            next_state,
            ChunkSummary {
                blocks: blocks.len() as u32,
                outputs: outputs_total,
                received: summary.received_sapling_note_count() as u32,
                spent: summary.spent_sapling_note_count() as u32,
            },
        ))
    }

    /// Drops every cached compact block (they are re-fetched on demand; keeping them is waste).
    pub(crate) fn clear_cache(&mut self) -> Result<(), Error> {
        for entry in fs::read_dir(&self.blocks_dir)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                fs::remove_file(entry.path())?;
            }
        }
        self.cache
            .truncate_to_height(BlockHeight::from_u32(0))
            .map_err(|e| Error::Cache(e.to_string()))?;
        Ok(())
    }
}

struct ChunkSummary {
    blocks: u32,
    outputs: u32,
    received: u32,
    spent: u32,
}

fn bad_cmu(
    height: BlockHeight,
) -> ChainError<zcash_client_sqlite::error::SqliteClientError, zcash_client_sqlite::FsBlockDbError>
{
    ChainError::Scan(zcash_client_backend::scanning::ScanError::TreeSizeInvalid {
        protocol: zcash_protocol::ShieldedProtocol::Sapling,
        at_height: height,
    })
}

/// How [`Wallet::rewind_for_reorg`] rewound.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Rewind {
    /// To a checkpoint at or below `at - REORG_REWIND`.
    Checkpoint,
    /// To the block before the birthday, the store having refused the checkpoint rewind.
    Birthday,
}

enum RangeOutcome {
    Done,
    Reorg(BlockHeight),
    HigherPriority,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_lwd::{self, Chain, Fake};
    use crate::wallet::{Options, Wallet};
    use crate::YcashNetwork;

    const BIRTHDAY: u32 = 101;

    /// A wallet over the fake with a fresh key born at `BIRTHDAY`, synced to `tip` of a chain with
    /// a Sapling output at each of `outputs`.
    async fn synced(name: &str, tip: u64, outputs: &[u64]) -> (Fake, Wallet, std::path::PathBuf) {
        synced_from(name, BIRTHDAY, tip, outputs).await
    }

    async fn synced_from(
        name: &str,
        birthday: u32,
        tip: u64,
        outputs: &[u64],
    ) -> (Fake, Wallet, std::path::PathBuf) {
        let (fake, channel, _) = fake_lwd::start(true).await;
        let mut chain = Chain::new(tip);
        chain.outputs.extend(outputs);
        fake.set_chain(chain);
        let dir = fake_lwd::temp_data_dir(name);
        let mut w = Wallet::open(Options {
            channel: Some(channel),
            ..Options::new(&dir, "fake", YcashNetwork::devnet_regtest())
        })
        .await
        .expect("open");
        let extsk = sapling::zip32::ExtendedSpendingKey::master(&[7; 32]);
        w.register_key(extsk, Some(birthday)).await.expect("key");
        let r = w.sync(DEFAULT_CHUNK_BLOCKS).await.expect("first sync");
        assert_eq!(r.scannedHeight, Some(tip as u32));
        assert_eq!((r.reorgs, r.birthdayRewinds), (0, 0));
        (fake, w, dir)
    }

    fn stored_hash(w: &Wallet, h: u64) -> Option<[u8; 32]> {
        w.db.get_block_hash(BlockHeight::from_u32(h as u32))
            .expect("read")
            .map(|b| b.0)
    }

    /// After a sync: every block from the birthday to the tip is the served chain's. (The scanner
    /// checks each chunk's Sapling tree size against its checkpoint, so a wrong tree state at the
    /// rewind would have failed the sync.)
    async fn assert_on_chain(fake: &Fake, w: &mut Wallet) {
        let chain = fake.chain().expect("chain");
        for h in u64::from(BIRTHDAY)..=chain.tip {
            assert_eq!(stored_hash(w, h), Some(chain.hash(h)), "block {h}");
        }
        let top = w.db.get_max_height_hash().expect("max height");
        assert_eq!(top.map(|(h, _)| u64::from(u32::from(h))), Some(chain.tip));
    }

    async fn cleanup(w: Wallet, dir: std::path::PathBuf) {
        drop(w);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// YEW Z-9: a reorg within ten blocks of the birthday replacing the block that holds a
    /// receipt (102). The checkpoint rewind (105 - 10 = 95) lies below the store's oldest
    /// checkpoint (102, the only block with a note commitment) and is refused; the sync rewinds to
    /// 100 with the server's tree state and scans the new branch instead of failing on this and
    /// every later call.
    #[tokio::test]
    async fn a_reorg_near_the_birthday_rewinds_to_the_birthday() {
        let (fake, mut w, dir) = synced("rewind-near", 105, &[102]).await;
        fake.with_chain(|c| c.fork(102, 106));
        fake.tree_states.lock().unwrap().clear();

        let r = w.sync(DEFAULT_CHUNK_BLOCKS).await.expect("syncs through");
        assert_eq!(r.scannedHeight, Some(106));
        assert_eq!((r.reorgs, r.birthdayRewinds), (1, 1), "{r:?}");
        assert_eq!(r.blocksScanned, 6, "rescanned from the birthday: {r:?}");
        assert!(
            fake.tree_states
                .lock()
                .unwrap()
                .contains(&u64::from(BIRTHDAY - 1)),
            "the birthday's chain state comes from the server"
        );
        assert_on_chain(&fake, &mut w).await;

        // The next reorg near the birthday is answered the same way, not refused for good.
        fake.with_chain(|c| c.fork(104, 107));
        let r = w.sync(DEFAULT_CHUNK_BLOCKS).await.expect("again");
        assert_eq!((r.scannedHeight, r.birthdayRewinds), (Some(107), 1));
        assert_on_chain(&fake, &mut w).await;
        let r = w.sync(DEFAULT_CHUNK_BLOCKS).await.expect("quiet");
        assert_eq!((r.reorgs, r.blocksScanned), (0, 0));
        cleanup(w, dir).await;
    }

    /// A deeper branch: one replacing the birthday block itself, and one forking below the
    /// birthday. The rewind uses the server's current state for the block before the birthday,
    /// not the one saved at import.
    #[tokio::test]
    async fn a_branch_replacing_the_birthday_block_or_below_syncs_through() {
        for (name, from, outputs) in [
            ("rewind-at", u64::from(BIRTHDAY), &[103][..]),
            ("rewind-below", 97, &[103][..]),
            // The branch also replaces a note commitment below the birthday: the tree state at
            // the block before the birthday changes, and the rewind takes the server's.
            ("rewind-below-tree", 97, &[98, 103][..]),
        ] {
            let (fake, mut w, dir) = synced(name, 104, outputs).await;
            fake.with_chain(|c| c.fork(from, 109));
            let r = w.sync(DEFAULT_CHUNK_BLOCKS).await.expect("syncs through");
            assert_eq!(r.scannedHeight, Some(109), "{name}");
            assert_eq!(r.birthdayRewinds, 1, "{name}: {r:?}");
            assert_on_chain(&fake, &mut w).await;
            cleanup(w, dir).await;
        }
    }

    /// Far from the birthday, with a checkpoint (a block with a note commitment) at or below the
    /// rewind height, the checkpoint rewind is accepted as before: no rescan from the birthday.
    #[tokio::test]
    async fn a_reorg_far_from_the_birthday_uses_the_checkpoint() {
        let (fake, mut w, dir) = synced("rewind-far", 140, &[110, 120, 128, 137]).await;
        fake.with_chain(|c| c.fork(136, 141));
        fake.tree_states.lock().unwrap().clear();
        let r = w.sync(DEFAULT_CHUNK_BLOCKS).await.expect("sync");
        assert_eq!(r.scannedHeight, Some(141));
        assert_eq!((r.reorgs, r.birthdayRewinds), (1, 0), "{r:?}");
        assert!(!fake
            .tree_states
            .lock()
            .unwrap()
            .contains(&u64::from(BIRTHDAY - 1)));
        // 140 - 10 = 130 lands on the checkpoint at 128: 129..=141 rescanned.
        assert_eq!(r.blocksScanned, 13, "{r:?}");
        assert_on_chain(&fake, &mut w).await;
        cleanup(w, dir).await;
    }

    /// The refusal is not only "within ten blocks of the birthday": the store checkpoints only
    /// blocks with note commitments, so with no Sapling output between the birthday and the
    /// rewind height (common on a quiet chain) it refuses too, and the same answer applies.
    #[tokio::test]
    async fn a_reorg_with_no_checkpoint_below_rewinds_to_the_birthday() {
        let (fake, mut w, dir) = synced("rewind-quiet", 140, &[]).await;
        fake.with_chain(|c| c.fork(136, 141));
        let r = w.sync(DEFAULT_CHUNK_BLOCKS).await.expect("sync");
        assert_eq!(r.scannedHeight, Some(141));
        assert_eq!((r.reorgs, r.birthdayRewinds), (1, 1), "{r:?}");
        assert_eq!(r.blocksScanned, 41, "{r:?}");
        assert_on_chain(&fake, &mut w).await;
        cleanup(w, dir).await;
    }

    /// The same, on a chain whose tree is not empty below the reorg: the stale leaf at 298 goes,
    /// the shared ones (150, 250) stay, and the new branch's 298 and 303 are scanned on top.
    #[tokio::test]
    async fn a_branch_replacing_a_commitment_below_the_birthday_keeps_the_shared_tree() {
        let (fake, mut w, dir) = synced_from("rewind-deep", 301, 304, &[150, 250, 298, 303]).await;
        fake.with_chain(|c| c.fork(297, 306));
        let r = w.sync(DEFAULT_CHUNK_BLOCKS).await.expect("syncs through");
        assert_eq!(
            (r.scannedHeight, r.birthdayRewinds),
            (Some(306), 1),
            "{r:?}"
        );
        let asked = fake.tree_states.lock().unwrap().clone();
        assert!(
            asked.contains(&300) && asked.contains(&200),
            "300 conflicted, so the tree went to 300 - 100: {asked:?}"
        );
        let chain = fake.chain().expect("chain");
        for h in 301..=306 {
            assert_eq!(stored_hash(&w, h), Some(chain.hash(h)), "block {h}");
        }
        // The next block's output lands at the right position: scanning checks the tree size.
        fake.with_chain(|c| {
            c.outputs.insert(307);
            c.tip = 307;
        });
        let r = w.sync(DEFAULT_CHUNK_BLOCKS).await.expect("next block");
        assert_eq!((r.scannedHeight, r.reorgs), (Some(307), 0));
        cleanup(w, dir).await;
    }

    /// The birthday answer is bounded per sync; past the bound the refusal is returned as is.
    #[tokio::test]
    async fn birthday_rewinds_are_bounded() {
        let (fake, mut w, dir) = synced("rewind-bound", 105, &[102]).await;
        let at = BlockHeight::from_u32(105);
        match w.rewind_for_reorg(at, MAX_BIRTHDAY_REWINDS).await {
            Err(Error::Wallet(SqliteClientError::RequestedRewindInvalid {
                requested_height,
                ..
            })) => assert_eq!(u32::from(requested_height), 95),
            other => panic!("expected the refusal, got {other:?}"),
        }
        assert_eq!(stored_hash(&w, 105), Some(fake.chain().unwrap().hash(105)));
        assert_eq!(
            w.rewind_for_reorg(at, MAX_BIRTHDAY_REWINDS - 1)
                .await
                .expect("within the bound"),
            Rewind::Birthday
        );
        assert_eq!(
            stored_hash(&w, u64::from(BIRTHDAY)),
            None,
            "truncated to 100"
        );
        cleanup(w, dir).await;
    }
}
