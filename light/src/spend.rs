//! Transaction assembly from a proposal, with the caller's `nExpiryHeight`.
//!
//! `zcash_client_backend::create_proposed_transactions` always sets `nExpiryHeight` to the target
//! height + 40 (`zcash_primitives` `Builder::new`, `DEFAULT_TX_EXPIRY_DELTA`) and has no setter. An
//! x402 `sapling` payment must carry tip + 3 + ⌈maxTimeoutSeconds / 75⌉ (spec, Transaction
//! Construction; the facilitator refuses anything outside its window), so this module builds the
//! v4 transaction itself from the proposal's notes: the Sapling bundle with `sapling-crypto`'s
//! builder, the proofs, the ZIP-243 sighash over `TransactionData` with the chosen expiry, and the
//! signatures — the steps of `zcash_primitives` `Builder::build_internal`, Sapling-only.

use rand::rngs::OsRng;
use zcash_client_backend::data_api::WalletCommitmentTrees;
use zcash_client_backend::proposal::Proposal;
use zcash_client_backend::wallet::Note;
use zcash_client_sqlite::error::SqliteClientError;
use zcash_client_sqlite::ReceivedNoteId;
use zcash_keys::address::Address;
use zcash_primitives::transaction::components::sapling::zip212_enforcement;
use zcash_primitives::transaction::sighash::{signature_hash, SignableInput};
use zcash_primitives::transaction::txid::TxIdDigester;
use zcash_primitives::transaction::{
    Authorized, Transaction, TransactionData, TxVersion, Unauthorized,
};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::consensus::{BlockHeight, BranchId};
use zcash_protocol::memo::MemoBytes;
use zcash_protocol::value::{ZatBalance, Zatoshis};
use zcash_protocol::PoolType;

use sapling::builder::{Builder as SaplingBuilder, BundleType};
use sapling::value::NoteValue;
use sapling::zip32::ExtendedSpendingKey;
use sapling::PaymentAddress;
use zip32::Scope;

use crate::net::YcashNetwork;
use crate::wallet::{Db, Error};

/// ZIP-317's marginal fee and grace actions, and the SDK's absolute minimum: the facilitator
/// refuses a payment below max(1000, 500 · max(2, logical actions)) (`packages/ycash/src/tx/fee.ts`
/// `feeFloor`; 6.21.0-shaped transactions need 1500 for three actions).
pub const FLOOR_MARGINAL_ZAT: u64 = 500;
pub const FLOOR_GRACE_ACTIONS: u64 = 2;
pub const FLOOR_MIN_ZAT: u64 = 1000;

/// The relay floor: a transaction expiring before next block + 3 is "expiring soon" on both lines
/// (`ycash-dd/src/main.cpp:742`, `ycash6 :799`, `TX_EXPIRING_SOON_THRESHOLD`).
pub const EXPIRING_SOON_THRESHOLD: u32 = 3;

/// The SDK fee floor of a shielded-only transaction: its logical actions are max(spends, outputs).
pub fn fee_floor(spends: usize, outputs: usize) -> u64 {
    let actions = (spends.max(outputs) as u64).max(FLOOR_GRACE_ACTIONS);
    (FLOOR_MARGINAL_ZAT * actions).max(FLOOR_MIN_ZAT)
}

/// Seconds per block, for the x402 window (`packages/ycash/src/constants.ts` `BLOCK_SECONDS`).
pub const BLOCK_SECONDS: u64 = 75;

/// The widest default window above the relay floor: 1152 blocks, about a day. A transaction that
/// expires later locks its notes that long if it is never mined (`wallet::Options::max_expiry_window`).
pub const DEFAULT_MAX_EXPIRY_WINDOW: u32 = 1152;

/// What the caller asks of `nExpiryHeight`: a height, or `None` for the default, and the most it
/// may sit above the relay floor (target + 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExpiryRequest {
    pub height: Option<u32>,
    pub max_above_floor: u32,
}

impl ExpiryRequest {
    /// A requested height (or the default) within `max_window` blocks of the floor.
    pub fn new(height: Option<u32>, max_window: u32) -> Self {
        ExpiryRequest {
            height,
            max_above_floor: max_window,
        }
    }

