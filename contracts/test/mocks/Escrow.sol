// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @dev A stand-in for Pons V2's fee escrow, `0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c`.
 *
 * Written against the verified source rather than from the ABI, because the two behaviours that
 * matter to `harvest` are not visible in a function signature:
 *
 *  1. **`claimToken` REVERTS with `NoBalance` when there is nothing to claim** — it does not return
 *     zero. A harvest that called it optimistically would revert whenever fees had already been
 *     collected, which on a permissionless function is every second caller in the same block.
 *  2. **`creditToken` is permissionless and credits the balance DELTA**, so anyone may enlarge a
 *     recipient's balance and a fee-on-transfer asset credits less than the nominal amount.
 *
 * `claim`/`credit` mirror the native side, including paying out with a bare `call` — which is why
 * the staking contract needs a `receive`.
 */
contract MockPonsEscrow {
    using SafeERC20 for IERC20;

    error NoBalance();
    error InsufficientBalance(uint256 requested, uint256 available);
    error TransferFailed();

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _tokenBalances;

    function credit(address recipient) external payable {
        if (msg.value == 0) return;
        _balances[recipient] += msg.value;
    }

    function creditToken(address recipient, address token, uint256 amount) external {
        if (amount == 0) return;
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) return;
        _tokenBalances[recipient][token] += received;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function balanceOfToken(address account, address token) external view returns (uint256) {
        return _tokenBalances[account][token];
    }

    function claim() external returns (uint256 amount) {
        amount = _balances[msg.sender];
        if (amount == 0) revert NoBalance();
        _balances[msg.sender] = 0;
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        if (!sent) revert TransferFailed();
    }

    function claimToken(address token) external returns (uint256 amount) {
        amount = _tokenBalances[msg.sender][token];
        if (amount == 0) revert NoBalance();
        _tokenBalances[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}
