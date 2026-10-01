import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, rpc } from './supabase'
import type { Access } from './types'

type AuthState = {
  loading: boolean
  session: Session | null
  access: Access | null
  can: (permission: string) => boolean
  isStaff: boolean
  isAttendee: boolean
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)
const LOGIN_MARK = 'edp:last-login'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [access, setAccess] = useState<Access | null>(null)
  const [loading, setLoading] = useState(true)

  const loadAccess = useCallback(async (s: Session | null) => {
    if (!s) {
      setAccess(null)
      return
    }
    // on_login (vincula cuenta por email verificado + audita LOGIN) solo una vez por inicio de sesión real.
    const mark = `${s.user.id}:${s.user.last_sign_in_at ?? ''}`
    let alreadyLogged = false
    try {
      alreadyLogged = localStorage.getItem(LOGIN_MARK) === mark
    } catch {
      /* almacenamiento no disponible */
    }
    try {
      const a = await rpc<Access>(alreadyLogged ? 'my_access' : 'on_login')
      if (!alreadyLogged) {
        try {
          localStorage.setItem(LOGIN_MARK, mark)
        } catch {
          /* ignorar */
        }
      }
      setAccess(a)
    } catch {
      setAccess({ authenticated: true, profile: null, attendee: null, roles: [], permissions: [] })
    }
  }, [])

  useEffect(() => {
    let active = true
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return
      setSession(data.session)
      await loadAccess(data.session)
      if (active) setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'INITIAL_SESSION') return
      setSession(s)
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        // Diferido: no llamar a Supabase dentro del callback (recomendación de supabase-js).
        setTimeout(() => void loadAccess(s), 0)
      }
    })
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [loadAccess])

  const value = useMemo<AuthState>(() => {
    const perms = new Set(access?.permissions ?? [])
    return {
      loading,
      session,
      access,
      can: (p) => perms.has(p),
      isStaff: Boolean(access?.profile?.activo) && perms.size > 0,
      isAttendee: Boolean(access?.attendee),
      refresh: () => loadAccess(session),
      signOut: async () => {
        try {
          await rpc('log_client_event', { p_action: 'LOGOUT', p_metadata: {} })
        } catch {
          /* no bloquear el cierre de sesión */
        }
        try {
          for (const k of Object.keys(localStorage)) if (k.startsWith('edp:')) localStorage.removeItem(k)
        } catch {
          /* ignorar */
        }
        await supabase.auth.signOut()
        setAccess(null)
      },
    }
  }, [loading, session, access, loadAccess])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth fuera de AuthProvider')
  return ctx
}
