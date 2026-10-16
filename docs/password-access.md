# Acceso con contraseña sin correo

El login usa únicamente email y contraseña. Las consultas públicas de cupo siguen siendo independientes del login.

Para una cuenta sin contraseña o para recuperar acceso, un Super Admin verifica la identidad de la persona y abre **Admin → Usuarios → Contraseña temporal sin correo**. El correo debe estar registrado y activo como staff o asistente. La contraseña temporal reemplaza la anterior, se muestra una sola vez y debe entregarse directamente al dueño. No se envía por email ni se guarda en la auditoría.

Al ingresar con ella, la aplicación dirige a **Mi cuenta** para crear la contraseña personal. Las contraseñas existentes siguen funcionando. Nunca se permite establecer una contraseña pública con solo conocer el correo de otra persona.

## Despliegue

Aplicar `20261016000016_password_access.sql` y desplegar `password-access` con el JWT de plataforma desactivado: la función valida el JWT contra Auth mediante `getUser`, y la RPC verifica Super Admin. Requiere las variables estándar de Supabase (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). `PASSWORD_ACCESS_ORIGINS` admite una lista de orígenes CORS; por defecto permite GitHub Pages de ProyectosSoft y localhost:5173.

La redirección al cambio de contraseña es una regla de navegación; la contraseña temporal autentica al usuario como titular de la cuenta. RLS y los permisos del usuario siguen aplicándose.
