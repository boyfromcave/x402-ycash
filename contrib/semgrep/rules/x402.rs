// Tests for x402.yaml (semgrep --test contrib/semgrep/rules). Not compiled, not shipped.
fn seeds() {
    // ruleid: x402.crypto.non-crypto-rng-rust
    let a = SmallRng::from_entropy();
    // ruleid: x402.crypto.non-crypto-rng-rust
    let b = StdRng::seed_from_u64(7);
    // ok: x402.crypto.non-crypto-rng-rust
    let c = OsRng;
    // ok: x402.crypto.non-crypto-rng-rust
    let d = rand::thread_rng();
}
