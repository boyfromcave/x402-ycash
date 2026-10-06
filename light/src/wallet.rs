//! The wallet: a `zcash_client_sqlite` store under a data directory, one Sapling account, a
//! lightwalletd connection and (when configured) the Sapling prover.
//!
//! Layout of `--data`:
//!   wallet.sqlite        the WalletDb (notes, nullifiers, commitment tree, created transactions)
//!   cache/               the FsBlockDb: blockmeta.sqlite + blocks/ (compact blocks, deleted once scanned)
//! The spending key is injected (`Options::spending_key`, `register_key`); where it is kept is the
//! embedding application's business (the x402-light binary stores it as `spending.key`, mode 0600).

use std::fs;
use std::num::NonZeroU32;
use std::path::PathBuf;

use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use zcash_client_backend::data_api::chain::ChainState;
use zcash_client_backend::data_api::wallet::input_selection::GreedyInputSelector;
use zcash_client_backend::data_api::wallet::{
    decrypt_and_store_transaction, propose_standard_transfer_to_address, propose_transfer,
    ConfirmationsPolicy, TargetHeight,
};
use zcash_client_backend::data_api::{
    AccountBirthday, AccountPurpose, InputSource, NullifierQuery, TargetValue, WalletRead,
    WalletWrite,
};
use zcash_client_backend::fees::StandardFeeRule;
use zcash_client_backend::proto::compact_formats::CompactTx;
use zcash_client_sqlite::chain::init::init_blockmeta_db;
use zcash_client_sqlite::util::SystemClock;
use zcash_client_sqlite::wallet::init::init_wallet_db;
use zcash_client_sqlite::{AccountUuid, FsBlockDb, WalletDb};
use zcash_keys::address::Address;
use zcash_primitives::transaction::components::sapling::zip212_enforcement;
use zcash_primitives::transaction::fees::fixed::FeeRule as FixedFeeRule;
use zcash_primitives::transaction::{Transaction, TxId};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::consensus::{BlockHeight, BranchId, Parameters};
use zcash_protocol::memo::MemoBytes;
use zcash_protocol::value::Zatoshis;
use zcash_protocol::ShieldedProtocol;

use sapling::keys::PreparedIncomingViewingKey;
use sapling::note_encryption::{try_sapling_compact_note_decryption, CompactOutputDescription};
use sapling::zip32::ExtendedSpendingKey;
use zip32::Scope;

use tonic::transport::Channel;

use crate::keys;
use crate::lwd::{self, Client};
use crate::net::YcashNetwork;
use crate::spend;

pub type Db = WalletDb<rusqlite::Connection, YcashNetwork, SystemClock, OsRng>;

pub struct Wallet {
    pub params: YcashNetwork,
    pub(crate) db: Db,
    pub(crate) cache: FsBlockDb,
    pub(crate) blocks_dir: PathBuf,
    pub data_dir: PathBuf,
    extsk: Option<ExtendedSpendingKey>,
    params_dir: Option<PathBuf>,
    prover: Option<LocalTxProver>,
    pub(crate) client: Client,
    channel: Channel,
    pub(crate) lwd_addr: String,
    max_expiry_window: u32,
    /// Held for the wallet's lifetime: see [`lock_data_dir`].
    _lock: fs::File,
}

pub struct Options {
    pub data_dir: PathBuf,
    /// The lightwalletd address (`grpc://h:p`, `grpcs://h:p`, `h:p`), dialed with `tls_roots`
    /// when `channel` is `None`. With a channel it is only the label `status` reports.
    pub lwd: String,
    pub params: YcashNetwork,
    pub proving_params_dir: Option<PathBuf>,
    /// The Sapling extended spending key whose account this wallet holds, if already known.
    pub spending_key: Option<ExtendedSpendingKey>,
    /// A channel built by the host (its own TLS: a pinned certificate, webpki roots, a proxy).
    /// When set, every lightwalletd call goes over it (sync, GetTreeState, GetLightdInfo,
    /// GetChainInfo, GetMempoolTx, SendTransaction) and `lwd` is not dialed. Timeouts are the
    /// host's: the URL path sets 10 s connect and 600 s per request, and a long `GetBlockRange`
    /// stream needs a request timeout at least that generous.
    pub channel: Option<Channel>,
    /// Root store for the URL path when it uses TLS; ignored with `channel`.
    pub tls_roots: lwd::TlsRoots,
    /// The most blocks a built transaction's `nExpiryHeight` may sit above the relay floor
    /// (target + 3): an unmined transaction locks its notes until then. Default 1152 (~1 day).
    pub max_expiry_window: u32,
}

