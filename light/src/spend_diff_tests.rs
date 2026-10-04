//! Differential test of `spend::assemble` against librustzcash's `create_proposed_transactions`
//! on the same proposal (ignored by default: it needs a synced, funded wallet and lightwalletd).
//!
//!   X402_LIGHT_DIFF_DATA  a light data dir with `spending.key` and spendable regtest notes
//!                         (`KEEP=1 scripts/regtest.sh {dd|6} <seed>` leaves one at
//!                         `$X402_SCRATCH/light-<line>-<seed>`)
//!   X402_LIGHT_LWD        lightwalletd address
//!   X402_LIGHT_PARAMS     directory with sapling-{spend,output}.params (default ~/.zcash-params)
//!   X402_LIGHT_DIFF_ZAT   payment amount (default 10000000)
//!   X402_LIGHT_DIFF_BROADCAST=1  also broadcast ours through lightwalletd (the node's verdict)
//!
//! Both transactions are verified offline with sapling-crypto's `BatchValidator` (proofs against
//! the anchor, spend-auth and binding signatures over the ZIP-243 sighash), and ours is re-checked
//! with the expiry changed to show `nExpiryHeight` is inside the signed data. The data dir is left
//! with librustzcash's transaction stored (its notes marked spent until it expires).

use std::collections::BTreeSet;
use std::path::PathBuf;

use rand::rngs::OsRng;
use zcash_client_backend::data_api::wallet::{
    create_proposed_transactions, propose_standard_transfer_to_address, ConfirmationsPolicy,
    SpendingKeys,
};
use zcash_client_backend::data_api::WalletRead;
use zcash_client_backend::fees::StandardFeeRule;
use zcash_client_backend::wallet::OvkPolicy;
use zcash_keys::address::Address;
use zcash_primitives::transaction::sighash::{signature_hash, SignableInput};
use zcash_primitives::transaction::txid::TxIdDigester;
use zcash_primitives::transaction::{Authorized, Transaction, TransactionData};
use zcash_protocol::memo::MemoBytes;
use zcash_protocol::value::{ZatBalance, Zatoshis};
use zcash_protocol::ShieldedProtocol;

use sapling::keys::PreparedIncomingViewingKey;
use sapling::note_encryption::{
    try_sapling_note_decryption, try_sapling_output_recovery, Zip212Enforcement,
};
use sapling::zip32::ExtendedSpendingKey;
use sapling::Rseed;
use zip32::Scope;

use super::*;
use crate::keys;
use crate::wallet::{Options, Wallet};

/// What a v4 Sapling transaction says, minus its randomness.
#[derive(Debug, PartialEq, Eq)]
struct Shape {
    version: String,
    branch: BranchId,
    lock_time: u32,
    anchor: [u8; 32],
    nullifiers: BTreeSet<[u8; 32]>,
    outputs: usize,
    value_balance: i64,
    /// (recipient, value, memo) of every output the sender can open, sorted.
    opened: Vec<(Vec<u8>, u64, Vec<u8>)>,
}

fn shape(tx: &Transaction, extsk: &ExtendedSpendingKey) -> Shape {
    let b = tx.sapling_bundle().expect("a Sapling bundle");
    let dfvk = extsk.to_diversifiable_full_viewing_key();
    let mut anchors: BTreeSet<[u8; 32]> = BTreeSet::new();
    for s in b.shielded_spends() {
        anchors.insert(s.anchor().to_bytes());
    }
    assert_eq!(anchors.len(), 1, "one anchor for every spend");
    let mut opened = Vec::new();
    for o in b.shielded_outputs() {
        // Zip212Enforcement::On refuses a lead byte other than 0x02 (ZIP-212 on Ycash since
        // Canopy + ZIP212_GRACE_PERIOD 3).
        let by_ovk = [Scope::External, Scope::Internal]
            .iter()
            .find_map(|s| try_sapling_output_recovery(&dfvk.to_ovk(*s), o, Zip212Enforcement::On));
        let by_ivk = || {
            [Scope::External, Scope::Internal].iter().find_map(|s| {
                try_sapling_note_decryption(
                    &PreparedIncomingViewingKey::new(&dfvk.to_ivk(*s)),
                    o,
                    Zip212Enforcement::On,
                )
            })
        };
        if let Some((note, to, memo)) = by_ovk.or_else(by_ivk) {
            assert!(
                matches!(note.rseed(), Rseed::AfterZip212(_)),
                "ZIP-212 note"
            );
            opened.push((to.to_bytes().to_vec(), note.value().inner(), memo.to_vec()));
        }
        // else: the padding output, sent to a random address under no key of ours.
    }
    opened.sort();
    Shape {
        version: format!("{:?}", tx.version()),
        branch: tx.consensus_branch_id(),
        lock_time: tx.lock_time(),
        anchor: anchors.into_iter().next().unwrap(),
        nullifiers: b
            .shielded_spends()
            .iter()
            .map(|s| s.nullifier().0)
            .collect(),
        outputs: b.shielded_outputs().len(),
        value_balance: i64::from(*b.value_balance()),
        opened,
    }
}

