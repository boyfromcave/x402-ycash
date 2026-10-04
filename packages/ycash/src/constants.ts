// Network ids and assets (plan X-3, X-4). Ycash's genesis blocks are Zcash's, so the network id is a
// named namespace, following Cardano's unregistered `cardano:mainnet` form.
export const YCASH_MAINNET = "ycash:mainnet" as const;
export const YCASH_TESTNET = "ycash:testnet" as const;
export const YCASH_REGTEST = "ycash:regtest" as const;
export type YcashNetwork = typeof YCASH_MAINNET | typeof YCASH_TESTNET | typeof YCASH_REGTEST;
export const YCASH_NETWORKS: readonly YcashNetwork[] = [YCASH_MAINNET, YCASH_TESTNET, YCASH_REGTEST];

/** Asset symbols; YEC counts zatoshis (1e-8), YED counts cents. */
export const ASSET_YEC = "YEC" as const;
export const ASSET_YED = "YED" as const;
export type YcashAsset = typeof ASSET_YEC | typeof ASSET_YED;

/** Target block spacing after Blossom, seconds. */
export const BLOCK_SECONDS = 75;
/** A tx whose nExpiryHeight is below next + 3 is refused at relay (TX_EXPIRING_SOON_THRESHOLD). */
export const TX_EXPIRING_SOON_THRESHOLD = 3;
/** YED minimum and maximum output, cents (overlay XFER-1; an out-of-range assignment burns everything). */
export const YED_MIN_OUTPUT_CENTS = 100;
export const YED_MAX_OUTPUT_CENTS = 10_000_000;
/** YEC carried by each wallet-built YED output (builder convention, not a rule). */
export const TOKEN_VALUE_ZAT = 10_000;
