import { Link } from 'react-router-dom'
import { BRAND, LOCK_TIERS } from '../brand'

const TOC = [
  ['overview', 'Overview'],
  ['bstocks', 'What a bStock is'],
  ['pools', 'How a pool works'],
  ['locking', 'Locking'],
  ['rewards', 'How rewards are calculated'],
  ['creators', 'For creators'],
  ['fees', 'Fees'],
  ['risks', 'Risks'],
] as const

export default function Docs() {
  return (
    <div className="wrap page">
      <div className="page-head page-head-center">
        <h1>Docs</h1>
        <p>How {BRAND.name} enables staking on Binance Smart Chain.</p>
      </div>

      <div className="doc-layout">
        <nav className="doc-toc">
          {TOC.map(([id, label]) => (
            <a href={`#${id}`} key={id}>
              {label}
            </a>
          ))}
        </nav>

        <article className="doc">
          <h2 id="overview">Overview</h2>
          <p>
            {BRAND.name} is a staking layer for tokens launched on {BRAND.launchpad}, the token
            launchpad on {BRAND.chain}. Holders lock a token for a fixed period; in exchange they
            receive a share of the creator fees that token generates while they are locked.
          </p>
          <p>
            The part that makes it different from every other staking site: the payout is not the
            token you staked, and it is not a chain's native coin. It is a <b>bStock</b>, a tokenized
            US equity. You lock a volatile meme and you are paid in NVIDIA, Tesla or Microsoft.
          </p>

          <h2 id="bstocks">What a bStock is</h2>
          <p>
            A bStock is a BEP-20 token on {BRAND.chain} that represents one real share, held 1:1 by a
            regulated custodian. It gives full economic exposure to the underlying listing,
            including price, dividends and corporate actions, and trades continuously rather than
            only during US market hours.
          </p>
          <p>
            Tickers follow the underlying with a <code>B</code> suffix: NVIDIA is <code>NVDAB</code>,
            Tesla is <code>TSLAB</code>, Microsoft is <code>MSFTB</code>. Because a bStock is a normal
            BEP-20, once claimed you can hold it, swap it on PancakeSwap, or post it as collateral on
            lending markets without touching your stake.
          </p>

          <h2 id="pools">How a pool works</h2>
          <p>
            On {BRAND.launchpad}, every token is launched against a <b>quote asset</b>, which is the
            asset it trades against. When a creator picks a bStock as the quote asset, the fees that token
            generates are denominated in that stock. That is the mechanism {BRAND.name} sits on top of.
          </p>
          <ol>
            <li>A creator launches a token against a bStock quote asset.</li>
            <li>
              They route the token's creator-fee share to the {BRAND.name} fee wallet. Creator fees on{' '}
              {BRAND.launchpad} accrue to the token and are <em>claimed</em>, not pushed, so we claim
              on a schedule.
            </li>
            <li>
              Everything claimed for that token, minus the protocol cut, goes into that pool's reward
              pot. Pots never mix, so a pool only ever pays out its own stock.
            </li>
            <li>The pot is split across everyone with an open lock, by weight.</li>
          </ol>

          <h2 id="locking">Locking</h2>
          <p>
            When you stake you choose one of the available lock durations. Reward weight increases
            with longer lock durations, multipliers are calculated automatically by the yield
            calculator.
          </p>
          <ul>
            {LOCK_TIERS.map((t) => (
              <li key={t.days}>
                <b>
                  {t.days} {t.days === 1 ? 'day' : 'days'}
                </b>
              </li>
            ))}
          </ul>
          <p>
            Weighting does not mint anything extra. The pot is fixed by trading volume, and weight
            only decides how it is divided, so a longer lock earns more at a shorter lock's expense
            rather than from new supply.
          </p>
          <p>
            Locks cannot be broken early. Your tokens become withdrawable the moment the lock expires,
            and rewards already accrued stay claimable indefinitely; expiry does not forfeit anything.
          </p>

          <h2 id="rewards">How rewards are calculated</h2>
          <p>For each distribution, your share of a pool is:</p>
          <p>
            <code>your weight = amount staked, adjusted for lock duration</code>
            <br />
            <code>your share = your weight ÷ total pool weight</code>
          </p>
          <p>
            That share of the claimed fees is used to acquire the pool's bStock, credited to you as a
            fractional share balance. Rewards accrue continuously and are claimed on demand, so there
            is no epoch to wait for and nothing expires.
          </p>
          <p>
            Rewards are a description of what trading actually did, never a promise about what comes
            next. If a token stops trading, its rewards stop with it.
          </p>

          {/* ⛔ Do not put a fee-recipient address here for creators to copy.
              This block used to print `BRAND.feeWallet` next to "set your creator-fee recipient
              to:" — and that value is the zero address, so anyone following it would have burned
              their fee stream permanently. The instruction is obsolete regardless: launching
              through bStake sets the beneficiary inside the launch transaction, so there is
              nothing for a creator to copy or configure. See LAUNCH_POLICY in lib/flap.ts. */}
          <h2 id="creators">For creators</h2>
          <p>
            Anyone can plug a token in. Launch through {BRAND.name} against a bStock quote asset and
            the fee route is set inside the launch transaction itself, so there is no address to
            copy and nothing to configure afterwards. The full walkthrough is on the{' '}
            <Link to="/launch">Launch page</Link>.
          </p>

          <h3>Why bother</h3>
          <p>
            Locked supply cannot be sold, and holders being paid in equity have a reason to keep
            rolling the lock instead of rotating out. Your volume becomes your holders' brokerage
            account, which is a considerably better retention story than an emissions schedule.
          </p>

          <h2 id="fees">Fees</h2>
          <ul>
            <li>
              <b>Protocol cut:</b> {BRAND.protocolFeeBps / 100}% of claimed creator fees, taken before
              distribution.
            </li>
            <li>
              <b>Staking, unstaking, claiming:</b> no protocol fee. You pay {BRAND.chain} gas, which is
              typically well under a cent.
            </li>
            <li>
              <b>Listing:</b> free.
            </li>
          </ul>

          <h2 id="risks">Risks</h2>
          <p>Read this part.</p>
          <ul>
            <li>
              <b>Rewards can be zero.</b> They are entirely a function of trading volume. A pool with no
              volume pays nothing, however long you lock.
            </li>
            <li>
              <b>Locks are irreversible.</b> If the token you staked falls 80% during a 30-day lock,
              you cannot exit. Size accordingly.
            </li>
            <li>
              <b>Tokenized equity is not brokerage equity.</b> You get economic exposure, not
              registered ownership or voting rights, and you take on custody and issuer risk.
            </li>
            <li>
              <b>Smart-contract risk.</b> Staking contracts hold your tokens for the duration of the
              lock.
            </li>
            <li>
              <b>Jurisdiction.</b> Tokenized equities are not available everywhere. Check your own
              eligibility.
            </li>
          </ul>
          <p>
            None of this is investment advice. {BRAND.name} is not affiliated with Binance, BNB Chain or{' '}
            {BRAND.launchpad}.
          </p>
        </article>
      </div>
    </div>
  )
}
