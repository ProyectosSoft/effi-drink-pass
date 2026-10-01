# Operación durante la feria

## Antes de abrir (cada día)

1. Admin → Configuración: verificar que el día de hoy esté **activo** y el horario sea correcto. El reloj oficial del servidor aparece arriba.
2. Dashboard: *Consumos hoy* en 0 y *Pendientes* coherentes.
3. Cada operador abre **Scanner** en su dispositivo, ya con sesión iniciada, y hace una prueba con un QR demo o de un compañero (en modo confirmación puede cancelar sin consumir).

## Scanner

- Ruta `/admin/scanner`. Instalable como app (PWA): en Android “Agregar a pantalla de inicio”; en iPhone Safari → Compartir → “Agregar a inicio”.
- **Modo confirmación** (recomendado en barras con fila moderada): valida, muestra usuario/ID Effi/día y el operador pulsa **Confirmar entrega**.
- **Modo automático** (alta demanda): QR válido → se consume al instante.
- El modo por defecto se define en Configuración; cada dispositivo puede cambiarlo.
- Controles: linterna, cambio de cámara, ingreso manual del código si la cámara falla.
- Tras cada resultado vuelve solo al scanner (segundos configurables) o con *Escanear siguiente*.

| Pantalla | Qué hacer |
|---|---|
| 🟢 **BENEFICIO APROBADO · BEBIDA ENTREGADA** | Entregar la bebida |
| 🟠 **BENEFICIO YA CONSUMIDO** | No entregar. Muestra quién y a qué hora lo consumió |
| 🔴 **QR NO VÁLIDO PARA HOY** | No entregar. Muestra el día del beneficio |
| 🔴 **BENEFICIO EXPIRADO** / **FUERA DE HORARIO** | No entregar |
| 🔴 **USUARIO NO ELEGIBLE** / **USUARIO INACTIVO** | Remitir a punto de información |
| 🔴 **QR INVÁLIDO** | No es un pase de este sistema o fue regenerado |
| 🔴 **SIN CONEXIÓN — NO ES POSIBLE CONFIRMAR EL CONSUMO** | **No entregar.** Reintentar cuando vuelva la señal: el reintento es seguro (misma Idempotency-Key, nunca se duplica) |

## Conectividad

No hay consumo offline (por diseño: no se puede garantizar un solo consumo sin el servidor). Recomendaciones:

- Red Wi-Fi dedicada para barras o datos móviles de respaldo en cada dispositivo.
- El portal del asistente guarda su QR en el teléfono: aunque el asistente no tenga señal, puede mostrarlo.
- Tener al menos un dispositivo de respaldo por barra.

## Excepciones

- **Consumo excepcional** (fuera de día/horario o expirado): solo `supervisor`/`admin`, desde Admin → Asistentes → beneficio → *Consumo excepcional*, con motivo obligatorio. Queda auditado como `OVERRIDE_REDEEM` y marcado en consumos y reportes.
- **QR filtrado** (captura en redes): *Regenerar QR* invalida el anterior.
- **Asistente sin registro**: crear en Admin → Asistentes → *Nuevo* (con el email con que ingresará) y marcar los días.
- **Asistente no recibe el código**: verificar email en su registro, revisar spam, o que el staff le cambie el email; el SMTP propio debe estar configurado.

## Monitoreo

- Dashboard (se refresca cada 30 s): consumos de hoy, por hora, por operador, por tipo de acceso.
- Consumos (cada 20 s) y Auditoría (filtrar `FAILED_REDEEM`, `API_AUTH_FAILED`).
- Supabase Dashboard → Logs: Edge Function `api` (líneas JSON con `request_id`), Postgres, Auth.

## Cierre del día / evento

- Admin → Beneficios → **Expirar vencidos** (opcional; el estado efectivo ya lo refleja).
- Reportes → exportar CSV (consumos diarios, por operador, pendientes/expirados).
- Al cierre del evento: revocar credenciales de integraciones que ya no se usen y desactivar operadores temporales.
