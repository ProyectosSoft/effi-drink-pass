# Despliegue

| Pieza | Dónde |
|---|---|
| Frontend (estático, PWA) | GitHub Pages |
| Base de datos, Auth, RLS | Supabase (proyecto **propio** de Drink Pass) |
| API pública | Supabase Edge Function `api` |

GitHub Pages solo sirve archivos estáticos: no se ejecuta backend allí.

## 1. Supabase

1. Crear un proyecto nuevo en <https://supabase.com> (región cercana, p. ej. `us-east-1`). Guardar la contraseña de la base de datos.
2. **Migraciones** — elija una opción:
   - CLI (recomendado):
     ```bash
     npm i -g supabase            # o: npx supabase …
     supabase login
     supabase link --project-ref <REF>
     supabase db push             # aplica supabase/migrations/*
     ```
   - Sin CLI: SQL Editor → pegar y ejecutar cada archivo de `supabase/migrations/` **en orden**.
   - O GitHub Actions: workflow *Deploy Supabase* (ver sección 3).
3. Verificar: `select value from private.config where key = 'allow_clock_override';` → debe ser `false`.
4. **Auth** (ver [AUTHENTICATION.md](AUTHENTICATION.md)): Site URL, Redirect URLs, plantillas de email con `{{ .Token }}`, **SMTP propio**, rate limits.
5. **Edge Function**:
   ```bash
   supabase secrets set API_JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"
   supabase secrets set API_ALLOWED_ORIGINS="https://drinkpass.midominio.com"   # opcional (CORS de navegador)
   supabase functions deploy api --no-verify-jwt
   ```
   `--no-verify-jwt` es necesario: la API hace su propia autenticación (OAuth2/API key/JWT). `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase.
   Probar: `curl https://<REF>.supabase.co/functions/v1/api/v1/health`.
6. **Webhooks** (opcional; solo si alguna integración los usará):
   ```bash
   supabase secrets set WEBHOOK_DISPATCHER_SECRET="<48 bytes aleatorios en base64url>"
   supabase functions deploy webhooks --no-verify-jwt
   ```
   Habilitar **pg_cron** y **pg_net** (Database → Extensions) y ejecutar `supabase/scripts/schedule_webhooks.sql` con la URL y el mismo secreto. También programa `expire_benefits()` cada hora.
7. **Primer Super Admin**: editar el email en `supabase/scripts/bootstrap_super_admin.sql` y ejecutarlo en el SQL Editor. Luego esa persona entra por `/login` con código por email.

## 2. GitHub Pages (frontend)

1. Subir el repositorio a GitHub (rama `main`).
2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions → Variables**:

   | Variable | Valor |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<REF>.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | anon / publishable key (pública por diseño; protegida por RLS) |
   | `VITE_PUBLIC_APP_URL` | URL pública final (contenido del QR y redirects), p. ej. `https://<user>.github.io/<repo>` |
   | `PAGES_BASE_PATH` | Opcional. `/` con dominio propio; por defecto `/<repo>/` |

4. Push a `main` → workflow *Deploy frontend to GitHub Pages* (corre pruebas, build, verificación de secretos y publica).
5. **Dominio propio** (**obligatorio en producción**: en `<usuario>.github.io` la sesión queda expuesta a los demás sitios de Pages de la misma cuenta; p. ej. `drinkpass.feriaeffix.com`): Settings → Pages → Custom domain + HTTPS obligatorio; poner `PAGES_BASE_PATH=/` y `VITE_PUBLIC_APP_URL=https://drinkpass.feriaeffix.com`; actualizar Site URL en Supabase Auth.

> Cambiar `VITE_PUBLIC_APP_URL` después de repartir QR no rompe nada: el QR se genera al mostrarse y el scanner acepta cualquier URL `…/qr/<token>`.

`404.html` (copia de `index.html`) permite abrir rutas profundas (`/admin/scanner`, `/qr/…`) en GitHub Pages.

## 3. GitHub Actions

| Workflow | Disparo | Qué hace |
|---|---|---|
| `ci.yml` | PR y push a `main` | typecheck, pruebas (unit + API + PostgreSQL), build, búsqueda de secretos en el bundle |
| `deploy-pages.yml` | push a `main` / manual | pruebas + build + publicación en Pages |
| `deploy-supabase.yml` | **manual** | `supabase db push` + secrets + `functions deploy api` |

Secrets para `deploy-supabase.yml`: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, `API_JWT_SECRET`, `WEBHOOK_DISPATCHER_SECRET`. Variable opcional: `API_ALLOWED_ORIGINS`. Se recomienda proteger el environment `production` con aprobación manual.

## 4. Desarrollo local

```bash
npm install
cp .env.example .env.local     # completar VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (proyecto de desarrollo)
npm run dev                    # http://localhost:5173
npm test                       # no requiere Supabase ni Docker (PostgreSQL embebido)
```

Con Supabase CLI + Docker (opcional): `supabase start` levanta todo localmente y carga `supabase/seed.sql` (datos **demo**); `supabase functions serve api --no-verify-jwt --env-file supabase/functions/.env`.

La cámara requiere HTTPS o `localhost`. Para probar el scanner desde un celular en la red local use un túnel HTTPS (p. ej. `npx vite --host` + túnel) o el despliegue en Pages.

## 5. Checklist antes de la feria

- [ ] Días del evento creados con fechas y horarios oficiales (Admin → Configuración).
- [ ] Asistentes importados y días asignados; beneficios generados (Admin → Beneficios → *Generar faltantes* no crea nada nuevo).
- [ ] Datos demo desactivados (`supabase/scripts/cleanup_demo.sql`) si se cargaron.
- [ ] `allow_clock_override = false`.
- [ ] SMTP propio y plantillas con código.
- [ ] Operadores creados con rol `operator`, cada uno ya ingresó una vez.
- [ ] Prueba de punta a punta en cada dispositivo de barra (cámara, sonido, modo elegido).
- [ ] Plan de conectividad en barras (ver [OPERATIONS.md](OPERATIONS.md)).
- [ ] Credenciales de integraciones con expiración al cierre del evento.
- [ ] Backups: Supabase PITR o backups diarios habilitados en el plan contratado.
