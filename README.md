# x402-ycash

x402 (HTTP-402, protocol v2, [x402.org](https://x402.org)) agent payments on the Ycash network, in
**YEC** and **YED** (Ycash Yellowback, the dollar on Ycash).

- **Pay-per-request** (`exact`): the agent signs a complete transparent transaction, the facilitator
  verifies it and relays it (the pattern of x402's Cardano binding).
- **Payment channels** (`batch-settlement`): a one-way CLTV channel, so per-request payments stay
  off chain until one close; YEC, then YED.
- **Private payments**: shielded (Sapling) YEC to a fresh diversified address per request.

No consensus change and no node change: it runs against stock `ycashd` RPCs (plus the read-only
`yed_*` RPCs for YED) on both Ycash node lines, 4.5.0 and 6.21.0, and node and pool operators need
to do nothing.

The plan is `docs/plans/x402-agent-payments-plan.md` in the
[Yellowback workspace](https://github.com/boyfromcave/yellowback); the binding specs are in
[`specs/`](specs/), language-neutral test vectors in [`vectors/`](vectors/).

## Layout

```
packages/ycash/   the x402 mechanism (TypeScript, on @x402/core v2): tx, yed, channel, exact, batch, node, store
specs/            the binding specifications (x402 Foundation templates)
vectors/          JSON test vectors every implementation must reproduce
```

## Develop

```
nvm use            # Node 22 (see .nvmrc); >= 20 works
npm install
npm run typecheck
npm test           # unit tests
npm run test:devnet   # against a running yellowback-devnet (see the plan, §6)
```

MIT licensed.
