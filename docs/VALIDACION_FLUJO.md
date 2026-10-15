# Validación del flujo de trabajo

Fecha: 15 de octubre de 2026.

## Alcance y resultado

Revisión del código de navegación, autenticación, portal, importación y escáner; revisión de las funciones SQL de beneficios y de la cobertura automatizada. No se modificó la lógica de la aplicación durante esta revisión.

`npm run typecheck`: correcto. `npm run build`: correcto, incluido el service worker de la PWA. `npm test`: 175 pruebas aprobadas en 15 archivos (unitarias, API y PostgreSQL embebido con las migraciones del repositorio).

Esto valida la lógica cubierta en el entorno local. No certifica el despliegue ni la entrega de emails, la configuración de SMTP, la cámara física, ni la concurrencia contra Supabase hospedado. La prueba de 30 consumos simultáneos de `tests/integration/concurrency.test.ts` requiere credenciales y un beneficio de staging; no se ejecutó.

Dictamen: el flujo principal está implementado y sus pruebas locales pasan. Hay hallazgos de interfaz y aislamiento de sesión que deben resolverse antes de considerar validado el funcionamiento completo en la feria.

## Cómo funciona

1. **Preparación:** el Super Admin inicial se crea con el script de bootstrap. La organización configura días activos, fechas y horarios, y crea personal con roles y permisos. El sistema tiene cuentas propias; no depende del login de Effi.
2. **Asistentes:** se crean individualmente o se importan desde CSV/XLSX. La importación mapea columnas, valida localmente, realiza una simulación en el servidor y pide confirmación. Asignar días elegibles genera beneficios, uno por asistente y día. Estar registrado sin días asignados no da derecho a una bebida.
3. **Acceso:** el asistente solicita un código por email y lo verifica, o abre el enlace recibido. La cuenta se vincula al registro por email verificado. Una cuenta autenticada sin registro de asistente ni staff no recibe beneficios. El staff también puede entrar con contraseña después de haberla definido.
4. **Destino:** un asistente entra a sus beneficios; un operador al escáner; el personal con estadísticas al panel. Si tiene ambos perfiles, puede elegir entre sus beneficios y administración.
5. **QR:** el asistente abre el beneficio de un día. El token se obtiene de una función que verifica que sea su dueño. Un QR de un día futuro se puede mostrar anticipadamente, pero no canjear antes de tiempo.
6. **Barra:** en modo confirmación, el escáner consulta la validez y luego el operador confirma la entrega. La validación sola no consume. En modo automático, el QR se consume al leerse. Abrir la URL de un QR como staff fuerza confirmación.
7. **Decisión del servidor:** PostgreSQL comprueba permisos, estado, asistente activo, elegibilidad, día y horario con hora de Bogotá. Si aprueba, cambia el beneficio a consumido y registra consumo, auditoría y evento para integraciones en la misma transacción.
8. **Seguimiento:** el portal consulta periódicamente para mostrar “BEBIDA ENTREGADA”. La organización revisa consumos, estadísticas, auditoría y exportaciones. Las excepciones requieren permiso especial y motivo; no permiten volver a consumir un beneficio ya consumido.

## Controles verificados

| Control | Evidencia revisada |
|---|---|
| Consumo único | Bloqueo `FOR UPDATE`, actualización condicionada, restricción única por beneficio y estado consumido terminal |
| Reintento tras fallo de red | El escáner conserva la misma clave de idempotencia; la base devuelve la respuesta original |
| Horarios y elegibilidad | Reglas SQL y pruebas de días futuros/pasados, fuera de horario, inactivos y no elegibles |
| Permisos | Guards de navegación, RLS y comprobaciones en funciones; pruebas de acceso y escalamiento |
| Importación | Simulación sin guardar, conflictos entre identificadores, permisos, inserción y actualización |
| Trazabilidad | Pruebas de consumo, auditoría inmutable, reportes y evento de salida |
| Sin conexión en barra | El escáner bloquea la confirmación y ofrece reintento; no confirma entregas offline |

## Hallazgos pendientes

### Alta: caché de datos compartida entre sesiones

`src/main.tsx:17`, `src/lib/auth.tsx:103`, `src/pages/MyBenefits.tsx:44`.

