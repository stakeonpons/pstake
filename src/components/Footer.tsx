import { Link } from 'react-router-dom'
import { BRAND } from '../brand'
import { Mark } from './Icons'

export default function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footer-top">
          <div className="footer-brand">
            <Link to="/" className="logo">
              <Mark size={26} />
              <span className="yellow">{BRAND.name}</span>
            </Link>
            <p>Stake pStocks on Robinhood Chain.</p>
          </div>

          <div className="footer-col">
            <h4>Protocol</h4>
            <Link to="/tokens">Tokens</Link>
            <Link to="/stake">Stake</Link>
            <Link to="/rewards">Rewards</Link>
            <Link to="/pstocks">pStocks</Link>
          </div>

          <div className="footer-col">
            <h4>Links</h4>
            <Link to="/docs">Docs</Link>
            <a href={BRAND.launchpadUrl} target="_blank" rel="noreferrer">
              {BRAND.launchpad} ↗
            </a>
            <a href="https://www.bnbchain.org" target="_blank" rel="noreferrer">
              Robinhood Chain ↗
            </a>
          </div>

          <div className="footer-col">
            <h4>Socials</h4>
            <a href={BRAND.twitter} target="_blank" rel="noreferrer">
              X ↗
            </a>
            {/* Falls back to plain text if BRAND.github is ever cleared: a link that goes nowhere
                is worse than no link. */}
            {BRAND.github ? (
              <a href={BRAND.github} target="_blank" rel="noreferrer">
                GitHub ↗
              </a>
            ) : (
              <span className="footer-soon">GitHub</span>
            )}
          </div>
        </div>

        <div className="footer-bottom">
          <span>
            © {new Date().getFullYear()} {BRAND.name}. Built on {BRAND.chain}.
          </span>
        </div>
      </div>
    </footer>
  )
}
