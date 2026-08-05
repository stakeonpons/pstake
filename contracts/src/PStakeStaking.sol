// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @dev Pons V2's fee escrow, at `0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c` on Robinhood Chain.
 *
 *      Only the four functions this contract uses. Two matter:
 *
 *      - `claimToken` pays out to `msg.sender`, with **no restriction on being an externally owned
 *        account**. That single fact is what lets this contract be a token's `creatorFeeRecipient`
 *        and collect its own fees, with no keeper and no wallet holding stakers' money in between.
 *      - `balanceOfToken` is read before claiming because `claimToken` **reverts** on a zero
 *        balance rather than returning zero.
 */
interface IPonsV2FeeEscrow {
    function balanceOf(address account) external view returns (uint256);
    function balanceOfToken(address account, address token) external view returns (uint256);
    function claim() external returns (uint256);
    function claimToken(address token) external returns (uint256);
}

/**
 * @title PStakeStaking
 * @notice Locked staking for pStake on Pons / Robinhood Chain. One contract, many pools, two
 *         products, and fees it collects itself.
 *
 * ## The two products, and why one contract serves both
 *
 * pStake runs two reward models that look similar and are not:
 *
 *  - **A token launched through pStake.** You stake that token, and you earn its own trading fees,
 *    paid in the single pStock it is paired against.
 *  - **The pStake token itself.** You do NOT stake pStake. You stake a pStock, and you earn from
 *    the pStake token's fees.
 *
 * Both reduce to the same primitive: a pool with a stake asset, a reward asset, and rewards that
 * arrive from outside. So a pool here is just `(stakeToken, rewardToken)` and the difference lives
 * entirely in which pools get created, not in the mechanics. Nothing in this contract needs to know
 * which product a pool belongs to, which is what stops the two models drifting apart in code.
 *
 * ## ⭐ Why this contract collects its own revenue
 *
 * A launchpad that pushes fees to a fixed wallet forces a human or a keeper to move money into the
 * pools every time. Pons instead credits a **fee escrow keyed by (recipient, asset)** and lets the
 * recipient claim for itself. So this contract can be named as `creatorFeeRecipient` at launch, and
 * `harvest` — which **anybody** may call — pulls the fees out of the escrow and into the pools. Nobody has to be trusted to run anything, and no EOA
 * ever custodies fees on their way to stakers.
 *
 * ## ⚠⚠ The escrow merges tokens that share a stock, and `splits` is an ASSERTION about that
 *
 * The escrow key is `(recipient, asset)`, **not** `(recipient, token, asset)`. Pons's own comment
 * on it: *"A recipient's balance aggregates credits from every launch, curve, hook and buyback
 * release."* So when two pStake tokens are both paired against NVDA and both name this contract,
 * their fees arrive as **one indivisible NVDA balance** and the chain retains nothing that says
 * which token earned what.
 *
 * `setSplit` therefore does not *discover* the division — it **declares** one, on the operator's
 * authority, and `harvest` follows the declaration. With a single token per stock the declaration
 * is exact (one share, 100%) and this caveat is theoretical. From the second token paired against
 * the same stock onward, it is a judgement call that no amount of reading the chain can check.
 *
 * ⛔ Do not add a heuristic that infers the division from volume, supply or curve state. Every such
 * estimate drifts from the truth the moment anything is claimed or routed elsewhere, and it would
 * be paying real stakers on a guess while looking like a measurement.
 *
 * ## ⚠⚠ Principal and rewards are tracked, never inferred from balances
 *
 * `stakeToken` and `rewardToken` may be **the same asset** — staking NVDA to earn NVDA is an
 * intended configuration. If this contract ever answered "how much is reward" by subtracting
 * accounting from `balanceOf`, that arrangement would silently pay principal out as rewards.
 *
 * So `balanceOf` is never consulted for accounting. `totalStaked` and the reward accumulator are
 * maintained explicitly, and a direct transfer into this contract is invisible to it — which is the
 * intended behaviour, not an oversight. Rewards enter only through `depositRewards` and `harvest`.
 *
 * ## ⚠⚠ Amounts are measured, not assumed
 *
 * A contract that credits the amount it *asked* for rather than the amount that *arrived* would
 * over-credit every staker on a token that takes a cut of transfers, and the shortfall would
 * surface later as the last person out being unable to withdraw. Every inbound transfer here is
 * measured by balance delta, so such a token simply credits less.
 *
 * ⚠ Pons charges its creator fee through the curve and the pool hook rather than on transfer, so a
 * pStake-launched token is not itself expected to be fee-on-transfer. The measurement stays because
 * a pool's assets are whatever the operator points it at, and being right by construction costs one
 * `balanceOf`.
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
contract PStakeStaking is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* --------------------------------------------------------------------------------------- */
    /*                                        constants                                          */
    /* --------------------------------------------------------------------------------------- */

    /**
     * @dev Fixed-point scale for the reward accumulator.
     *
     *      Weights reach roughly 1e27 for a 1e9-supply 18-decimal token fully staked at the top
     *      multiplier. Scaling by 1e27 keeps per-weight quantities meaningful for reward assets as
     *      small as 6 decimals, while the largest intermediate — rewards x PRECISION — stays far
     *      below 2^256.
     */
    uint256 private constant PRECISION = 1e27;

    /// @dev Multipliers and split shares in basis points. 10_000 = 1x / 100%.
    uint256 private constant MULT_BPS = 10_000;

    /**
     * @notice Pons V2's fee escrow, the only address this contract will pull rewards from.
     * @dev Immutable and set once at construction: a settable escrow would be an owner-controlled
     *      route to make this contract call an arbitrary address, which is not a power the operator
     *      needs and not one stakers should have to trust.
     */
    IPonsV2FeeEscrow public immutable feeEscrow;

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
         * @dev Rewards credited while nothing was staked.
         *
         *      Dividing by a zero total weight is undefined, and simply reverting would make
         *      funding fail at exactly the moment a pool is new. Instead the amount is held and
         *      folded into the next credit, so it reaches the first real stakers rather than being
         *      stranded here forever.
         */
        uint256 queued;
        /**
         * @dev Smallest position this pool accepts, in stake-token units, measured after arrival.
         *
         *      ⚠⚠ This is the guard on `harvest` being permissionless. Rewards are paid on
         *      arrival, so whoever holds weight at the instant of a credit takes a full share of
         *      it — and with a public `harvest` the attacker, not the operator, picks that instant.
         *      Without a floor, one wei staked into an empty pool followed by `harvest` in the same
         *      transaction collects the entire claimable balance. A floor makes that cost real
         *      money locked for a real term, which is the same deal every honest staker takes.
         *
         *      Zero is permitted, because a pool whose reward asset has no fee route cannot be
         *      farmed this way. It should not be the default choice.
         */
        uint256 minStake;
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

    /// @dev One line of a reward asset's declared division. See the header on `splits`.
    struct Share {
        uint256 poolId;
        uint256 bps;
    }

    /* --------------------------------------------------------------------------------------- */
    /*                                          state                                            */
    /* --------------------------------------------------------------------------------------- */

    Pool[] private _pools;

    /// @notice pool id => staker => their positions.
    mapping(uint256 => mapping(address => Position[])) private _positions;

    /// @notice Lock term in days => weight multiplier in bps. Zero means the term is not offered.
    mapping(uint32 => uint256) public multiplierBps;

    /// @notice Addresses permitted to fund pools directly. Kept for funding that is not fee revenue.
    mapping(address => bool) public isDepositor;

    /// @dev Reward asset => how a harvest of it is divided between pools. See the header.
    mapping(address => Share[]) private _splits;

    /**
     * @notice Harvested amounts too small to divide, carried to the next harvest of that asset.
     * @dev Every share truncates downward so the pools can never be credited more than arrived.
     *      The few wei that leaves over are kept here and added to the next harvest rather than
     *      being stranded — the same reasoning as `Pool.queued`, one level up.
     */
    mapping(address => uint256) public residual;

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
    event Harvested(address indexed rewardToken, address indexed caller, uint256 claimed, uint256 distributed, uint256 residual);
    event SplitSet(address indexed rewardToken, uint256 shares);
    event DepositorSet(address indexed who, bool allowed);
    event TierSet(uint32 indexed termDays, uint256 multiplierBps);
    event MinStakeSet(uint256 indexed poolId, uint256 minStake);
    event StakingOpenSet(bool open);
    event NativeRescued(address indexed to, uint256 amount);

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
    error DuplicatePool();
    error AmountTooLarge();
    error BelowMinimum(uint256 minStake);
    error NoSplit();
    error BadSplit();
    error WrongRewardToken(uint256 poolId);
    error NothingToHarvest();
    error TransferFailed();

    /* --------------------------------------------------------------------------------------- */
    /*                                       construction                                        */
    /* --------------------------------------------------------------------------------------- */

    /**
     * @param owner_    The operator. Ownable2Step, so a transfer must be accepted by the new owner
     *                  and a typo cannot orphan the contract.
     * @param feeEscrow_ Pons V2's fee escrow. Passed in rather than hard-coded so the test suite can
     *                  drive a mock, and so a redeploy against a different Pons generation does not
     *                  need the source edited.
     */
    constructor(address owner_, address feeEscrow_) Ownable(owner_) {
        if (owner_ == address(0) || feeEscrow_ == address(0)) revert ZeroAddress();
        feeEscrow = IPonsV2FeeEscrow(feeEscrow_);

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

    /**
     * @param minStake The floor on a single position. Read the note on `Pool.minStake` before
     *                 passing zero — it is what stops a dust position front-running a harvest.
     */
    function createPool(address stakeToken, address rewardToken, uint256 minStake)
        external
        onlyOwner
        returns (uint256 poolId)
    {
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
                minStake: minStake,
                exists: true
            })
        );
        poolId = n;
        emit PoolCreated(poolId, stakeToken, rewardToken);
        emit MinStakeSet(poolId, minStake);
    }

    function setMinStake(uint256 poolId, uint256 minStake) external onlyOwner {
        _pool(poolId).minStake = minStake;
        emit MinStakeSet(poolId, minStake);
    }

    function setDepositor(address who, bool allowed) external onlyOwner {
        if (who == address(0)) revert ZeroAddress();
        isDepositor[who] = allowed;
        emit DepositorSet(who, allowed);
    }

    /**
     * @notice Declares how a harvest of `rewardToken` is divided between pools.
     *
     * @dev ⚠⚠ A declaration, not a measurement — see the header. What this function CAN check, it
     *      does, because each of these mistakes silently misroutes real money:
     *
     *       - every pool named must actually pay out in `rewardToken`, or a harvest would credit a
     *         pool with an asset it does not hold and its stakers' claims would drain a different
     *         pool's principal;
     *       - no pool may appear twice, since two shares against one pool reads as a bug and hides
     *         whatever the intended figure was;
     *       - the shares must total exactly 100%, so nothing is silently left behind.
     *
     *      Passing empty arrays clears the split, after which `harvest` refuses to claim at all.
     *      That is the safe direction: the fees stay in the escrow, still owed to this contract,
     *      rather than arriving with nowhere to go.
     */
    function setSplit(address rewardToken, uint256[] calldata poolIds, uint256[] calldata bps) external onlyOwner {
        if (rewardToken == address(0)) revert ZeroAddress();
        uint256 n = poolIds.length;
        if (n != bps.length) revert BadSplit();

        delete _splits[rewardToken];

        if (n == 0) {
            emit SplitSet(rewardToken, 0);
            return;
        }

        uint256 total;
        for (uint256 i; i < n; ++i) {
            Pool storage p = _pool(poolIds[i]);
            if (address(p.rewardToken) != rewardToken) revert WrongRewardToken(poolIds[i]);
            if (bps[i] == 0) revert BadSplit();

            for (uint256 j; j < i; ++j) {
                if (poolIds[j] == poolIds[i]) revert BadSplit();
            }

            total += bps[i];
            _splits[rewardToken].push(Share({poolId: poolIds[i], bps: bps[i]}));
        }
        if (total != MULT_BPS) revert BadSplit();

        emit SplitSet(rewardToken, n);
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
     * @dev The credited amount is what actually arrived, not what was requested — see the header.
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
        // Checked against what ARRIVED, so a taxed asset cannot slip under the floor.
        if (received < p.minStake) revert BelowMinimum(p.minStake);

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
                // Snapshot now, so this position earns only from rewards credited after it opened.
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
     * @notice Funds a pool from the caller's own balance.
     *
     * @dev Retained alongside `harvest` for revenue that does not arrive through Pons's escrow — a
     *      one-off top-up, or a token whose fees route somewhere else. Fee revenue itself needs
     *      nobody to call this.
     *
     *      Paid out on arrival rather than streamed, by the operator's decision: fees are
     *      distributed whenever they are available.
     *
     *      ⚠ The consequence worth knowing: because a credit lands in one block, somebody who
     *      stakes immediately before it takes a full share of fees earned while they were not
     *      staked. Only positions open at that moment are paid, so this cannot dilute anyone
     *      retroactively — but it does reward precise timing, and with `harvest` public the timing
     *      is anybody's to choose. `Pool.minStake` is what keeps that from being free; streaming
     *      over a window would remove it, and the plumbing to add that later is `queued` plus a
     *      rate, without touching the position accounting.
     */
    function depositRewards(uint256 poolId, uint256 amount) external nonReentrant {
        if (!isDepositor[msg.sender]) revert NotDepositor();
        Pool storage p = _pool(poolId);
        if (amount == 0) revert ZeroAmount();

        uint256 before = p.rewardToken.balanceOf(address(this));
        p.rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = p.rewardToken.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        _credit(poolId, received, msg.sender);
    }

    /**
     * @notice Pulls this contract's creator fees for `rewardToken` out of Pons's escrow and pays
     *         them to stakers, following the declared split.
     *
     * @dev ⭐ **Permissionless on purpose.** The money is owed to this contract and can only ever
     *      land in its own pools, so gating the call would add a trusted party without adding a
     *      protection. Stakers do not have to wait on the operator, and there is no keyed wallet in
     *      the path.
     *
     *      ⚠ Anyone may also *enlarge* what this collects: the escrow's `creditToken` is
     *      permissionless, so a third party can credit this contract at will. That is a donation to
     *      stakers of the pools in the split, which is harmless — but it does mean the harvested
     *      figure is not by itself proof of what the tokens earned.
     *
     *      The escrow reverts rather than returning zero when there is nothing to claim, so the
     *      balance is read first and a harvest with nothing behind it fails cleanly.
     */
    function harvest(address rewardToken) external nonReentrant returns (uint256 distributed) {
        Share[] storage shares = _splits[rewardToken];
        uint256 n = shares.length;
        // Refuse before touching the escrow: unclaimed fees stay owed to this contract, whereas
        // fees claimed with nowhere to send them would sit here needing an owner to intervene.
        if (n == 0) revert NoSplit();

        uint256 claimed;
        if (feeEscrow.balanceOfToken(address(this), rewardToken) != 0) {
            uint256 before = IERC20(rewardToken).balanceOf(address(this));
            feeEscrow.claimToken(rewardToken);
            // Measured, not taken from the return value: what matters is what this contract holds.
            claimed = IERC20(rewardToken).balanceOf(address(this)) - before;
        }

        uint256 distributable = claimed + residual[rewardToken];
        if (distributable == 0) revert NothingToHarvest();
        residual[rewardToken] = 0;

        for (uint256 i; i < n; ++i) {
            uint256 part = Math.mulDiv(distributable, shares[i].bps, MULT_BPS);
            if (part == 0) continue;
            distributed += part;
            _credit(shares[i].poolId, part, address(this));
        }

        // Truncation dust. Carried, never rounded up — rounding up would promise more than arrived.
        residual[rewardToken] = distributable - distributed;
        emit Harvested(rewardToken, msg.sender, claimed, distributed, residual[rewardToken]);
    }

    /**
     * @notice Pulls any native balance Pons has credited this contract out of the escrow.
     *
     * @dev Pools hold ERC-20s, so native revenue cannot be paid to stakers by this contract. It
     *      exists only because a launch paired against native, or a future hook, would credit
     *      native here — and without a way to claim it, and a `receive` for the escrow's transfer
     *      to succeed against, that money would be permanently unreachable by anyone.
     *
     *      Permissionless, like `harvest`: it only ever moves money towards this contract.
     */
    function claimNativeFees() external nonReentrant returns (uint256 amount) {
        if (feeEscrow.balanceOf(address(this)) == 0) revert NothingToHarvest();
        return feeEscrow.claim();
    }

    /**
     * @notice Sends the contract's native balance to `to`.
     *
     * @dev ⚠ Deliberately native-only. There is no ERC-20 equivalent and there must not be: every
     *      ERC-20 this contract holds is either somebody's principal or rewards already credited to
     *      a pool, so a token rescue would be a licence to take stakers' money. Native is the one
     *      asset that can never belong to a pool.
     */
    function rescueNative(address to) external onlyOwner returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = address(this).balance;
        if (amount == 0) revert ZeroAmount();
        (bool sent,) = payable(to).call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit NativeRescued(to, amount);
    }

    /// @dev Required for the escrow's native `claim` to succeed; see `claimNativeFees`.
    receive() external payable {}

    /* --------------------------------------------------------------------------------------- */
    /*                                          views                                            */
    /* --------------------------------------------------------------------------------------- */

    function poolCount() external view returns (uint256) {
        return _pools.length;
    }

    function pools(uint256 poolId)
        external
        view
        returns (
            address stakeToken,
            address rewardToken,
            uint256 totalStaked,
            uint256 totalWeight,
            uint256 queued,
            uint256 minStake
        )
    {
        Pool storage p = _pool(poolId);
        return (address(p.stakeToken), address(p.rewardToken), p.totalStaked, p.totalWeight, p.queued, p.minStake);
    }

    /// @notice The declared division of a reward asset, in order.
    function splitOf(address rewardToken) external view returns (Share[] memory) {
        return _splits[rewardToken];
    }

    /// @notice What a `harvest` of this asset would distribute right now, escrow balance included.
    function harvestable(address rewardToken) external view returns (uint256) {
        if (_splits[rewardToken].length == 0) return 0;
        return feeEscrow.balanceOfToken(address(this), rewardToken) + residual[rewardToken];
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
     * @dev Credits `amount` of already-arrived reward token to a pool.
     *
     *      Shared by `depositRewards` and `harvest` so the two funding routes cannot drift: this is
     *      the only place the accumulator moves, and neither caller transfers anything here — both
     *      have measured their inbound amount before calling.
     */
    function _credit(uint256 poolId, uint256 amount, address from) private {
        Pool storage p = _pool(poolId);
        uint256 payable_ = amount + p.queued;

        if (p.totalWeight == 0) {
            // Nobody to pay yet. Hold it for the first stakers rather than stranding it.
            p.queued = payable_;
            emit RewardsDeposited(poolId, from, amount, payable_);
            return;
        }

        p.queued = 0;
        // mulDiv, not a plain multiply: see the note on _weighted below.
        p.accPerWeight += Math.mulDiv(payable_, PRECISION, p.totalWeight);
        emit RewardsDeposited(poolId, from, amount, 0);
    }

    /**
     * @dev `weight * accPerWeight / PRECISION`, with a 512-bit intermediate.
     *
     *      ⚠⚠ A plain `weight * acc` OVERFLOWS in a case that is not exotic. `accPerWeight` grows
     *      by `credit * PRECISION / totalWeight`, so funding a pool while its total weight is tiny
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
