# Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| La app muestra “Configuración pendiente” | Faltan `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` en el build | Definir las variables del repo (o `.env.local`) y recompilar |
| Pantalla en blanco / 404 al recargar `/admin/...` en GitHub Pages | Base path incorrecto | `PAGES_BASE_PATH` debe ser `/<repo>/` (o `/` con dominio propio). Verificar que `404.html` exista en el deploy |
| El asistente solo recibe un enlace, no un código | Plantilla de email sin `{{ .Token }}` | Supabase → Auth → Email Templates (Magic Link y Confirm signup) |
| “Código inválido o expirado” | Código de un envío anterior o vencido | Pedir uno nuevo (esperar 60 s); verificar OTP expiry |
| Ingresó pero “No encontramos beneficios para tu cuenta” | El email de login no coincide con el registrado | Corregir el email del asistente en Admin → Asistentes y volver a ingresar |
| Usuario del staff ingresa pero no ve el panel | Perfil inexistente, inactivo o sin roles; o ingresó con otro email | Admin → Usuarios: crear/activar con ese email y asignar rol |
| Scanner: “Permiso de cámara denegado” | El navegador bloqueó la cámara | Ajustes del sitio → Cámara → Permitir; recargar |
| Scanner: “No se pudo iniciar la cámara” | Página sin HTTPS o navegador antiguo | Usar la URL HTTPS; actualizar navegador; usar ingreso manual |
| iPhone no emite sonido | iOS exige un gesto previo | Tocar el selector de modo o cualquier botón una vez |
| Todos los QR dan **QR NO VÁLIDO PARA HOY** | No existe/está inactivo el día de hoy, o la fecha del día está mal | Admin → Configuración: revisar el día (el reloj del servidor se muestra ahí) |
| **FUERA DE HORARIO** al abrir | `start_time` posterior a la hora actual | Ajustar horario del día |
| **DEMASIADOS INTENTOS** | > 180 validaciones/min por operador | Esperar el tiempo indicado; revisar lecturas repetidas |
| Consumo muestra *SIN CONEXIÓN* | Sin red o Supabase inaccesible | No entregar; reintentar (seguro) cuando vuelva la señal |
| API `401 INVALID_TOKEN` con un token recién emitido | `API_JWT_SECRET` cambió entre emisión y uso, o token de otro entorno | Pedir un token nuevo; verificar secrets de la función |
| API `401 CREDENTIAL_REVOKED` | La credencial fue revocada o rotada | Usar la credencial vigente |
| API `403 INSUFFICIENT_SCOPE` | La credencial no tiene el scope | Emitir credencial con el scope (dentro del techo de la integración) |
| API `403 INTEGRATION_DISABLED` | Integración desactivada | Reactivarla en Admin → Integraciones |
| API responde 401 en todo, incluso `/v1/health` | La función se desplegó con verificación JWT | Redesplegar con `--no-verify-jwt` (o `verify_jwt = false`) |
| `/v1/health` → 503 | Base de datos no disponible o migraciones no aplicadas | Revisar Supabase status y `supabase db push` |
| API 500 | Error inesperado | Buscar el `request_id` en Supabase → Edge Functions → Logs |
| Importación: “conflicto de unicidad” | Email/effi_id/usuario usado por otro asistente | Corregir el archivo o el asistente existente |
| CSV con tildes rotas en Excel | Archivo sin UTF-8 | Guardar como “CSV UTF-8”; los CSV exportados ya incluyen BOM |
| `npm test` falla en migraciones | SQL inválido en una migración nueva | El mensaje indica el archivo; las pruebas usan PostgreSQL real (PGlite) |
