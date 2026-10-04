//! Shared helpers for the X4-M tools: Ycash Sapling key/address encoding and the lwdprobe dump.
use bech32::{primitives::decode::CheckedHrpstring, Bech32, Hrp};
use sapling::note_encryption::CompactOutputDescription;
use sapling::zip32::ExtendedFullViewingKey;
use zcash_note_encryption::EphemeralKeyBytes;

/// Ycash extended-full-viewing-key HRP -> Sapling payment-address HRP
/// (ycash-dd/src/chainparams.cpp:164-168, :424-428, :623-627).
pub fn address_hrp_for(fvk_hrp: &str) -> Option<&'static str> {
    match fvk_hrp {
        "zxviews" => Some("ys"),
        "zxviewtestsapling" => Some("ytestsapling"),
        "zxviewregtestsapling" => Some("yregtestsapling"),
        _ => None,
    }
}

/// Decodes a `zxview…` key as `z_exportviewingkey` prints it. Bech32 with no length limit, as
/// zcash_keys::encoding::bech32_decode does.
pub fn decode_extfvk(s: &str) -> Result<(String, ExtendedFullViewingKey), String> {
    let parsed = CheckedHrpstring::new::<Bech32>(s).map_err(|e| e.to_string())?;
    let hrp = parsed.hrp().as_str().to_owned();
    let data: Vec<u8> = parsed.byte_iter().collect();
    let k = ExtendedFullViewingKey::read(&data[..]).map_err(|e| e.to_string())?;
    Ok((hrp, k))
}

pub fn encode_address(hrp: &str, addr: &sapling::PaymentAddress) -> String {
    bech32::encode::<Bech32>(Hrp::parse_unchecked(hrp), &addr.to_bytes()).expect("encodable")
}

/// One record of lwdprobe's dump (164 bytes).
pub struct Rec {
    pub height: u32,
    pub txid: [u8; 32],
    pub out_index: u32,
    pub output: CompactOutputDescription,
}

pub fn read_dump(path: &str) -> Vec<Rec> {
    let b = std::fs::read(path).expect("read dump");
    assert_eq!(b.len() % 164, 0, "dump length is not a multiple of 164");
    b.chunks(164)
        .filter_map(|r| {
            let cmu: [u8; 32] = r[48..80].try_into().unwrap();
            let cmu = Option::from(sapling::note::ExtractedNoteCommitment::from_bytes(&cmu))?;
            Some(Rec {
                height: u32::from_le_bytes(r[0..4].try_into().unwrap()),
                out_index: u32::from_le_bytes(r[8..12].try_into().unwrap()),
                txid: r[16..48].try_into().unwrap(),
                output: CompactOutputDescription {
                    ephemeral_key: EphemeralKeyBytes(r[80..112].try_into().unwrap()),
                    cmu,
                    enc_ciphertext: r[112..164].try_into().unwrap(),
                },
            })
        })
        .collect()
}
