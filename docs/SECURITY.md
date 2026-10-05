# Seguridad

## Resumen de controles

| Control | Implementación |
|---|---|
| HTTPS | GitHub Pages y Supabase solo sirven HTTPS (activar *Enforce HTTPS* con dominio propio). La cámara exige contexto seguro |
| Autenticación | Supabase Auth (OTP por email / password); JWT de 1 h con refresh rotativo. Las integraciones usan credenciales propias, nunca cuentas de usuario |
| RLS | Habilitado en **todas** las tablas; solo políticas SELECT. Nunca se desactiva |
| RBAC | Permisos granulares; anti-escalamiento al asignar roles **y al editar perfiles** (nadie sin `super_admin` edita un perfil con más privilegios que él); `super_admin` protegido. Catálogo de roles/permisos y `app_settings` visibles solo para el staff |
| Escrituras | Solo vía funciones `SECURITY DEFINER` con `search_path = ''`, validación y auditoría |
| Secretos | `service_role` solo en la Edge Function; `API_JWT_SECRET` como secret de Supabase; secreto HMAC de QR solo en `private.secrets`; secretos de integraciones solo como hash |
| Frontend | Solo variables `VITE_*` públicas; `config.ts` aborta si detecta una service key; CI busca claves en el bundle; **Content-Security-Policy** (solo scripts propios, conexiones solo a este origen y Supabase); redirección post-login solo a rutas internas |
| Tokens QR | HMAC-SHA256 de 256 bits, únicos, solo hash almacenado, rotables ([QR.md](QR.md)) |
| Validación de entrada | zod en la API (objetos estrictos, límites de longitud, UUID, fechas ISO; `metadata` de consumo ≤ 20 claves y ≤ 2 KB); CHECK constraints y normalización en la base |
| Sanitización | Sin HTML de usuario renderizado; CSV con neutralización de fórmulas (`=`, `+`, `-`, `@`); comodines `%`/`_` escapados en las búsquedas parciales de la API |
| CORS | Lista blanca `API_ALLOWED_ORIGINS`; sin cabeceras CORS para orígenes no listados |
| Rate limiting | En PostgreSQL por credencial/usuario y grupo de endpoints; bloqueo por IP tras 20 fallos de autenticación en 5 min; limitador en memoria para rutas públicas ([API.md](API.md)); `on_login`/`log_client_event` limitados por usuario. La IP se toma de `cf-connecting-ip` (no falsificable) antes que de `X-Forwarded-For` |
| Replay | Tokens de un solo uso (estado terminal CONSUMED); `Idempotency-Key` por actor; access tokens de 1 h con `jti` y revalidación de la credencial en cada request |
| Enumeración | IDs UUID aleatorios; QR desconocido → `INVALID_QR` sin datos; `/qr/<token>` público no consulta nada; login OTP no revela si el email existe |
| Auditoría | `audit_logs` inmutable (triggers bloquean UPDATE/DELETE/TRUNCATE); las cuentas sin rol solo pueden registrar `LOGOUT` |
| Consumos | Inmutables; imposible doble consumo (lock + UPDATE condicional + UNIQUE + máquina de estados) |
| Hora | Siempre la del servidor; override de reloj solo en pruebas |
| Webhooks | Solo HTTPS a hosts públicos con nombre (sin IPs, credenciales en la URL, `localhost` ni dominios internos); **antes de cada entrega se resuelve el DNS y se bloquea si alguna IP es privada/loopback/link-local** (anti-SSRF); errores de red genéricos en el historial; entregas solo mientras la integración tenga `consumptions:read`; sin seguir redirecciones, timeout 10 s; firma HMAC-SHA256 con timestamp; secreto por suscripción y rotable; despachador autenticado con `WEBHOOK_DISPATCHER_SECRET` guardado en Vault |
| Cabeceras API | `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Request-Id` |
| Tamaño | Cuerpos > 64 KB → 413 (también en streaming sin `Content-Length`); importación ≤ 1000 filas por lote |
| CI/CD | Actions fijadas por SHA; CLI de Supabase con versión exacta; `npm ci --ignore-scripts`; secretos por `env:` (nunca interpolados en `run:`); permisos de Pages/OIDC solo en el job de despliegue |
| Dependencias | `npm audit` sin vulnerabilidades (05/10/2026) |

## Nunca

- Exponer `SUPABASE_SERVICE_ROLE_KEY` ni secret keys (`sb_secret_…`).
- Subir `.env`, `.env.local`, tokens, passwords o environments de Postman con valores reales (`.gitignore` los excluye; use `*.local.json`).
- Agregar el esquema `private` a los esquemas expuestos por la API de Supabase.
- Poner `allow_clock_override = true` en producción.
- Desactivar RLS o crear políticas de escritura para `anon`/`authenticated`.
- Desactivar **Confirm email** en Supabase Auth ni habilitar un proveedor OAuth que no verifique emails: el staff pre-registrado se vincula por email verificado, y sin verificación cualquiera podría registrarse con el email de un miembro del staff y apropiarse de su perfil.
- Borrar auditoría o consumos.

## Respuesta a incidentes

| Situación | Acción |
|---|---|
| Captura de un QR circulando | Admin → asistente → beneficio → **Regenerar QR** |
| Credencial de integración filtrada | Admin → Integraciones → **Revocar** (efecto inmediato) y emitir otra |
| Operador comprometido | Desactivar su perfil (pierde permisos al instante) y revisar Auditoría filtrando por actor |
| `API_JWT_SECRET` filtrado | Rotar el secret en Supabase y redesplegar la función: todos los access tokens emitidos quedan inválidos |
| Secreto HMAC de QR comprometido | `update private.secrets set value = encode(extensions.gen_random_bytes(32),'hex') where name='qr_hmac_secret';` y luego recalcular hashes: `update public.benefits set token_hash = private.hash_token(private.benefit_token(id, token_salt)) where status = 'PENDING';` (los QR cambian para todos) |
| Intentos masivos de QR inválidos | Auditoría → `FAILED_REDEEM`/`VALIDATE_QR` fallidos por actor; el rate limit ya frena a 180/min |

## Mejoras recomendadas

- **Dominio propio para el frontend (prioritario).** En `https://<usuario>.github.io/<repo>/` el origen es compartido con todos los demás sitios de GitHub Pages de la misma cuenta, y la sesión de Supabase vive en `localStorage` (por origen, no por ruta): cualquier otro sitio de esa cuenta podría leerla. Ver [DEPLOYMENT.md](DEPLOYMENT.md).
- Cambiar el flujo de Auth a PKCE (`flowType: 'pkce'` en `src/lib/supabase.ts`) cuando las plantillas de email incluyan siempre `{{ .Token }}`: con PKCE el enlace mágico solo funciona en el mismo navegador que lo pidió.
- Riesgo residual de webhooks: *DNS rebinding* entre la verificación del DNS y la conexión. Requiere `integrations:manage` y no devuelve el contenido de la respuesta.

- Mover `qr_hmac_secret` a Supabase Vault (cifrado en reposo) si el plan lo permite.
- Deshabilitar el registro abierto en Auth y crear cuentas de asistentes vía invitación (hoy cualquiera puede crear una cuenta, pero sin registro asociado no ve ni puede hacer nada).
- WAF/CDN delante del dominio propio.
