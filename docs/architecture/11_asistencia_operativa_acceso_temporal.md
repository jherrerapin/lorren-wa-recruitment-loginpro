# Asistencia operativa: acceso temporal controlado por DEV

## Objetivo

Mientras se estabiliza la nueva función de asistencia, la configuración por punto queda visible y funcional únicamente para `dev`.

El perfil protegido `reclutador-general` puede recibir acceso temporal mediante un interruptor visible solo para `dev`. Cualquier otro reclutador permanece bloqueado aunque tenga permiso general para entrar a Operaciones / Despacho.

## Estado inicial

El interruptor es temporal y se representa mediante eventos append-only en `DevAuditEvent`:

- `ATTENDANCE_RECRUITER_GENERAL_ENABLED`;
- `ATTENDANCE_RECRUITER_GENERAL_DISABLED`.

La consulta toma únicamente el evento más reciente de la familia exacta `FEATURE_ACCESS` y la etiqueta `Asistencia operativa para reclutador-general`.

La ausencia de eventos se interpreta como deshabilitado. Por tanto, después del despliegue:

- `dev`: acceso permitido;
- `reclutador-general`: acceso denegado;
- otros perfiles: acceso denegado.

No se requiere migración para este control temporal y no se utiliza `BotKnowledge`, porque esa tabla pertenece al contexto curado del bot.

## Autoridad

`src/services/attendanceFeatureAccess.js` es la única autoridad del interruptor.

### Consulta

`resolveAttendanceFeatureAccess()` aplica las reglas:

1. `dev` siempre puede entrar;
2. solo el username exacto `reclutador-general` puede heredar el interruptor;
3. el usuario debe existir, estar activo y conservar rol `ADMIN`;
4. los demás perfiles se rechazan sin consultar eventos ni usuarios adicionales;
5. si falla la persistencia, el middleware niega el acceso.

### Actualización

`setRecruiterGeneralAttendanceEnabled()`:

- exige un booleano real;
- exige actor con rol `dev`;
- comprueba la existencia del perfil protegido;
- lee el estado anterior dentro de la transacción;
- agrega un nuevo `DevAuditEvent` con estado anterior, estado nuevo, actor, IP, ruta y agente de usuario;
- nunca modifica el rol, el alcance o los demás permisos del usuario.

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

Los eventos históricos pueden conservarse como auditoría aunque la autoridad temporal deje de utilizarse.
