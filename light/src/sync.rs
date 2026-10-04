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
//!    wallet truncates to the previous checkpoint and resumes from the suggested ranges.
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
use zcash_client_backend::data_api::{WalletRead, WalletWrite};
use zcash_client_backend::proto::compact_formats::{ChainMetadata, CompactBlock};
use zcash_client_sqlite::chain::BlockMeta;
use zcash_primitives::block::BlockHash;
use zcash_protocol::consensus::BlockHeight;

use crate::lwd;
use crate::net::parse_branch_id;
use crate::wallet::{Error, Wallet};

/// Chunking: cut a chunk once it holds this many Sapling outputs, or this many blocks.
pub const CHUNK_OUTPUTS: u32 = 1_000;
pub const DEFAULT_CHUNK_BLOCKS: u32 = 2_000;
/// Blocks to rewind below a mismatch, as `sync::run` does.
const REORG_REWIND: u32 = 10;

#[allow(non_snake_case)]
#[derive(Debug, Default, Serialize)]
pub struct SyncReport {
    pub tipHeight: u32,
    pub scannedHeight: Option<u32>,
    pub blocksScanned: u32,
    pub chunksScanned: u32,
    pub outputsScanned: u64,
    pub reorgs: u32,
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
                    let rewind = at.saturating_sub(REORG_REWIND);
                    tracing::warn!("chain reorg at {at}, rewinding to checkpoint {rewind}");
                    self.db.truncate_to_height(rewind)?;
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

enum RangeOutcome {
    Done,
    Reorg(BlockHeight),
    HigherPriority,
}