/// `Authorized` with transparent authorization a sighash can be computed under (there are no
/// transparent inputs, so only the type changes).
#[derive(Debug)]
struct Verifying;
impl zcash_primitives::transaction::Authorization for Verifying {
    type TransparentAuth = zcash_transparent::bundle::EffectsOnly;
    type SaplingAuth = <Authorized as zcash_primitives::transaction::Authorization>::SaplingAuth;
    type OrchardAuth = <Authorized as zcash_primitives::transaction::Authorization>::OrchardAuth;
}

/// The ZIP-243 sighash of a shielded-only transaction, as a verifier computes it.
fn sighash_of_parts(
    tx: &Transaction,
    expiry: BlockHeight,
    branch: BranchId,
    lock_time: u32,
) -> [u8; 32] {
    assert!(tx.transparent_bundle().is_none() && tx.sprout_bundle().is_none());
    let data = TransactionData::<Verifying>::from_parts(
        tx.version(),
        branch,
        lock_time,
        expiry,
        None,
        None,
        tx.sapling_bundle().cloned(),
        None,
    );
    let parts = data.digest(TxIdDigester);
    *signature_hash(&data, &SignableInput::Shielded, &parts).as_ref()
}

fn sighash_of(tx: &Transaction) -> [u8; 32] {
    sighash_of_parts(
        tx,
        tx.expiry_height(),
        tx.consensus_branch_id(),
        tx.lock_time(),
    )
}