impl Options {
    /// The URL path with the platform-default roots, no proving parameters and no key; set the
    /// other fields with struct update syntax (`Options { channel: Some(ch), ..Options::new(..) }`).
    pub fn new(
        data_dir: impl Into<PathBuf>,
        lwd_addr: impl Into<String>,
        params: YcashNetwork,
    ) -> Self {
        Options {
            data_dir: data_dir.into(),
            lwd: lwd_addr.into(),
            params,
            proving_params_dir: None,
            spending_key: None,
            channel: None,
            tls_roots: lwd::TlsRoots::default(),
            max_expiry_window: spend::DEFAULT_MAX_EXPIRY_WINDOW,
        }
    }
}

/// One confirmation, the ycashd default for `z_sendmany` on both lines.
pub fn default_policy() -> ConfirmationsPolicy {
    ConfirmationsPolicy::new_symmetrical(NonZeroU32::new(1).expect("nonzero"))
}

impl Wallet {
    pub async fn open(opts: Options) -> Result<Self, Error> {
        fs::create_dir_all(&opts.data_dir)?;
        let lock = lock_data_dir(&opts.data_dir)?;
        let cache_root = opts.data_dir.join("cache");
        let blocks_dir = cache_root.join("blocks");
        fs::create_dir_all(&blocks_dir)?;
        let mut cache =
            FsBlockDb::for_path(&cache_root).map_err(|e| Error::Cache(e.to_string()))?;
        init_blockmeta_db(&mut cache).map_err(|e| Error::Cache(e.to_string()))?;

        let mut db = WalletDb::for_path(
            opts.data_dir.join("wallet.sqlite"),
            opts.params,
            SystemClock,
            OsRng,
        )?;
        init_wallet_db(&mut db, None).map_err(|e| Error::Init(e.to_string()))?;

        let extsk = opts.spending_key;

        let (client, channel) = match opts.channel {
            Some(channel) => (lwd::client(channel.clone()), channel),
            None => lwd::connect(&opts.lwd, opts.tls_roots).await?,
        };
        Ok(Wallet {
            params: opts.params,
            db,
            cache,
            blocks_dir,
            data_dir: opts.data_dir,
            extsk,
            params_dir: opts.proving_params_dir,
            prover: None,
            client,
            channel,
            lwd_addr: opts.lwd,
            max_expiry_window: opts.max_expiry_window,
            _lock: lock,
        })
    }

    /// The lightwalletd channel every call of this wallet uses (injected or dialed), for a host
    /// that makes calls of its own (e.g. `GetTransaction`) over the same connection.
    pub fn channel(&self) -> &Channel {
        &self.channel
    }

    // ------------------------------------------------------------------ keys and account

    pub fn has_key(&self) -> bool {
        self.extsk.is_some()
    }

    fn extsk(&self) -> Result<&ExtendedSpendingKey, Error> {
        self.extsk.as_ref().ok_or(Error::NoKey)
    }

    pub fn account(&self) -> Result<AccountUuid, Error> {
        self.db
            .get_account_ids()?
            .into_iter()
            .next()
            .ok_or(Error::NoKey)
    }

