# QR

## Contenido

El QR contiene **solo** una URL con un token opaco:

```
https://<sitio>/qr/<token>
```

Nunca contiene nombre, ID Effi, usuario Effi, email, teléfono ni ningún otro dato personal. El scanner también acepta el token crudo o rutas `/r/<token>`.

## Token

```
token = base64url( HMAC-SHA256( qr_hmac_secret, benefit_id || ':' || token_salt ) )   → 43 caracteres
token_hash = SHA-256(token)                                                          → único en benefits
```

| Propiedad | Cómo se cumple |
|---|---|
| Aleatorio / impredecible | `token_salt` de 128 bits aleatorios por beneficio + secreto HMAC de 256 bits que nunca sale de PostgreSQL (`private.secrets`) |
| Criptográficamente seguro | HMAC-SHA256; 256 bits de salida |
| Único | `UNIQUE (benefits.token_hash)` |
| No almacenado | Solo se guarda `token_hash`. El token se **recalcula** para el dueño cuando abre su QR |
| Rotable | `regenerate_benefit_token` cambia el salt → el QR anterior (incluidas capturas) deja de funcionar |
| Anti-enumeración | Un token desconocido responde `INVALID_QR` sin ningún dato; los intentos fallidos se auditan con un prefijo del hash; rate limit por operador/credencial |

¿Por qué HMAC y no un token aleatorio guardado? Porque así la base de datos no contiene tokens utilizables: un volcado de `benefits` solo expone hashes. El asistente obtiene su token con `get_my_benefit_token`, que solo responde al dueño autenticado.

## Un beneficio por día

Cada día elegible genera su propio beneficio y su propio token. Un QR del 16/10 responde `NOT_TODAY` el 15/10 y `EXPIRED` el 17/10 (fecha y hora del **servidor**, America/Bogota). La única excepción es el **consumo excepcional** (`benefits:override`), que exige motivo y queda auditado.

## Portal del asistente

- Lista los días con estado: *Disponible*, *Consumido*, *No disponible*, *Expirado* o *Próximamente*.
- “Mostrar QR” pide el token al servidor y lo guarda en el dispositivo (`localStorage`) para poder mostrarlo aunque la señal en la feria sea mala. El QR se valida siempre en línea en la barra.
- Mantiene la pantalla encendida (Wake Lock) y detecta el consumo en vivo (sondeo cada 5 s) para mostrar **BEBIDA ENTREGADA**.

## Cámara nativa

Si alguien escanea el QR con la cámara del teléfono, abre `/qr/<token>`:
- staff con permiso de validación → se abre el scanner en **modo confirmación** con ese token;
- cualquier otra persona → mensaje genérico, sin consultar ni revelar nada.

## Generación y librerías

- QR renderizado como SVG con `qrcode` (corrección de errores M, margen 2, negro sobre blanco).
- Lectura con `qr-scanner` (usa `BarcodeDetector` nativo cuando existe y un worker como alternativa; compatible con Android, iOS Safari y escritorio). Requiere HTTPS para la cámara.
