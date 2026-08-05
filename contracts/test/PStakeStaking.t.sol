// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PStakeStaking} from "../src/PStakeStaking.sol";
import {MockToken, TaxedToken} from "./mocks/Tokens.sol";
import {MockPonsEscrow} from "./mocks/Escrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PStakeStakingTest is Test {
    PStakeStaking internal s;
    MockPonsEscrow internal escrow;
    MockToken internal stakeTok; // a launched token
    MockToken internal nvda; // an 18-decimal pStock
    MockToken internal xaut; // a 6-decimal pStock, the decimals trap

    address internal owner = address(0xB0B);
    address internal feeWallet = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0BB);
    address internal carol = address(0xCAFE);

    uint256 internal launchedPool; // stake the token, earn its pStock
    uint256 internal pstockPool; // stake a pStock, earn the same pStock
    uint256 internal xautPool;

    function setUp() public {
        escrow = new MockPonsEscrow();
        s = new PStakeStaking(owner, address(escrow));

        stakeTok = new MockToken("Launched", "LNCH", 18);
        nvda = new MockToken("NVIDIA", "NVDA", 18);
        xaut = new MockToken("Tether Gold", "XAUT", 6);

        vm.startPrank(owner);
        launchedPool = s.createPool(address(stakeTok), address(nvda), 0);
        // ⚠ The configuration that makes balance-based accounting unsafe: stake and reward are the
        // same asset.
        pstockPool = s.createPool(address(nvda), address(nvda), 0);
        xautPool = s.createPool(address(xaut), address(xaut), 0);
        s.setDepositor(feeWallet, true);
        s.setStakingOpen(true);
        vm.stopPrank();

        for (uint256 i; i < 3; ++i) {
            address u = [alice, bob, carol][i];
            stakeTok.mint(u, 1_000_000e18);
            nvda.mint(u, 1_000_000e18);
            xaut.mint(u, 1_000_000e6);
            vm.startPrank(u);
            stakeTok.approve(address(s), type(uint256).max);
            nvda.approve(address(s), type(uint256).max);
            xaut.approve(address(s), type(uint256).max);
            vm.stopPrank();
        }

        nvda.mint(feeWallet, 1_000_000e18);
        xaut.mint(feeWallet, 1_000_000e6);
        vm.startPrank(feeWallet);
        nvda.approve(address(s), type(uint256).max);
        xaut.approve(address(s), type(uint256).max);
        vm.stopPrank();
    }

    /* --------------------------------- helpers --------------------------------- */

    function _stake(address who, uint256 pool, uint256 amount, uint32 term) internal returns (uint256 id) {
        vm.prank(who);
        id = s.stake(pool, amount, term);
    }

    function _deposit(uint256 pool, uint256 amount) internal {
        vm.prank(feeWallet);
        s.depositRewards(pool, amount);
    }

    /* --------------------------------- basics --------------------------------- */

    function test_stake_recordsPositionAndWeight() public {
        uint256 id = _stake(alice, launchedPool, 1_000e18, 30);
        (uint256 amount, uint256 weight, uint64 unlockAt, uint32 tier, bool withdrawn,) =
            s.positions(launchedPool, alice, id);

        assertEq(amount, 1_000e18);
        assertEq(weight, 3_000e18, "30 days is 3x");
        assertEq(tier, 30);
        assertEq(unlockAt, uint64(block.timestamp + 30 days));
        assertFalse(withdrawn);
    }

    function test_multipliers_scaleWithTerm() public {
        uint32[6] memory terms = [uint32(1), 3, 7, 14, 21, 30];
        uint256[6] memory expected = [uint256(1_000e18), 1_250e18, 1_500e18, 2_000e18, 2_500e18, 3_000e18];
        for (uint256 i; i < terms.length; ++i) {
            uint256 id = _stake(alice, launchedPool, 1_000e18, terms[i]);
            (, uint256 weight,,,,) = s.positions(launchedPool, alice, id);
            assertEq(weight, expected[i], "weight must follow the ladder");
        }
    }

    function test_stake_rejectsUnknownTerm() public {
        vm.prank(alice);
        vm.expectRevert(PStakeStaking.UnknownTerm.selector);
        s.stake(launchedPool, 1e18, 5);
    }

    function test_stake_rejectedWhenClosed() public {
        vm.prank(owner);
        s.setStakingOpen(false);
        vm.prank(alice);
        vm.expectRevert(PStakeStaking.StakingClosed.selector);
        s.stake(launchedPool, 1e18, 30);
    }

    /* --------------------------------- rewards --------------------------------- */

    function test_rewards_splitByWeightNotAmount() public {
        // Equal amounts, different terms: the longer lock earns more of the same pot.
        _stake(alice, launchedPool, 1_000e18, 1); // weight 1000
        _stake(bob, launchedPool, 1_000e18, 30); // weight 3000

        _deposit(launchedPool, 4_000e18);

        assertApproxEqAbs(s.pending(launchedPool, alice, 0), 1_000e18, DUST, "alice takes 1/4");
        assertApproxEqAbs(s.pending(launchedPool, bob, 0), 3_000e18, DUST, "bob takes 3/4");
    }

    function test_claim_paysAndZeroesPending() public {
        _stake(alice, launchedPool, 1_000e18, 30);
        _deposit(launchedPool, 900e18);

        uint256 before = nvda.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = s.claim(launchedPool, 0);

        assertApproxEqAbs(paid, 900e18, DUST);
        assertApproxEqAbs(nvda.balanceOf(alice) - before, 900e18, DUST);
        assertEq(s.pending(launchedPool, alice, 0), 0);
    }

    /**
     * @dev ⚠ Rewards are compared with a small tolerance throughout, and that is a property of the
     *      design rather than slack in the test.
     *
     *      The accumulator divides twice — once spreading a deposit over total weight, once
     *      applying it to a position — and integer division truncates each time. The residue is a
     *      few wei per claim and it is left in the contract, which is the correct direction: the
     *      alternative is rounding up, which pays out marginally more than came in and eventually
     *      leaves the last claimant unable to be paid. `testFuzz_solvency` pins that down properly.
     */
    uint256 internal constant DUST = 10;

    function test_claimIsAllowedDuringTheLock() public {
        _stake(alice, launchedPool, 1_000e18, 30);
        _deposit(launchedPool, 100e18);
        skip(1 days);
        vm.prank(alice);
        assertApproxEqAbs(s.claim(launchedPool, 0), 100e18, DUST, "a lock must not withhold earned rewards");
    }

    /**
     * A staker who joins after a deposit must not be paid from it. This is the reward-debt
     * snapshot doing its job, and getting it wrong would let anyone drain a pool by staking late.
     */
    function test_lateStakerCannotClaimEarlierRewards() public {
        _stake(alice, launchedPool, 1_000e18, 30);
        _deposit(launchedPool, 500e18);

        _stake(bob, launchedPool, 1_000e18, 30);

        assertEq(s.pending(launchedPool, bob, 0), 0, "bob was not staked when this was deposited");
        assertApproxEqAbs(s.pending(launchedPool, alice, 0), 500e18, DUST);

        _deposit(launchedPool, 600e18);
        assertApproxEqAbs(s.pending(launchedPool, bob, 0), 300e18, DUST, "and shares the next one equally");
        assertApproxEqAbs(s.pending(launchedPool, alice, 0), 800e18, DUST);
    }

    /* --------------------------------- withdrawal --------------------------------- */

    function test_withdraw_blockedUntilUnlock() public {
        _stake(alice, launchedPool, 1_000e18, 7);
        skip(7 days - 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PStakeStaking.StillLocked.selector, uint64(block.timestamp + 1))
        );
        s.withdraw(launchedPool, 0);
    }

    function test_withdraw_returnsPrincipalAndRewards() public {
        _stake(alice, launchedPool, 1_000e18, 7);
        _deposit(launchedPool, 70e18);
        skip(7 days);

        uint256 stakeBefore = stakeTok.balanceOf(alice);
        uint256 rewardBefore = nvda.balanceOf(alice);

        vm.prank(alice);
        (uint256 amount, uint256 rewards) = s.withdraw(launchedPool, 0);

        assertEq(amount, 1_000e18, "principal is exact, always");
        assertApproxEqAbs(rewards, 70e18, DUST);
        assertEq(stakeTok.balanceOf(alice) - stakeBefore, 1_000e18);
        assertApproxEqAbs(nvda.balanceOf(alice) - rewardBefore, 70e18, DUST);
    }

    function test_withdraw_twiceReverts() public {
        _stake(alice, launchedPool, 1_000e18, 1);
        skip(1 days);
        vm.startPrank(alice);
        s.withdraw(launchedPool, 0);
        vm.expectRevert(PStakeStaking.AlreadyWithdrawn.selector);
        s.withdraw(launchedPool, 0);
        vm.stopPrank();
    }

    function test_withdrawnPositionStopsEarning() public {
        _stake(alice, launchedPool, 1_000e18, 1);
        _stake(bob, launchedPool, 1_000e18, 1);
        skip(1 days);

        vm.prank(alice);
        s.withdraw(launchedPool, 0);

        _deposit(launchedPool, 1_000e18);

        assertEq(s.pending(launchedPool, alice, 0), 0, "gone means gone");
        assertApproxEqAbs(s.pending(launchedPool, bob, 0), 1_000e18, DUST, "bob now takes the whole pot");
    }

    /* --------------------------------- the traps --------------------------------- */

    /**
     * ⚠⚠ The configuration that would break balance-based accounting: staking NVDA to earn NVDA.
     *
     * If rewards were computed from `balanceOf` minus bookkeeping, principal would leak out as
     * rewards here. Alice must be able to withdraw every token she staked, and Bob's principal must
     * still be there afterwards.
     */
    function test_sameAssetPool_principalIsNeverPaidAsReward() public {
        _stake(alice, pstockPool, 1_000e18, 1);
        _stake(bob, pstockPool, 1_000e18, 1);
        _deposit(pstockPool, 100e18);

        assertApproxEqAbs(s.pending(pstockPool, alice, 0), 50e18, DUST);
        assertApproxEqAbs(s.pending(pstockPool, bob, 0), 50e18, DUST);

        skip(1 days);

        vm.prank(alice);
        (uint256 amount, uint256 rewards) = s.withdraw(pstockPool, 0);
        assertEq(amount, 1_000e18, "principal back in full");
        assertApproxEqAbs(rewards, 50e18, DUST, "and only her share as reward");

        // Bob's principal and reward are both still claimable.
        vm.prank(bob);
        (uint256 bobAmount, uint256 bobRewards) = s.withdraw(pstockPool, 0);
        assertEq(bobAmount, 1_000e18);
        assertApproxEqAbs(bobRewards, 50e18, DUST);

        (,, uint256 totalStaked,,,) = s.pools(pstockPool);
        assertEq(totalStaked, 0);
    }

    /**
     * ⚠⚠ A stake asset that takes a cut of transfers delivers less than the amount requested. Crediting the requested amount would over-credit stakers and leave the last one
     * out unable to withdraw.
     */
    function test_taxedToken_creditsWhatArrived() public {
        TaxedToken taxed = new TaxedToken(200); // 2%, the launch policy
        taxed.mint(alice, 1_000e18);

        vm.prank(owner);
        uint256 pool = s.createPool(address(taxed), address(nvda), 0);

        vm.startPrank(alice);
        taxed.approve(address(s), type(uint256).max);
        uint256 id = s.stake(pool, 1_000e18, 1);
        vm.stopPrank();

        (uint256 amount, uint256 weight,,,,) = s.positions(pool, alice, id);
        assertEq(amount, 980e18, "credited the 980 that arrived, not the 1000 requested");
        assertEq(weight, 980e18);
        assertEq(taxed.balanceOf(address(s)), 980e18, "and the books match the balance");

        skip(1 days);
        vm.prank(alice);
        (uint256 out,) = s.withdraw(pool, 0);
        assertEq(out, 980e18, "withdrawable, so the contract is never short");
    }

    /// XAUT is 6 decimals. Reward maths must not assume 18 anywhere.
    function test_sixDecimalToken() public {
        _stake(alice, xautPool, 100e6, 30);
        _stake(bob, xautPool, 100e6, 1);
        _deposit(xautPool, 4e6);

        assertApproxEqAbs(s.pending(xautPool, alice, 0), 3e6, DUST, "3x weight takes 3/4");
        assertApproxEqAbs(s.pending(xautPool, bob, 0), 1e6, DUST);
    }

    /**
     * Rewards deposited into an empty pool must reach the first stakers rather than being stranded.
     */
    function test_depositIntoEmptyPool_isQueuedThenPaid() public {
        _deposit(launchedPool, 100e18);

        (,,,, uint256 queued,) = s.pools(launchedPool);
        assertEq(queued, 100e18, "held, not lost");

        _stake(alice, launchedPool, 1_000e18, 1);
        assertEq(s.pending(launchedPool, alice, 0), 0, "not paid until the next deposit settles it");

        _deposit(launchedPool, 50e18);
        assertApproxEqAbs(s.pending(launchedPool, alice, 0), 150e18, DUST, "queued amount arrives with it");

        (,,,, uint256 queuedAfter,) = s.pools(launchedPool);
        assertEq(queuedAfter, 0);
    }

    /* --------------------------------- access control --------------------------------- */

    function test_onlyDepositorCanFund() public {
        nvda.mint(alice, 1e18);
        vm.startPrank(alice);
        nvda.approve(address(s), type(uint256).max);
        vm.expectRevert(PStakeStaking.NotDepositor.selector);
        s.depositRewards(launchedPool, 1e18);
        vm.stopPrank();
    }

    function test_onlyOwnerAdmin() public {
        vm.startPrank(alice);
        vm.expectRevert();
        s.createPool(address(stakeTok), address(xaut), 0);
        vm.expectRevert();
        s.setDepositor(alice, true);
        vm.expectRevert();
        s.setStakingOpen(false);
        vm.stopPrank();
    }

    function test_ownershipIsTwoStep() public {
        vm.prank(owner);
        s.transferOwnership(alice);
        assertEq(s.owner(), owner, "not transferred until accepted");
        vm.prank(alice);
        s.acceptOwnership();
        assertEq(s.owner(), alice);
    }

    function test_duplicatePoolRejected() public {
        vm.prank(owner);
        vm.expectRevert(PStakeStaking.DuplicatePool.selector);
        s.createPool(address(stakeTok), address(nvda), 0);
    }

    function test_closingStakingDoesNotTrapFunds() public {
        _stake(alice, launchedPool, 1_000e18, 1);
        _deposit(launchedPool, 10e18);

        vm.prank(owner);
        s.setStakingOpen(false);

        skip(1 days);
        vm.prank(alice);
        (uint256 amount, uint256 rewards) = s.withdraw(launchedPool, 0);
        assertEq(amount, 1_000e18, "principal must never be trapped by an admin switch");
        assertApproxEqAbs(rewards, 10e18, DUST);
    }

    /* --------------------------------- solvency --------------------------------- */

    /**
     * The property that matters most: whatever the sequence, the contract can always pay everyone
     * their principal and their claimed rewards.
     */
    function testFuzz_solvency(uint96 a1, uint96 a2, uint96 r1, uint96 r2) public {
        uint256 s1 = uint256(a1) % 500_000e18 + 1e18;
        uint256 s2 = uint256(a2) % 500_000e18 + 1e18;
        uint256 d1 = uint256(r1) % 100_000e18 + 1;
        uint256 d2 = uint256(r2) % 100_000e18 + 1;

        _stake(alice, launchedPool, s1, 1);
        _stake(bob, launchedPool, s2, 30);
        _deposit(launchedPool, d1);
        _deposit(launchedPool, d2);

        skip(30 days);

        vm.prank(alice);
        (uint256 pa, uint256 ra) = s.withdraw(launchedPool, 0);
        vm.prank(bob);
        (uint256 pb, uint256 rb) = s.withdraw(launchedPool, 0);

        assertEq(pa, s1);
        assertEq(pb, s2);
        // Rounding leaves dust behind rather than overpaying; it must never exceed what came in.
        assertLe(ra + rb, d1 + d2, "never pays out more than was deposited");
        assertGe(ra + rb + 10, d1 + d2, "and loses only rounding dust");
    }
}