    /// Registers a spending key with a birthday: the account is created with the tree state just
    /// before the birthday so scanning starts there. One key per wallet; the key is not persisted
    /// here (see the module docs).
    pub async fn register_key(
        &mut self,
        extsk: ExtendedSpendingKey,
        birthday: Option<u32>,
    ) -> Result<KeyInfo, Error> {
        if let Some(existing) = &self.extsk {
            if existing.to_bytes() != extsk.to_bytes() {
                return Err(Error::KeyExists);
            }
            return self.key_info();
        }
        let tip = lwd::latest_height(&mut self.client).await?;
        let sapling_activation = self
            .params
            .activation_height(zcash_protocol::consensus::NetworkUpgrade::Sapling)
            .unwrap_or(BlockHeight::from_u32(1));
        let birthday_height = match birthday {
            Some(h) => BlockHeight::from_u32(h).max(sapling_activation),
            None => tip,
        };
        if birthday_height > tip + 1 {
            return Err(Error::Birthday(format!(
                "{birthday_height} is above the tip {tip}"
            )));
        }
        let prior = self.chain_state_at(birthday_height - 1).await?;
        let birthday_state = AccountBirthday::from_parts(prior, None);

        let usk = keys::usk_from_extsk(&extsk);
        self.db.import_account_ufvk(
            "x402-light",
            &keys::ufvk(&usk),
            &birthday_state,
            AccountPurpose::Spending { derivation: None },
            Some("imported Sapling extended spending key"),
        )?;

        self.extsk = Some(extsk);
        self.key_info()
    }

    pub fn key_info(&self) -> Result<KeyInfo, Error> {
        let extsk = self.extsk()?;
        let birthday = self.db.get_account_birthday(self.account()?)?;
        Ok(KeyInfo {
            address: keys::default_address(&self.params, extsk),
            fvk: keys::encode_extfvk(&self.params, extsk),
            birthday: u32::from(birthday),
            network: self.params.name().to_owned(),
        })
    }

    /// The chain state (block hash + Sapling frontier) as of the end of `height`, from
    /// `GetTreeState`. The 0.4.6 lineage answers height 0 on regtest from `z_gettreestate 0`;
    /// should a server refuse it, the genesis block's hash with an empty tree is equivalent.
    pub(crate) async fn chain_state_at(
        &mut self,
        height: BlockHeight,
    ) -> Result<ChainState, Error> {
        match lwd::tree_state(&mut self.client, height).await {
            Ok(ts) => ts
                .to_chain_state()
                .map_err(|e| Error::Server(format!("bad tree state at {height}: {e}"))),
            Err(e) if u32::from(height) == 0 => {
                let blocks = lwd::block_range(&mut self.client, height, height).await?;
                let genesis = blocks.first().ok_or(e)?;
                Ok(ChainState::empty(height, genesis.hash()))
            }
            Err(e) => Err(e.into()),
        }
    }

    // ------------------------------------------------------------------ status

    fn policy(min_confirmations: u32) -> ConfirmationsPolicy {
        ConfirmationsPolicy::new_symmetrical(
            NonZeroU32::new(min_confirmations.max(1)).expect("nonzero"),
        )
    }

    pub async fn status(&mut self, min_confirmations: u32) -> Result<Status, Error> {
        let info = lwd::info(&mut self.client).await?;
        let lwd_height = u32::try_from(info.block_height).unwrap_or(u32::MAX);
        // GetLightdInfo.blockHeight is the node's height; the compact-block cache (what sync
        // reads) can lag it by the ingestor's poll interval. GetLatestBlock is the cache's tip.
        let lwd_latest = u32::from(lwd::latest_height(&mut self.client).await?);
        let chain_height = self.db.chain_height()?.map(u32::from);
        let (mut balance, scanned, synced) = (Balance::default(), None, false);
        let mut out = Status {
            network: self.params.name().to_owned(),
            lwd: self.lwd_addr.clone(),
            lwdHeight: lwd_height,
            lwdLatestHeight: lwd_latest,
            lwdChainName: info.chain_name.clone(),
            lwdBranchId: info.consensus_branch_id.clone(),
            branchIdNextBlock: format!(
                "{:08x}",
                u32::from(
                    self.params
                        .branch_id_at(BlockHeight::from_u32(lwd_height.saturating_add(1)))
                )
            ),
            height: chain_height,
            scannedHeight: scanned,
            synced,
            hasKey: self.has_key(),
            address: None,
            minConfirmations: min_confirmations.max(1),
            balance: Balance::default(),
            mempool: Mempool::default(),
        };
        if !self.has_key() {
            return Ok(out);
        }
        out.address = Some(keys::default_address(&self.params, self.extsk()?));
        let account = self.account()?;
        if let Some(summary) = self
            .db
            .get_wallet_summary(Self::policy(min_confirmations))?
        {
            out.scannedHeight = Some(u32::from(summary.fully_scanned_height()));
            out.synced =
                summary.is_synced() && chain_height == Some(lwd_latest) && lwd_latest == lwd_height;
            if let Some(b) = summary.account_balances().get(&account) {
                let s = b.sapling_balance();
                balance = Balance {
                    spendableZat: s.spendable_value().into_u64(),
                    pendingChangeZat: s.change_pending_confirmation().into_u64(),
                    pendingIncomingZat: s.value_pending_spendability().into_u64(),
                    totalZat: b.total().into_u64(),
                };
            }
        }
        out.balance = balance;
        out.mempool = self.mempool_view(lwd_height).await?;
        Ok(out)
    }

