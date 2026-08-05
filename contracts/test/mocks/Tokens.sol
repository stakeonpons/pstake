// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev A plain token. `decimals` is settable so XAUT's 6 can be exercised alongside the usual 18.
contract MockToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @dev A token that takes a cut of every transfer.
 *
 * Pons charges its creator fee through the curve and the pool hook rather than on transfer, so a
 * launched token is not itself expected to behave this way. This exists because a pool's assets are
 * whatever the operator points it at, and it proves the contract credits what ARRIVED rather than
 * what was asked for.
 */
contract TaxedToken is ERC20 {
    uint256 public taxBps;

    constructor(uint256 taxBps_) ERC20("Taxed", "TAX") {
        taxBps = taxBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || taxBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * taxBps) / 10_000;
        super._update(from, address(0xdead), fee);
        super._update(from, to, value - fee);
    }
}

/// @dev Attempts to re-enter on receiving a reward, to prove the guard holds.
contract Reenterer {
    address public target;
    bytes public payload;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    fallback() external payable {
        if (target != address(0)) {
            (bool ok,) = target.call(payload);
            ok; // ignored: the point is that the guard stops it
        }
    }
}
