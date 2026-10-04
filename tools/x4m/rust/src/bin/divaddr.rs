//! divaddr <zxview-key> <start-index> <count>
//! Derives Sapling diversified payment addresses from a full viewing key alone, offline: no
//! spending key and no node. ZIP-32 diversifier indices; invalid diversifiers (~half) are skipped.
use sapling::zip32::DiversifiableFullViewingKey;
use zip32::DiversifierIndex;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 4 {
        eprintln!("usage: divaddr <zxview-key> <start-index> <count>");
        std::process::exit(2);
    }
    let (hrp, extfvk) = x4m::decode_extfvk(&a[1]).expect("decode viewing key");
    let addr_hrp = x4m::address_hrp_for(&hrp).expect("unknown viewing-key HRP");
    let dfvk: DiversifiableFullViewingKey = extfvk.to_diversifiable_full_viewing_key();
    let mut j = DiversifierIndex::from(a[2].parse::<u64>().expect("start index"));
    let count: usize = a[3].parse().expect("count");
    for _ in 0..count {
        // find_address walks forward from j to the next index whose diversifier is valid.
        let (found, addr) = dfvk.find_address(j).expect("diversifier space exhausted");
        let idx = u64::try_from(found).expect("index fits u64");
        println!("{} {}", idx, x4m::encode_address(addr_hrp, &addr));
        j = DiversifierIndex::from(idx + 1);
    }
}
