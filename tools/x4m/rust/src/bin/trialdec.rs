//! trialdec <dump> <zxview-key|random> [rounds]
//! Times Sapling compact trial decryption (the light-wallet scan cost) over lwdprobe's dump of
//! real compact outputs, one output at a time and batched, and lists the outputs the key owns.
use rand::RngCore;
use sapling::keys::PreparedIncomingViewingKey;
use sapling::note_encryption::{try_sapling_compact_note_decryption, SaplingDomain, Zip212Enforcement};
use sapling::zip32::ExtendedSpendingKey;
use std::time::Instant;
use zip32::Scope;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 3 {
        eprintln!("usage: trialdec <dump> <zxview-key|random> [rounds]");
        std::process::exit(2);
    }
    let recs = x4m::read_dump(&a[1]);
    let rounds: usize = a.get(3).map(|s| s.parse().unwrap()).unwrap_or(3);
    let (dfvk, addr_hrp) = if a[2] == "random" {
        let mut seed = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut seed);
        (ExtendedSpendingKey::master(&seed).to_diversifiable_full_viewing_key(), "ys")
    } else {
        let (hrp, k) = x4m::decode_extfvk(&a[2]).expect("decode viewing key");
        (k.to_diversifiable_full_viewing_key(), x4m::address_hrp_for(&hrp).unwrap())
    };
    let ivk = PreparedIncomingViewingKey::new(&dfvk.to_ivk(Scope::External));
    // Canopy (ZIP-212 on) is active on mainnet since well before the dumped ranges and on regtest.
    let z = Zip212Enforcement::On;
    let n = recs.len();

    let mut best_single = f64::MAX;
    let mut hits = Vec::new();
    for r in 0..rounds {
        let t = Instant::now();
        let mut h = Vec::new();
        for (i, rec) in recs.iter().enumerate() {
            if let Some((note, addr)) = try_sapling_compact_note_decryption(&ivk, &rec.output, z) {
                h.push((i, note.value().inner(), addr));
            }
        }
        best_single = best_single.min(t.elapsed().as_secs_f64());
        if r == 0 {
            hits = h;
        }
    }
    let pairs: Vec<_> = recs.iter().map(|r| (SaplingDomain::new(z), r.output.clone())).collect();
    let mut best_batch = f64::MAX;
    let mut batch_hits = 0;
    for _ in 0..rounds {
        let t = Instant::now();
        let res = zcash_note_encryption::batch::try_compact_note_decryption(&[ivk.clone()], &pairs);
        best_batch = best_batch.min(t.elapsed().as_secs_f64());
        batch_hits = res.iter().filter(|x| x.is_some()).count();
    }
    // All cores, the way zcash_client_backend's batch runners spread scanning (rayon).
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let mut best_par = f64::MAX;
    for _ in 0..rounds {
        let t = Instant::now();
        let chunk = (n + threads - 1) / threads.max(1);
        std::thread::scope(|sc| {
            for part in recs.chunks(chunk.max(1)) {
                let ivk = &ivk;
                sc.spawn(move || part.iter().filter(|r| try_sapling_compact_note_decryption(ivk, &r.output, z).is_some()).count());
            }
        });
        best_par = best_par.min(t.elapsed().as_secs_f64());
    }
    // A light wallet also appends every cmu to its note-commitment tree (to witness its own notes).
    let t = Instant::now();
    let mut tree = sapling::CommitmentTree::empty();
    for rec in &recs {
        if tree.append(sapling::Node::from_cmu(&rec.output.cmu)).is_err() {
            break;
        }
    }
    let tree_s = t.elapsed().as_secs_f64();
    println!("{{\"treeAppendSeconds\":{:.6},\"treeAppendUsPerOutput\":{:.3}}}", tree_s,
        if n > 0 { tree_s * 1e6 / n as f64 } else { 0.0 });
    println!("{{\"threads\":{},\"parallelSeconds\":{:.6},\"parallelUsPerOutput\":{:.3}}}", threads, best_par,
        if n > 0 { best_par * 1e6 / n as f64 } else { 0.0 });
    println!(
        "{{\"outputs\":{},\"hits\":{},\"batchHits\":{},\"singleSeconds\":{:.6},\"batchSeconds\":{:.6},\"singleUsPerOutput\":{:.3},\"batchUsPerOutput\":{:.3}}}",
        n, hits.len(), batch_hits, best_single, best_batch,
        if n > 0 { best_single * 1e6 / n as f64 } else { 0.0 },
        if n > 0 { best_batch * 1e6 / n as f64 } else { 0.0 }
    );
    for (i, v, addr) in hits {
        let mut txid = recs[i].txid;
        txid.reverse(); // compact blocks carry the txid in internal byte order
        println!("HIT height={} txid={} out={} value={} to={}", recs[i].height, hex::encode(txid),
            recs[i].out_index, v, x4m::encode_address(addr_hrp, &addr));
    }
}
