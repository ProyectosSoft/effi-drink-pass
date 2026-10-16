# Acceso del cliente desde un QR general

**Actualización:** el nuevo flujo por empresa, cantidad de usuarios y entregas parciales se describe en [COMPANY_QUOTAS.md](COMPANY_QUOTAS.md). Después de la migración 13, `/claim` usa `lookup_company_drink_pass`; el flujo individual descrito abajo se conserva como antecedente de la migración 12, no como el acceso actual de empresas.

## Flujo

1. La organización abre **Administración → Configuración → QR de entrada para clientes** y descarga el SVG para colocarlo en la feria. Debe hacerlo desde el sitio con su URL pública definitiva.
2. El cliente escanea ese QR con la cámara de su teléfono; abre `/claim`.
3. Selecciona **Correo** o **ID Effi** e ingresa el dato de su inscripción. No se envía OTP, no necesita contraseña y no se crea una sesión.
4. El servidor busca el asistente por coincidencia exacta. El correo ignora mayúsculas; el ID Effi conserva su formato, incluidos los ceros iniciales. Se recortan espacios exteriores. No se busca por usuario Effi ni por nombre.
5. Se consulta el beneficio de **hoy según el servidor en Bogotá** y se reutiliza `private.process_benefit` en modo `validate`.
6. Solo con respuesta `VALID` se devuelve el token existente para mostrar el QR personal. No se crea, regenera ni consume el beneficio.
7. El operador usa el escáner habitual. Mantiene sus permisos, confirmación/modo automático, reglas, idempotencia, auditoría y protección contra doble consumo.
8. El cliente puede pulsar **Finalizar consulta** para retirar el QR y limpiar el dato de la pantalla. El resultado no se guarda en localStorage ni en la caché de consultas.

La portada también ofrece **Reclamar mi bebida**. El portal autenticado y el login del staff siguen disponibles.

## Despliegue

Aplicar la migración `supabase/migrations/20261015000012_public_benefit_lookup.sql` al proyecto y publicar el frontend actualizado. No necesita una nueva Edge Function ni configurar SMTP para este flujo. El login anterior por email sigue dependiendo de SMTP.

La nueva RPC pública es `lookup_drink_benefit(p_kind, p_identifier)`. Solo admite `email` y `effi_id`. Devuelve disponibilidad, código de resultado y, exclusivamente si está disponible, token del QR, día y hora de la consulta. No devuelve email, nombre, historial ni datos del operador. El visitante no recibe permisos de lectura de tablas ni de canje.

Se limitan las consultas a 60 por minuto por IP usando el contador persistente existente. En una feria con Wi-Fi compartido, esa cuota se comparte entre visitantes de la misma salida a Internet; verificar el volumen esperado antes de abrir.

## Decisión de acceso

Por solicitud expresa del responsable, correo e ID Effi sirven para obtener el QR **sin verificación de identidad**. Cualquier persona que conozca uno de esos datos puede obtener el pase disponible. El límite por IP reduce consultas masivas, pero no prueba la identidad. El QR personal sigue siendo de un único consumo. El nuevo flujo no debe confundirse con una sesión autenticada del portal.

La pantalla refleja la disponibilidad en el instante de la consulta. Si otro dispositivo consume, se cancela el beneficio o cambia su elegibilidad después, el QR puede seguir en pantalla, pero el escáner vuelve a validar las reglas antes de aceptar la entrega.

## Verificación

Las pruebas de `tests/db/public-benefit-lookup.test.ts` comprueban acceso anónimo por correo e ID, formato/identificadores inválidos, ausencia de beneficio elegible hoy, reutilización del mismo token sin consumo, rechazo después del canje, horarios, inactivos, no elegibles, cancelación, día deshabilitado, cuota por IP y prohibición de canje anónimo.

Prueba manual tras publicar: descargar y escanear el QR general en móvil, consultar un asistente de prueba por ambos datos, comprobar el QR en la barra y volver a consultar tras consumir. El segundo intento debe informar que ya fue reclamado.