    /// Trial-decrypts the server's mempool with our incoming viewing keys and matches its spends
    /// against our unspent nullifiers: what is coming in and what of ours is going out, 0-conf.
    async fn mempool_view(&mut self, tip: u32) -> Result<Mempool, Error> {
        let txs: Vec<CompactTx> = lwd::mempool(&mut self.client).await?;
        let extsk = self.extsk()?;
        let dfvk = extsk.to_diversifiable_full_viewing_key();
        let ivks: Vec<PreparedIncomingViewingKey> = [Scope::External, Scope::Internal]
            .iter()
            .map(|s| PreparedIncomingViewingKey::new(&dfvk.to_ivk(*s)))
            .collect();
        let zip212 = zip212_enforcement(&self.params, BlockHeight::from_u32(tip + 1));
        let ours: Vec<[u8; 32]> = self
            .db
            .get_sapling_nullifiers(NullifierQuery::Unspent)?
            .into_iter()
            .map(|(_, nf)| nf.0)
            .collect();
        let mut view = Mempool {
            txCount: txs.len() as u32,
            ..Default::default()
        };
        for tx in &txs {
            let txid = TxId::from_bytes(
                tx.txid
                    .as_slice()
                    .try_into()
                    .map_err(|_| Error::Server("bad mempool txid".into()))?,
            );
            let mut incoming = 0u64;
            for out in &tx.outputs {
                let Ok(desc) = CompactOutputDescription::try_from(out) else {
                    continue;
                };
                for ivk in &ivks {
                    if let Some((note, _)) = try_sapling_compact_note_decryption(ivk, &desc, zip212)
                    {
                        incoming += note.value().inner();
                        break;
                    }
                }
            }
            if incoming > 0 {
                view.incomingZat += incoming;
                view.incomingTxids.push(txid.to_string());
            }
            if tx
                .spends
                .iter()
                .any(|s| ours.iter().any(|nf| nf[..] == s.nf[..]))
            {
                view.spendingTxids.push(txid.to_string());
            }
        }
        Ok(view)
    }

    pub fn list_notes(&self, min_confirmations: u32) -> Result<Vec<NoteInfo>, Error> {
        let account = self.account()?;
        let Some(tip) = self.db.chain_height()? else {
            return Ok(vec![]);
        };
        let target = TargetHeight::from(tip + 1);
        let notes = self.db.select_spendable_notes(
            account,
            TargetValue::AtLeast(Zatoshis::const_from_u64(zcash_protocol::value::MAX_MONEY)),
            &[ShieldedProtocol::Sapling],
            target,
            Self::policy(min_confirmations),
            &[],
        )?;
        Ok(notes
            .sapling()
            .iter()
            .map(|n| NoteInfo {
                txid: n.txid().to_string(),
                outputIndex: n.output_index() as u32,
                valueZat: n.note_value().map(|z| z.into_u64()).unwrap_or(0),
                minedHeight: n.mined_height().map(u32::from),
            })
            .collect())
    }

    // ------------------------------------------------------------------ spending

