import { Link } from 'react-router-dom'
import { BRAND, LOCK_TIERS } from '../brand'

/**
 * ⚠ Copy rules for this page, and they are not stylistic preferences:
 *
 *  - Nothing here describes any part of the product as forthcoming. Present tense throughout.
 *  - No emojis, no hashtags, no double hyphens.
 *  - No fee-recipient address for a creator to copy. Launching through Stake sets the fee route
 *    inside the launch transaction, so there is nothing to configure by hand, and an address
 *    printed here would be one somebody could get permanently wrong.
 *
 * ⚠ Accuracy note: pons PUSHES creator fees. They accumulate in the token's own tax processor and
 * are dispatched to the fee route when trading triggers it. An earlier version of this page said
 * they were claimed on a schedule, which was wrong.
 */

const TOC = [
  ['overview', 'Overview'],
  ['stocks', 'What a stock is'],
  ['tracks', 'The two reward tracks'],
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
        <p>How {BRAND.name} enables staking on Robinhood Chain.</p>
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
            {BRAND.name} is a staking layer built on {BRAND.launchpad}, the token launchpad on{' '}
            {BRAND.chain}. You lock an asset for a fixed period, and in exchange you receive a share
            of the trading fees a token generates while you are locked.
          </p>
          <p>
            What makes it different from other staking sites is the payout. It is not the token you
            staked, and it is not a chain's native coin. It is a <b>stock</b>, a tokenized US
            equity. Your share of trading volume arrives as NVIDIA, Tesla or Alphabet.
          </p>

          <h2 id="stocks">What a stock is</h2>
          <p>
            A stock is an ERC-20 token on {BRAND.chain} that represents one real share, held 1:1 by a
            regulated custodian. It gives full economic exposure to the underlying listing, including
            price, dividends and corporate actions, and it trades continuously rather than only
            during US market hours.
          </p>
          <p>
            Tickers match the underlying exactly, with no suffix: NVIDIA is <code>NVDA</code>,
            Tesla is <code>TSLA</code>, Apple is <code>AAPL</code>. Not all of them are listed
            equities: <code>SPY</code> is an index fund, and <code>SPCX</code> tracks SpaceX, which
            is private.
          </p>
          <p>
            Because a stock is an ordinary ERC-20, once claimed you can hold it, swap it on
            Uniswap, or post it as collateral without touching your stake. The full list, with
            live prices, is on the <Link to="/stocks">stocks page</Link>.
          </p>

          <h2 id="tracks">The two reward tracks</h2>
          <p>
            There are two ways to earn here. They are funded from different pots and are never mixed,
            because the source of the money, and therefore the risk, is different in each.
          </p>

          <h3>Stake a token launched through {BRAND.name}</h3>
          <p>
            Every token launched here is paired against a stock. Because the pair is denominated in
            that stock, the fees the token generates are already in it, so paying its stakers in that
            stock is the natural settlement rather than a conversion bolted on afterwards.
          </p>
          <ol>
            <li>A creator launches a token against a stock of their choosing.</li>
            <li>
              The fee route is written into the launch transaction itself, so the token is wired to
              its stakers from the moment it exists.
            </li>
            <li>
              Trading the token collects a tax. That tax accrues in the token's own processor and is
              paid out to the fee route, denominated in the stock the token is paired against.
            </li>
            <li>
              Everything a token generates goes to that token's own pool. Pools never mix, so a pool
              only ever pays out its own stock.
            </li>
          </ol>

          <h3>Stake a stock</h3>
          <p>
            The second track is funded by the {BRAND.name} token itself. You stake any stock, and you
            earn from the fees the {BRAND.name} token generates. The {BRAND.name} token is not staked:
            holding stocks is what earns from it.
          </p>
          <p>
            This is why the two tracks stay separate. One is funded by a single token's own volume and
            pays in one stock. The other is funded by {BRAND.name}'s volume and pays across stocks.
          </p>

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
            Locks cannot be broken early, and there is no exit penalty, because a penalty is an early
            exit with extra steps and the multiplier only means something if the commitment is real.
            Your tokens become withdrawable the moment the lock expires. Rewards already accrued stay
            claimable throughout, including during the lock, and expiry forfeits nothing.
          </p>

          <h2 id="rewards">How rewards are calculated</h2>
          <p>For each distribution, your share of a pool is:</p>
          <p>
            <code>your weight = amount staked, adjusted for lock duration</code>
            <br />
            <code>your share = your weight ÷ total pool weight</code>
          </p>
          <p>
            Rewards accrue continuously and are claimed on demand, so there is no epoch to wait for
            and nothing expires. Only positions open at the moment fees arrive share in them, so a
            stake opened later never dilutes anyone retroactively.
          </p>
          <p>
            Rewards are a description of what trading actually did, never a promise about what comes
            next. If a token stops trading, its rewards stop with it.
          </p>

          <h2 id="creators">For creators</h2>
          <p>
            Anyone can plug a token in. Launch through {BRAND.name} against a stock quote asset and
            the fee route is set inside the launch transaction itself, so there is no address to copy
            and nothing to configure afterwards. The full walkthrough is on the{' '}
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
            {/*
              ⚠ This once described a 2% buy tax and a 2% sell tax. Pons has no transfer tax at
              all: it charges one creator rate through the curve and the pool hook, so a "buy tax
              and sell tax" claim here would describe a mechanism the contract does not have.
            */}
            <li>
              <b>Creator fee:</b> a token launched here charges 2% on its trading, taken by {' '}
              {BRAND.launchpad} as it trades rather than on transfer. That fee is the entire reward
              pot, and it is what funds the people staking the paired stock.
            </li>
            <li>
              <b>Protocol cut:</b> {BRAND.protocolFeeBps / 100}% of collected fees, taken before
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
              <b>Rewards can be zero.</b> They are entirely a function of trading volume. A pool with
              no volume pays nothing, however long you lock.
            </li>
            <li>
              <b>Locks are irreversible.</b> If the token you staked falls 80% during a 30 day lock,
              you cannot exit. Size accordingly.
            </li>
            <li>
              <b>Tokenized equity is not brokerage equity.</b> You get economic exposure, not
              registered ownership or voting rights, and you take on custody and issuer risk.
            </li>
            <li>
              <b>Smart contract risk.</b> Staking contracts hold your tokens for the duration of the
              lock.
            </li>
            <li>
              <b>A token's settings are permanent.</b> The tax rates and the fee route of a launched
              token are fixed when it is created, and nobody can change them afterwards.
            </li>
          </ul>
        </article>
      </div>
    </div>
  )
}
