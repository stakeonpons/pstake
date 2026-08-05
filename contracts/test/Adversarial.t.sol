// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {BStakeStaking} from "../src/BStakeStaking.sol";
import {MockToken} from "./mocks/Tokens.sol";

/// Hostile pass: things the happy-path suite was not looking for.
contract AdversarialTest is Test {
    BStakeStaking internal s;
    MockToken internal tok;
    MockToken internal rew;

    address internal owner = address(0xB0B);
    address internal feeWallet = address(0xFEE);
    address internal dust = address(0xD057);
    address internal whale = address(0x1A16);

    uint256 internal pool;

    function setUp() public {
        s = new BStakeStaking(owner);
        tok = new MockToken("Stake", "STK", 18);
        rew = new MockToken("Reward", "RWD", 18);

        vm.startPrank(owner);
        pool = s.createPool(address(tok), address(rew));
        s.setDepositor(feeWallet, true);
        s.setStakingOpen(true);
        vm.stopPrank();

        tok.mint(dust, 1e18);
        tok.mint(whale, 500_000_000e18);
        rew.mint(feeWallet, 100_000_000e18);

        vm.prank(dust); tok.approve(address(s), type(uint256).max);
        vm.prank(whale); tok.approve(address(s), type(uint256).max);
        vm.prank(feeWallet); rew.approve(address(s), type(uint256).max);
    }

    /**
     * A pool whose total weight is momentarily tiny inflates `accPerWeight` enormously. A staker
     * who arrives afterwards with a normal-sized position then multiplies a huge weight by a huge
     * accumulator.
     *
     * If that product exceeds 2^256 the multiplication reverts — and it reverts inside `_pending`,
     * which `claim` AND `withdraw` both depend on. That does not lose funds, it does something
     * worse: it locks them in, permanently, for everyone in the pool.
     */
    function test_accumulatorOverflow_canBrickAPool() public {
        // Someone stakes the smallest possible position.
        vm.prank(dust);
        s.stake(pool, 1, 1);

        // The fee wallet funds the pool while that is the only weight in it.
        vm.startPrank(feeWallet);
        for (uint256 i; i < 5; ++i) s.depositRewards(pool, 20_000_000e18);
        vm.stopPrank();

        // A normal staker arrives.
        vm.prank(whale);
        try s.stake(pool, 400_000_000e18, 30) {
            emit log("stake succeeded");
        } catch {
            emit log("!!! stake REVERTED - the pool is unusable for normal positions");
            fail();
        }
    }

    /**
     * The same arithmetic, but with the large position already open when the accumulator inflates.
     * Here it is not a usability problem, it is trapped principal: `withdraw` cannot complete.
     */
    function test_accumulatorOverflow_canTrapExistingPrincipal() public {
        vm.prank(whale);
        s.stake(pool, 400_000_000e18, 30);
        vm.prank(dust);
        s.stake(pool, 1, 1);

        // The whale exits at term, dropping total weight to the dust position alone.
        skip(31 days);
        vm.prank(whale);
        s.withdraw(pool, 0);

        // Fees keep arriving against a near-zero weight.
        vm.startPrank(feeWallet);
        for (uint256 i; i < 5; ++i) s.depositRewards(pool, 20_000_000e18);
        vm.stopPrank();

        // Someone else stakes normally afterwards.
        tok.mint(address(this), 400_000_000e18);
        tok.approve(address(s), type(uint256).max);
        try s.stake(pool, 400_000_000e18, 30) {
            emit log("later stake succeeded");
        } catch {
            emit log("!!! a pool that once worked can no longer be staked into");
            fail();
        }
    }

    /* ------------------------------------------------------------------------------------- */

    /// Claiming the same position twice in one call must not pay twice.
    function test_claimMany_duplicateIdsDoNotDoublePay() public {
        vm.prank(whale);
        s.stake(pool, 1_000e18, 1);
        vm.prank(feeWallet);
        s.depositRewards(pool, 100e18);

        uint256[] memory ids = new uint256[](3);
        ids[0] = 0;
        ids[1] = 0;
        ids[2] = 0;

        uint256 before = rew.balanceOf(whale);
        vm.prank(whale);
        uint256 paid = s.claimMany(pool, ids);

        assertApproxEqAbs(paid, 100e18, 10, "three claims of one position pay once");
        assertApproxEqAbs(rew.balanceOf(whale) - before, 100e18, 10);
    }

    /// A staker must never be able to claim against somebody else's position.
    function test_cannotClaimAnotherUsersPosition() public {
        vm.prank(whale);
        s.stake(pool, 1_000e18, 1);
        vm.prank(feeWallet);
        s.depositRewards(pool, 100e18);

        // dust has no position 0 of their own.
        vm.prank(dust);
        vm.expectRevert(BStakeStaking.NoSuchPosition.selector);
        s.claim(pool, 0);
    }

    /**
     * ⚠ Economic, not arithmetic, and worth stating plainly.
     *
     * Because a deposit is distributed the instant it lands, whoever holds the weight at that
     * moment takes it. In a pool that is empty or nearly so, one wei of stake collects the entire
     * deposit. This is a direct consequence of paying on arrival rather than streaming, and it is
     * demonstrated rather than asserted against so the behaviour is on the record.
     */
    function test_dustStakerCapturesAWholeDepositIntoAnEmptyPool() public {
        vm.prank(dust);
        s.stake(pool, 1, 1); // one wei

        vm.prank(feeWallet);
        s.depositRewards(pool, 1_000e18);

        uint256 owed = s.pending(pool, dust, 0);
        emit log_named_decimal_uint("one wei of stake earned", owed, 18);
        assertGt(owed, 900e18, "a dust position takes essentially the whole deposit");
    }

    /// Withdrawing must not let a position keep earning, even if claim is called afterwards.
    function test_claimAfterWithdrawPaysNothing() public {
        vm.prank(whale);
        s.stake(pool, 1_000e18, 1);
        skip(1 days);
        vm.prank(whale);
        s.withdraw(pool, 0);

        // Someone else takes over the pool.
        vm.prank(dust);
        s.stake(pool, 1e18, 1);
        vm.prank(feeWallet);
        s.depositRewards(pool, 500e18);

        vm.prank(whale);
        assertEq(s.claim(pool, 0), 0, "a closed position must never earn again");
    }
}