    /// The x402 window for `maxTimeoutSeconds` (`specs/scheme_exact_ycash.md` rule 8, with
    /// tip = target − 1): tip + 4 ≤ expiry ≤ tip + 4 + ⌈t/75⌉ + 1. Without a height, the client's
    /// tip + 3 + ⌈t/75⌉ (Transaction Construction), raised to the floor when ⌈t/75⌉ is 0.
    /// `max_window` still caps it.
    pub fn for_timeout(
        target: BlockHeight,
        max_timeout_seconds: u64,
        height: Option<u32>,
        max_window: u32,
    ) -> Self {
        let blocks = u32::try_from(max_timeout_seconds.div_ceil(BLOCK_SECONDS)).unwrap_or(u32::MAX);
        let floor = u32::from(target).saturating_add(EXPIRING_SOON_THRESHOLD);
        let client = (u32::from(target) - 1)
            .saturating_add(EXPIRING_SOON_THRESHOLD)
            .saturating_add(blocks);
        ExpiryRequest {
            height: Some(height.unwrap_or(client.max(floor))),
            max_above_floor: blocks.saturating_add(1).min(max_window),
        }
    }
}

/// The `nExpiryHeight` to use: the caller's, which must lie in [target + 3, target + 3 +
/// `max_above_floor`], or the librustzcash default of target + 40 (lowered to that bound). Either
/// must stay below the next network upgrade: the signature commits to the target's branch id, so
/// a transaction still unmined at the upgrade can never be mined, yet the wallet would hold its
/// notes until `nExpiryHeight`. ycashd caps its own default the same way
/// (`ycash-dd/src/main.cpp:7386-7388`, `ycash6/src/main.cpp:9441-9443`); a requested expiry is the
/// x402 contract, so it is refused rather than moved.
pub fn choose_expiry(
    params: &YcashNetwork,
    target: BlockHeight,
    requested: ExpiryRequest,
) -> Result<BlockHeight, Error> {
    let branch = BranchId::for_height(params, target);
    let min = u32::from(target) + EXPIRING_SOON_THRESHOLD;
    // 499_999_999 is the largest nExpiryHeight consensus allows (ZIP-203).
    let max = min
        .saturating_add(requested.max_above_floor)
        .min(499_999_999);
    let Some(e) = requested.height else {
        // At most 40 steps down to the last height of the target's branch.
        let mut e = BlockHeight::from_u32((u32::from(target) + 40).min(max));
        while BranchId::for_height(params, e) != branch && u32::from(e) > min {
            e = e - 1;
        }
        if BranchId::for_height(params, e) != branch {
            return Err(Error::Expiry(format!(
                "a network upgrade activates within {EXPIRING_SOON_THRESHOLD} blocks of target height {target}"
            )));
        }
        return Ok(e);
    };
    if e < min || e > max {
        return Err(Error::Expiry(format!(
            "expiryHeight {e} must be in [{min}, {max}] for target height {target}"
        )));
    }
    let e = BlockHeight::from_u32(e);
    if BranchId::for_height(params, e) != branch {
        return Err(Error::Expiry(format!(
            "expiryHeight {e} is past the next network upgrade (branch {:?} at target height {target})",
            branch
        )));
    }
    Ok(e)
}

/// One payment to a Sapling address.
pub struct Payment<'a> {
    pub to: &'a PaymentAddress,
    pub amount: Zatoshis,
    pub memo: Option<MemoBytes>,
}

/// The proposal is the authority on what the transaction pays: `payment` must be its one request
/// payment, to a Sapling address, or a mismatch would silently become fee or wrong change.
fn check_payment<FR>(
    params: &YcashNetwork,
    step: &zcash_client_backend::proposal::Step<FR>,
    payment: &Payment<'_>,
) -> Result<(), Error> {
    let payments = step.transaction_request().payments();
    let ok = payments.len() == 1
        && step
            .payment_pools()
            .values()
            .all(|p| *p == PoolType::SAPLING)
        && payments.values().all(|p| {
            p.amount() == Some(payment.amount)
                && p.memo() == payment.memo.as_ref()
                && *p.recipient_address() == Address::Sapling(*payment.to).to_zcash_address(params)
        });
    if !ok {
        return Err(Error::Create(
            "the payment does not match the proposal's request".into(),
        ));
    }
    Ok(())
}