    /// Takes the prover out of `self` (loading it on first use) so it can be used while the
    /// wallet db is borrowed mutably; `build` puts it back.
    fn take_prover(&mut self) -> Result<LocalTxProver, Error> {
        if let Some(p) = self.prover.take() {
            return Ok(p);
        }
        let dir = self.params_dir.clone().ok_or(Error::NoProvingParams)?;
        let spend = dir.join("sapling-spend.params");
        let output = dir.join("sapling-output.params");
        if !spend.is_file() || !output.is_file() {
            return Err(Error::ProvingParamsMissing(dir));
        }
        tracing::info!("loading Sapling proving parameters from {}", dir.display());
        Ok(LocalTxProver::new(&spend, &output))
    }

    /// Builds, proves and signs a shielded spend to `to` with `memo`, records it in the wallet
    /// (its inputs are marked spent until the transaction expires) and returns the raw hex
    /// WITHOUT broadcasting it. A `fee` of `None` is the ZIP-317 conventional fee.
    pub async fn build(&mut self, req: &BuildRequest) -> Result<Built, Error> {
        let account = self.account()?;
        // Branch id and expiry come from the server's next block, so the wallet must stand at the
        // server's tip: one sync pass if it does not, then refuse if it still does not.
        let mut server = lwd::branch_info(&mut self.client, &self.channel).await?;
        if check_tip(self.db.chain_height()?, &server).is_err() {
            self.sync(crate::sync::DEFAULT_CHUNK_BLOCKS).await?;
            server = lwd::branch_info(&mut self.client, &self.channel).await?;
        }
        let tip = check_tip(self.db.chain_height()?, &server)?;
        let to =
            Address::decode(&self.params, &req.to).ok_or_else(|| Error::Address(req.to.clone()))?;
        if !matches!(to, Address::Sapling(_)) {
            return Err(Error::Address(format!("{}: not a Sapling address", req.to)));
        }
        let amount =
            Zatoshis::from_u64(req.amount_zat).map_err(|_| Error::Amount(req.amount_zat))?;
        let memo = match &req.memo_hex {
            Some(h) if !h.is_empty() => {
                let bytes = hex::decode(h).map_err(|e| Error::Memo(e.to_string()))?;
                Some(MemoBytes::from_bytes(&bytes).map_err(|e| Error::Memo(format!("{e:?}")))?)
            }
            _ => match &req.memo {
                Some(text) if !text.is_empty() => Some(
                    MemoBytes::from_bytes(text.as_bytes())
                        .map_err(|e| Error::Memo(format!("{e:?}")))?,
                ),
                _ => None,
            },
        };
        let policy = Self::policy(req.min_confirmations.unwrap_or(1));
        let target_height = tip + 1;
        let expiry = match req.max_timeout_seconds {
            Some(t) => spend::ExpiryRequest::for_timeout(
                target_height,
                t,
                req.expiry_height,
                self.max_expiry_window,
            ),
            None => spend::ExpiryRequest::new(req.expiry_height, self.max_expiry_window),
        };
        let branch_id = check_branch(&self.params, &server, target_height)?;

        let params = self.params;
        let Address::Sapling(to_pa) = &to else {
            unreachable!("checked above")
        };
        let extsk = self.extsk()?.clone();
        let payment = spend::Payment {
            to: to_pa,
            amount,
            memo: memo.clone(),
        };
        let prover = self.take_prover()?;
        // Note selection, fee and change come from librustzcash's proposal; the transaction itself is
        // assembled in `spend` so nExpiryHeight can be the caller's (create_proposed_transactions
        // fixes it at target + 40).
        let assembled: Result<Transaction, Error> = match req.fee_zat {
            None => propose_standard_transfer_to_address::<_, _, Error>(
                &mut self.db,
                &params,
                StandardFeeRule::Zip317,
                account,
                policy,
                &to,
                amount,
                memo,
                None,
                ShieldedProtocol::Sapling,
                None,
            )
            .map_err(|e| Error::Propose(format!("{e}")))
            .and_then(|proposal| {
                spend::assemble(
                    &mut self.db,
                    &params,
                    &extsk,
                    &prover,
                    &proposal,
                    &payment,
                    expiry,
                )
            }),
            Some(fee) => {
                let fee = Zatoshis::from_u64(fee).map_err(|_| Error::Amount(fee))?;
                let change_strategy =
                    zcash_client_backend::fees::fixed::SingleOutputChangeStrategy::new(
                        FixedFeeRule::non_standard(fee),
                        None,
                        ShieldedProtocol::Sapling,
                        zcash_client_backend::fees::DustOutputPolicy::default(),
                    );
                let selector = GreedyInputSelector::<Db>::new();
                let request = zip321::TransactionRequest::new(vec![zip321::Payment::new(
                    to.to_zcash_address(&params),
                    Some(amount),
                    memo,
                    None,
                    None,
                    vec![],
                )
                .map_err(|e| Error::Propose(format!("{e:?}")))?])
                .map_err(|e| Error::Propose(format!("{e:?}")))?;
                propose_transfer::<_, _, _, _, Error>(
                    &mut self.db,
                    &params,
                    account,
                    &selector,
                    &change_strategy,
                    request,
                    policy,
                    None,
                )
                .map_err(|e| Error::Propose(format!("{e}")))
                .and_then(|proposal| {
                    spend::assemble(
                        &mut self.db,
                        &params,
                        &extsk,
                        &prover,
                        &proposal,
                        &payment,
                        expiry,
                    )
                })
            }
        };
        self.prover = Some(prover);
        let tx = assembled?;
        let txid = tx.txid();
        let sapling = tx.sapling_bundle();
        let (n_spends, n_outputs, value_balance) = sapling.map_or((0, 0, 0), |b| {
            (
                b.shielded_spends().len(),
                b.shielded_outputs().len(),
                i64::from(*b.value_balance()),
            )
        });
        // Shielded-only: the fee is the Sapling value balance.
        let fee = u64::try_from(value_balance)
            .map_err(|_| Error::Create(format!("negative value balance {value_balance}")))?;
        let floor = spend::fee_floor(n_spends, n_outputs);
        if fee < floor {
            return Err(Error::FeeBelowFloor { fee, floor });
        }
        if let Some(e) = expiry.height {
            debug_assert_eq!(u32::from(tx.expiry_height()), e);
        }
        let mut raw = Vec::new();
        tx.write(&mut raw)
            .map_err(|e| Error::Create(e.to_string()))?;
        // Record it as ours, unmined: its spends mark our notes spent until nExpiryHeight passes
        // unbroadcast, and the OVK recovers the payment and the change.
        decrypt_and_store_transaction(&params, &mut self.db, &tx, None)?;
        let fee = Some(fee);
        Ok(Built {
            txid: txid.to_string(),
            txHex: hex::encode(&raw),
            feeZat: fee,
            targetHeight: u32::from(target_height),
            expiryHeight: u32::from(tx.expiry_height()),
            branchId: format!("{:08x}", u32::from(branch_id)),
            branchIdSource: if server.next_block {
                "GetChainInfo.nextBlockBranchId"
            } else {
                "GetLightdInfo.consensusBranchId (chaintip, X-F71)"
            }
            .to_owned(),
            version: format!("{:?}", tx.version()),
        })
    }