El cliente de consultas vive durante toda la ejecución de la app. Cerrar sesión borra claves `edp:*` de localStorage, pero no limpia las consultas en memoria. “Mis beneficios” usa una clave que no incluye el usuario. Al cerrar la sesión A y abrir B en la misma pestaña sin recargar, pueden aparecer datos de A antes de refrescar; con una consulta fallida pueden permanecer visibles. RLS protege las nuevas respuestas del servidor, pero no elimina los datos ya descargados.

Acción: cancelar y limpiar consultas al cambiar de identidad, usar claves por usuario para datos privados y comprobar el cambio A → B, incluyendo red caída.

### Media: la navegación puede adelantarse a la carga de permisos

`src/lib/auth.tsx:78`, `src/pages/Login.tsx:50`, `src/pages/Dashboard.tsx:21`.

Tras un inicio de sesión se actualiza `session` antes de cargar el acceso; `loading` no vuelve a activarse. El login puede redirigir mientras el perfil aún es nulo, produciendo un aviso temporal de cuenta no registrada o acceso denegado. Si la consulta de permisos falla, se presenta como falta de registro en vez de permitir distinguir un fallo de carga.

Acción: esperar la resolución del acceso, separar el error de carga del perfil inexistente y ofrecer reintento.

### Media: destino inadecuado para roles personalizados

`src/pages/Dashboard.tsx:19`, `src/App.tsx:84`.

El staff sin estadísticas se envía al escáner. Un rol personalizado con permisos de importación o asistentes, pero sin validación/consumo, encuentra “Sin acceso” como primera pantalla. Los roles estándar de operador y viewer sí tienen destinos compatibles.

Acción: elegir la primera sección autorizada entre todos los permisos del usuario.

### Media: importación parcial sin resumen recuperable

`src/pages/admin/Import.tsx:89`.

La importación usa lotes de 500 filas. Si falla un lote posterior, los anteriores quedan guardados; el manejo del error no conserva un resumen descargable de esos lotes. El operador podría interpretar el error como fallo de toda la importación.

Acción: mostrar cuántos lotes y filas se confirmaron, conservar su reporte y ofrecer una reanudación controlada.

### Media: acceso a “Mi cuenta” incompleto para asistentes

`src/components/layout.tsx:40`, `src/pages/MyBenefits.tsx:56`.

El enlace público llamado “Mi cuenta” lleva a `/dashboard`, no a `/account`. El portal de beneficios no incluye enlace a `/account`. La función para definir contraseña existe, pero un asistente no dispone de un acceso visible directo desde su portal.

Acción: añadir el enlace correcto para que pueda configurar su contraseña.

### Limitación: recuperación offline del QR

`src/pages/MyBenefits.tsx:43`, `src/pages/MyBenefits.tsx:155`.

Se guarda el token, pero la lista de beneficios depende de la caché de consultas en memoria. Con la pantalla ya abierta el QR puede seguir visible sin red; después de recargar sin conexión, guardar solo el token no garantiza que se pueda recuperar la pantalla del beneficio. La documentación debe distinguir estos escenarios.

Acción: validar ambos casos en móvil y, si se requiere reapertura offline, diseñar persistencia acotada de la información mínima, aislada por usuario y eliminada al salir.

## Validación operativa pendiente

La captura aportada demuestra un rechazo de envío por cuota, pero no permite conocer la configuración actual del proyecto. No se comprobó que Mailtrap esté conectado.

Antes de la feria se debe ejecutar en staging este recorrido:

1. Configurar SMTP, remitente, dominio, plantillas con código, URLs de retorno y cuotas; recibir un código y un enlace reales.
2. Crear un asistente de prueba con un día elegible y comprobar acceso con su mismo email.
3. Validar su QR sin consumir; confirmar después y verificar consumo, auditoría y actualización del portal.
4. Escanear otra vez y comprobar que se rechaza sin una segunda entrega.
5. Probar día futuro, vencido, cancelado, asistente inactivo y usuario sin permiso.
6. Cortar la red durante un consumo y reintentar; verificar un solo registro y que la entrega física no se repita.
7. Ejecutar la prueba de concurrencia real en staging con el beneficio preparado para ella.
8. Probar cámara y permisos en Android/iPhone, URL directa del QR, cierre de sesión y cambio de usuario en el mismo dispositivo.

La aprobación de producción queda pendiente de estas verificaciones y de resolver el aislamiento de caché entre sesiones.
