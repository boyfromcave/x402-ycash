### Ycash

- Network binding: `network` MUST match the chain the facilitator's node reports (`ycash:mainnet`, `ycash:testnet`, `ycash:regtest`); the ZIP-243 signature hash binds the consensus branch id, so a transaction signed for one network does not validate on another.
- Transfer correctness: exactly one output pays `payTo`, with `amount` zatoshis for `YEC`; for `YED` the transaction's single Yellowback TRANSFER assigns exactly `amount` cents to that output and burns nothing.
- Signature scope: every input MUST be signed `SIGHASH_ALL`, so the facilitator relays the transaction byte for byte and no party can add or redirect outputs.
- Validity window: `nExpiryHeight` MUST be set and bounded by `maxTimeoutSeconds`; `nLockTime` MUST be 0.
- Replay protection: the spent outpoints are the replay primitive; inputs MUST be unspent and not spent by a mempool transaction at verification, and settlements are deduplicated by txid in a store shared by every process serving `/settle`.
- No sponsorship: the payer funds the network fee inside the signed transaction; the facilitator holds no keys and pays nothing.
- Shielded payments (`sapling-proof`, client-submitted; `sapling`, facilitator-submitted): `payTo` is a diversified Sapling address issued for this request only and `extra.memo` commits to the request; the facilitator MUST find exactly one output to `payTo` of at least `amount` zatoshis carrying that memo, decrypted with the merchant's incoming viewing key, and MUST claim the txid atomically before the resource runs. `sapling` transactions are verified before broadcast and broadcast only at settle. A facilitator holding the merchant's viewing key learns all revenue at that key, so it MUST be the merchant's own.