    pub async fn broadcast(&mut self, tx_hex: &str) -> Result<Sent, Error> {
        let raw = hex::decode(tx_hex.trim()).map_err(|e| Error::Hex(e.to_string()))?;
        let resp = lwd::send(&mut self.client, raw).await?;
        if resp.error_code != 0 {
            return Err(Error::Rejected(resp.error_code, resp.error_message));
        }
        // lightwalletd's success reply carries the node's txid in errorMessage.
        Ok(Sent {
            // lightwalletd returns the node's raw JSON result, the quoted txid.
            txid: resp.error_message.trim().trim_matches('"').to_owned(),
        })
    }
}

/// The wallet's tip, if it is exactly the server's (`BranchInfo.height`, the node's tip): what
/// `build` derives the target height, branch id and expiry from.
pub(crate) fn check_tip(
    wallet: Option<BlockHeight>,
    server: &lwd::BranchInfo,
) -> Result<BlockHeight, Error> {
    match wallet {
        Some(tip) if u32::from(tip) == server.height => Ok(tip),
        _ => Err(Error::NotAtServerTip {
            wallet: wallet.map(u32::from),
            server: server.height,
        }),
    }
}

/// The branch id to sign for `target` (the server's tip + 1). Sign with what the server says the
/// next block wants (GetChainInfo.nextBlockBranchId), by refusing to build when our parameters
/// disagree with it: the builder derives the branch id from the parameters, so agreement here is
/// what makes the signature valid. This is also what stops a wallet whose parameters lack an
/// upgrade the node has activated (Vault, `6d5b7a31`, on a regtest started with
/// `-nuparams=6d5b7a31:<h>` but no `--upgrades vault=<h>` here) from signing under the old branch.
pub(crate) fn check_branch(
    params: &YcashNetwork,
    server: &lwd::BranchInfo,
    target: BlockHeight,
) -> Result<BranchId, Error> {
    let server_branch = crate::net::parse_branch_id(&server.branch_id_hex)
        .ok_or_else(|| Error::Server(format!("unknown branch id {}", server.branch_id_hex)))?;
    let compare_at = if server.next_block {
        BlockHeight::from_u32(server.height) + 1
    } else {
        BlockHeight::from_u32(server.height)
    };
    if params.branch_id_at(compare_at) != server_branch {
        return Err(Error::Server(format!(
            "branch id mismatch: lightwalletd wants {:?} ({}) for height {compare_at}, our parameters give {:?}; check --network/--upgrades",
            server_branch, server.branch_id_hex, params.branch_id_at(compare_at)
        )));
    }
    Ok(params.branch_id_at(target))
}

