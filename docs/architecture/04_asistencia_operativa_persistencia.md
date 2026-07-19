# Asistencia operativa: persistencia aditiva

## Estado

Diseño de persistencia relacionado con los issues #509 y #514.

Esta fase únicamente amplía el esquema Prisma y agrega una migración versionada. No crea rutas, formularios, tareas automáticas ni consumidores runtime. La asistencia permanece desactivada en todos los puntos mediante `attendanceEnabled = false`.

## Objetivo

Separar el ciclo de asistencia del ciclo actual de asignación y confirmación de despacho.

`DispatchAssignment.status` continúa representando la asignación del auxiliar y su disponibilidad. La presencia física se almacenará en `DispatchAttendanceSession` y sus entidades relacionadas.

## Cambios de esquema

### Configuración del punto

`DispatchOperationPoint` recibe campos opcionales o con valores seguros para:

- activar asistencia;
- guardar coordenadas;
- definir radio de geocerca;
- limitar la precisión aceptable;
- establecer ventanas de llegada y ausencia;
- configurar zona horaria;
- definir la política de fotografía;
- permitir o impedir registros manuales.

Los puntos existentes quedan con asistencia desactivada y no requieren actualización de datos.

### Sesión por asignación

`DispatchAttendanceSession` representa una única asistencia para una asignación.

La restricción única sobre `assignmentId` evita crear dos sesiones para la misma asignación. Sus estados son independientes de `DispatchAssignment.status`.

### Marcaciones

`DispatchAttendanceMark` conserva cada intento recibido. `idempotencyKey` impide que un reintento de red cree dos registros para la misma solicitud.

Las coordenadas, precisión, distancia, decisión y señales de riesgo quedan preparadas para fases posteriores. La hora oficial será `serverReceivedAt`.

Las fotografías no se guardan como `Bytes`; solo se almacena una referencia futura mediante `evidenceStorageKey` y su tipo MIME.

### Dispositivos

`DispatchWorkerDevice` asocia instalaciones con auxiliares.

La combinación `(workerId, installationIdHash)` es única, pero el hash no es globalmente único. Esto permite detectar que una misma instalación apareció vinculada a varios auxiliares en vez de ocultar el evento mediante un error de unicidad.

### Revisión

`DispatchAttendanceReview` es un registro de auditoría append-only para correcciones manuales. Conserva estados anteriores, estados nuevos, actor, motivo y metadatos.

## Integridad referencial

Las relaciones desde sesiones, marcaciones, dispositivos y revisiones usan `RESTRICT` cuando borrar el padre eliminaría evidencia operativa. La referencia opcional desde una marcación hacia un dispositivo usa `SET NULL` para conservar la marcación aunque el dispositivo deje de estar disponible.

Consecuencia futura: una asignación con sesión de asistencia no debe eliminarse físicamente. La funcionalidad de desasignación tendrá que cambiar a una transición auditable antes de activar asistencia en producción. Este PR no crea sesiones y, por tanto, no modifica todavía el comportamiento actual.

## Despliegue

1. Revisar el SQL de la migración.
2. Ejecutar `npx prisma validate` y `npm run build` en CI.
3. Ensayar `prisma migrate deploy` sobre una base aislada con una copia estructural, sin datos personales.
4. Verificar que los puntos existentes tengan `attendanceEnabled = false`.
5. Desplegar la migración mediante el flujo habitual de Railway.
6. No habilitar puntos hasta que existan rutas, autenticación, permisos y pruebas de marcación.

Prisma diferencia los comandos de desarrollo y producción. La migración versionada debe desplegarse con `prisma migrate deploy`; no se debe ejecutar `prisma migrate dev` ni `prisma migrate reset` sobre producción.

## Verificaciones posteriores

- Las tablas nuevas existen.
- Los índices únicos de sesión e idempotencia existen.
- No se crearon sesiones retroactivas.
- Ningún punto quedó habilitado.
- Las solicitudes, asignaciones y confirmaciones actuales continúan funcionando.
- El servidor inicia y Prisma Client se genera correctamente.

## Rollback

El rollback inmediato es operativo:

- mantener `attendanceEnabled = false`;
- no desplegar consumidores runtime;
- revertir el código si todavía no se aplicó la migración.

Si la migración ya fue aplicada, no ejecutar automáticamente `DROP TABLE` o `DROP COLUMN`. Las estructuras son aditivas y no afectan el flujo actual; pueden permanecer sin uso hasta una ventana controlada de mantenimiento. Una eliminación futura debe tener issue, respaldo y migración independiente.

## Fuera de alcance

- Portal del auxiliar.
- GPS y cámara reales.
- Registro de entrada o salida.
- Autorización de dispositivos.
- Revisión desde dashboard.
- Detección de ausencias.
- Reemplazos.
- Cálculo de horas o nómina.
- Reconocimiento facial.
