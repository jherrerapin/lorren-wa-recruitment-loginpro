# Asistencia operativa: acceso temporal controlado por DEV

## Objetivo

Mientras se estabiliza la nueva función de asistencia, la configuración por punto queda visible y funcional únicamente para `dev`.

El perfil protegido `reclutador-general` puede recibir acceso temporal mediante un interruptor visible solo para `dev`. Cualquier otro reclutador permanece bloqueado aunque tenga permiso general para entrar a Operaciones / Despacho.

## Estado inicial

El interruptor se conserva en `BotKnowledge` con la clave:

```text
feature.attendance.recruiter_general.enabled
```

La ausencia de la clave, un valor desconocido o cualquier valor diferente de `true` se interpreta como deshabilitado.

Por tanto, después del despliegue:

- `dev`: acceso permitido;
- `reclutador-general`: acceso denegado;
- otros perfiles: acceso denegado.

No se requiere migración para este control temporal.

## Autoridad

`src/services/attendanceFeatureAccess.js` es la única autoridad del interruptor.

### Consulta

`resolveAttendanceFeatureAccess()` aplica las reglas:

1. `dev` siempre puede entrar;
2. solo el username exacto `reclutador-general` puede heredar el interruptor;
3. el usuario debe existir, estar activo y conservar rol `ADMIN`;
4. los demás perfiles se rechazan sin consultar el interruptor.

### Actualización

`setRecruiterGeneralAttendanceEnabled()`:

- exige un booleano real;
- exige actor con rol `dev`;
- comprueba la existencia del perfil protegido;
- actualiza la clave dentro de una transacción;
- crea un `DevAuditEvent` con estado anterior, estado nuevo, actor, IP, ruta y agente de usuario.

## Protección en servidor

La ruta existente:

```text
POST /admin/operaciones/clientes/:clientId/operaciones/:operationId/asistencia
```

ahora exige dos controles independientes:

1. acceso general a Operaciones;
2. acceso temporal a la función de asistencia.

Ocultar el formulario no concede seguridad por sí mismo. Una solicitud construida manualmente continúa bloqueada mediante `requireAttendanceAccess`.

## Interfaz

En la página de operaciones del cliente:

- una persona sin acceso no recibe el bloque `Configurar asistencia`;
- `dev` conserva el bloque y recibe una tarjeta de control temporal;
- el botón alterna entre habilitar y deshabilitar a `reclutador-general`;
- `reclutador-general`, cuando está habilitado, recibe el formulario pero nunca el botón DEV.

El interruptor no modifica el rol, las ciudades, las vacantes ni el permiso general de Operaciones.

## Alcance preservado

Este cambio no:

- habilita asistencia para ningún punto;
- publica un portal del auxiliar;
- crea una ruta pública de llegada;
- captura GPS o fotografías;
- modifica asignaciones, cobertura o WhatsApp;
- cambia `DispatchAssignment.status`;
- modifica Railway;
- introduce reconocimiento facial.

## Reactivación futura

Cuando la función sea estable, el control temporal puede reemplazarse por un permiso dedicado en `AppUser` o ampliarse a otros perfiles. La ruta y la interfaz deben seguir consultando una autoridad del servidor; no debe eliminarse la protección dejando únicamente condiciones visuales.

## Rollback

Revertir:

- `src/services/attendanceFeatureAccess.js`;
- el gate agregado en `src/routes/dispatchBridge.js`;
- las pruebas y este documento.

La clave temporal puede permanecer en `BotKnowledge` sin consumidores. No requiere eliminación destructiva.