/// Proofs and signatures of `tx`'s Sapling bundle, checked against `sighash`.
fn verifies(tx: &Transaction, sighash: [u8; 32], vk: &zcash_proofs::ZcashParameters) -> bool {
    let mut v = sapling::BatchValidator::new();
    let ok = v.check_bundle(tx.sapling_bundle().unwrap().clone(), sighash);
    ok && v.validate(
        &vk.spend_params.verifying_key(),
        &vk.output_params.verifying_key(),
        OsRng,
    )
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a funded light wallet and lightwalletd: see the module docs"]
async fn assemble_matches_create_proposed_transactions() {
    let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} not set"));
    let data = PathBuf::from(var("X402_LIGHT_DIFF_DATA"));
    let params_dir = std::env::var("X402_LIGHT_PARAMS")
        .map(PathBuf::from)
        .unwrap_or(PathBuf::from(var("HOME")).join(".zcash-params"));
    let amount: u64 = std::env::var("X402_LIGHT_DIFF_ZAT")
        .map(|s| s.parse().unwrap())
        .unwrap_or(10_000_000);
    let net = YcashNetwork::devnet_regtest();
    let key = std::fs::read_to_string(data.join("spending.key")).unwrap();
    let extsk = keys::decode_extsk(&net, &key).unwrap();
    let mut w = Wallet::open(Options {
        proving_params_dir: Some(params_dir.clone()),
        spending_key: Some(extsk.clone()),
        ..Options::new(data.clone(), var("X402_LIGHT_LWD"), net)
    })
    .await
    .unwrap();
    w.sync(2000).await.unwrap();
    let account = w.account().unwrap();
    let tip = w.db.chain_height().unwrap().unwrap();
    let target = tip + 1;

    // A merchant whose key we hold, so the payment can be opened from both sides.
    let merchant = ExtendedSpendingKey::master(&rand::random::<[u8; 32]>());
    let (_, merchant_pa) = merchant.default_address();
    let to = Address::Sapling(merchant_pa);
    let memo = MemoBytes::from_bytes(b"x402 spendreview: differential").unwrap();
    let proposal = propose_standard_transfer_to_address::<_, _, crate::wallet::Error>(
        &mut w.db,
        &net,
        StandardFeeRule::Zip317,
        account,
        ConfirmationsPolicy::new_symmetrical(std::num::NonZeroU32::new(1).unwrap()),
        &to,
        Zatoshis::from_u64(amount).unwrap(),
        Some(memo.clone()),
        None,
        ShieldedProtocol::Sapling,
        None,
    )
    .expect("propose (is the wallet funded and synced?)");
    let fee = proposal.steps().head.balance().fee_required();
    let prover = zcash_proofs::prover::LocalTxProver::new(
        &params_dir.join("sapling-spend.params"),
        &params_dir.join("sapling-output.params"),
    );
    let vk = zcash_proofs::load_parameters(
        &params_dir.join("sapling-spend.params"),
        &params_dir.join("sapling-output.params"),
        None,
    );

    // A mismatched payment is refused before anything is proven.
    let short = Payment {
        to: &merchant_pa,
        amount: Zatoshis::from_u64(amount - 1).unwrap(),
        memo: Some(memo.clone()),
    };
    assert!(matches!(
        assemble(
            &mut w.db,
            &net,
            &extsk,
            &prover,
            &proposal,
            &short,
            ExpiryRequest::new(None, u32::MAX)
        ),
        Err(Error::Create(_))
    ));

    // Ours first: assemble stores nothing, create_proposed_transactions stores its transaction.
    let expiry = u32::from(target) + 3 + 12;
    let payment = Payment {
        to: &merchant_pa,
        amount: Zatoshis::from_u64(amount).unwrap(),
        memo: Some(memo.clone()),
    };
    let ours = assemble(
        &mut w.db,
        &net,
        &extsk,
        &prover,
        &proposal,
        &payment,
        ExpiryRequest::new(Some(expiry), DEFAULT_MAX_EXPIRY_WINDOW),
    )
    .unwrap();
    let txids = create_proposed_transactions::<
        _,
        _,
        std::convert::Infallible,
        _,
        std::convert::Infallible,
        _,
    >(
        &mut w.db,
        &net,
        &prover,
        &prover,
        &SpendingKeys::from_unified_spending_key(keys::usk_from_extsk(&extsk)),
        OvkPolicy::Sender,
        &proposal,
        None,
    )
    .expect("create_proposed_transactions");
    let theirs =
        w.db.get_transaction(*txids.first())
            .unwrap()
            .expect("stored");

    // Same notes, outputs, fee, branch, version; only expiry and randomness differ.
    let (so, st) = (shape(&ours, &extsk), shape(&theirs, &extsk));
    println!(
        "spends {}, outputs {}, value balance {}, opened {:?}",
        so.nullifiers.len(),
        so.outputs,
        so.value_balance,
        so.opened.iter().map(|(_, v, _)| v).collect::<Vec<_>>()
    );
    assert!(so == st, "ours {so:?}\ntheirs {st:?}");
    assert_eq!(
        so.value_balance,
        i64::from(ZatBalance::from(fee)),
        "value balance is the proposal's fee"
    );
    assert!(
        so.opened
            .iter()
            .any(|(to, v, m)| to == &merchant_pa.to_bytes().to_vec()
                && *v == amount
                && m == &memo.as_array().to_vec()),
        "the payment, with its memo, under the external OVK"
    );
    assert_eq!(u32::from(ours.expiry_height()), expiry);
    assert_eq!(theirs.expiry_height(), target + 40);
    assert_eq!(
        ours.consensus_branch_id(),
        BranchId::for_height(&net, target)
    );
    // The merchant opens the payment with its own IVK.
    let merchant_ivk = PreparedIncomingViewingKey::new(
        &merchant
            .to_diversifiable_full_viewing_key()
            .to_ivk(Scope::External),
    );
    let got = ours
        .sapling_bundle()
        .unwrap()
        .shielded_outputs()
        .iter()
        .find_map(|o| try_sapling_note_decryption(&merchant_ivk, o, Zip212Enforcement::On))
        .expect("merchant decrypts its note");
    assert_eq!(got.0.value().inner(), amount);
    assert_eq!(&got.2[..], memo.as_array());

    // Fresh randomness: no rk or cv shared between the two builds or within one.
    let rks: BTreeSet<[u8; 32]> = [&ours, &theirs]
        .iter()
        .flat_map(|t| {
            t.sapling_bundle()
                .unwrap()
                .shielded_spends()
                .iter()
                .map(|s| <[u8; 32]>::from(*s.rk()))
        })
        .collect();
    assert_eq!(rks.len(), 2 * so.nullifiers.len(), "fresh alpha per spend");
    let cvs: BTreeSet<[u8; 32]> = [&ours, &theirs]
        .iter()
        .flat_map(|t| {
            let b = t.sapling_bundle().unwrap();
            b.shielded_spends()
                .iter()
                .map(|s| s.cv().to_bytes())
                .chain(b.shielded_outputs().iter().map(|o| o.cv().to_bytes()))
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(
        cvs.len(),
        2 * (so.nullifiers.len() + so.outputs),
        "fresh rcv per description"
    );

    // Both verify (proofs against the anchor, spend-auth and binding signatures over the ZIP-243
    // sighash); ours fails once the expiry, branch id or lock time it was signed with changes.
    assert!(verifies(&theirs, sighash_of(&theirs), &vk));
    assert!(verifies(&ours, sighash_of(&ours), &vk));
    let with = |expiry: BlockHeight, branch: BranchId, lock_time: u32| {
        sighash_of_parts(&ours, expiry, branch, lock_time)
    };
    let e = ours.expiry_height();
    assert!(
        !verifies(&ours, with(e + 1, ours.consensus_branch_id(), 0), &vk),
        "expiry is signed"
    );
    assert!(
        !verifies(&ours, with(e, BranchId::Heartwood, 0), &vk),
        "branch id is signed"
    );
    assert!(
        !verifies(&ours, with(e, ours.consensus_branch_id(), 1), &vk),
        "lock time is signed"
    );

    if std::env::var("X402_LIGHT_DIFF_BROADCAST").is_ok_and(|v| v == "1") {
        let mut raw = Vec::new();
        ours.write(&mut raw).unwrap();
        let sent = w
            .broadcast(&hex::encode(raw))
            .await
            .expect("the node accepts ours");
        assert_eq!(sent.txid, ours.txid().to_string());
        println!("broadcast {}", sent.txid);
    }
}
