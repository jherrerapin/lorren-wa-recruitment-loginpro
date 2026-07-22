# Asistencia operativa: persistencia de sesión del Portal del Auxiliar

## Estado

Implementación relacionada con #509, #581 y #583. Continúa la política de sesión integrada en #582.

La entrega persiste sesiones del Portal del Auxiliar y proporciona un adaptador Prisma. Todavía no crea rutas públicas, cookies reales, vistas, WhatsApp, GPS ni marcaciones.

## Objetivo

Garantizar que estas acciones se confirmen o se reviertan juntas:

1. reclamar una activación pendiente y vigente;
2. revalidar al auxiliar;
3. revocar sesiones anteriores;
4. revocar el dispositivo principal anterior;
5. autorizar la instalación actual;
6. crear la nueva sesión;
7. enlazar la activación consumida con el dispositivo.

Una falla en cualquiera de los pasos debe revertir todas las escrituras.

## Modelo `DispatchWorkerPortalSession`

La tabla conserva:

- auxiliar;
- dispositivo autorizado;
- activación de origen;
- hash SHA-256 único del token de sesión;
- estado;
- fecha de emisión;
- vencimiento;
- última actividad;
- revocación, actor y motivo;
- metadatos técnicos limitados: IP, agente de usuario y plataforma;
- fechas de auditoría.

No existe una columna para el token crudo, documento, teléfono o nombre del auxiliar.

`activationId` es único para impedir que una activación produzca dos sesiones.

## Autoridad transaccional

`createPrismaWorkerPortalSessionRepository(prisma)` implementa:

```text
claimActivationAuthorizeDeviceAndCreateSession(input)
resolveActiveSession(input)
```

### Creación de sesión

La creación usa una transacción interactiva corta con:

```text
isolationLevel: Serializable
```

El adaptador reutiliza el mecanismo de reintentos ya validado para activaciones y reintenta únicamente conflictos Prisma `P2034`, con un máximo configurable de cero a cinco.

La secuencia es:

1. buscar la activación por hash;
2. verificar propósito, estado, consumo, revocación y vencimiento;
3. revalidar que el auxiliar siga `ACTIVE` o `CONTRATADO`;
4. reclamar condicionalmente la activación mediante `updateMany`;
5. revocar sesiones activas anteriores del auxiliar;
6. revocar dispositivos principales activos anteriores;
7. crear o reactivar el dispositivo actual como `PRIMARY / ACTIVE`;
8. crear la sesión con el hash recibido;
9. enlazar la activación consumida con el dispositivo;
10. confirmar la transacción.

Si el reclamo condicional devuelve `count = 0`, otra solicitud ganó la carrera y no se crea dispositivo ni sesión.

## Resolución de sesión

`resolveActiveSession()` busca únicamente una sesión que cumpla simultáneamente:

- hash exacto;
- estado `ACTIVE`;
- sin revocación;
- vencimiento futuro;
- auxiliar `ACTIVE` o `CONTRATADO`;
- dispositivo `PRIMARY / ACTIVE`;
- dispositivo sin revocación;
- autorización del dispositivo vigente.

Después actualiza `lastSeenAt` mediante una escritura condicional. Si la sesión fue revocada o venció entre la lectura y la actualización, devuelve `null`.

El middleware futuro tratará `null` como usuario no autenticado y eliminará la cookie.

## Migración

La migración:

- crea una tabla nueva;
- crea dos restricciones únicas;
- crea índices de estado, vencimiento y última actividad;
- crea tres claves foráneas;
- no elimina ni renombra tablas o columnas;
- no contiene `DROP`, `TRUNCATE`, `DELETE FROM` ni `ALTER COLUMN`.

No debe ejecutarse manualmente contra producción. El proyecto mantiene `prisma migrate deploy` dentro del proceso de despliegue.

## Seguridad

- El token crudo de sesión nunca llega al adaptador.
- El token de activación llega únicamente como SHA-256.
- El identificador de instalación llega únicamente como HMAC-SHA-256.
- Una activación solo puede originar una sesión.
- Una nueva sesión revoca sesiones activas anteriores del auxiliar.
- El adaptador no contiene HTTP, cookies, WhatsApp ni llamadas externas dentro de la transacción.
- Los metadatos técnicos deben limitarse y no registrarse en mensajes de error.

OWASP recomienda que el identificador de sesión sea aleatorio, sin contenido de negocio y que la información asociada permanezca en el servidor. Prisma recomienda mantener cortas las transacciones interactivas y usar `Serializable` con reintentos limitados ante `P2034` cuando se requiere serialización estricta.

## Fuera de alcance

- endpoint de activación;
- cookie `__Secure-lorren-attendance` real;
- middleware HTTP;
- cierre de sesión;
- envío del enlace por WhatsApp;
- PWA y listado de asignaciones;
- GPS, cámara, llegada, salida o R2;
- despliegue o migración manual en Railway.

## Pruebas

La suite específica cubre:

- modelos Prisma obligatorios;
- activación vencida;
- carrera de reclamo perdida;
- orden de la transacción exitosa;
- revocación de sesiones y dispositivo anterior;
- ausencia de token crudo;
- resolución con auxiliar y dispositivo activos;
- sesión ausente o carrera durante `lastSeenAt`;
- límites de reintento;
- migración exclusivamente expansiva;
- ausencia de rutas o integraciones externas.

## Rollback

Antes del despliegue, revertir el PR completo.

Después de aplicar la migración:

1. no eliminar la tabla automáticamente;
2. dejarla sin consumidores;
3. revertir el adaptador y cualquier consumidor futuro;
4. conservar registros de auditoría hasta definir una eliminación controlada.

## Próximo paso

Después de integrar esta persistencia se podrá crear, en un PR separado, el router público de activación que:

- reciba el token una sola vez;
- genere o lea el identificador de instalación;
- invoque la autoridad de #582 con este adaptador;
- coloque la cookie segura;
- redirija a una URL sin token;
- aplique `Cache-Control: no-store`.
