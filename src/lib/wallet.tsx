import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { BRAND } from '../brand'
import { ADD_CHAIN_PARAMS, CHAIN_ID_HEX } from './chain'
import {
  legacyProvider,
  providerByRdns,
  startDiscovery,
  type Eip1193Provider,
  type ProviderDetail,
  type ProviderRpcError,
} from './eip6963'

type WalletState = {
  address: string | null
  connected: boolean
  chainId: number | null
  /** Native ETH balance, refreshed on connect and on account/chain change. */
  balanceNative: number
  /** The connected wallet's name and icon, for the header. */
  wallet: { name: string; icon: string } | null
  provider: Eip1193Provider | null
  connecting: boolean
  error: string | null

  /** Opens the wallet picker. */
  openPicker: () => void
  closePicker: () => void
  pickerOpen: boolean

  /** Connects to a specific discovered provider. */
  connectTo: (detail: ProviderDetail) => Promise<void>
  disconnect: () => void
  switchChain: () => Promise<void>
}

const LAST_WALLET = 'pstake.last-wallet-rdns'

const Ctx = createContext<WalletState | null>(null)

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [balanceNative, setBalanceNative] = useState(0)
  const [wallet, setWallet] = useState<{ name: string; icon: string } | null>(null)
  const [provider, setProvider] = useState<Eip1193Provider | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => startDiscovery(), [])

  const refreshBalance = useCallback(async (p: Eip1193Provider, addr: string) => {
    try {
      const wei = (await p.request({ method: 'eth_getBalance', params: [addr, 'latest'] })) as string
      setBalanceNative(Number(BigInt(wei)) / 1e18)
    } catch {
      setBalanceNative(0)
    }
  }, [])

  /**
   * Re-read the chain the wallet is actually on.
   *
   * ⚠⚠ `eth_chainId` used to be read in exactly ONE place — `attach`, which runs only on connect.
   * After that the value could change only through a `chainChanged` event, so a wallet that does
   * not emit one (or that exposes no `.on` at all, which the listener effect silently tolerates)
   * left the app frozen on whatever chain it saw at connect time. The visible symptom was a
   * successful switch to Robinhood Chain with the "Wrong network" banner still showing, and no way
   * to clear it but a reload.
   *
   * ⚠ A failed read keeps the last known value on purpose: not being able to ask is not evidence
   * of being on a different chain, and blanking it would flash the banner off and on.
   */
  const syncChain = useCallback(async (p: Eip1193Provider) => {
    try {
      const cid = (await p.request({ method: 'eth_chainId' })) as string
      setChainId(Number(BigInt(cid)))
    } catch {
      /* keep the last known value */
    }
  }, [])

  const attach = useCallback(
    async (detail: ProviderDetail, accounts: string[]) => {
      const p = detail.provider
      const addr = accounts[0] ?? null
      setProvider(p)
      setWallet({ name: detail.info.name, icon: detail.info.icon })
      setAddress(addr)
      localStorage.setItem(LAST_WALLET, detail.info.rdns)

      // Cleared first because this may be a different wallet than the one just detached, and
      // carrying its chain over would be wrong. Null reads as "unknown" and shows no banner.
      setChainId(null)
      await syncChain(p)
      if (addr) await refreshBalance(p, addr)
    },
    [refreshBalance, syncChain],
  )

  const connectTo = useCallback(
    async (detail: ProviderDetail) => {
      setConnecting(true)
      setError(null)
      try {
        const accounts = (await detail.provider.request({ method: 'eth_requestAccounts' })) as string[]
        if (!accounts?.length) throw new Error('No accounts returned.')
        await attach(detail, accounts)
        setPickerOpen(false)
      } catch (err) {
        const e = err as ProviderRpcError
        // 4001 is the user clicking "reject" — not worth showing as an error.
        setError(e?.code === 4001 ? null : (e?.message ?? 'Could not connect.'))
      } finally {
        setConnecting(false)
      }
    },
    [attach],
  )

  const disconnect = useCallback(() => {
    localStorage.removeItem(LAST_WALLET)
    setAddress(null)
    setProvider(null)
    setWallet(null)
    setChainId(null)
    setBalanceNative(0)
  }, [])

  const switchChain = useCallback(async () => {
    if (!provider) return
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] })
    } catch (err) {
      // 4902 = the wallet does not know this chain yet, so offer to add it.
      if ((err as ProviderRpcError)?.code === 4902) {
        try {
          await provider.request({ method: 'wallet_addEthereumChain', params: [ADD_CHAIN_PARAMS] })
        } catch {
          setError(`Could not add ${BRAND.chain} to your wallet.`)
          return
        }
      }
    }
    // ⚠ Read the chain back rather than assuming the request landed. Wallets resolve
    // `wallet_switchEthereumChain` before the switch has taken effect, and some never emit
    // `chainChanged` at all — trusting either is what left the banner up after a real switch.
    await syncChain(provider)
  }, [provider, syncChain])

  /** Reconnect silently if this browser already authorised a wallet. */
  useEffect(() => {
    const rdns = localStorage.getItem(LAST_WALLET)
    if (!rdns) return
    let cancelled = false
    const t = setTimeout(async () => {
      const detail = providerByRdns(rdns) ?? (rdns === 'legacy.injected' ? legacyProvider() : null)
      if (!detail || cancelled) return
      try {
        // eth_accounts does NOT prompt — it returns only already-authorised accounts.
        const accounts = (await detail.provider.request({ method: 'eth_accounts' })) as string[]
        if (accounts?.length && !cancelled) await attach(detail, accounts)
      } catch {
        /* stay disconnected */
      }
    }, 700)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [attach])

  /** Follow account and network changes coming from the wallet itself. */
  useEffect(() => {
    if (!provider?.on) return
    const onAccounts = (...args: never[]) => {
      const accounts = args[0] as unknown as string[]
      if (!accounts?.length) return disconnect()
      setAddress(accounts[0])
      void refreshBalance(provider, accounts[0])
    }
    const onChain = (...args: never[]) => {
      const cid = args[0] as unknown as string
      setChainId(Number(BigInt(cid)))
      if (address) void refreshBalance(provider, address)
    }
    provider.on('accountsChanged', onAccounts)
    provider.on('chainChanged', onChain)
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts)
      provider.removeListener?.('chainChanged', onChain)
    }
  }, [provider, address, disconnect, refreshBalance])

  /**
   * Re-read the chain whenever this tab regains focus.
   *
   * ⭐ This is the safety net that does not depend on the wallet cooperating. A wallet is a separate
   * popup or window, so the ordinary way to change network is to leave this page, change it there,
   * and come back — and `chainChanged` is not guaranteed to arrive for that. Re-reading on focus
   * makes a stale banner correct itself instead of needing a reload.
   */
  useEffect(() => {
    if (!provider) return
    const resync = () => {
      if (document.visibilityState === 'visible') void syncChain(provider)
    }
    window.addEventListener('focus', resync)
    document.addEventListener('visibilitychange', resync)
    return () => {
      window.removeEventListener('focus', resync)
      document.removeEventListener('visibilitychange', resync)
    }
  }, [provider, syncChain])

  const value = useMemo<WalletState>(
    () => ({
      address,
      connected: address !== null,
      chainId,
      balanceNative,
      wallet,
      provider,
      connecting,
      error,
      pickerOpen,
      openPicker: () => {
        setError(null)
        setPickerOpen(true)
      },
      closePicker: () => setPickerOpen(false),
      connectTo,
      disconnect,
      switchChain,
    }),
    [address, chainId, balanceNative, wallet, provider, connecting, error, pickerOpen, connectTo, disconnect, switchChain],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWallet(): WalletState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWallet outside WalletProvider')
  return v
}

/** True when connected but pointed at the wrong network. */
export function useWrongChain(): boolean {
  const { connected, chainId } = useWallet()
  return connected && chainId !== null && chainId !== BRAND.chainId
}
