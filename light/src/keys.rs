//! Sapling keys: import, derivation and the unified-key wrapper the backend wants.
//!
//! `zcash_client_backend` spends from a `UnifiedSpendingKey`. With only the `sapling` feature
//! enabled that key *is* a Sapling extended spending key, and `UnifiedSpendingKey::from_bytes`
//! (feature `unstable`) accepts an encoding that carries just the Sapling item, so a key imported
//! as `secret-extended-key-…` (the form `z_exportkey` prints) becomes a USK without a seed.

use bip0039::{English, Mnemonic};
use secrecy::{ExposeSecret, SecretVec};
use zcash_keys::encoding::{
    decode_extended_spending_key, encode_extended_full_viewing_key, encode_extended_spending_key,
    encode_payment_address,
};
use zcash_keys::keys::{Era, UnifiedFullViewingKey, UnifiedSpendingKey};
use zcash_protocol::consensus::{BranchId, NetworkConstants, Parameters};
use zip32::AccountId;

use sapling::zip32::{ExtendedFullViewingKey, ExtendedSpendingKey};

/// The ZIP-316 typecode of a Sapling item, as `UnifiedSpendingKey::to_bytes` writes it.
const TYPECODE_SAPLING: u8 = 2;
const EXTSK_LEN: u8 = 169;

/// Wraps a bare Sapling extended spending key as the backend's unified key.
pub fn usk_from_extsk(extsk: &ExtendedSpendingKey) -> UnifiedSpendingKey {
    let mut buf = Vec::with_capacity(4 + 2 + usize::from(EXTSK_LEN));
    // The era id is the NU5 branch id (zcash_keys::keys::Era::id).
    buf.extend_from_slice(&u32::from(BranchId::Nu5).to_le_bytes());
    buf.push(TYPECODE_SAPLING); // CompactSize of a value < 253 is the byte itself
    buf.push(EXTSK_LEN);
    buf.extend_from_slice(&extsk.to_bytes());
    UnifiedSpendingKey::from_bytes(Era::Orchard, &buf).expect("a valid extsk wraps into a USK")
}

/// What the user handed us: an encoded extended spending key, or a BIP-39 phrase from which the
/// ZIP-32 account 0 key is derived (m/32'/coin_type'/0', as ycashd's HD wallet does).
pub fn import<P: Parameters>(params: &P, secret: &str) -> Result<ExtendedSpendingKey, KeyError> {
    let secret = secret.trim();
    let hrp = params.hrp_sapling_extended_spending_key();
    if secret.starts_with("secret-extended-key-") {
        if !secret.starts_with(hrp) {
            return Err(KeyError::WrongNetwork(hrp.to_owned()));
        }
        return decode_extended_spending_key(hrp, secret)
            .map_err(|e| KeyError::Decode(e.to_string()));
    }
    let mnemonic: Mnemonic<English> =
        Mnemonic::from_phrase(secret).map_err(|e| KeyError::Mnemonic(e.to_string()))?;
    let seed = SecretVec::new(mnemonic.to_seed("").to_vec());
    Ok(zcash_keys::keys::sapling::spending_key(
        seed.expose_secret(),
        params.coin_type(),
        AccountId::ZERO,
    ))
}

pub fn encode_extsk<P: Parameters>(params: &P, extsk: &ExtendedSpendingKey) -> String {
    encode_extended_spending_key(params.hrp_sapling_extended_spending_key(), extsk)
}

pub fn decode_extsk<P: Parameters>(params: &P, s: &str) -> Result<ExtendedSpendingKey, KeyError> {
    decode_extended_spending_key(params.hrp_sapling_extended_spending_key(), s.trim())
        .map_err(|e| KeyError::Decode(e.to_string()))
}

/// `zxviews…` (`zxviewregtestsapling…`), the form `z_exportviewingkey` prints and
/// `z_importviewingkey` accepts.
pub fn encode_extfvk<P: Parameters>(params: &P, extsk: &ExtendedSpendingKey) -> String {
    #[allow(deprecated)]
    let extfvk: ExtendedFullViewingKey = extsk.to_extended_full_viewing_key();
    encode_extended_full_viewing_key(params.hrp_sapling_extended_full_viewing_key(), &extfvk)
}

/// The key's default diversified address (`ys1…`, `yregtestsapling1…`).
pub fn default_address<P: Parameters>(params: &P, extsk: &ExtendedSpendingKey) -> String {
    let (_, addr) = extsk.default_address();
    encode_payment_address(params.hrp_sapling_payment_address(), &addr)
}

pub fn ufvk(usk: &UnifiedSpendingKey) -> UnifiedFullViewingKey {
    usk.to_unified_full_viewing_key()
}

#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("key is for another network (want prefix {0})")]
    WrongNetwork(String),
    #[error("cannot decode spending key: {0}")]
    Decode(String),
    #[error("bad seed phrase: {0}")]
    Mnemonic(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::YcashNetwork;

    fn test_extsk() -> ExtendedSpendingKey {
        ExtendedSpendingKey::master(&[7u8; 32])
    }

    #[test]
    fn usk_round_trips_the_sapling_key() {
        let extsk = test_extsk();
        let usk = usk_from_extsk(&extsk);
        assert_eq!(usk.sapling().to_bytes(), extsk.to_bytes());
        assert_eq!(usk.to_bytes(Era::Orchard).len(), 4 + 2 + 169);
        let fvk = ufvk(&usk);
        assert!(fvk.sapling().is_some());
        assert_eq!(
            fvk.sapling().unwrap().to_bytes(),
            extsk.to_diversifiable_full_viewing_key().to_bytes()
        );
    }

    #[test]
    fn encodings_use_the_network_hrps() {
        let extsk = test_extsk();
        let reg = YcashNetwork::devnet_regtest();
        let enc = encode_extsk(&reg, &extsk);
        assert!(enc.starts_with("secret-extended-key-regtest1"));
        assert_eq!(
            decode_extsk(&reg, &enc).unwrap().to_bytes(),
            extsk.to_bytes()
        );
        assert_eq!(import(&reg, &enc).unwrap().to_bytes(), extsk.to_bytes());
        assert!(encode_extfvk(&reg, &extsk).starts_with("zxviewregtestsapling1"));
        assert!(default_address(&reg, &extsk).starts_with("yregtestsapling1"));
        assert!(default_address(&YcashNetwork::Main, &extsk).starts_with("ys1"));
        assert!(encode_extsk(&YcashNetwork::Main, &extsk).starts_with("secret-extended-key-main1"));
        assert!(matches!(
            import(&YcashNetwork::Main, &enc),
            Err(KeyError::WrongNetwork(_))
        ));
    }

    #[test]
    fn seed_phrase_derives_account_zero() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let main = import(&YcashNetwork::Main, phrase).unwrap();
        let reg = import(&YcashNetwork::devnet_regtest(), phrase).unwrap();
        // coin types differ (347 vs 1), so the keys do.
        assert_ne!(main.to_bytes(), reg.to_bytes());
        assert!(import(&YcashNetwork::Main, "not a phrase").is_err());
    }
}
