import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, rpc } from './supabase'
import type { Access } from './types'

/** Estado de autenticación expuesto por `useAuth()`. */
type AuthState = {
  /** true hasta que se resuelve la sesión inicial y sus permisos. */
  loading: boolean
  session: Session | null
  access: Access | null
  /**
   * Indica si el usuario tiene un permiso. Solo sirve para decidir qué mostrar en la UI:
   * la autorización efectiva la aplican RLS y las RPC en la base de datos.
   */
  can: (permission: string) => boolean
  /** Perfil de staff activo con al menos un permiso. */
  isStaff: boolean
  /** La cuenta está vinculada a un asistente (puede ver su QR). */
  isAttendee: boolean
  /** Vuelve a consultar permisos (p. ej. tras cambiar roles). */
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)
/** Clave de localStorage que recuerda el último inicio de sesión ya registrado (prefijo edp: = Effi Drink Pass). */
const LOGIN_MARK = 'edp:last-login'

/**
 * Proveedor de sesión de Supabase + permisos de la aplicación.
 * Escucha los cambios de sesión de supabase-js y carga `Access` desde la base de datos.
 */
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
    // last_sign_in_at cambia en cada login, así que recargar la página no genera un LOGIN duplicado.
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
      // Falla cerrada: si no se pueden leer los permisos, el usuario queda autenticado pero sin permisos.
      setAccess({ authenticated: true, profile: null, attendee: null, roles: [], permissions: [] })
    }
  }, [])

  useEffect(() => {
    // Evita actualizar estado si el componente se desmonta antes de que resuelva getSession().
    let active = true
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return
      setSession(data.session)
      await loadAccess(data.session)
      if (active) setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // La sesión inicial ya la maneja getSession() arriba; se ignora para no cargar permisos dos veces.
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
        // Limpia el estado local de la app (claves edp:*) para que no quede a la vista del siguiente usuario.
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

/** Acceso al estado de autenticación; debe usarse dentro de `<AuthProvider>`. */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth fuera de AuthProvider')
  return ctx
}
