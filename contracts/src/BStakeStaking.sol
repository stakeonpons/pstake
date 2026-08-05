// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title BStakeStaking
 * @notice Locked staking for bStake. One contract, many pools, two products.
 *
 * ## The two products, and why one contract serves both
 *
 * bStake runs two reward models that look similar and are not:
 *
 *  - **A token launched through bStake.** You stake that token, and you earn its own trading fees,
 *    paid in the single bStock it is paired against.
 *  - **The bStake token itself.** You do NOT stake bStake. You stake a bStock, and you earn from
 *    the bStake token's fees.
 *
 * Both reduce to the same primitive: a pool with a stake asset, a reward asset, and rewards that
 * arrive from outside. So a pool here is just `(stakeToken, rewardToken)` and the difference lives
 * entirely in which pools get created, not in the mechanics. Nothing in this contract needs to know
 * which product a pool belongs to, which is what stops the two models drifting apart in code.
 *
 * ## ⚠⚠ Principal and rewards are tracked, never inferred from balances
 *
 * `stakeToken` and `rewardToken` may be **the same asset** — staking NVDAB to earn NVDAB is an
 * intended configuration. If this contract ever answered "how much is reward" by subtracting
 * accounting from `balanceOf`, that arrangement would silently pay principal out as rewards.
 *
 * So `balanceOf` is never consulted for accounting. `totalStaked` and the reward accumulator are
 * maintained explicitly, and a direct transfer into this contract is invisible to it — which is the
 * intended behaviour, not an oversight. Rewards enter only through `depositRewards`.
 *
 * ## ⚠⚠ Amounts are measured, not assumed
 *
 * bStake-launched tokens carry a transfer tax. A contract that credits the amount it *asked* for
 * rather than the amount that *arrived* would over-credit every staker on a taxed token, and the
 * shortfall would surface later as the last person out being unable to withdraw. Every inbound
 * transfer here is measured by balance delta, so a taxed token simply credits less.
 *
 * ## Locks
 *
 * A stake is locked for a chosen term and earns a weight multiplier for it. Rewards accrue on
 * weight, continuously, and can be claimed at any time including during the lock. Principal cannot
 * be withdrawn before the term expires — there is no early exit and no penalty path, because a
 * penalty is an early exit with extra steps and the multiplier is only meaningful if the commitment
 * is real.
 *
 * ⚠ Multiplier values are deliberately never published in the UI. They are on chain and therefore
 * public; treat them as such.
 */
