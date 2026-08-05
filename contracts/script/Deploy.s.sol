// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {PStakeStaking} from "../src/PStakeStaking.sol";

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
    address constant OWNER = 0x992774a622E2eA40e193FE967475e58648eDbC48;

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
     * ⭐ These seven are not a selection. They are exactly the tokens `approvedPairTokens()` on the
     * V2 factory returns true for, out of all 202 Robinhood tokenized stocks — so they are the only
     * assets a pStake token can be paired against, and therefore the only assets fees can arrive
     * in. Re-derive rather than edit by hand if Pons approves more; the check is one multicall.
     */
    address[7] STOCKS = [
        0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, // NVDA
        0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, // AAPL
        0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, // SPCX
        0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3, // GOOGL
        0x322F0929c4625eD5bAd873c95208D54E1c003b2d, // TSLA
        0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, // SPY
        0x1b0E319c6A659F002271B69dB8A7df2F911c153E // GME
    ];

    /**
     * The floor on a single position, in stake-token units.
     *
     * ⚠⚠ Not cosmetic. `harvest` is permissionless and rewards are paid on arrival, so without a
     * floor one wei staked into an empty pool immediately before a harvest collects the whole
     * claimable balance. All seven pStocks are 18 decimals, so this is one whole share.
     */
    uint256 constant MIN_STAKE = 1e18;

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
            uint256 id = staking.createPool(STOCKS[i], STOCKS[i], MIN_STAKE);
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
    }
}
