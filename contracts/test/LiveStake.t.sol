// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IStaking {
    function stake(uint256 poolId, uint256 amount, uint32 termDays) external returns (uint256);
    function pools(uint256) external view returns (address, address, uint256, uint256, uint256, uint256);
    function stakingOpen() external view returns (bool);
    function pending(uint256, address, uint256) external view returns (uint256);
    function positionCount(uint256, address) external view returns (uint256);
}

/// Can a real user actually stake STAKE right now? Against the DEPLOYED contract, on a fork.
contract LiveStakeTest is Test {
    IStaking constant S = IStaking(0x730465263fFaA2855fF3614C93C486038dE41ed6);
    address constant STAKE = 0x831758E8C9C043bE7DEB4D74a4Cf581599aeffe5;
    uint256 constant POOL = 8;

    function test_aRealUserCanStakeRightNow() public {
        assertTrue(S.stakingOpen(), "staking is not open");

        address user = makeAddr("user");
        uint256 amount = 200_000e18; // comfortably over the 100k floor
        deal(STAKE, user, amount);

        vm.startPrank(user);
        IERC20(STAKE).approve(address(S), amount);
        S.stake(POOL, amount, 7);
        vm.stopPrank();

        assertEq(S.positionCount(POOL, user), 1, "no position was opened");
        (,, uint256 totalStaked, uint256 totalWeight,,) = S.pools(POOL);
        assertEq(totalStaked, amount, "pool did not record the stake");
        // A 7 day lock carries a 1.5x multiplier, so weight is deliberately larger than principal.
        assertEq(totalWeight, (amount * 15) / 10, "lock multiplier not applied to weight");
    }

    /// Below the floor must still be refused on the LIVE configuration, not just in theory.
    function test_belowTheLiveMinimumIsRefused() public {
        address user = makeAddr("user2");
        deal(STAKE, user, 99_999e18);
        vm.startPrank(user);
        IERC20(STAKE).approve(address(S), 99_999e18);
        vm.expectRevert();
        S.stake(POOL, 99_999e18, 7);
        vm.stopPrank();
    }
}
