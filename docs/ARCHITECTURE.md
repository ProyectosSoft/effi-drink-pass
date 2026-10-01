# Arquitectura

## Principio rector

Effi Drink Pass es **tecnológicamente independiente de Effi**. Tiene su propia base de datos, autenticación, usuarios, roles, asistentes, beneficios, QR, consumos, auditoría y API. `effi_id` y `effi_username` son solo **identificadores externos opcionales** guardados en este sistema.

El sistema opera durante toda la feria aunque Effi esté caído, no exista o nunca se conecte. Si Effi (u otro sistema) quiere integrarse, lo hace como **consumidor externo** de la API documentada, con credenciales propias y scopes mínimos.

```
                         ┌────────────────────────────────────────────┐
  Asistente / Staff      │  Frontend PWA (React + TS + Vite)          │   GitHub Pages
  (navegador, móvil) ───►│  portal · scanner · administración         │   (estático)
                         └──────────────┬─────────────────────────────┘
                                        │ supabase-js (anon key + JWT del usuario)
                                        ▼
                         ┌────────────────────────────────────────────┐
                         │  Supabase                                  │
                         │  ├─ Auth (OTP por email / password)        │
                         │  ├─ PostgREST  ── RLS (solo SELECT)        │
                         │  │              └─ RPC SECURITY DEFINER ───┼──┐
                         │  └─ Edge Function "api" (/api/v1)          │  │
                         └──────────────▲─────────────────────────────┘  │
                                        │ HTTPS + OAuth2 / API key       ▼
  Effi · boletería · apps ──────────────┘                   ┌────────────────────────┐
  (consumidores externos, opcionales)                       │ PostgreSQL             │
                                                            │ lógica crítica en SQL: │
                                                            │ consumo atómico,       │
                                                            │ auditoría, rate limit, │
                                                            │ idempotencia, outbox   │
                                                            └────────────────────────┘
```

No existe ni `Effi → base de datos` ni `Drink Pass → Effi`.

## Decisiones clave

| Decisión | Motivo |
|---|---|
| **La lógica crítica vive en PostgreSQL** (funciones `SECURITY DEFINER`) | El scanner y la API usan exactamente el mismo código de consumo; las garantías (atomicidad, doble consumo, auditoría) no dependen de la capa HTTP. |
| **RLS solo con políticas SELECT; escrituras solo por funciones** | Ningún cliente puede escribir tablas directamente; toda mutación valida permisos y reglas, y audita. |
| **El scanner llama RPC directo (no la Edge Function)** | Un salto menos (≈ latencia) y sin dependencia de la Edge Function para operar la barra. |
| **Edge Function delgada** (`supabase/functions/_shared/app.ts`) | Solo autentica, aplica scopes/rate limit, valida entrada y traduce a HTTP. Independiente del runtime → probada en Node con la base real (PGlite). |
| **Tokens QR por HMAC; solo se guarda el hash** | Ver [QR.md](QR.md). |
| **Hora oficial = `now()` del servidor en America/Bogota** | El navegador nunca decide la fecha del beneficio. |
| **Permisos = scopes** (mismo vocabulario) | Un staff con JWT y una integración se autorizan igual en la API. |
| **Outbox transaccional + despachador** (`private.event_outbox` → Edge Function `webhooks`) | Webhooks firmados (`benefit.consumed`) con reintentos, sin que la barra espere a terceros. |
| **Sin consumo offline** | Un consumo sin servidor no puede garantizar unicidad. El scanner muestra *SIN CONEXIÓN — NO ES POSIBLE CONFIRMAR EL CONSUMO* y permite reintentar de forma segura con la misma `Idempotency-Key`. |

## Componentes

| Ruta | Contenido |
|---|---|
| `src/` | Frontend React 19 + TypeScript + Tailwind 4 + React Query + React Router 7 |
| `src/pages/admin/Scanner.tsx` | Scanner (qr-scanner) con máquina de estados, modos automático/confirmación |
| `supabase/migrations/` | Esquema completo, reconstruible desde cero (10 migraciones) |
| `supabase/functions/api/index.ts` | Entrada Deno de la API |
| `supabase/functions/webhooks/index.ts` | Despachador programado de webhooks |
| `supabase/functions/_shared/` | Router, auth, JWT, validación (zod), errores, utilidades de QR (compartidas con el frontend) |
| `supabase/scripts/` | Bootstrap del Super Admin, tokens demo, limpieza demo |
| `tests/` | unit · api (HTTP end-to-end) · db (PostgreSQL real) · postman (Newman) · integration (Supabase real) |
| `docs/` | Esta documentación, OpenAPI y Postman |

## Flujo de consumo (scanner)

1. El operador escanea; el cliente extrae el token del QR (`…/qr/<token>`). Si el contenido no es un token válido → **QR INVÁLIDO** sin consultar.
2. Sin conexión → pantalla de sin conexión (no se consume).
3. **Modo confirmación**: `benefit_validate(token)` → muestra datos → el operador confirma → `benefit_redeem(token, idempotency_key)`.
   **Modo automático**: `benefit_redeem` directo.
4. `private.process_benefit` (una transacción):
   verifica permiso → rate limit → idempotencia → `hash(token)` → `SELECT … FOR UPDATE` → reglas (estado, asistente activo, elegibilidad, día activo, fecha, horario) → `UPDATE … WHERE status='PENDING'` → `INSERT consumptions` → outbox `benefit.consumed` → auditoría → respuesta.
5. Resultado a pantalla completa con sonido/vibración; vuelve al scanner automáticamente.

## Concurrencia (doble consumo imposible)

Defensa en profundidad dentro de PostgreSQL:

1. `SELECT … FOR UPDATE` serializa a los operadores que escanean el mismo beneficio a la vez; el segundo espera y ve `CONSUMED`.
2. `UPDATE benefits SET status='CONSUMED' … WHERE status='PENDING'`: solo una transacción afecta la fila.
3. `UNIQUE (consumptions.benefit_id)`: imposible un segundo registro de consumo.
4. Trigger de máquina de estados: `CONSUMED` es terminal (ni el superusuario lo revierte).

La prueba `tests/integration/concurrency.test.ts` lanza 30 consumos simultáneos contra un proyecto real y exige exactamente 1 aprobado.

## Estados del beneficio

```
PENDING ──► CONSUMED (terminal)
   │  ▲
   │  └──── restore ─── CANCELLED ◄── cancel ──┐
   ├──► EXPIRED ──► CONSUMED (solo consumo excepcional auditado)
   │       └──► PENDING (restore) / CANCELLED
   └──► CANCELLED
```

Un `PENDING` cuyo día terminó se reporta como `EXPIRED` (estado efectivo) aunque aún no se haya persistido; `expire_benefits()` lo persiste.
