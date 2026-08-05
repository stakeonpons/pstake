import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { BRAND } from '../brand'
import { useWallet, useWrongChain } from '../lib/wallet'
import { shortAddr } from '../lib/format'
import { Mark, Menu, Wallet } from './Icons'

const LINKS = [
  { to: '/tokens', label: 'Tokens' },
  { to: '/stake', label: 'Stake' },
  { to: '/bstocks', label: 'bStocks' },
  { to: '/rewards', label: 'Rewards' },
  { to: '/launch', label: 'Launch' },
  { to: '/docs', label: 'Docs' },
]

export default function Header() {
  const { connected, address, openPicker, disconnect, switchChain } = useWallet()
  const wrongChain = useWrongChain()
  const [open, setOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const loc = useLocation()

  // Close the account menu on an outside click or Escape, so it never strands itself open.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  return (
    <>
      <header className="header">
        <div className="wrap">
          <NavLink to="/" className="logo" onClick={() => setOpen(false)}>
            <Mark />
            <span className="yellow">{BRAND.name}</span>
          </NavLink>

          <nav className="nav">
            {LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'on' : '')}>
                {l.label}
              </NavLink>
            ))}
          </nav>

          <div className="header-right">
            {/* No steady-state chain badge — it said nothing a correctly-connected user needed.
                The wrong-network button stays: without it, someone on the wrong chain just sees
                reads fail with no explanation. */}
            {wrongChain && (
              <button className="chain-pill chain-pill-wrong" onClick={switchChain}>
                Wrong network. Switch to {BRAND.chain}
              </button>
            )}
            {connected ? (
              <div className="account-menu" ref={menuRef}>
                {/* The chain, not the wallet brand: which network you are on is what actually
                    affects whether anything here works. */}
                <button
                  className="btn btn-ghost account-pill"
                  onClick={() => setMenuOpen((o) => !o)}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                >
                  {/* 20px, not 18: the cube is line-art inside a padded canvas, so it reads
                      optically smaller than the filled disc it replaces. */}
                  <img src="/bnb-64.png" width={20} height={20} alt="" className="chain-icon" />
                  <span className="mono">{shortAddr(address!)}</span>
                  <span className={`account-caret ${menuOpen ? 'open' : ''}`}>▾</span>
                </button>

                {menuOpen && (
                  <div className="account-drop" role="menu">
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        disconnect()
                      }}
                    >
                      Disconnect
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button className="btn btn-primary" onClick={openPicker}>
                <Wallet />
                Connect Wallet
              </button>
            )}
            <button className="burger" onClick={() => setOpen(!open)} aria-label="Menu">
              <Menu />
            </button>
          </div>
        </div>
      </header>

      <div className={`mobile-nav ${open ? 'open' : ''}`}>
        {LINKS.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            className={loc.pathname.startsWith(l.to) ? 'on' : ''}
            onClick={() => setOpen(false)}
          >
            {l.label}
          </NavLink>
        ))}
      </div>
    </>
  )
}
