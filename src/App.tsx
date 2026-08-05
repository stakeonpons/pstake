import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { BRAND } from './brand'
import Header from './components/Header'
import Footer from './components/Footer'
import WalletModal from './components/WalletModal'
import Home from './pages/Home'
import Tokens from './pages/Tokens'
import TokenDetail from './pages/TokenDetail'
import Stake from './pages/Stake'
import Stocks from './pages/Stocks'
import Rewards from './pages/Rewards'
import Launch from './pages/Launch'
import Docs from './pages/Docs'
import { Empty } from './components/Ui'
import { ToastProvider } from './lib/toast'
import { Link } from 'react-router-dom'

/** Tab title per route. Home is the bare brand; everything else is "pStake - Page". */
const PAGE_TITLES: Record<string, string> = {
  '/tokens': 'Tokens',
  '/stake': 'Stake',
  '/pstocks': 'pStocks',
  '/rewards': 'Rewards',
  '/launch': 'Launch',
  '/docs': 'Docs',
}

/**
 * Route side effects: scroll to top, and set the tab title.
 *
 * The title has to be set from JS because this is a single-page app — the one in index.html is
 * only ever the first paint, so without this every route would keep showing the home title.
 */
function RouteEffects() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
    // /token/<address> is dynamic, so it is matched by prefix rather than looked up.
    const page = pathname === '/'
      ? ''
      : pathname.startsWith('/token/')
        ? 'Token'
        : (PAGE_TITLES[pathname] ?? 'Not found')
    document.title = page ? `${BRAND.name} - ${page}` : BRAND.name
  }, [pathname])
  return null
}

export default function App() {
  return (
    <ToastProvider>
    <div className="app">
      <Header />
      <WalletModal />
      <RouteEffects />
      <main style={{ flex: 1 }}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/tokens" element={<Tokens />} />
          {/* Per-token dashboard. Linked from every card on /tokens. */}
          <Route path="/token/:address" element={<TokenDetail />} />
          <Route path="/stake" element={<Stake />} />
          <Route path="/pstocks" element={<Stocks />} />
          {/* Old path kept alive so any link already shared still lands. */}
          {/* Old paths keep working: /bstocks is what this site used on BNB, and links to it exist. */}
          <Route path="/stocks" element={<Navigate to="/pstocks" replace />} />
          <Route path="/bstocks" element={<Navigate to="/pstocks" replace />} />
          <Route path="/rewards" element={<Rewards />} />
          <Route path="/launch" element={<Launch />} />
          <Route path="/docs" element={<Docs />} />
          <Route
            path="*"
            element={
              <div className="wrap page">
                <Empty
                  title="Page not found"
                  body="That route does not exist."
                  action={
                    <Link className="btn btn-primary" to="/">
                      Back home
                    </Link>
                  }
                />
              </div>
            }
          />
        </Routes>
      </main>
      <Footer />
    </div>
    </ToastProvider>
  )
}
