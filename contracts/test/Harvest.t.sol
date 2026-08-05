// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PStakeStaking} from "../src/PStakeStaking.sol";
import {MockToken} from "./mocks/Tokens.sol";
import {MockPonsEscrow} from "./mocks/Escrow.sol";

/**
 * The Pons-specific surface: pulling creator fees out of the escrow and dividing them.
 *
 * Two things are being proven here. That the mechanism works — fees leave the escrow, land in the
 * right pools, and reach stakers. And that the parts of it which are *declarations* rather than
 * measurements cannot be declared into a state that misroutes money.
 */
contract HarvestTest is Test {
    PStakeStaking internal s;
    MockPonsEscrow internal escrow;
    MockToken internal nvda;
    MockToken internal gme;
    MockToken internal tokenA; // a launched token paired against NVDA
    MockToken internal tokenB; // a second one, also paired against NVDA

    address internal owner = address(0xB0B);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0BB);
    address internal passerby = address(0xDEAD);
    address internal donor = address(0xD01);

    uint256 internal poolA; // stake tokenA, earn NVDA
    uint256 internal poolB; // stake tokenB, earn NVDA
    uint256 internal poolStock; // stake NVDA, earn NVDA — the pStake track

    uint256 internal constant DUST = 10;

    function setUp() public {
        escrow = new MockPonsEscrow();
        s = new PStakeStaking(owner, address(escrow));

        nvda = new MockToken("NVIDIA", "NVDA", 18);
        gme = new MockToken("GameStop", "GME", 18);
        tokenA = new MockToken("Alpha", "ALPHA", 18);
        tokenB = new MockToken("Beta", "BETA", 18);

        vm.startPrank(owner);
        poolA = s.createPool(address(tokenA), address(nvda), 1e18);
        poolB = s.createPool(address(tokenB), address(nvda), 1e18);
        poolStock = s.createPool(address(nvda), address(nvda), 1e18);
        s.setStakingOpen(true);
        vm.stopPrank();

        for (uint256 i; i < 2; ++i) {
            address u = [alice, bob][i];
            tokenA.mint(u, 1_000_000e18);
            tokenB.mint(u, 1_000_000e18);
            nvda.mint(u, 1_000_000e18);
            vm.startPrank(u);
            tokenA.approve(address(s), type(uint256).max);
            tokenB.approve(address(s), type(uint256).max);
            nvda.approve(address(s), type(uint256).max);
            vm.stopPrank();
        }
    }

    /* --------------------------------- helpers --------------------------------- */

    function _split(address rewardToken, uint256[] memory ids, uint256[] memory bps) internal {
        vm.prank(owner);
        s.setSplit(rewardToken, ids, bps);
    }

    function _one(uint256 poolId) internal pure returns (uint256[] memory ids, uint256[] memory bps) {
        ids = new uint256[](1);
        bps = new uint256[](1);
        ids[0] = poolId;
        bps[0] = 10_000;
    }

    function _two(uint256 a, uint256 aBps, uint256 b, uint256 bBps)
        internal
        pure
        returns (uint256[] memory ids, uint256[] memory bps)
    {
        ids = new uint256[](2);
        bps = new uint256[](2);
        (ids[0], bps[0], ids[1], bps[1]) = (a, aBps, b, bBps);
    }

    /// Credits the staking contract through the escrow, exactly as Pons's fee route does.
    function _credit(MockToken token, uint256 amount) internal {
        token.mint(donor, amount);
        vm.startPrank(donor);
        token.approve(address(escrow), amount);
        escrow.creditToken(address(s), address(token), amount);
        vm.stopPrank();
    }

    /* --------------------------------- the mechanism --------------------------------- */

    function test_harvest_pullsFromEscrowAndPaysStakers() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(poolA);
        _split(address(nvda), ids, bps);

        vm.prank(alice);
        s.stake(poolA, 1_000e18, 1);

        _credit(nvda, 100e18);
        assertEq(s.harvestable(address(nvda)), 100e18);

        uint256 distributed = s.harvest(address(nvda));

        assertEq(distributed, 100e18);
        assertEq(escrow.balanceOfToken(address(s), address(nvda)), 0, "escrow drained");
        assertApproxEqAbs(s.pending(poolA, alice, 0), 100e18, DUST, "and it reached the staker");
    }

    /**
     * ⭐ Permissionless. The point of the whole design: stakers do not wait on the operator, and no
     * keyed wallet sits in the path between Pons and the pools.
     */
    function test_harvest_isPermissionless() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(poolA);
        _split(address(nvda), ids, bps);
        vm.prank(alice);
        s.stake(poolA, 1_000e18, 1);
        _credit(nvda, 50e18);

        vm.prank(passerby);
        assertEq(s.harvest(address(nvda)), 50e18, "a stranger may collect for the pool");
    }

    /**
     * ⚠⚠ The escrow reverts rather than returning zero when there is nothing to claim.
     *
     * Two callers racing in the same block is the ordinary case for a public function, so the
     * second one must fail on this contract's own clear error and never on the escrow's.
     */
    function test_harvest_withNothingBehindIt_revertsCleanly() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(poolA);
        _split(address(nvda), ids, bps);
        vm.prank(alice);
        s.stake(poolA, 1_000e18, 1);
        _credit(nvda, 10e18);

        s.harvest(address(nvda));

        vm.expectRevert(PStakeStaking.NothingToHarvest.selector);
        s.harvest(address(nvda));
    }

    /**
     * With no split declared, harvest must refuse BEFORE claiming. Fees left in the escrow are
     * still owed to this contract; fees claimed with nowhere to go would need the owner to rescue
     * them, and there is deliberately no ERC-20 rescue.
     */
    function test_harvest_withoutSplit_leavesTheMoneyInTheEscrow() public {
        _credit(nvda, 100e18);

        vm.expectRevert(PStakeStaking.NoSplit.selector);
        s.harvest(address(nvda));

        assertEq(escrow.balanceOfToken(address(s), address(nvda)), 100e18, "untouched, still ours");
        assertEq(s.harvestable(address(nvda)), 0, "and reported as not harvestable");
    }

    /* --------------------------------- the declared split --------------------------------- */

    /**
     * The case the escrow's (recipient, asset) key forces on us: two launched tokens paired against
     * the same stock credit ONE balance, and the division is the operator's declaration.
     */
    function test_split_dividesOneEscrowBalanceBetweenTwoTokens() public {
        (uint256[] memory ids, uint256[] memory bps) = _two(poolA, 7_000, poolB, 3_000);
        _split(address(nvda), ids, bps);

        vm.prank(alice);
        s.stake(poolA, 1_000e18, 1);
        vm.prank(bob);
        s.stake(poolB, 1_000e18, 1);

        _credit(nvda, 1_000e18);
        s.harvest(address(nvda));

        assertApproxEqAbs(s.pending(poolA, alice, 0), 700e18, DUST, "70% as declared");
        assertApproxEqAbs(s.pending(poolB, bob, 0), 300e18, DUST, "30% as declared");
    }

    /**
     * ⛔ A pool that does not pay out in the harvested asset must be refused.
     *
     * Accepting it would credit that pool with an asset it does not hold, and its stakers' claims
     * would then drain a different pool's principal. This is the single most dangerous way to
     * mis-declare a split, so it is a hard revert rather than a convention.
     */
    function test_split_rejectsPoolWithADifferentRewardToken() public {
        vm.prank(owner);
        uint256 gmePool = s.createPool(address(gme), address(gme), 0);

        (uint256[] memory ids, uint256[] memory bps) = _two(poolA, 5_000, gmePool, 5_000);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PStakeStaking.WrongRewardToken.selector, gmePool));
        s.setSplit(address(nvda), ids, bps);
    }

    function test_split_rejectsSharesThatDoNotTotalOneHundredPercent() public {
        (uint256[] memory ids, uint256[] memory bps) = _two(poolA, 6_000, poolB, 3_000);
        vm.prank(owner);
        vm.expectRevert(PStakeStaking.BadSplit.selector);
        s.setSplit(address(nvda), ids, bps);

        (ids, bps) = _two(poolA, 6_000, poolB, 5_000);
        vm.prank(owner);
        vm.expectRevert(PStakeStaking.BadSplit.selector);
        s.setSplit(address(nvda), ids, bps);
    }

    function test_split_rejectsDuplicateAndZeroShares() public {
        (uint256[] memory ids, uint256[] memory bps) = _two(poolA, 5_000, poolA, 5_000);
        vm.prank(owner);
        vm.expectRevert(PStakeStaking.BadSplit.selector);
        s.setSplit(address(nvda), ids, bps);

        (ids, bps) = _two(poolA, 10_000, poolB, 0);
        vm.prank(owner);
        vm.expectRevert(PStakeStaking.BadSplit.selector);
        s.setSplit(address(nvda), ids, bps);
    }

    function test_split_canBeReplacedAndCleared() public {
        (uint256[] memory ids, uint256[] memory bps) = _two(poolA, 5_000, poolB, 5_000);
        _split(address(nvda), ids, bps);
        assertEq(s.splitOf(address(nvda)).length, 2);

        (ids, bps) = _one(poolB);
        _split(address(nvda), ids, bps);
        PStakeStaking.Share[] memory shares = s.splitOf(address(nvda));
        assertEq(shares.length, 1, "replaced, not appended");
        assertEq(shares[0].poolId, poolB);

        _split(address(nvda), new uint256[](0), new uint256[](0));
        assertEq(s.splitOf(address(nvda)).length, 0, "cleared");
    }

    function test_onlyOwnerCanDeclareASplit() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(poolA);
        vm.prank(alice);
        vm.expectRevert();
        s.setSplit(address(nvda), ids, bps);
    }

    /* --------------------------------- rounding --------------------------------- */

    /**
     * Truncation dust is carried to the next harvest, never rounded up and never stranded.
     *
     * Three equal shares of an amount that does not divide by three is the smallest case that
     * exercises it: 100 wei splits 33/33/33 and one wei is left.
     */
    function test_harvest_dustIsCarriedNotStranded() public {
        uint256[] memory ids = new uint256[](3);
        uint256[] memory bps = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (poolA, poolB, poolStock);
        (bps[0], bps[1], bps[2]) = (3_334, 3_333, 3_333);
        _split(address(nvda), ids, bps);

        vm.prank(alice);
        s.stake(poolA, 1_000e18, 1);
        vm.prank(bob);
        s.stake(poolB, 1_000e18, 1);
        vm.prank(alice);
        s.stake(poolStock, 1_000e18, 1);

        _credit(nvda, 100);
        uint256 distributed = s.harvest(address(nvda));

        assertLe(distributed, 100, "never distributes more than arrived");
        assertEq(s.residual(address(nvda)), 100 - distributed, "the remainder is kept, not lost");

        // It is not stranded: the next harvest picks it up.
        _credit(nvda, 1_000e18);
        s.harvest(address(nvda));
        assertEq(s.residual(address(nvda)) < 100, true, "carried forward into the next division");
    }

    /* --------------------------------- the minimum stake --------------------------------- */

    /**
     * ⚠⚠ The reason `minStake` exists.
     *
     * Rewards are paid on arrival and `harvest` is public, so an attacker — not the operator —
     * chooses the instant of a credit. Without a floor, one wei staked into an empty pool followed
     * by a harvest in the same transaction collects the entire claimable balance.
     */
    function test_minStake_blocksTheDustHarvestSnipe() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(poolA);
        _split(address(nvda), ids, bps);
        _credit(nvda, 1_000e18);

        address attacker = address(0xBAD);
        tokenA.mint(attacker, 1_000e18);
        vm.startPrank(attacker);
        tokenA.approve(address(s), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(PStakeStaking.BelowMinimum.selector, 1e18));
        s.stake(poolA, 1, 1);
        vm.stopPrank();
    }

    /**
     * And what the floor actually costs the attacker: real capital, locked for a real term, on the
     * same terms as everyone else. The snipe is not eliminated — it is priced.
     */
    function test_minStake_makesTheSnipeCostRealMoney() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(poolA);
        _split(address(nvda), ids, bps);

        vm.prank(alice);
        s.stake(poolA, 1_000e18, 30); // an honest staker already holds most of the weight

        address attacker = address(0xBAD);
        tokenA.mint(attacker, 1e18);
        vm.startPrank(attacker);
        tokenA.approve(address(s), type(uint256).max);
        s.stake(poolA, 1e18, 1); // the minimum, at the lowest multiplier
        vm.stopPrank();

        _credit(nvda, 1_000e18);
        s.harvest(address(nvda));

        // Weight is 3000e18 against 1e18: the attacker's share is a rounding error, not a payday.
        assertLt(s.pending(poolA, attacker, 0), 1e18, "a minimum position takes a minimum share");
        assertGt(s.pending(poolA, alice, 0), 990e18);
    }

    function test_minStake_isCheckedAfterArrivalAndCanBeChanged() public {
        vm.prank(owner);
        s.setMinStake(poolA, 500e18);
        (,,,,, uint256 minStake) = s.pools(poolA);
        assertEq(minStake, 500e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PStakeStaking.BelowMinimum.selector, 500e18));
        s.stake(poolA, 499e18, 1);

        vm.prank(alice);
        s.stake(poolA, 500e18, 1);
    }

    /* --------------------------------- native --------------------------------- */

    /**
     * Native revenue cannot be paid to stakers — pools hold ERC-20s. It must still be reachable,
     * or a launch paired against native would credit this contract money nobody could ever move.
     */
    function test_native_canBeClaimedFromEscrowAndRescued() public {
        vm.deal(donor, 5 ether);
        vm.prank(donor);
        escrow.credit{value: 5 ether}(address(s));

        vm.prank(passerby);
        assertEq(s.claimNativeFees(), 5 ether, "permissionless, like harvest");
        assertEq(address(s).balance, 5 ether, "the receive hook let it land");

        vm.prank(owner);
        s.rescueNative(owner);
        assertEq(owner.balance, 5 ether);
        assertEq(address(s).balance, 0);
    }

    function test_native_claimWithNothingBehindItRevertsCleanly() public {
        vm.expectRevert(PStakeStaking.NothingToHarvest.selector);
        s.claimNativeFees();
    }

    function test_rescueNative_isOwnerOnly() public {
        vm.deal(address(s), 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        s.rescueNative(alice);
    }

    /* --------------------------------- solvency --------------------------------- */

    /**
     * The property that matters: however the fees are divided and whoever harvests them, the pools
     * can never promise more than the escrow actually delivered.
     */
    function testFuzz_harvestNeverOverDistributes(uint96 credited, uint16 shareA) public {
        uint256 amount = uint256(credited) % 1_000_000e18 + 1;
        uint256 aBps = uint256(shareA) % 9_999 + 1;

        (uint256[] memory ids, uint256[] memory bps) = _two(poolA, aBps, poolB, 10_000 - aBps);
        _split(address(nvda), ids, bps);

        vm.prank(alice);
        s.stake(poolA, 1_000e18, 1);
        vm.prank(bob);
        s.stake(poolB, 1_000e18, 1);

        _credit(nvda, amount);
        uint256 distributed = s.harvest(address(nvda));

        assertLe(distributed, amount, "never more than arrived");
        assertEq(distributed + s.residual(address(nvda)), amount, "and nothing is lost");

        uint256 owed = s.pending(poolA, alice, 0) + s.pending(poolB, bob, 0);
        assertLe(owed, amount, "stakers are never owed more than the escrow paid");
    }
}