contract BStakeStaking is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* --------------------------------------------------------------------------------------- */
    /*                                        constants                                          */
    /* --------------------------------------------------------------------------------------- */

    /**
     * @dev Fixed-point scale for the reward accumulator.
     *
     *      Weights reach roughly 1e27 for a 1e9-supply 18-decimal token fully staked at the top
     *      multiplier. Scaling by 1e27 keeps per-weight quantities meaningful for reward assets as
     *      small as XAUT's 6 decimals, while the largest intermediate — rewards x PRECISION —
     *      stays far below 2^256.
     */
    uint256 private constant PRECISION = 1e27;

    /// @dev Multipliers in basis points. 10_000 = 1x.
    uint256 private constant MULT_BPS = 10_000;

    /* --------------------------------------------------------------------------------------- */
    /*                                          types                                            */
    /* --------------------------------------------------------------------------------------- */

    struct Pool {
        IERC20 stakeToken;
        IERC20 rewardToken;
        /// @dev Sum of `amount x multiplier`, not of amounts. Rewards divide by this.
        uint256 totalWeight;
        /// @dev Principal held for stakers. Never derived from `balanceOf`; see the header.
        uint256 totalStaked;
        /// @dev PRECISION-scaled rewards per unit of weight, monotonically increasing.
        uint256 accPerWeight;
        /**
         * @dev Rewards deposited while nothing was staked.
         *
         *      Dividing by a zero total weight is undefined, and simply reverting would make the
         *      fee wallet's deposits fail at exactly the moment a pool is new. Instead the amount
         *      is held and folded into the next deposit, so it reaches the first real stakers
         *      rather than being stranded here forever.
         */
        uint256 queued;
        bool exists;
    }

    struct Position {
        uint128 amount;
        uint128 weight;
        uint64 unlockAt;
        uint32 tierDays;
        bool withdrawn;
        /// @dev PRECISION-scaled accumulator snapshot; the classic reward-debt pattern.
        uint256 rewardDebt;
    }

    /* --------------------------------------------------------------------------------------- */
    /*                                          state                                            */
    /* --------------------------------------------------------------------------------------- */

    Pool[] private _pools;

    /// @notice pool id => staker => their positions.
    mapping(uint256 => mapping(address => Position[])) private _positions;

    /// @notice Lock term in days => weight multiplier in bps. Zero means the term is not offered.
    mapping(uint32 => uint256) public multiplierBps;

    /// @notice Addresses permitted to fund pools. The fee wallet, and any keeper acting for it.
    mapping(address => bool) public isDepositor;

    /**
     * @notice Whether staking is open.
     * @dev Deposits, claims and withdrawals are unaffected by this — switching it off must never
     *      trap somebody's principal or strand rewards they have already earned. It only stops new
     *      positions being opened.
     */
    bool public stakingOpen;

    /* --------------------------------------------------------------------------------------- */
    /*                                          events                                           */
    /* --------------------------------------------------------------------------------------- */

    event PoolCreated(uint256 indexed poolId, address indexed stakeToken, address indexed rewardToken);
    event Staked(uint256 indexed poolId, address indexed user, uint256 positionId, uint256 amount, uint256 weight, uint64 unlockAt);
    event Withdrawn(uint256 indexed poolId, address indexed user, uint256 positionId, uint256 amount);
    event Claimed(uint256 indexed poolId, address indexed user, uint256 positionId, uint256 amount);
    event RewardsDeposited(uint256 indexed poolId, address indexed from, uint256 amount, uint256 queued);
    event DepositorSet(address indexed who, bool allowed);
    event TierSet(uint32 indexed termDays, uint256 multiplierBps);
    event StakingOpenSet(bool open);

    /* --------------------------------------------------------------------------------------- */
    /*                                          errors                                           */
    /* --------------------------------------------------------------------------------------- */

    error NoSuchPool();
    error NoSuchPosition();
    error ZeroAddress();
    error ZeroAmount();
    error UnknownTerm();
    error StakingClosed();
    error StillLocked(uint64 unlockAt);
    error AlreadyWithdrawn();
    error NotDepositor();
    error NothingStaked();
    error DuplicatePool();
    error AmountTooLarge();

    /* --------------------------------------------------------------------------------------- */
    /*                                       construction                                        */
    /* --------------------------------------------------------------------------------------- */

    /**
     * @param owner_ The operator. Ownable2Step, so a transfer must be accepted by the new owner
     *               and a typo cannot orphan the contract.
     */
    constructor(address owner_) Ownable(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();

        // The published ladder. Longer commitment, larger share of the same pot.
        multiplierBps[1] = 10_000;
        multiplierBps[3] = 12_500;
        multiplierBps[7] = 15_000;
        multiplierBps[14] = 20_000;
        multiplierBps[21] = 25_000;
        multiplierBps[30] = 30_000;
    }

    /* --------------------------------------------------------------------------------------- */
    /*                                       administration                                      */
    /* --------------------------------------------------------------------------------------- */

    function createPool(address stakeToken, address rewardToken) external onlyOwner returns (uint256 poolId) {
        if (stakeToken == address(0) || rewardToken == address(0)) revert ZeroAddress();

        uint256 n = _pools.length;
        for (uint256 i; i < n; ++i) {
            if (address(_pools[i].stakeToken) == stakeToken && address(_pools[i].rewardToken) == rewardToken) {
                revert DuplicatePool();
            }
        }

        _pools.push(
            Pool({
                stakeToken: IERC20(stakeToken),
                rewardToken: IERC20(rewardToken),
                totalWeight: 0,
                totalStaked: 0,
                accPerWeight: 0,
                queued: 0,
                exists: true
            })
        );
        poolId = n;
        emit PoolCreated(poolId, stakeToken, rewardToken);
    }

    function setDepositor(address who, bool allowed) external onlyOwner {
        if (who == address(0)) revert ZeroAddress();
        isDepositor[who] = allowed;
        emit DepositorSet(who, allowed);
    }

    /**
     * @notice Adds or retires a lock term.
     * @dev Setting a term to zero stops it being offered to new stakers. Positions already open on
     *      that term keep the weight they were given, because their multiplier was the consideration
     *      for a commitment they cannot exit.
     */
    function setTier(uint32 termDays, uint256 bps) external onlyOwner {
        if (termDays == 0) revert UnknownTerm();
        multiplierBps[termDays] = bps;
        emit TierSet(termDays, bps);
    }

    function setStakingOpen(bool open) external onlyOwner {
        stakingOpen = open;
        emit StakingOpenSet(open);
    }

    /* --------------------------------------------------------------------------------------- */
    /*                                         staking                                           */
    /* --------------------------------------------------------------------------------------- */

    /**
     * @notice Locks `amount` of a pool's stake token for `termDays`.
     * @dev The credited amount is what actually arrived, not what was requested — see the header on
     *      taxed tokens.
     */
    function stake(uint256 poolId, uint256 amount, uint32 termDays)
        external
        nonReentrant
        returns (uint256 positionId)
    {
        if (!stakingOpen) revert StakingClosed();
        Pool storage p = _pool(poolId);
        if (amount == 0) revert ZeroAmount();

        uint256 bps = multiplierBps[termDays];
        if (bps == 0) revert UnknownTerm();

        uint256 before = p.stakeToken.balanceOf(address(this));
        p.stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = p.stakeToken.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        uint256 weight = (received * bps) / MULT_BPS;
        if (weight == 0) revert ZeroAmount();

        p.totalStaked += received;
        p.totalWeight += weight;

        positionId = _positions[poolId][msg.sender].length;
        uint64 unlockAt = uint64(block.timestamp + uint256(termDays) * 1 days);

        _positions[poolId][msg.sender].push(
            Position({
                amount: _u128(received),
                weight: _u128(weight),
                unlockAt: unlockAt,
                tierDays: termDays,
                withdrawn: false,
                // Snapshot now, so this position earns only from rewards deposited after it opened.
                rewardDebt: _weighted(weight, p.accPerWeight)
            })
        );

        emit Staked(poolId, msg.sender, positionId, received, weight, unlockAt);
    }

    /// @notice Claims everything a position has earned so far. Allowed during the lock.
    function claim(uint256 poolId, uint256 positionId) external nonReentrant returns (uint256 paid) {
        return _claim(poolId, positionId, msg.sender);
    }

    /// @notice Claims across several of the caller's positions in one transaction.
    function claimMany(uint256 poolId, uint256[] calldata positionIds) external nonReentrant returns (uint256 paid) {
        uint256 n = positionIds.length;
        for (uint256 i; i < n; ++i) {
            paid += _claim(poolId, positionIds[i], msg.sender);
        }
    }

    /**
     * @notice Returns principal once the lock has expired, claiming any rewards with it.
     * @dev There is deliberately no early withdrawal, with or without penalty.
     */
    function withdraw(uint256 poolId, uint256 positionId) external nonReentrant returns (uint256 amount, uint256 rewards) {
        Pool storage p = _pool(poolId);
        Position storage pos = _position(poolId, msg.sender, positionId);

        if (pos.withdrawn) revert AlreadyWithdrawn();
        if (block.timestamp < pos.unlockAt) revert StillLocked(pos.unlockAt);

        rewards = _claim(poolId, positionId, msg.sender);

        amount = pos.amount;
        pos.withdrawn = true;

        // Weight leaves the pool, so remaining stakers' share of future rewards rises.
        p.totalWeight -= pos.weight;
        p.totalStaked -= amount;

        p.stakeToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(poolId, msg.sender, positionId, amount);
    }

    /* --------------------------------------------------------------------------------------- */
    /*                                         rewards                                           */
    /* --------------------------------------------------------------------------------------- */

    /**
     * @notice Funds a pool. Distributed to current stakers immediately, in proportion to weight.
     *
     * @dev Paid out on arrival rather than streamed, by the operator's decision: fees are
     *      distributed whenever they land in the fee wallet.
     *
     *      ⚠ The consequence worth knowing: because a deposit lands in one block, somebody who
     *      stakes immediately before it takes a full share of fees earned while they were not
     *      staked. Only positions open at the moment of deposit are paid, so this cannot dilute
     *      anyone retroactively — but it does reward precise timing. Depositing in irregular,
     *      smaller amounts blunts it; streaming over a window would remove it, and the plumbing to
     *      add that later is `queued` plus a rate, without touching the position accounting.
     */
    function depositRewards(uint256 poolId, uint256 amount) external nonReentrant {
        if (!isDepositor[msg.sender]) revert NotDepositor();
        Pool storage p = _pool(poolId);
        if (amount == 0) revert ZeroAmount();

        uint256 before = p.rewardToken.balanceOf(address(this));
        p.rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = p.rewardToken.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        uint256 payable_ = received + p.queued;

        if (p.totalWeight == 0) {
            // Nobody to pay yet. Hold it for the first stakers rather than stranding it.
            p.queued = payable_;
            emit RewardsDeposited(poolId, msg.sender, received, payable_);
            return;
        }

        p.queued = 0;
        // mulDiv, not a plain multiply: see the note on _weighted below.
        p.accPerWeight += Math.mulDiv(payable_, PRECISION, p.totalWeight);
        emit RewardsDeposited(poolId, msg.sender, received, 0);
    }

    /* --------------------------------------------------------------------------------------- */
    /*                                          views                                            */
    /* --------------------------------------------------------------------------------------- */

    function poolCount() external view returns (uint256) {
        return _pools.length;
    }

    function pools(uint256 poolId)
        external
        view
        returns (address stakeToken, address rewardToken, uint256 totalStaked, uint256 totalWeight, uint256 queued)
    {
        Pool storage p = _pool(poolId);
        return (address(p.stakeToken), address(p.rewardToken), p.totalStaked, p.totalWeight, p.queued);
    }

    function positionCount(uint256 poolId, address user) external view returns (uint256) {
        return _positions[poolId][user].length;
    }

    function positions(uint256 poolId, address user, uint256 positionId)
        external
        view
        returns (uint256 amount, uint256 weight, uint64 unlockAt, uint32 tierDays, bool withdrawn, uint256 pending)
    {
        Position storage pos = _position(poolId, user, positionId);
        return (pos.amount, pos.weight, pos.unlockAt, pos.tierDays, pos.withdrawn, _pending(poolId, pos));
    }

    /// @notice Rewards a position can claim right now.
    function pending(uint256 poolId, address user, uint256 positionId) external view returns (uint256) {
        return _pending(poolId, _position(poolId, user, positionId));
    }

    /* --------------------------------------------------------------------------------------- */
    /*                                         internals                                         */
    /* --------------------------------------------------------------------------------------- */

    /**
     * @dev `weight * accPerWeight / PRECISION`, with a 512-bit intermediate.
     *
     *      ⚠⚠ A plain `weight * acc` OVERFLOWS in a case that is not exotic. `accPerWeight` grows
     *      by `deposit * PRECISION / totalWeight`, so funding a pool while its total weight is tiny
     *      — a single dust position, or the moment after everyone has withdrawn — inflates the
     *      accumulator enormously. A normal-sized position multiplied by that inflated accumulator
     *      exceeds 2^256 and reverts.
     *
     *      That revert is not a failed transaction, it is a bricked pool: the multiplication sits
     *      inside `_pending`, which `stake`, `claim` and `withdraw` all reach, so nobody can enter
     *      and — for anyone already in — nobody can leave. Both cases are covered in
     *      `test/Adversarial.t.sol`.
     *
     *      `Math.mulDiv` carries the full 512-bit product and only the final quotient must fit in
     *      256 bits, which it always does because the quotient is a token amount.
     */
    function _weighted(uint256 weight, uint256 acc) private pure returns (uint256) {
        return Math.mulDiv(weight, acc, PRECISION);
    }

    /**
     * @dev Narrows to uint128, reverting rather than truncating.
     *
     *      A silent truncation here would not be a rounding error: it would record a fraction of
     *      somebody's principal and lose the rest, with no way to tell afterwards. The ceiling is
     *      ~3.4e38, far above any plausible stake of an 18-decimal token, so this should never
     *      fire — which is exactly why it must revert if it ever does.
     */
    function _u128(uint256 v) private pure returns (uint128) {
        if (v > type(uint128).max) revert AmountTooLarge();
        return uint128(v);
    }

    function _pool(uint256 poolId) private view returns (Pool storage p) {
        if (poolId >= _pools.length) revert NoSuchPool();
        p = _pools[poolId];
        if (!p.exists) revert NoSuchPool();
    }

    function _position(uint256 poolId, address user, uint256 positionId) private view returns (Position storage) {
        if (positionId >= _positions[poolId][user].length) revert NoSuchPosition();
        return _positions[poolId][user][positionId];
    }

    function _pending(uint256 poolId, Position storage pos) private view returns (uint256) {
        if (pos.withdrawn) return 0;
        uint256 acc = _pools[poolId].accPerWeight;
        uint256 earned = _weighted(pos.weight, acc);
        // Defensive: the accumulator only ever rises, so this cannot underflow in practice.
        return earned > pos.rewardDebt ? earned - pos.rewardDebt : 0;
    }

    function _claim(uint256 poolId, uint256 positionId, address user) private returns (uint256 paid) {
        Pool storage p = _pool(poolId);
        Position storage pos = _position(poolId, user, positionId);

        paid = _pending(poolId, pos);
        // Settle the debt even when nothing is owed, so a withdrawn position stops accruing.
        pos.rewardDebt = _weighted(pos.weight, p.accPerWeight);
        if (paid == 0) return 0;

        p.rewardToken.safeTransfer(user, paid);
        emit Claimed(poolId, user, positionId, paid);
    }
}
