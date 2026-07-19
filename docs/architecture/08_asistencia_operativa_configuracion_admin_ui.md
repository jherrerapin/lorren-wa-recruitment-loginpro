# Asistencia operativa: montaje y formulario administrativo

## Estado

Implementación relacionada con los issues #509, #527 y #531. Consume la autoridad integrada en #522 y el router aislado integrado en #529.

## Objetivo

Permitir configurar asistencia por punto desde **Clientes → Operaciones**, sin publicar todavía una ruta de marcación para auxiliares.

## Fachada de compatibilidad

El archivo histórico `dispatchBridge.js` concentraba muchas rutas y estaba minificado en varios tramos. Para evitar una reescritura amplia:

- su contenido vigente se conserva sin cambios en `dispatchBridgeCore.js`;
- `dispatchBridge.js` se convierte en una fachada pequeña;
- la fachada monta primero la configuración de asistencia;
- después delega todas las rutas existentes al núcleo conservado.

La separación no cambia URLs ni comportamiento previo del módulo.

## Ruta administrativa

```text
POST /admin/operaciones/clientes/:clientId/operaciones/:operationId/asistencia
```

La fachada coloca el subrouter detrás de `requireOps`. El router hijo usa `mergeParams: true` para recibir `clientId` y `operationId`.

## Formulario

Cada operación muestra una sección desplegable con:

- estado habilitado o deshabilitado;
- latitud y longitud;
- radio de geocerca;
- precisión máxima GPS;
- ventana anticipada;
- tolerancia de tardanza;
- tiempo para declarar ausencia;
- zona horaria;
- política de fotografía;
- permiso de registro manual auditado.

Los checkboxes incluyen un fallback oculto `false` y envían `true` únicamente cuando están marcados.

## Validación

Los atributos HTML `type="number"`, `min`, `max` y `step` ayudan a capturar valores correctos, pero la autoridad definitiva sigue en el servidor mediante `updateDispatchAttendancePointConfig()`.

## Seguridad funcional

- la ruta requiere acceso a Operaciones;
- el punto debe pertenecer al cliente;
- no hay escritura Prisma directa en el router;
- no existe ruta pública de llegada;
- no se activa ningún punto automáticamente;
- no se modifica `DispatchAssignment.status`;
- no se aplican migraciones ni cambios en Railway.

## Pruebas

La suite contractual verifica:

- delegación exclusiva en la autoridad;
- montaje detrás de `requireOps`;
- conservación del núcleo de rutas;
- booleanos explícitos;
- límites HTML coherentes;
- ausencia de marcación pública.

## Próximo paso

La siguiente fase será la activación segura del auxiliar y el registro del dispositivo principal. La marcación pública solo debe habilitarse después de tener autenticación, sesión persistente e idempotencia extremo a extremo.

## Rollback

Restaurar `dispatchBridge.js` desde `dispatchBridgeCore.js`, retirar la sección visual y conservar autoridad, router y esquema sin consumidores.