/// An advisory exclusive lock on `<data>/wallet.lock`, held while the wallet is open, so two
/// processes on one data directory (`serve` and a `once build`) cannot select the same notes.
/// The OS releases it when the process exits, so a crash leaves no stale lock.
fn lock_data_dir(dir: &std::path::Path) -> Result<fs::File, Error> {
    let path = dir.join("wallet.lock");
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(fs::TryLockError::WouldBlock) => Err(Error::Locked(dir.to_owned())),
        Err(fs::TryLockError::Error(e)) => Err(e.into()),
    }
}

// ---------------------------------------------------------------------- wire types

#[derive(Debug, Serialize)]
pub struct KeyInfo {
    pub address: String,
    pub fvk: String,
    pub birthday: u32,
    pub network: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Default, Serialize)]
pub struct Balance {
    pub spendableZat: u64,
    pub pendingChangeZat: u64,
    pub pendingIncomingZat: u64,
    pub totalZat: u64,
}

#[allow(non_snake_case)]
#[derive(Debug, Default, Serialize)]
pub struct Mempool {
    pub txCount: u32,
    pub incomingZat: u64,
    pub incomingTxids: Vec<String>,
    pub spendingTxids: Vec<String>,
}

#[allow(non_snake_case)]
#[derive(Debug, Serialize)]
pub struct Status {
    pub network: String,
    pub lwd: String,
    pub lwdHeight: u32,
    pub lwdLatestHeight: u32,
    pub lwdChainName: String,
    pub lwdBranchId: String,
    pub branchIdNextBlock: String,
    pub height: Option<u32>,
    pub scannedHeight: Option<u32>,
    pub synced: bool,
    pub hasKey: bool,
    pub address: Option<String>,
    pub minConfirmations: u32,
    pub balance: Balance,
    pub mempool: Mempool,
}

