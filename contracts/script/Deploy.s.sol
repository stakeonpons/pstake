// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {PStakeStaking} from "../src/PStakeStaking.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/**
 * Deploys the staking contract on Robinhood Chain and puts it into a usable state in one batch.
 *
 * ## Running it
 *
 * The deployer key is never passed on the command line and never lives in this repository. Import
 * it once into an encrypted keystore, then refer to it by name:
 *
 *   cast wallet import pstake-deployer --interactive
 *   forge script script/Deploy.s.sol --rpc-url rhc --account pstake-deployer --broadcast
 *
 * ## What it does, and what it deliberately does not
 *
 * It deploys, creates one pool per pStock for the pStake reward track, and declares each stock's
 * harvest split to be that single pool at 100%. It does NOT open staking. That is left as a
 * separate, deliberate transaction so the pools can be checked on chain before anybody can put
 * money into them.
 *
 * ⚠ It also does NOT point any token's fees here. That happens at launch, by naming this address as
 * `creatorFeeRecipient` — which is `VITE_FEE_RECIPIENT` in the front end. Until a token launches
 * with it, `harvest` has nothing to collect.
 *
 * ⚠ `OWNER` should be a wallet you are willing to hold long term. Ownership is `Ownable2Step`, so
 * transferring it later requires the new owner to accept, and a typo cannot orphan the contract.
 */
