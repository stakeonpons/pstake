// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PStakeStaking} from "../src/PStakeStaking.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Stake $STAKE, earn $STAKE — driven with the REAL token on a fork of Robinhood Chain.
 *
 * ## Why this is the pool that needs its own tests
 *
 * Every other pool stakes one asset and pays a different one. This one pays the asset it holds, so
 * **principal and rewards sit in a single balance**. If payouts were ever derived from the
 * contract's balance rather than from the reward accumulator, one staker's claim would quietly be
 * paid out of another's deposit, and the shortfall would only surface when somebody tried to
 * withdraw. The tests below assert the property directly: total principal never leaves except
 * through `withdraw`, and rewards never exceed what was deposited.
 *
 * The real token is used rather than a mock because it is a live V1 launch and its transfer
 * behaviour is a fact, not an assumption — a fee-on-transfer token would silently break credit
 * accounting, and `depositRewards` measuring the received delta is only correct if that is true.
 */
contract StakePoolTest is Test {
    /// The live $STAKE token.
    address constant STAKE = 0x831758E8C9C043bE7DEB4D74a4Cf581599aeffe5;
    /// Pons V2's fee escrow — required by the constructor, unused by this pool.
    address constant FEE_ESCROW = 0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c;

    /// ⚠ Mirrors `STAKE_MIN` in Deploy.s.sol. If that moves, move this — otherwise the floor
    /// under test stops being the floor that ships.
    uint256 constant MIN_STAKE = 10_000e18;

    PStakeStaking internal s;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal pool;

    function setUp() public {
        s = new PStakeStaking(owner, FEE_ESCROW);
        vm.startPrank(owner);
        pool = s.createPool(STAKE, STAKE, MIN_STAKE);
        s.setDepositor(owner, true);
        s.setStakingOpen(true);
        vm.stopPrank();
    }

    function _stake(address who, uint256 amount, uint32 termDays) internal {
        deal(STAKE, who, amount);
        vm.startPrank(who);
        IERC20(STAKE).approve(address(s), amount);
        s.stake(pool, amount, termDays);
        vm.stopPrank();
    }

    function _fund(uint256 amount) internal {
        deal(STAKE, owner, amount);
        vm.startPrank(owner);
        IERC20(STAKE).approve(address(s), amount);
        s.depositRewards(pool, amount);
        vm.stopPrank();
    }

    /// ⚠ The real token must not tax transfers, or every credit figure here would be short.
    function test_realToken_doesNotTaxTransfers() public {
        deal(STAKE, alice, 1_000e18);
        vm.prank(alice);
        IERC20(STAKE).transfer(bob, 1_000e18);
        assertEq(IERC20(STAKE).balanceOf(bob), 1_000e18, "STAKE appears to tax transfers");
    }

    function test_stakeAndEarnTheSameToken() public {
        _stake(alice, 100_000e18, 1);
        _fund(1_000e18);

        assertApproxEqAbs(s.pending(pool, alice, 0), 1_000e18, 1e6, "sole staker takes the deposit");

        vm.prank(alice);
        uint256 paid = s.claim(pool, 0);
        assertApproxEqAbs(paid, 1_000e18, 1e6, "claim pays the pending amount");

        // ⭐ Principal is untouched by a claim.
        (,, uint256 totalStaked,,,) = s.pools(pool);
        assertEq(totalStaked, 100_000e18, "claiming must not consume principal");
    }

    /// Two stakers, equal weight, one deposit: split evenly and neither eats the other's principal.
    function test_twoStakers_splitDeposit_principalIntact() public {
        _stake(alice, 100_000e18, 1);
        _stake(bob, 100_000e18, 1);
        _fund(500e18);

        assertApproxEqAbs(s.pending(pool, alice, 0), 250e18, 1e6, "alice half");
        assertApproxEqAbs(s.pending(pool, bob, 0), 250e18, 1e6, "bob half");

        // Both exit after the term. Each must get their principal back IN FULL plus their share.
        vm.warp(block.timestamp + 2 days);

        vm.prank(alice);
        (uint256 aliceAmount, uint256 aliceRewards) = s.withdraw(pool, 0);
        vm.prank(bob);
        (uint256 bobAmount, uint256 bobRewards) = s.withdraw(pool, 0);

        assertEq(aliceAmount, 100_000e18, "alice principal returned in full");
        assertEq(bobAmount, 100_000e18, "bob principal returned in full");
        assertApproxEqAbs(aliceRewards + bobRewards, 500e18, 1e6, "rewards total the deposit");

        (,, uint256 totalStaked,,,) = s.pools(pool);
        assertEq(totalStaked, 0, "pool empty after both withdraw");
    }

    /**
     * ⭐⭐ The property that matters for a self-paying pool: **rewards can never exceed what was
     * deposited**, so no claim is ever funded out of somebody's principal.
     */
    function test_rewardsNeverExceedDeposits() public {
        _stake(alice, 500_000e18, 7);
        _stake(bob, 100_000e18, 1);

        uint256 deposited = 3_000e18;
        _fund(deposited);

        uint256 a = s.pending(pool, alice, 0);
        uint256 b = s.pending(pool, bob, 0);
        assertLe(a + b, deposited, "claimable exceeds what was ever deposited");

        // A longer lock earns more of the same pot, which is the whole point of the tiers.
        assertGt(a, b, "the 7 day lock should out-earn the 1 day lock");
    }

    /// A deposit with nobody staked must not be silently lost or credited to a later staker.
    function test_depositWithNoStakers_thenStake() public {
        _fund(1_000e18);
        _stake(alice, 100_000e18, 1);
        assertEq(s.pending(pool, alice, 0), 0, "a later staker must not collect an earlier deposit");
    }

    /// ⚠ The floor is what prices front-running a deposit. It must actually bind.
    function test_belowMinimumIsRejected() public {
        deal(STAKE, alice, MIN_STAKE);
        vm.startPrank(alice);
        IERC20(STAKE).approve(address(s), MIN_STAKE);
        vm.expectRevert();
        s.stake(pool, MIN_STAKE - 1, 1);
        vm.stopPrank();
    }

    /// ⚠ Exactly the minimum must be ACCEPTED — the floor is inclusive, so an off-by-one here would
    /// silently reject the smallest legitimate position.
    function test_exactlyMinimumIsAccepted() public {
        _stake(alice, MIN_STAKE, 1);
        (,, uint256 totalStaked,,,) = s.pools(pool);
        assertEq(totalStaked, MIN_STAKE, "a position at exactly the floor must be accepted");
    }

    /// Only an allowlisted wallet may fund the pool.
    function test_onlyDepositorCanFund() public {
        deal(STAKE, alice, 1_000e18);
        vm.startPrank(alice);
        IERC20(STAKE).approve(address(s), 1_000e18);
        vm.expectRevert();
        s.depositRewards(pool, 1_000e18);
        vm.stopPrank();
    }

    /// Principal cannot be withdrawn before the lock ends.
    function test_lockedUntilTermEnds() public {
        _stake(alice, 100_000e18, 7);
        vm.prank(alice);
        vm.expectRevert();
        s.withdraw(pool, 0);
    }
}