#[allow(non_snake_case)]
#[derive(Debug, Serialize)]
pub struct NoteInfo {
    pub txid: String,
    pub outputIndex: u32,
    pub valueZat: u64,
    pub minedHeight: Option<u32>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildRequest {
    pub to: String,
    /// The SDK's builder contract sends a decimal string; an integer is accepted too.
    #[serde(deserialize_with = "zat_from_string_or_number")]
    pub amount_zat: u64,
    #[serde(default)]
    pub memo_hex: Option<String>,
    #[serde(default)]
    pub memo: Option<String>,
    #[serde(default, rename = "fee")]
    pub fee_zat: Option<u64>,
    #[serde(default)]
    pub min_confirmations: Option<u32>,
    /// nExpiryHeight; absent, target + 40 (the x402 client passes tip + 3 + ⌈maxTimeoutSeconds/75⌉).
    /// At most `Options::max_expiry_window` above target + 3.
    #[serde(default)]
    pub expiry_height: Option<u32>,
    /// The requirement's `maxTimeoutSeconds`: when given, the expiry must lie in the spec's window
    /// (rule 8: tip + 4 ≤ expiry ≤ tip + 4 + ⌈t/75⌉ + 1) and defaults to tip + 3 + ⌈t/75⌉.
    #[serde(default)]
    pub max_timeout_seconds: Option<u64>,
}

/// `amountZat` as the TS contract sends it (a canonical decimal string) or as a JSON integer.
fn zat_from_string_or_number<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum Zat {
        Int(u64),
        Text(String),
    }
    match Zat::deserialize(d)? {
        Zat::Int(v) => Ok(v),
        Zat::Text(t)
            if !t.is_empty()
                && t.bytes().all(|b| b.is_ascii_digit())
                && (t == "0" || !t.starts_with('0')) =>
        {
            t.parse().map_err(serde::de::Error::custom)
        }
        Zat::Text(t) => Err(serde::de::Error::custom(format!(
            "amountZat {t:?} is not a decimal number of zatoshis"
        ))),
    }
}

#[allow(non_snake_case)]
#[derive(Debug, Serialize)]
pub struct Built {
    pub txid: String,
    pub txHex: String,
    pub feeZat: Option<u64>,
    pub targetHeight: u32,
    pub expiryHeight: u32,
    pub branchId: String,
    pub branchIdSource: String,
    pub version: String,
}

#[derive(Debug, Serialize)]
pub struct Sent {
    pub txid: String,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("wallet db: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("wallet db: {0}")]
    Wallet(#[from] zcash_client_sqlite::error::SqliteClientError),
    #[error("wallet init: {0}")]
    Init(String),
    #[error("block cache: {0}")]
    Cache(String),
    #[error(transparent)]
    Lwd(#[from] lwd::Error),
    #[error(transparent)]
    Key(#[from] keys::KeyError),
    #[error("no spending key registered (import_key first)")]
    NoKey,
    #[error("this wallet already holds a different key; use another --data directory")]
    KeyExists,
    #[error("bad birthday: {0}")]
    Birthday(String),
    #[error("lightwalletd misbehaved: {0}")]
    Server(String),
    #[error("no --params directory configured for the Sapling proving parameters")]
    NoProvingParams,
    #[error("sapling-spend.params / sapling-output.params not found in {0}")]
    ProvingParamsMissing(PathBuf),
    #[error("bad address {0}")]
    Address(String),
    #[error("bad amount {0}")]
    Amount(u64),
    #[error("bad memo: {0}")]
    Memo(String),
    #[error("bad hex: {0}")]
    Hex(String),
    #[error("wallet has not synced yet")]
    NotSynced,
    #[error("wallet tip {wallet:?} is not the server's tip {server}; sync and retry")]
    NotAtServerTip { wallet: Option<u32>, server: u32 },
    #[error("another process holds the wallet in {0}")]
    Locked(PathBuf),
    #[error("cannot propose: {0}")]
    Propose(String),
    #[error("cannot create: {0}")]
    Create(String),
    #[error("lightwalletd rejected the transaction ({0}): {1}")]
    Rejected(i32, String),
    #[error("scan: {0}")]
    Scan(String),
    #[error("bad expiry: {0}")]
    Expiry(String),
    #[error(
        "fee {fee} is below the x402 floor {floor} (max(1000, 500 · max(2, logical actions)))"
    )]
    FeeBelowFloor { fee: u64, floor: u64 },
}

impl
    From<
        zcash_client_backend::data_api::chain::error::Error<
            zcash_client_sqlite::error::SqliteClientError,
            zcash_client_sqlite::FsBlockDbError,
        >,
    > for Error
{
    fn from(
        e: zcash_client_backend::data_api::chain::error::Error<
            zcash_client_sqlite::error::SqliteClientError,
            zcash_client_sqlite::FsBlockDbError,
        >,
    ) -> Self {
        Error::Scan(e.to_string())
    }
}