/// Builds, proves and signs the single-step, Sapling-only transaction `proposal` describes,
/// paying `payment` with the proposal's change, at `expiry`. Nothing is stored or broadcast.
pub fn assemble<FR>(
    db: &mut Db,
    params: &YcashNetwork,
    extsk: &ExtendedSpendingKey,
    prover: &LocalTxProver,
    proposal: &Proposal<FR, ReceivedNoteId>,
    payment: &Payment<'_>,
    expiry: ExpiryRequest,
) -> Result<Transaction, Error> {
    if proposal.steps().len() != 1 {
        return Err(Error::Create(format!(
            "expected a one-step proposal, got {}",
            proposal.steps().len()
        )));
    }
    let step = &proposal.steps().head;
    if !step.transparent_inputs().is_empty() || !step.prior_step_inputs().is_empty() {
        return Err(Error::Create(
            "the proposal spends transparent coins".into(),
        ));
    }
    let inputs = step
        .shielded_inputs()
        .ok_or_else(|| Error::Create("the proposal has no shielded inputs".into()))?;
    let target = BlockHeight::from(proposal.min_target_height());
    let expiry = choose_expiry(params, target, expiry)?;
    check_payment(params, step, payment)?;
    let branch_id = BranchId::for_height(params, target);
    let anchor_height = inputs.anchor_height();

    // The anchor and a witness per note, at the proposal's anchor checkpoint.
    let (anchor, spends) = db.with_sapling_tree_mut::<_, _, SqliteClientError>(|tree| {
        let anchor: sapling::Anchor = tree
            .root_at_checkpoint_id(&anchor_height)?
            .ok_or_else(|| {
                SqliteClientError::CorruptedData(format!("no anchor at {anchor_height}"))
            })?
            .into();
        let mut spends = Vec::new();
        for selected in inputs.notes().iter() {
            // Sapling is the only shielded pool here (no `orchard` feature; Orchard is inactive on Ycash).
            let Note::Sapling(note) = selected.note();
            let path = tree
                .witness_at_checkpoint_id_caching(
                    selected.note_commitment_tree_position(),
                    &anchor_height,
                )?
                .ok_or_else(|| {
                    SqliteClientError::CorruptedData(format!(
                        "no witness at {anchor_height} (checkpoint pruned)"
                    ))
                })?;
            spends.push((selected.spending_key_scope(), note.clone(), path));
        }
        Ok((anchor, spends))
    })?;

    let dfvk = extsk.to_diversifiable_full_viewing_key();
    let mut builder = SaplingBuilder::new(
        zip212_enforcement(params, target),
        BundleType::DEFAULT,
        anchor,
    );
    for (scope, note, path) in spends {
        let fvk = match scope {
            Scope::External => dfvk.fvk().clone(),
            Scope::Internal => dfvk.to_internal_fvk(),
        };
        builder
            .add_spend(fvk, note, path)
            .map_err(|e| Error::Create(format!("spend: {e:?}")))?;
    }
    // The payment under the external OVK (OvkPolicy::Sender, as create_proposed_transactions), so
    // the wallet recovers what it paid from the chain. Change also under the internal OVK, where
    // create_proposed_transactions passes none; the internal IVK finds it either way, and the
    // internal OVK derives from the same full viewing key, so this reveals nothing new.
    let memo_bytes =
        |m: Option<&MemoBytes>| *m.cloned().unwrap_or_else(MemoBytes::empty).as_array();
    builder
        .add_output(
            Some(dfvk.to_ovk(Scope::External)),
            *payment.to,
            NoteValue::from_raw(payment.amount.into_u64()),
            memo_bytes(payment.memo.as_ref()),
        )
        .map_err(|e| Error::Create(format!("output: {e:?}")))?;
    let (_, change_address) = dfvk.change_address();
    for change in step.balance().proposed_change() {
        if change.output_pool() != PoolType::SAPLING {
            return Err(Error::Create(format!(
                "change to {:?} is not supported",
                change.output_pool()
            )));
        }
        builder
            .add_output(
                Some(dfvk.to_ovk(Scope::Internal)),
                change_address,
                NoteValue::from_raw(change.value().into_u64()),
                memo_bytes(change.memo()),
            )
            .map_err(|e| Error::Create(format!("change: {e:?}")))?;
    }

    let extsks = [extsk.clone(), extsk.derive_internal()];
    let mut rng = OsRng;
    let (bundle, _meta) = builder
        .build::<LocalTxProver, LocalTxProver, _, ZatBalance>(&extsks, &mut rng)
        .map_err(|e| Error::Create(format!("bundle: {e:?}")))?
        .ok_or_else(|| Error::Create("empty Sapling bundle".into()))?;
    // Builder::build_internal's consistency check: shielded-only, so the value balance is the
    // fee, and it must be exactly the fee the proposal computed (nothing lost to the miner).
    let fee = step.balance().fee_required();
    if *bundle.value_balance() != ZatBalance::from(fee) {
        return Err(Error::Create(format!(
            "value balance {} is not the proposal's fee {}",
            i64::from(*bundle.value_balance()),
            fee.into_u64()
        )));
    }
    // Proofs before signatures: a v4 sighash commits to the proofs (as Builder::build_internal).
    let proven = bundle.create_proofs(prover, prover, &mut rng, ());

    let version = TxVersion::suggested_for_branch(branch_id);
    let unauthed: TransactionData<Unauthorized> = TransactionData::from_parts(
        version,
        branch_id,
        0,
        expiry,
        None,
        None,
        Some(proven),
        None,
    );
    let txid_parts = unauthed.digest(TxIdDigester);
    let sighash = signature_hash(&unauthed, &SignableInput::Shielded, &txid_parts);
    let asks: Vec<_> = extsks.iter().map(|k| k.expsk.ask.clone()).collect();
    let signed = unauthed
        .sapling_bundle()
        .cloned()
        .expect("built with a Sapling bundle")
        .apply_signatures(rng, *sighash.as_ref(), &asks)
        .map_err(|e| Error::Create(format!("signatures: {e:?}")))?;
    let authorized: TransactionData<Authorized> = TransactionData::from_parts(
        version,
        branch_id,
        0,
        expiry,
        None,
        None,
        Some(signed),
        None,
    );
    authorized
        .freeze()
        .map_err(|e| Error::Create(e.to_string()))
}

