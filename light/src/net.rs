//! Ycash network parameters.
//!
//! `zcash_protocol` (librustzcash6) carries Ycash's mainnet and testnet activation heights, branch
//! ids and HRPs (`components/zcash_protocol/src/consensus.rs`, `constants/{mainnet,testnet,regtest}.rs`),
//! but its `Network` enum has no regtest variant: regtest heights are whatever `-nuparams` the node
//! was started with. The Yellowback devnets activate every upgrade through Canopy at height 1 and
//! never NU5 (`ycash-dd/qa/rpc-tests/test_framework/yellowback_util.py:129-134`, `util.py:267-268`),
//! which is the default here; `--upgrades` overrides it. The Vault upgrade (branch id `6d5b7a31`,
//! after Canopy) has no mainnet or testnet height yet; a regtest that activates it with
//! `-nuparams=6d5b7a31:<h>` needs `--upgrades vault=<h>` here.

use std::fmt;
use std::str::FromStr;

use zcash_protocol::consensus::{BlockHeight, BranchId, NetworkType, NetworkUpgrade, Parameters};
use zcash_protocol::local_consensus::LocalNetwork;

/// The three Ycash networks. Regtest carries its own activation heights.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum YcashNetwork {
    Main,
    Test,
    Regtest(LocalNetwork),
}

impl YcashNetwork {
    /// The devnet's regtest: every upgrade through Canopy at height 1, nothing after.
    pub fn devnet_regtest() -> Self {
        YcashNetwork::Regtest(LocalNetwork {
            overwinter: Some(BlockHeight::from_u32(1)),
            sapling: Some(BlockHeight::from_u32(1)),
            ycash: Some(BlockHeight::from_u32(1)),
            blossom: Some(BlockHeight::from_u32(1)),
            heartwood: Some(BlockHeight::from_u32(1)),
            canopy: Some(BlockHeight::from_u32(1)),
            nu5: None,
            nu6: None,
            nu6_1: None,
            nu6_2: None,
            // The Ycash Vault upgrade (branch 0x6d5b7a31): unset unless the devnet's
            // `-nuparams=6d5b7a31:<h>` is mirrored with `--upgrades vault=<h>`.
            vault: None,
        })
    }

    pub fn name(&self) -> &'static str {
        match self {
            YcashNetwork::Main => "mainnet",
            YcashNetwork::Test => "testnet",
            YcashNetwork::Regtest(_) => "regtest",
        }
    }

    /// The branch id a transaction targeting `height` must commit to.
    pub fn branch_id_at(&self, height: BlockHeight) -> BranchId {
        BranchId::for_height(self, height)
    }

    /// Applies `name=height` pairs (`height` may be `none`) to a regtest network.
    pub fn with_upgrades(self, spec: &str) -> Result<Self, String> {
        let YcashNetwork::Regtest(mut local) = self else {
            return Err("--upgrades applies to regtest only".into());
        };
        for item in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let (name, value) = item
                .split_once('=')
                .ok_or_else(|| format!("bad upgrade spec {item:?}; want name=height"))?;
            let height = match value.trim() {
                "none" | "" => None,
                h => Some(BlockHeight::from_u32(
                    u32::from_str(h).map_err(|_| format!("bad height in {item:?}"))?,
                )),
            };
            let slot = match name.trim().to_ascii_lowercase().as_str() {
                "overwinter" => &mut local.overwinter,
                "sapling" => &mut local.sapling,
                "ycash" => &mut local.ycash,
                "blossom" => &mut local.blossom,
                "heartwood" => &mut local.heartwood,
                "canopy" => &mut local.canopy,
                "nu5" => &mut local.nu5,
                "nu6" => &mut local.nu6,
                "nu6_1" | "nu6.1" => &mut local.nu6_1,
                "nu6_2" | "nu6.2" => &mut local.nu6_2,
                "vault" | "6d5b7a31" => &mut local.vault,
                other => return Err(format!("unknown upgrade {other:?}")),
            };
            *slot = height;
        }
        Ok(YcashNetwork::Regtest(local))
    }
}

impl FromStr for YcashNetwork {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "main" | "mainnet" => Ok(YcashNetwork::Main),
            "test" | "testnet" => Ok(YcashNetwork::Test),
            "regtest" => Ok(YcashNetwork::devnet_regtest()),
            other => Err(format!(
                "unknown network {other:?}; want mainnet, testnet or regtest"
            )),
        }
    }
}

impl fmt::Display for YcashNetwork {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

impl Parameters for YcashNetwork {
    fn network_type(&self) -> NetworkType {
        match self {
            YcashNetwork::Main => NetworkType::Main,
            YcashNetwork::Test => NetworkType::Test,
            YcashNetwork::Regtest(_) => NetworkType::Regtest,
        }
    }

