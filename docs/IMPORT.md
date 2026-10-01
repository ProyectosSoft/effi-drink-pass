# Importación masiva de asistentes

Ruta: **Admin → Importación** (`attendees:import`). Nada se guarda sin una confirmación explícita.

## Formatos

- **CSV** (UTF-8; separador `,` `;` tabulador o `|`, detectado automáticamente). Excel en español suele usar `;`.
- **XLSX** (primera hoja; fila 1 = encabezados).
- Máximo 5 MB y 20 000 filas por archivo.
- Plantilla descargable desde la misma pantalla.

| Columna | Obligatoria | Reglas |
|---|---|---|
| `nombres` | Sí | ≤ 120 |
| `apellidos` | No | ≤ 120 |
| `email` | Recomendada | formato válido; **sin email el asistente no puede entrar al portal** |
| `telefono` | No | ≤ 40 |
| `effi_id` | No | ≤ 64; único |
| `effi_username` | No | ≤ 120; único (sin distinguir mayúsculas) |
| `tipo_acceso` | No | `A-Z 0-9 espacio _ -`, ≤ 40; se normaliza a MAYÚSCULAS; por defecto `GENERAL` |
| `empresa` | No | ≤ 200 |

Los encabezados se reconocen con sinónimos (p. ej. *Nombre*, *Correo*, *Celular*, *ID Effi*, *Compañía*); el mapeo se puede corregir manualmente.

## Pasos

1. **Archivo** → lectura en el navegador.
2. **Columnas y opciones**
   - Si el asistente ya existe: *Actualizar* (celdas vacías **no** borran datos) u *Omitir*.
   - Días elegibles a asignar (generan beneficios y QR automáticamente).
3. **Previsualización**: validación local **y** validación del servidor en modo *dry-run* (lotes de 500). Muestra por fila: Nuevo / Actualizar / Omitir / Error, con errores y advertencias. Descargable en CSV.
4. **Confirmar** → se ejecuta en lotes; cada fila en su propia subtransacción (un error no aborta el lote).
5. **Resultado** + reporte CSV descargable. Auditoría `IMPORT_ATTENDEES` con el resumen, más `CREATE_ATTENDEE` / `UPDATE_ATTENDEE` por fila.

## Duplicados

- **Dentro del archivo**: mismo `effi_id`, `email` o `effi_username` que una fila anterior → error en la fila repetida.
- **Contra la base**: se busca por `effi_id`, luego `email`, luego `effi_username`. Si los identificadores de una fila apuntan a **asistentes distintos**, la fila se marca como error (nunca se fusiona en silencio).

## Por API

Integraciones con `attendees:write` pueden crear/actualizar uno a uno con `POST/PATCH /v1/attendees`. La importación masiva por archivo es exclusiva del staff.
