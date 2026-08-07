// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

/**
 * Proves the DEVELOPER BUY sequence the Launch page performs, against the real Pons V2 factory and
 * a real bonding curve, on a fork of Robinhood Chain.
 *
 * ## Why this exists
 *
 * The front end cannot be rehearsed on mainnet: `launchEnabled()` is false, so no launch can happen,
 * and **all 16 existing V2 launches have already graduated**, so none of their curves still accepts
 * a buy. Without this test the whole dev-buy path would ship never having been executed once — and
 * it spends the creator's real stock.
 *
 * ## What it proves
 *
 * The exact three-step sequence in `Launch.tsx`:
 *   1. `launchToken(...)` returns `(token, curve)`
 *   2. `pairToken.approve(curve, quoteIn)`   ← required: the quote is an ERC-20, not native
 *   3. `curve.buy(quoteIn, minTokensOut, recipient)` with **no** msg.value
 *
 * ⚠ The gate is forced open by impersonating the factory owner. That is a FORK-ONLY manoeuvre to
 * reach the code path; it asserts nothing about whether Pons will ever open it.
 */
interface IFactory {
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
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
    }

    function launchToken(LaunchParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, address curve);

    function launchEnabled() external view returns (bool);
    function launchFee() external view returns (uint256);
    function setLaunchEnabled(bool) external;
    function owner() external view returns (address);
    function approvedPairTokens(address) external view returns (bool);
}

interface ICurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut);
    function isNativeQuote() external view returns (bool);
    function pairToken() external view returns (address);
    function token() external view returns (address);
}

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

contract DevBuyTest is Test {
    IFactory constant FACTORY = IFactory(0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8);
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    address creator = makeAddr("creator");

    function _openGate() internal {
        address owner = FACTORY.owner();
        vm.prank(owner);
        FACTORY.setLaunchEnabled(true);
        assertTrue(FACTORY.launchEnabled(), "gate should be open on the fork");
    }

    function _launch(address pair, string memory sym) internal returns (address token, address curve) {
        IFactory.LaunchParams memory p = IFactory.LaunchParams({
            name: "DevBuy Test",
            symbol: sym,
            // A data: URI, exactly as the upload produces — this also proves such a string is
            // accepted by the launch call rather than rejected for length or content.
            logo: "data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvQWxvAGs=",
            description: "fork rehearsal",
            socials: IFactory.Socials("", "", "", "", ""),
            creatorFeeRecipient: creator,
            creatorTaxBps: 100,
            buybackEnabled: false,
            expectedEconomics: bytes32(0)
        });

        uint256 fee = FACTORY.launchFee();
        vm.deal(creator, fee + 1 ether);
        vm.prank(creator);
        (token, curve) = FACTORY.launchToken{value: fee}(p, 0, pair);
    }

    /// The whole sequence, on the 18-decimal pair the ordinary case uses.
    function test_devBuy_realFactory_realCurve_AAPL() public {
        _openGate();
        assertTrue(FACTORY.approvedPairTokens(AAPL), "AAPL must be an approved pair token");

        (address token, address curve) = _launch(AAPL, "DBT");
        assertTrue(token != address(0) && curve != address(0), "launch returned no addresses");

        // ⚠⚠ The load-bearing fact behind needing an approve at all.
        assertFalse(ICurve(curve).isNativeQuote(), "a stock-paired curve must NOT be native-quoted");
        assertEq(ICurve(curve).pairToken(), AAPL, "curve pair token");
        assertEq(ICurve(curve).token(), token, "curve token");

        uint256 quoteIn = 5e18; // 5 AAPL, 18 decimals
        deal(AAPL, creator, quoteIn);

        // Step 2: approve. Without this the buy reverts — the curve pulls the quote.
        vm.prank(creator);
        IERC20(AAPL).approve(curve, quoteIn);
        assertEq(IERC20(AAPL).allowance(creator, curve), quoteIn, "allowance not set");

        // The front end simulates the buy to derive a slippage floor. Same call, via staticcall
        // semantics, so the floor is anchored to the chain rather than to maths reimplemented here.
        uint256 expected;
        {
            vm.prank(creator);
            uint256 snap = vm.snapshotState();
            expected = ICurve(curve).buy(quoteIn, 0, creator);
            vm.revertToState(snap);
        }
        assertGt(expected, 0, "simulation returned no tokens");

        uint256 minOut = (expected * 9800) / 10000; // the 200 bps floor the app applies

        // Step 3: the real buy, with NO value.
        uint256 before = IERC20(token).balanceOf(creator);
        vm.prank(creator);
        uint256 got = ICurve(curve).buy(quoteIn, minOut, creator);

        assertGe(got, minOut, "received less than the slippage floor");
        assertEq(IERC20(token).balanceOf(creator) - before, got, "balance did not rise by the return value");
        assertEq(IERC20(AAPL).balanceOf(creator), 0, "the quote should have been spent");
    }

    /**
     * ⚠⚠ The 6-decimal case. USDG is the one approved pair token that is not 18 decimals, and a
     * front end that parsed the amount with a flat 1e18 would ask for a TRILLION times too much.
     * This proves the curve accepts an amount denominated in the pair token's OWN decimals.
     */
    function test_devBuy_sixDecimalPair_USDG() public {
        _openGate();
        assertEq(IERC20(USDG).decimals(), 6, "USDG must be 6 decimals");

        (address token, address curve) = _launch(USDG, "DBU");
        assertFalse(ICurve(curve).isNativeQuote(), "USDG-paired curve must not be native-quoted");

        uint256 quoteIn = 250e6; // 250 USDG in ITS decimals, not 250e18
        deal(USDG, creator, quoteIn);

        vm.prank(creator);
        IERC20(USDG).approve(curve, quoteIn);

        vm.prank(creator);
        uint256 got = ICurve(curve).buy(quoteIn, 0, creator);

        assertGt(got, 0, "no tokens received for a 6-decimal quote");
        assertEq(IERC20(token).balanceOf(creator), got, "token balance mismatch");
    }

    /// A buy with no allowance must fail, which is what makes step 2 mandatory rather than optional.
    function test_buyWithoutApproveReverts() public {
        _openGate();
        (, address curve) = _launch(AAPL, "DBN");

        deal(AAPL, creator, 5e18);
        vm.prank(creator);
        vm.expectRevert();
        ICurve(curve).buy(5e18, 0, creator);
    }
}
