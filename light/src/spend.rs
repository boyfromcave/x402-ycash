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

/// The `nExpiryHeight` to use: the caller's, which must leave the relay floor, or the
/// librustzcash default of target + 40.
pub fn choose_expiry(target: BlockHeight, requested: Option<u32>) -> Result<BlockHeight, Error> {
    let Some(e) = requested else {
        return Ok(target + 40);
    };
    let min = u32::from(target) + EXPIRING_SOON_THRESHOLD;
    // 499_999_999 is the largest nExpiryHeight consensus allows (ZIP-203).
    if e < min || e > 499_999_999 {
        return Err(Error::Expiry(format!(
            "expiryHeight {e} must be in [{min}, 499999999] for target height {target}"
        )));
    }
    Ok(BlockHeight::from_u32(e))
}

/// One payment to a Sapling address.
pub struct Payment<'a> {
    pub to: &'a PaymentAddress,
    pub amount: Zatoshis,
    pub memo: Option<MemoBytes>,
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
    expiry: Option<u32>,
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
    let expiry = choose_expiry(target, expiry)?;
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
    // OvkPolicy::Sender, as create_proposed_transactions: the payment under the external OVK, change
    // under the internal one, so the wallet recovers both from the chain.
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

    #[test]
    fn expiry_defaults_to_target_plus_40_and_keeps_the_relay_floor() {
        let t = BlockHeight::from_u32(100);
        assert_eq!(choose_expiry(t, None).unwrap(), BlockHeight::from_u32(140));
        // tip 99 → target 100; the spec's tip + 3 + ⌈60/75⌉ = 103 is exactly the floor.
        assert_eq!(
            choose_expiry(t, Some(103)).unwrap(),
            BlockHeight::from_u32(103)
        );
        assert!(matches!(choose_expiry(t, Some(102)), Err(Error::Expiry(_))));
        assert!(matches!(
            choose_expiry(t, Some(500_000_000)),
            Err(Error::Expiry(_))
        ));
    }
}