    fn activation_height(&self, nu: NetworkUpgrade) -> Option<BlockHeight> {
        match self {
            YcashNetwork::Main => zcash_protocol::consensus::MAIN_NETWORK.activation_height(nu),
            YcashNetwork::Test => zcash_protocol::consensus::TEST_NETWORK.activation_height(nu),
            YcashNetwork::Regtest(local) => local.activation_height(nu),
        }
    }
}

/// Parses lightwalletd's `consensusBranchId` (hex, as `GetLightdInfo` reports it).
pub fn parse_branch_id(hex_id: &str) -> Option<BranchId> {
    let raw = u32::from_str_radix(hex_id.trim_start_matches("0x"), 16).ok()?;
    BranchId::try_from(raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_protocol::consensus::NetworkConstants;

    #[test]
    fn mainnet_carries_ycash_heights_and_prefixes() {
        let net = YcashNetwork::Main;
        // ycashd chainparams.cpp: Ycash fork at 570_000, Canopy is the latest mainnet upgrade.
        assert_eq!(
            net.activation_height(NetworkUpgrade::Ycash),
            Some(BlockHeight::from_u32(570_000))
        );
        assert_eq!(net.activation_height(NetworkUpgrade::Nu5), None);
        assert_eq!(net.hrp_sapling_payment_address(), "ys");
        assert_eq!(
            net.hrp_sapling_extended_spending_key(),
            "secret-extended-key-main"
        );
        assert_eq!(net.coin_type(), 347);
        assert_eq!(
            net.branch_id_at(BlockHeight::from_u32(3_075_000)),
            BranchId::Canopy
        );
    }

    #[test]
    fn testnet_prefixes_match_chainparams() {
        let net = YcashNetwork::Test;
        assert_eq!(net.hrp_sapling_payment_address(), "ytestsapling");
        assert_eq!(
            net.activation_height(NetworkUpgrade::Ycash),
            Some(BlockHeight::from_u32(510_248))
        );
    }

    #[test]
    fn devnet_regtest_is_canopy_from_height_one() {
        let net = YcashNetwork::devnet_regtest();
        assert_eq!(net.hrp_sapling_payment_address(), "yregtestsapling");
        assert_eq!(net.branch_id_at(BlockHeight::from_u32(1)), BranchId::Canopy);
        assert_eq!(
            net.branch_id_at(BlockHeight::from_u32(500)),
            BranchId::Canopy
        );
        // X-F9: Canopy 19bd2d2f on both devnets.
        assert_eq!(
            u32::from(net.branch_id_at(BlockHeight::from_u32(10))),
            0x19bd_2d2f
        );
    }

    #[test]
    fn upgrades_override_regtest_heights() {
        let net = YcashNetwork::devnet_regtest()
            .with_upgrades("canopy=100, nu5=none")
            .unwrap();
        assert_eq!(
            net.branch_id_at(BlockHeight::from_u32(99)),
            BranchId::Heartwood
        );
        assert_eq!(
            net.branch_id_at(BlockHeight::from_u32(100)),
            BranchId::Canopy
        );
        assert!(YcashNetwork::Main.with_upgrades("canopy=1").is_err());
        assert!(YcashNetwork::devnet_regtest()
            .with_upgrades("bogus=1")
            .is_err());
    }

    #[test]
    fn vault_follows_canopy_and_is_unset_on_mainnet_and_testnet() {
        // The Vault upgrade (upgrade plan U-9): branch 6d5b7a31, after Canopy, no height on the
        // public networks yet (P8 sets it).
        assert_eq!(u32::from(BranchId::Vault), 0x6d5b_7a31);
        assert!(BranchId::Vault.height_range(&YcashNetwork::Main).is_none());
        for net in [YcashNetwork::Main, YcashNetwork::Test] {
            assert_eq!(net.activation_height(NetworkUpgrade::Vault), None);
        }
        assert_eq!(
            YcashNetwork::devnet_regtest().activation_height(NetworkUpgrade::Vault),
            None
        );
        // The wt/up-dd devnet: Vault at 103 on top of the devnet's Canopy-at-1.
        for spec in ["vault=103", "6d5b7a31=103"] {
            let net = YcashNetwork::devnet_regtest().with_upgrades(spec).unwrap();
            assert_eq!(
                net.branch_id_at(BlockHeight::from_u32(102)),
                BranchId::Canopy
            );
            assert_eq!(
                net.branch_id_at(BlockHeight::from_u32(103)),
                BranchId::Vault
            );
            assert_eq!(
                u32::from(net.branch_id_at(BlockHeight::from_u32(500))),
                0x6d5b_7a31
            );
        }
        let off = YcashNetwork::devnet_regtest()
            .with_upgrades("vault=103,vault=none")
            .unwrap();
        assert_eq!(off, YcashNetwork::devnet_regtest());
    }

    #[test]
    fn branch_id_parses_lightwalletd_form() {
        assert_eq!(parse_branch_id("6d5b7a31"), Some(BranchId::Vault));
        assert_eq!(parse_branch_id("19bd2d2f"), Some(BranchId::Canopy));
        assert_eq!(parse_branch_id("0x374d694f"), Some(BranchId::Ycash));
        assert_eq!(parse_branch_id("zz"), None);
    }
}