contract Deploy is Script {
    /// The wallet that will own the contract and administer pools.
    address constant OWNER = 0x69a8a7164309D58E6a1510D1d393f93256EDAD3D;

    /**
     * Pons V2's fee escrow on Robinhood Chain.
     *
     * ⚠ Found via `factory.feeEscrow()` on the V2 factory `0x7E1EAbd5…4dB8`, not carried over from
     * an older integration. V1's locker-based fee path is a different generation entirely, and a
     * contract wired to it would report zero forever.
     */
    address constant FEE_ESCROW = 0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c;

    /**
     * The pStake reward track: stake a pStock, earn that same pStock.
     *
     * ⭐ Not a selection. Every entry is verified against `approvedPairTokens()` on the V2 factory,
     * so these are the assets a token can be paired against and therefore the assets fees arrive
     * in. Keep in step with `STOCKS` in `src/lib/stocks.ts`.
     *
     * ⚠⚠ Deriving this by scanning "Robinhood tokenized stocks" MISSES entries — that is how USDG
     * was absent at first. It is a stablecoin, so it was never in the candidate set, even though
     * the factory approves it. The factory is the authority, not any token-list query.
     *
     * ⚠ Native ETH is also pairable on Pons and is deliberately absent: a token paired against it
     * pays stakers in ETH rather than in a stock, and pools here hold ERC-20s.
     */
    address[8] STOCKS = [
        0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, // NVDA
        0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, // AAPL
        0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, // SPCX
        0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3, // GOOGL
        0x322F0929c4625eD5bAd873c95208D54E1c003b2d, // TSLA
        0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, // SPY
        0x1b0E319c6A659F002271B69dB8A7df2F911c153E, // GME
        0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 // USDG, 6 decimals
    ];

    /**
     * The floor on a single position, in each asset's OWN units.
     *
     * ⚠⚠ Not cosmetic. `harvest` is permissionless and rewards are paid on arrival, so without a
     * floor one wei staked into an empty pool immediately before a harvest collects the whole
     * claimable balance.
     *
     * ⚠⚠ **Read per asset, because they do not share decimals.** The seven equities are 18, USDG
     * is 6. A single `1e18` constant would set USDG's floor to a TRILLION USDG and make its pool
     * unusable, so this reads `decimals()` rather than assuming.
     */
    /**
     * The $STAKE token, and the pool where staking it earns more of it.
     *
     * ⭐ Funded by **`depositRewards`**, NOT by `harvest`. `harvest` pulls from Pons's **V2** fee
     * escrow, and $STAKE is a **V1** launch whose fees accrue in the locker's LP position instead —
     * a completely different path. The operator collects there and deposits here, which is why
     * `setDepositor` below matters and why this pool gets **no split**: a split exists to divide an
     * escrow balance, and there is no escrow balance in $STAKE. `harvest(STAKE)` refusing is correct.
     */
    address constant STAKE_TOKEN = 0x831758E8C9C043bE7DEB4D74a4Cf581599aeffe5;

    /**
     * Floor on a single $STAKE position.
     *
     * ⚠ A judgement call, not a derived number, and deliberately modest. Its job is to price
     * front-running a reward deposit — someone staking dust the moment before one lands takes a
     * full share of it. That risk is smaller here than for the stock pools because `depositRewards`
     * is **allowlisted**, so the operator picks the moment rather than the attacker; it is not zero,
     * because a deposit is still visible in the mempool.
     *
     * ✏️ Set to 100,000 $STAKE by the operator, 7 Aug (raised from 10,000).
     * ➤ Tune with `setMinStake(poolId, …)` at any time. It needs no redeploy, so do not treat this
     * value as settled.
     */
    uint256 constant STAKE_MIN = 100_000e18;

    function minStakeFor(address token) internal view returns (uint256) {
        return 10 ** IERC20Decimals(token).decimals();
    }

    function run() external returns (PStakeStaking staking) {
        vm.startBroadcast();

        // ⚠ Deployed owned by the DEPLOYER, not by OWNER directly.
        //
        // Every setup call below is `onlyOwner`, so handing ownership away first would make the
        // script deploy a contract it then cannot configure. The deployer sets everything up and
        // nominates OWNER at the end; because ownership is two-step, OWNER must accept before it
        // takes effect, which also proves that wallet can sign before it holds anything.
        address deployer = msg.sender;
        staking = new PStakeStaking(deployer, FEE_ESCROW);
        console.log("PStakeStaking:", address(staking));

        for (uint256 i; i < STOCKS.length; ++i) {
            uint256 id = staking.createPool(STOCKS[i], STOCKS[i], minStakeFor(STOCKS[i]));
            console.log("pool", id, STOCKS[i]);

            // One pool per stock today, so the declaration is exact: everything harvested in this
            // asset belongs to the people staking it. That stops being true the moment a second
            // pool rewards the same stock — see the header on `setSplit`.
            uint256[] memory ids = new uint256[](1);
            uint256[] memory bps = new uint256[](1);
            ids[0] = id;
            bps[0] = 10_000;
            staking.setSplit(STOCKS[i], ids, bps);
        }

        /*
          Stake $STAKE, earn $STAKE.

          ⚠⚠ Stake asset and reward asset are the SAME token, so principal and rewards share one
          balance in this contract. That is safe because payouts are computed from the
          `accPerWeight` accumulator rather than from the contract's balance — the configuration is
          covered by the existing suite (`createPool(nvda, nvda, …)`) and by `StakePool.t.sol`,
          which drives it with the real token on a fork.
        */
        uint256 stakePool = staking.createPool(STAKE_TOKEN, STAKE_TOKEN, STAKE_MIN);
        console.log("pool", stakePool, STAKE_TOKEN);
        console.log("  ^ stake $STAKE, earn $STAKE - funded by depositRewards, not harvest");

        // The operator collects V1 fees from the locker and deposits them here, so that wallet has
        // to be allowed to. ⚠ Without this the pool exists and can never be funded.
        staking.setDepositor(OWNER, true);

        if (OWNER != deployer) staking.transferOwnership(OWNER);

        vm.stopBroadcast();

        console.log("");
        if (OWNER != deployer) {
            console.log("Ownership nominated to:", OWNER);
            console.log("That wallet must accept it:");
            console.log("  cast send <address> 'acceptOwnership()' --rpc-url rhc --account <name>");
        }
        console.log("Staking is CLOSED. Check the pools, then open it:");
        console.log("  cast send <address> 'setStakingOpen(bool)' true --rpc-url rhc --account <name>");
        console.log("");
        console.log("Fees only arrive once a token launches naming this address as its");
        console.log("creatorFeeRecipient. Set VITE_FEE_RECIPIENT to it before the first launch.");
        console.log("");
        console.log("The $STAKE pool is funded by hand, from V1 fees you collect:");
        console.log("  1. locker.collectFees(STAKE)      -> pays your wallet");
        console.log("  2. STAKE.approve(staking, amount)");
        console.log("  3. staking.depositRewards(<poolId>, amount)");
    }
}
