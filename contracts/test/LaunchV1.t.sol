// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

/**
 * Proves the V1 launch the website performs, against the real Pons V1 factory and locker, on a fork
 * of Robinhood Chain.
 *
 * ## Why this exists
 *
 * V1's `launchEnabled` is **true**, so this path spends real money the moment it ships. Two claims
 * in particular had to be executed rather than reasoned about:
 *
 *   1. `params.feeWallet` really does route the token's fees to Stake, readable afterwards as
 *      `locker.feeRedirects(token)` — this is what makes a token "launched on our site", and what
 *      the Tokens page enumerates by.
 *   2. The developer buy is nothing but extra `msg.value`. Arithmetic on a real launch said so;
 *      this executes it and checks the creator actually receives tokens.
 */
interface IV1Factory {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct LaunchParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address feeWallet;
    }

    function launchToken(LaunchParams calldata params, uint256 launchConfigId, uint256 dexId, bytes32 salt)
        external
        payable
        returns (address token);

    function launchEnabled() external view returns (bool);
    function launchFee() external view returns (uint256);
    function launchConfigCount() external view returns (uint256);
    function getLaunchConfig(uint256 id)
        external
        view
        returns (
            address pairToken,
            uint256 graduationThreshold,
            int24 initialTick,
            uint256 supply,
            uint16 maxWalletBps,
            uint16 maxTxBps,
            uint32 restrictionBlocks,
            uint24 reservedFee,
            bool enabled,
            bool routerRequiresDeadline
        );

    struct Info {
        address token;
        address deployer;
        address pairedToken;
        address positionManager;
        uint256 positionId;
        uint256 dexId;
        uint256 launchConfigId;
        uint256 restrictionsEndBlock;
        uint256 supply;
        bool isToken0;
        uint24 poolFee;
        bool exists;
        uint256 initialBuyAmount;
    }

    function getLaunchedToken(address token) external view returns (Info memory);
}

interface ILocker {
    function feeRedirects(address token) external view returns (address);
    function feeRecipientTokenCount(address recipient) external view returns (uint256);
    function feeRecipientTokens(address recipient, uint256 index) external view returns (address);
    function collectFees(address token) external returns (uint256, uint256);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function symbol() external view returns (string memory);
}

interface IRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256);
}

