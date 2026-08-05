/**
 * Toasts — one short confirmation at a time, bottom centre.
 *
 * Deliberately minimal: no queue, no variants, no dismiss button. A toast here confirms something
 * the user just did and that they can already see the result of, so stacking them or making them
 * dismissible would add weight to a message that is gone in two seconds either way. Firing a second
 * toast replaces the first rather than queueing behind it, because the newer action is always the
 * one the user is looking at.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

type ToastContext = { show: (message: string) => void }

const Ctx = createContext<ToastContext>({ show: () => {} })

export function useToast() {
  return useContext(Ctx)
}

const DURATION = 2000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null)
  // Bumped on every show so React remounts the node and the entry animation replays even when the
  // same message fires twice in a row.
  const [seq, setSeq] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current)
    setMessage(next)
    setSeq((n) => n + 1)
    timer.current = setTimeout(() => setMessage(null), DURATION)
  }, [])

  const value = useMemo(() => ({ show }), [show])

  return (
    <Ctx.Provider value={value}>
      {children}
      {message && (
        <div className="toast-layer" role="status" aria-live="polite">
          <div className="toast" key={seq}>
            {message}
          </div>
        </div>
      )}
    </Ctx.Provider>
  )
}
