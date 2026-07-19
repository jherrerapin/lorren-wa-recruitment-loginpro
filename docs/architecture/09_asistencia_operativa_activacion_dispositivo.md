# Asistencia operativa: autoridad de activación del dispositivo principal

## Estado

Implementación relacionada con los issues #509 y #533. Esta fase define contratos de dominio y aplicación sin persistencia productiva, rutas, WhatsApp o PWA.

## Objetivo

Emitir activaciones de un solo uso y convertir una instalación válida del Portal del Auxiliar en el dispositivo principal, sin guardar secretos crudos ni separar el consumo del token de la autorización del dispositivo.

## Token de activación

- se generan 32 bytes aleatorios mediante CSPRNG;
- se codifican como Base64URL sin padding;
- el token crudo se devuelve una sola vez;
- solamente se entrega al repositorio su SHA-256;
- el TTL predeterminado es 30 minutos;
- el TTL permitido está entre 5 minutos y 24 horas;
- una emisión nueva debe revocar activaciones pendientes anteriores del mismo auxiliar.

OWASP recomienda que los tokens de recuperación o activación sean aleatorios, suficientemente largos, almacenados de forma segura, de un solo uso y con vencimiento. Node.js ofrece `randomBytes()` como fuente criptográficamente segura.

## Identificador de instalación

El navegador generará un UUID v4 mediante `crypto.randomUUID()` bajo HTTPS. Este valor no se persiste directamente.

El servidor calcula:

```text
HMAC-SHA-256(ATTENDANCE_INSTALLATION_PEPPER, installationId)
```

El pepper debe permanecer en variables seguras del servidor y tener al menos 32 caracteres. El hash permite reconocer la instalación sin conservar el identificador original.

## Autoridades

### `issuePrimaryDeviceActivation()`

Exige dos operaciones del repositorio:

- `findActiveWorker(workerId)`;
- `replacePendingActivation(input)`.

La segunda debe revocar activaciones pendientes previas y crear la nueva dentro de una única transacción.

### `activatePrimaryDevice()`

Exige:

- `claimActivationAndAuthorizePrimaryDevice(input)`.

Esta operación debe ejecutarse atómicamente y:

1. reclamar un token pendiente, no vencido, no consumido y del propósito correcto;
2. marcarlo como consumido;
3. revocar el dispositivo principal anterior cuando exista;
4. crear o autorizar la nueva instalación como principal;
5. devolver trabajador, dispositivo y hora de activación.

La aplicación no debe implementar esos pasos como llamadas independientes porque una falla intermedia podría consumir el token sin autorizar el dispositivo o dejar dos dispositivos principales activos.

## Sesión futura

La activación del dispositivo no equivale todavía a una sesión web. La fase posterior deberá regenerar la sesión después de autenticación y usar cookies `Secure`, `HttpOnly` y `SameSite`, evitando guardar credenciales en `localStorage`.

## Fuera de alcance

- modelo Prisma de activaciones;
- migración;
- endpoint de activación;
- envío del enlace por WhatsApp;
- cookies del Portal del Auxiliar;
- GPS, cámara y llegada.

## Pruebas

La suite cubre entropía y formato, hash sin token crudo, revocación de emisiones anteriores, TTL, trabajador activo, consumo único, expiración, UUID, pepper, separación por secreto y contrato transaccional.

## Próximo paso

Crear persistencia aditiva para activaciones y un adaptador Prisma que implemente los tres métodos del repositorio. Después se podrá agregar la ruta de activación y la sesión del Portal del Auxiliar.

## Referencias

- Node.js Crypto: https://nodejs.org/api/crypto.html
- OWASP Forgot Password Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
- OWASP Session Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- MDN Crypto.randomUUID(): https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID

## Rollback

Revertir los archivos nuevos. No existen consumidores ni efectos productivos.
