# Binding specifications

The x402 bindings for Ycash, in the x402 Foundation's templates (`specs/scheme_impl_template.md`
upstream). These files are the language-neutral source of truth: the TypeScript package and any
later port (Python, plan X-2) implement them.

- `scheme_exact_ycash.md`: `exact` for YEC (transparent), YED (≥ $1) and shielded YEC (client-submitted).
- `scheme_batch_settlement_ycash.md`: payment channels in YEC and YED.
