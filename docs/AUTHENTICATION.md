# Autenticación

Effi Drink Pass tiene **sus propias cuentas** en Supabase Auth. No se usa el login de Effi en ningún caso.

## Asistentes

- Ingresan en `/login` → **“Código por email”**: reciben un código de 6 dígitos (y un enlace) en el email con el que fueron registrados/importados.
- No manejan contraseñas: el método es más simple en el celular y evita contraseñas débiles o reutilizadas.
- Al verificar el código, `on_login()` vincula la cuenta de Auth con el registro de `attendees` **solo si el email coincide y está verificado** por Supabase Auth.
- Si el email no está registrado, el portal lo informa sin revelar nada más.

## Staff (administradores, operadores…)

1. Un administrador crea el usuario en `/admin/users` (email + roles). Queda *pendiente de primer ingreso*.
2. La persona ingresa con **código por email** usando ese email; `on_login()` vincula su perfil.
3. Opcional: define una contraseña en **Mi cuenta** y desde entonces puede usar **Contraseña (staff)**.

El primer Super Admin se crea con `supabase/scripts/bootstrap_super_admin.sql` (ver [DEPLOYMENT.md](DEPLOYMENT.md)).

Desactivar un perfil (`activo = false`) retira todos sus permisos de inmediato, aunque su sesión siga abierta: los permisos se evalúan en cada llamada.

## Configuración requerida en Supabase Auth

| Ajuste | Valor |
|---|---|
| Authentication → Providers → Email | habilitado; *Confirm email* activo |
| Authentication → URL Configuration → Site URL | URL pública del frontend (p. ej. `https://drinkpass.midominio.com` o `https://<user>.github.io/<repo>/`) |
| Redirect URLs | `<SITE_URL>/login`, `<SITE_URL>/**` |
| Email Templates → **Magic Link** | Incluir el código: `Tu código es {{ .Token }}` además de `{{ .ConfirmationURL }}` |
| Email Templates → **Confirm signup** | Incluir también `{{ .Token }}` (el primer ingreso de una cuenta nueva usa esta plantilla) |
| SMTP personalizado | **Obligatorio en producción** (el SMTP por defecto de Supabase tiene límites muy bajos) |
| Rate limits (Auth) | Ajustar envío de emails/OTP según volumen de la feria |
| OTP expiry | 900 s (15 min) recomendado |

> Sin `{{ .Token }}` en las plantillas, los usuarios solo reciben el enlace (también funciona si lo abren en el mismo dispositivo).

## Sesiones

- JWT de Supabase (1 h) con refresh token rotativo, persistido por supabase-js.
- El frontend solo usa la **anon/publishable key**. `config.ts` aborta si detecta una service key.
- Cerrar sesión borra datos locales del sistema (`edp:*`, incluido el QR en caché).

## Integraciones externas

No usan cuentas de usuario. Ver [INTEGRATIONS.md](INTEGRATIONS.md): OAuth2 *client credentials* o `X-API-Key`.

## Staff en la API

Un usuario del staff puede llamar la API con su JWT de Supabase (`Authorization: Bearer <jwt>`); sus permisos actúan como scopes. Es el único modo que habilita `/v1/admin/*`.
