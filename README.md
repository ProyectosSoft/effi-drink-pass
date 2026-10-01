# Effi Drink Pass

Sistema **independiente** de beneficios de bebidas de la **Feria Effix 2026**: cada asistente recibe un beneficio por día elegible, lo muestra como QR y el staff lo valida y consume en la barra. Un beneficio se consume **una sola vez** y solo **en su día**.

- Propios: base de datos, autenticación, usuarios, roles, asistentes, beneficios, QR, consumos, auditoría y API.
- `effi_id` / `effi_username` son solo identificadores externos opcionales. El sistema **no se conecta a Effi** y funciona aunque Effi no exista.
- Effi (u otros sistemas) pueden integrarse más adelante como **consumidores externos** de la API `/api/v1`.

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | React 19, TypeScript, Vite 8, Tailwind CSS 4, React Query, React Router 7, PWA |
| Backend | Supabase: PostgreSQL (RLS + funciones), Auth, Edge Function `api` (Deno) |
| API | REST `/api/v1`, OpenAPI 3.1, OAuth2 client credentials / API key |
| QR | `qrcode` (generación) · `qr-scanner` (lectura con cámara) |
| Hosting | GitHub Pages (frontend) · Supabase (backend) |
| Pruebas | Vitest · PGlite (PostgreSQL embebido con las migraciones reales) · Newman |

## Inicio rápido

```bash
npm install
cp .env.example .env.local   # completar con un proyecto Supabase de desarrollo
npm run dev
```

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Typecheck + build de producción (`dist/`) |
| `npm run typecheck` | Tipos del frontend y de las Edge Functions |
| `npm test` | Pruebas unitarias, API end-to-end y PostgreSQL (no requiere Supabase ni Docker) |
| `npm run test:postman` | Ejecuta la colección Postman completa con Newman contra la API local |
| `npm run test:integration` | Concurrencia real contra un proyecto Supabase de staging (variables `E2E_*`) |
| `npm run postman` | Regenera la colección y el environment de Postman |

## Estructura

```
src/                     Frontend (páginas públicas, portal, /admin, scanner)
supabase/migrations/     Esquema completo (reconstruible)
supabase/functions/      Edge Function "api" + módulos compartidos
supabase/scripts/        Primer Super Admin, tokens demo, limpieza demo
supabase/seed.sql        Datos DEMO (solo local)
tests/                   unit · api · db · postman · integration
docs/                    Documentación, OpenAPI, Postman
.github/workflows/       CI, deploy a Pages, deploy a Supabase
```

## Documentación

Empiece por [PROJECT_STATUS.md](PROJECT_STATUS.md) (puesta en marcha paso a paso) y [docs/README.md](docs/README.md).

## Seguridad

Nunca suba `.env*`, service keys, secretos de API ni tokens. El frontend solo usa la anon/publishable key; toda escritura pasa por funciones con permisos y auditoría. Ver [docs/SECURITY.md](docs/SECURITY.md).
