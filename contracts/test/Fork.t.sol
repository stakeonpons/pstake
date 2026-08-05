// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PStakeStaking} from "../src/PStakeStaking.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * The whole staking lifecycle against REAL pStocks, and the REAL Pons fee escrow, on a fork of
 * Robinhood Chain.
 *
 *   forge test --match-path test/Fork.t.sol --fork-url rhc -vv
 *
 * The unit suite proves the arithmetic against mock tokens it fully controls. This proves the
 * contract against the actual deployed bytecode of the assets it will hold and the escrow it will
 * pull from, which is where the surprises live: a proxy, a non-standard return value, a transfer
 * hook, a decimals field that is not 18 — and, for the escrow, whether it will pay a contract at
 * all.
 *
 * ⚠ The public RPC prunes state, so this must run against a recent block. There is no pinned block
 * number here for that reason: pinning one guarantees the test stops working within minutes.
 */
contract ForkTest is Test {
    PStakeStaking internal s;

    /// The live escrow, found via `factory.feeEscrow()` — not assumed from the V1 generation.
    address constant FEE_ESCROW = 0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c;

    /// Two of the seven `approvedPairTokens`. All seven are 18 decimals; see `src/lib/stocks.ts`.
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant GME = 0x1b0E319c6A659F002271B69dB8A7df2F911c153E;

    address internal owner = address(0xB0B);
    address internal feeWallet = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0BB);

    uint256 internal nvdaPool;
    uint256 internal gmePool;

    function setUp() public {
        s = new PStakeStaking(owner, FEE_ESCROW);
        vm.startPrank(owner);
        nvdaPool = s.createPool(NVDA, NVDA, 1e18);
        gmePool = s.createPool(GME, GME, 1e18);

        uint256[] memory ids = new uint256[](1);
        uint256[] memory bps = new uint256[](1);
        ids[0] = nvdaPool;
        bps[0] = 10_000;
        s.setSplit(NVDA, ids, bps);

        s.setDepositor(feeWallet, true);
        s.setStakingOpen(true);
        vm.stopPrank();
    }

    function _fund(address token, address who, uint256 amount) internal {
        deal(token, who, amount, true);
        vm.prank(who);
        IERC20(token).approve(address(s), type(uint256).max);
    }

    /// Stake, earn, claim, withdraw — against the real NVDA contract.
    function test_fullLifecycle_realNVDA() public {
        _fund(NVDA, alice, 100e18);
        _fund(NVDA, bob, 100e18);
        _fund(NVDA, feeWallet, 10e18);

        vm.prank(alice);
        s.stake(nvdaPool, 100e18, 30); // 3x weight
        vm.prank(bob);
        s.stake(nvdaPool, 100e18, 1); // 1x weight

        vm.prank(feeWallet);
        s.depositRewards(nvdaPool, 4e18);

        assertApproxEqAbs(s.pending(nvdaPool, alice, 0), 3e18, 10, "3x takes three quarters");
        assertApproxEqAbs(s.pending(nvdaPool, bob, 0), 1e18, 10);

        // Claim mid lock.
        uint256 before = IERC20(NVDA).balanceOf(alice);
        vm.prank(alice);
        s.claim(nvdaPool, 0);
        assertApproxEqAbs(IERC20(NVDA).balanceOf(alice) - before, 3e18, 10, "real NVDA arrived");

        // Withdraw at term.
        skip(30 days);
        vm.prank(alice);
        (uint256 principal,) = s.withdraw(nvdaPool, 0);
        assertEq(principal, 100e18, "principal returned exactly");

        vm.prank(bob);
        (uint256 bobPrincipal, uint256 bobRewards) = s.withdraw(nvdaPool, 0);
        assertEq(bobPrincipal, 100e18);
        assertApproxEqAbs(bobRewards, 1e18, 10);

        (,, uint256 totalStaked,,,) = s.pools(nvdaPool);
        assertEq(totalStaked, 0, "pool empties cleanly");
    }

    /**
     * ⭐ The claim that the whole Pons port rests on: **the real escrow pays a contract.**
     *
     * Everything else here could be proven with a mock. This cannot — the escrow either transfers
     * to `msg.sender` without caring that it has code, or the keeper-free design is wrong and the
     * fees would have to go through a wallet after all. Credited through the escrow's own
     * permissionless `creditToken`, then pulled by an address with no privileges at all.
     */
    function test_harvest_realEscrowPaysAContract() public {
        _fund(NVDA, alice, 100e18);
        vm.prank(alice);
        s.stake(nvdaPool, 100e18, 7);

        // Credit the staking contract exactly as a launch's trading fees would.
        deal(NVDA, feeWallet, 8e18, true);
        vm.startPrank(feeWallet);
        IERC20(NVDA).approve(FEE_ESCROW, 8e18);
        (bool ok,) = FEE_ESCROW.call(
            abi.encodeWithSignature("creditToken(address,address,uint256)", address(s), NVDA, 8e18)
        );
        vm.stopPrank();
        assertTrue(ok, "creditToken is permissionless");

        assertEq(s.harvestable(NVDA), 8e18, "the escrow is holding it for us");

        // A passer-by with no role harvests. Nobody has to be trusted to run anything.
        vm.prank(address(0xDEAD));
        uint256 distributed = s.harvest(NVDA);

        assertEq(distributed, 8e18, "the real escrow paid a contract");
        assertEq(IERC20(NVDA).balanceOf(address(s)), 108e18, "principal plus the harvest");
        assertApproxEqAbs(s.pending(nvdaPool, alice, 0), 8e18, 10, "and it reached the sole staker");

        skip(7 days);
        vm.prank(alice);
        (uint256 principal, uint256 rewards) = s.withdraw(nvdaPool, 0);
        assertEq(principal, 100e18, "principal is untouched by a harvest of the same asset");
        assertApproxEqAbs(rewards, 8e18, 10);
    }

    /// A second real stock, to prove nothing is special-cased to one token contract.
    function test_secondStock_realGME() public {
        _fund(GME, alice, 50e18);
        _fund(GME, feeWallet, 5e18);

        vm.prank(alice);
        s.stake(gmePool, 50e18, 7);
        vm.prank(feeWallet);
        s.depositRewards(gmePool, 5e18);

        assertApproxEqAbs(s.pending(gmePool, alice, 0), 5e18, 10, "sole staker takes it all");

        skip(7 days);
        vm.prank(alice);
        (uint256 principal, uint256 rewards) = s.withdraw(gmePool, 0);
        assertEq(principal, 50e18);
        assertApproxEqAbs(rewards, 5e18, 10);
    }

    /// The seven pStocks are all 18 decimals. Asserted rather than assumed.
    function test_stockDecimals() public view {
        assertEq(IERC20Metadata(NVDA).decimals(), 18);
        assertEq(IERC20Metadata(GME).decimals(), 18);
    }
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}