contract LaunchV1Test is Test {
    IV1Factory constant FACTORY = IV1Factory(0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB);
    ILocker constant LOCKER = ILocker(0x736D76699C26D0d966744cAe304C000d471f7F35);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;

    /// The wallet every token launched through the site must pay.
    address constant STAKE_FEE_WALLET = 0x69a8a7164309D58E6a1510D1d393f93256EDAD3D;

    address creator = makeAddr("creator");

    function _params(string memory sym) internal pure returns (IV1Factory.LaunchParams memory) {
        return IV1Factory.LaunchParams({
            name: "Fork Rehearsal",
            symbol: sym,
            // The same shape the upload produces, so this also proves a data: URI survives V1.
            logo: "data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvQWxvAGs=",
            description: "fork rehearsal",
            socials: IV1Factory.Socials("", "", "", "", ""),
            feeWallet: STAKE_FEE_WALLET
        });
    }

    /// ⚠⚠ The assumption the whole Tokens page rests on: V1 pairs against WETH and nothing else.
    function test_v1HasExactlyOneConfig_andItIsWeth() public view {
        assertEq(FACTORY.launchConfigCount(), 1, "V1 should expose exactly one launch config");
        (address pairToken,,,,,,,, bool enabled,) = FACTORY.getLaunchConfig(0);
        assertEq(pairToken, WETH, "the only V1 pair token must be WETH");
        assertTrue(enabled, "config 0 must be enabled");
        assertTrue(FACTORY.launchEnabled(), "V1 launches are open");
    }

    /// A launch with no developer buy. Fees must route to Stake and the token must be enumerable.
    function test_launch_routesFeesToStake_andIsEnumerable() public {
        uint256 fee = FACTORY.launchFee();
        uint256 before = LOCKER.feeRecipientTokenCount(STAKE_FEE_WALLET);

        vm.deal(creator, fee + 1 ether);
        vm.prank(creator);
        address token = FACTORY.launchToken{value: fee}(_params("FRK"), 0, 0, keccak256("salt-a"));

        assertTrue(token != address(0), "no token address returned");

        // ⭐ The membership test the site uses.
        assertEq(LOCKER.feeRedirects(token), STAKE_FEE_WALLET, "fees must route to Stake's wallet");

        // ⭐ And the reverse index that lets the Tokens page list our launches with no server.
        assertEq(LOCKER.feeRecipientTokenCount(STAKE_FEE_WALLET), before + 1, "reverse index did not grow");
        assertEq(LOCKER.feeRecipientTokens(STAKE_FEE_WALLET, before), token, "reverse index points elsewhere");

        IV1Factory.Info memory info = FACTORY.getLaunchedToken(token);
        assertTrue(info.exists, "factory has no record");
        assertEq(info.deployer, creator, "deployer should be the creator, not Stake");
        assertEq(info.pairedToken, WETH, "V1 pairs against WETH");
        assertEq(info.initialBuyAmount, 0, "no dev buy was requested");
    }

    /**
     * 🔴 THE TRAP, pinned so it can never be reintroduced.
     *
     * V1's built-in initial buy credits **`params.feeWallet`**, not the buyer. Because this site
     * hard-codes that to Stake's wallet, using it would mean the creator spends the ETH and Stake
     * receives the tokens. This test asserts that wrong-for-us behaviour explicitly.
     */
    function test_builtInInitialBuy_paysTheFeeWallet_notTheBuyer() public {
        uint256 fee = FACTORY.launchFee();
        uint256 devBuy = 0.05 ether;

        vm.deal(creator, fee + devBuy + 1 ether);
        vm.prank(creator);
        address token = FACTORY.launchToken{value: fee + devBuy}(_params("FRB"), 0, 0, keccak256("salt-b"));

        assertEq(FACTORY.getLaunchedToken(token).initialBuyAmount, devBuy, "surplus is recorded as the initial buy");
        assertEq(IERC20(token).balanceOf(creator), 0, "the creator must receive NOTHING from it");
        assertGt(IERC20(token).balanceOf(STAKE_FEE_WALLET), 0, "the fee wallet is who actually gets the tokens");
    }

    /// ⚠ Inside the restriction window the snipe reverts no matter how small it is.
    function test_snipe_revertsDuringRestrictionWindow() public {
        uint256 fee = FACTORY.launchFee();
        vm.deal(creator, fee + 1 ether);
        vm.prank(creator);
        address token = FACTORY.launchToken{value: fee}(_params("FRR"), 0, 0, keccak256("salt-r"));

        uint24 poolFee = FACTORY.getLaunchedToken(token).poolFee;
        vm.prank(creator);
        vm.expectRevert();
        IRouter(ROUTER).exactInputSingle{value: 0.01 ether}(
            IRouter.ExactInputSingleParams(WETH, token, poolFee, creator, 0.01 ether, 0, 0)
        );
    }

    /**
     * ⭐ What the site actually does: launch with NO initial buy, wait for the restriction window to
     * close, then snipe from the creator's own wallet. ETH and tokens end up with the same person.
     */
    function test_snipe_afterCleanLaunch_paysTheCreator() public {
        uint256 fee = FACTORY.launchFee();
        uint256 spend = 0.05 ether;

        vm.deal(creator, fee + spend + 1 ether);
        vm.prank(creator);
        address token = FACTORY.launchToken{value: fee}(_params("FRS"), 0, 0, keccak256("salt-s"));

        // Nothing was bought at launch, so nobody holds anything yet.
        assertEq(FACTORY.getLaunchedToken(token).initialBuyAmount, 0, "launch must carry no initial buy");
        assertEq(IERC20(token).balanceOf(STAKE_FEE_WALLET), 0, "the fee wallet must not receive tokens");

        /*
          ⚠⚠ The window the site's `waitForTrading` exists for. In the launch block this identical
          swap reverts with Uniswap's `TF` at ANY size — the token blocks transfers until
          `restrictionsEndBlock`, so the pool's payout fails. Rolling past it is what the front end
          does by polling the block number.
        */
        IV1Factory.Info memory pre = FACTORY.getLaunchedToken(token);
        vm.roll(pre.restrictionsEndBlock + 1);

        uint24 poolFee = pre.poolFee;
        vm.prank(creator);
        uint256 out = IRouter(ROUTER).exactInputSingle{value: spend}(
            IRouter.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: token,
                fee: poolFee,
                recipient: creator,
                amountIn: spend,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );

        assertGt(out, 0, "the snipe returned no tokens");
        assertEq(IERC20(token).balanceOf(creator), out, "the CREATOR must hold what they bought");
        assertEq(IERC20(token).balanceOf(STAKE_FEE_WALLET), 0, "Stake must still hold none of it");
        // Fee routing is unaffected by the snipe.
        assertEq(LOCKER.feeRedirects(token), STAKE_FEE_WALLET, "fees must still route to Stake");
    }

    /**
     * ⚠ A freshly launched token has nothing to collect, and the locker signals that by REVERTING
     * `NoFeesToCollect()` rather than returning zero. The fee reader treats that as zero; this
     * pins the behaviour so a future change to it is caught here rather than on the live site.
     */
    function test_freshToken_hasNoFeesToCollect() public {
        uint256 fee = FACTORY.launchFee();
        vm.deal(creator, fee + 1 ether);
        vm.prank(creator);
        address token = FACTORY.launchToken{value: fee}(_params("FRC"), 0, 0, keccak256("salt-c"));

        vm.prank(STAKE_FEE_WALLET);
        vm.expectRevert(bytes4(keccak256("NoFeesToCollect()")));
        LOCKER.collectFees(token);
    }

    /// Only the fee wallet may collect. Anyone else is refused with a DIFFERENT error.
    function test_collectFees_isPermissioned() public {
        uint256 fee = FACTORY.launchFee();
        vm.deal(creator, fee + 1 ether);
        vm.prank(creator);
        address token = FACTORY.launchToken{value: fee}(_params("FRD"), 0, 0, keccak256("salt-d"));

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(bytes4(keccak256("NotAuthorized()")));
        LOCKER.collectFees(token);
    }
}