#[cfg(test)]
#[path = "spend_diff_tests.rs"]
mod diff_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_floor_matches_the_sdk() {
        // feeFloor in packages/ycash/src/tx/fee.ts: max(1000, 500 · max(2, actions)).
        assert_eq!(fee_floor(1, 2), 1000);
        assert_eq!(fee_floor(0, 0), 1000);
        assert_eq!(fee_floor(1, 3), 1500);
        assert_eq!(fee_floor(5, 2), 2500);
        // ZIP-317's conventional fee (the light client's default) always clears it.
        for (s, o) in [(1, 2), (3, 2), (10, 2)] {
            assert!(5000 * (s.max(o) as u64).max(2) >= fee_floor(s, o));
        }
    }

    /// The pre-window behaviour: no upper bound short of consensus's.
    fn any(height: Option<u32>) -> ExpiryRequest {
        ExpiryRequest::new(height, u32::MAX)
    }

    #[test]
    fn expiry_window_caps_a_requested_height() {
        let net = YcashNetwork::devnet_regtest();
        let t = BlockHeight::from_u32(100);
        let day = ExpiryRequest::new(Some(103 + 1152), DEFAULT_MAX_EXPIRY_WINDOW);
        assert_eq!(
            choose_expiry(&net, t, day).unwrap(),
            BlockHeight::from_u32(1255)
        );
        let over = ExpiryRequest::new(Some(103 + 1153), DEFAULT_MAX_EXPIRY_WINDOW);
        assert!(matches!(
            choose_expiry(&net, t, over),
            Err(Error::Expiry(_))
        ));
        // The default comes down to a narrow window rather than failing.
        let narrow = ExpiryRequest::new(None, 10);
        assert_eq!(
            choose_expiry(&net, t, narrow).unwrap(),
            BlockHeight::from_u32(113)
        );
    }

    #[test]
    fn max_timeout_seconds_enforces_the_spec_window() {
        let net = YcashNetwork::devnet_regtest();
        // tip 99, target 100, maxTimeoutSeconds 900 → ⌈900/75⌉ = 12: rule 8 is [103, 116].
        let t = BlockHeight::from_u32(100);
        let w = |h| ExpiryRequest::for_timeout(t, 900, h, DEFAULT_MAX_EXPIRY_WINDOW);
        assert_eq!(w(None), ExpiryRequest::new(Some(114), 13));
        assert_eq!(
            choose_expiry(&net, t, w(None)).unwrap(),
            BlockHeight::from_u32(114)
        );
        assert_eq!(
            choose_expiry(&net, t, w(Some(103))).unwrap(),
            BlockHeight::from_u32(103)
        );
        assert_eq!(
            choose_expiry(&net, t, w(Some(116))).unwrap(),
            BlockHeight::from_u32(116)
        );
        assert!(matches!(
            choose_expiry(&net, t, w(Some(117))),
            Err(Error::Expiry(_))
        ));
        assert!(matches!(
            choose_expiry(&net, t, w(Some(140))),
            Err(Error::Expiry(_))
        ));
        // ⌈0/75⌉ = 0: the client's tip + 3 is below the relay floor, so the floor it is.
        let zero = ExpiryRequest::for_timeout(t, 0, None, DEFAULT_MAX_EXPIRY_WINDOW);
        assert_eq!(
            choose_expiry(&net, t, zero).unwrap(),
            BlockHeight::from_u32(103)
        );
        // The wallet's own cap still applies to a long timeout.
        let long = ExpiryRequest::for_timeout(t, 7 * 86_400, None, DEFAULT_MAX_EXPIRY_WINDOW);
        assert_eq!(long.max_above_floor, DEFAULT_MAX_EXPIRY_WINDOW);
        assert!(matches!(
            choose_expiry(&net, t, long),
            Err(Error::Expiry(_))
        ));
    }

    #[test]
    fn expiry_defaults_to_target_plus_40_and_keeps_the_relay_floor() {
        let net = YcashNetwork::devnet_regtest();
        let t = BlockHeight::from_u32(100);
        assert_eq!(
            choose_expiry(&net, t, any(None)).unwrap(),
            BlockHeight::from_u32(140)
        );
        // tip 99 → target 100; the spec's tip + 3 + ⌈60/75⌉ = 103 is exactly the floor.
        assert_eq!(
            choose_expiry(&net, t, any(Some(103))).unwrap(),
            BlockHeight::from_u32(103)
        );
        assert!(matches!(
            choose_expiry(&net, t, any(Some(102))),
            Err(Error::Expiry(_))
        ));
        assert!(matches!(
            choose_expiry(&net, t, any(Some(500_000_000))),
            Err(Error::Expiry(_))
        ));
    }

    #[test]
    fn expiry_stays_below_the_next_upgrade() {
        // NU5 at 120: the default is capped at 119, a requested expiry past it is refused.
        let net = YcashNetwork::devnet_regtest()
            .with_upgrades("nu5=120")
            .unwrap();
        let t = BlockHeight::from_u32(100);
        assert_eq!(
            choose_expiry(&net, t, any(None)).unwrap(),
            BlockHeight::from_u32(119)
        );
        assert_eq!(
            choose_expiry(&net, t, any(Some(119))).unwrap(),
            BlockHeight::from_u32(119)
        );
        assert!(matches!(
            choose_expiry(&net, t, any(Some(120))),
            Err(Error::Expiry(_))
        ));
        // An upgrade inside the relay floor leaves no valid default.
        let net = YcashNetwork::devnet_regtest()
            .with_upgrades("nu5=102")
            .unwrap();
        assert!(matches!(
            choose_expiry(&net, t, any(None)),
            Err(Error::Expiry(_))
        ));
        // Mainnet schedules nothing after Canopy: the default is untouched.
        let t = BlockHeight::from_u32(3_100_000);
        assert_eq!(
            choose_expiry(&YcashNetwork::Main, t, any(None)).unwrap(),
            BlockHeight::from_u32(3_100_040)
        );
    }
}
