# Bebidas por empresa y día

## Regla operativa

Cada empresa tiene un ID Effi único y una cantidad de usuarios. Esa cantidad determina cuántas bebidas puede recibir por cada día asignado del evento. **Cantidad vacía = 1**, por decisión del responsable. Cero, negativos, decimales, texto no reconocido e “ilimitado” se rechazan; no se convierten en cupos arbitrarios.

El responsable de la entrega indica una cantidad entera positiva. Puede hacer varias entregas parciales con el mismo QR de ese día. Por ejemplo, cupo 5: entrega 2, quedan 3; entrega 3, quedan 0. Un nuevo intento se rechaza. El siguiente día asignado comienza con su propio cupo completo, sin acumular sobrantes.

El número es un límite de unidades por empresa; no identifica qué personas recibieron cada bebida ni comprueba individualmente a los empleados.

## Flujo

1. Administración → **Empresas y bebidas**: registrar ID Effi, nombre fiscal, correo opcional, cantidad de usuarios y días elegibles. El ID de empresa no se debe cargar como un asistente individual para este flujo.
2. Para carga masiva: **Importar empresas**, descargar su plantilla o cargar el reporte de empresas guardado como CSV/XLSX. Se reconocen los encabezados `ID`, `Nombre fiscal` y `CANTIDAD USUARIO`; valores como `4 usuarios` se convierten en 4. El archivo `.xls` debe guardarse como `.xlsx` o `.csv`.
3. Revisar vista previa y días, ejecutar **Validar sin guardar** y después **Confirmar importación**. Las empresas existentes se actualizan por ID Effi. Si se omite el correo del archivo se conserva el ya registrado. Sin correo, la empresa consulta por ID.
4. El cliente escanea el QR general de `/claim`, ingresa el correo o ID de **su empresa** y obtiene el QR del día con cupo, entregadas y disponibles.
5. El operador escanea el QR, ve el saldo y escribe cuántas bebidas va a entregar. Debe confirmar expresamente: el escáner ya no consume automáticamente al leer un código.
6. El servidor verifica permiso, empresa activa, día habilitado, elegibilidad, horario en Bogotá y cantidad solicitada. Solo si registra una respuesta aprobada se entregan las bebidas.
7. Administración → **Cupos y entregas por día** permite revisar asignación, unidades entregadas, saldo e historial de cantidad, operador y hora. La tabla se actualiza cada 15 segundos y ofrece CSV de la página visible. El historial tiene paginación.

La portada y el QR general se mantienen en las mismas direcciones. La consulta sin OTP conserva la decisión de acceso anterior: quien conoce el correo o ID de una empresa puede obtener su QR. La autorización para descontar unidades corresponde exclusivamente al staff con permiso de canje.

## Garantías en el servidor

- Datos nuevos: `drink_companies`, `company_drink_days` y `company_drink_deliveries`, con RLS. Las escrituras se hacen únicamente por RPC autorizadas. El historial de entregas es inmutable.
- Un pase por empresa y día. El token usa el HMAC existente con un prefijo propio, y se almacena solo su hash y sal.
- El canje bloquea primero la empresa y después el pase diario con `FOR UPDATE`. Dos operadores no pueden descontar simultáneamente el mismo saldo disponible. La restricción de tabla exige `0 <= delivered <= quota`.
- Descuento, entrega, auditoría y respuesta de idempotencia se registran en una misma transacción.
- Los reintentos conservan token, cantidad y clave de idempotencia. Cambiar la cantidad con una clave ya usada se rechaza.
- No se puede reducir el cupo de hoy o de un día futuro por debajo de lo ya entregado. Editar o volver a importar no reinicia el contador. Los cupos históricos permanecen como estaban.
- Sin conexión, la barra no confirma entregas. Reintentar con la misma clave permite resolver una respuesta perdida sin duplicar el descuento.
- El lote de importación es atómico, con máximo 500 empresas. Si falla un lote posterior, los anteriores permanecen guardados y la pantalla informa cuántas empresas se confirmaron. Hay que volver a validar antes de reintentar.

## Compatibilidad y reportes

Los asistentes y beneficios individuales previos no se convierten ni se borran. El nuevo escáner también puede leer sus QR y mantiene exactamente una bebida por pase individual. `/claim` consulta exclusivamente empresas para evitar confundir la cantidad de usuarios con un beneficio personal.

El dashboard muestra un resumen de **bebidas de empresas de hoy**, separado de las estadísticas de pases individuales. Los reportes y consumos anteriores se rotulan como individuales. Las entregas de empresas se revisan en su panel; no forman parte de la API REST ni de los webhooks de consumos individuales existentes.

## Despliegue

Aplicar `20261015000013_company_drink_quotas.sql` después de la migración 12; después publicar el frontend actualizado. No aplicar nuevamente las migraciones iniciales a una base que ya las tiene, ni ejecutar los seeds demo en producción. No requiere redesplegar Edge Functions.

La instalación de las tablas no importa ni deduce empresas de los asistentes existentes. Debe cargarse el registro real de empresas, revisar sus cantidades y asignar días. Publicar la pantalla sin cargar esos datos hará que las consultas indiquen que no hay cupo disponible.

## Pruebas

`tests/db/company-drinks.test.ts` cubre consulta, cantidad predeterminada, entregas parciales, exceso, dos operadores con saldo leído anteriormente, idempotencia, cantidades inválidas, fecha y horario, permisos/RLS, historial, reducción de cupo, importación y compatibilidad individual. `tests/unit/company-import.test.ts` prueba el mapeo de columnas y las cantidades del archivo. `tests/unit/delivery-form.test.ts` comprueba que la pantalla exige confirmación y no envía cantidades vacías, negativas, fraccionarias ni superiores al saldo.

La prueba de dos operadores en PostgreSQL embebido ejecuta las solicitudes sucesivamente después de que ambos hayan consultado el mismo saldo. La garantía de concurrencia real se apoya en el bloqueo transaccional y la restricción; debe verificarse adicionalmente contra staging antes de publicar. No se ha ejecutado una prueba simultánea contra el proyecto hospedado para esta migración.

## Registro manual con permisos

Aplicar también `20261015000014_manual_company_deliveries.sql` para registrar entregas realizadas hoy o en días anteriores. En **Empresas y bebidas → Cupos y entregas por día**, seleccionar el día y usar **Registrar consumo manual** en la fila de la empresa. Se exige cantidad y motivo; el descuento corresponde al día elegido, mientras que la hora del registro y el operador quedan guardados en el historial inmutable y la auditoría.

El permiso `consumptions:manual` se asigna inicialmente solo a `super_admin`; un Super Admin puede otorgarlo a otros roles desde Roles. Para usar la pantalla se necesita además `attendees:read`, y para revisar entregas, `consumptions:read`. El permiso no se puede asignar a integraciones. La carga manual respeta el saldo y la elegibilidad del día, rechaza días futuros y permite documentar días cuyo horario terminó. Los reintentos del mismo formulario no duplican el descuento; una nueva apertura es un nuevo registro y requiere revisar el historial.
