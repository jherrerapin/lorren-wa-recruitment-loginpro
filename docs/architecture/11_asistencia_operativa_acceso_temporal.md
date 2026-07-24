# Asistencia operativa: permiso individual administrado por DEV

## Política

La función de Asistencia se rige por denegación predeterminada y menor privilegio:

- `DEV` conserva acceso completo;
- un usuario `ADMIN` solo puede entrar cuando su registro activo en `AppUser` tenga `canAccessAttendance = true`;
- el permiso se concede o retira únicamente desde el panel de Usuarios por una sesión `DEV`;
- conocer o escribir una URL directa no evita la autorización del servidor.

El permiso anterior, basado en un interruptor global temporal para `reclutador-general`, deja de ser autoridad. Los eventos históricos pueden conservarse como auditoría, pero no conceden acceso.

## Alcance del permiso

`canAccessAttendance` protege conjuntamente:

- el botón y el panel de Asistencia;
- revisión, validación, rechazo y corrección manual auditada;
- consulta de fotografías y evidencia;
- visualización de ubicación, geocerca y precisión;
- geocodificación interna;
- configuración de asistencia en los puntos operativos.

Como Asistencia pertenece a Operaciones / Despacho, habilitarla también deja activo `canAccessDispatch`. No modifica ciudades, vacantes ni alcance de reclutamiento.

## Funciones reservadas a DEV

La emisión de enlaces de activación del Portal del Auxiliar permanece exclusivamente para `DEV`. Esos enlaces autorizan un dispositivo primario y no forman parte del permiso administrativo ordinario de revisión de asistencia.

## Autoridad

`src/services/attendanceFeatureAccess.js` es la autoridad única. Para usuarios no DEV consulta el registro vigente de `AppUser` por username y exige simultáneamente:

1. rol de sesión `admin`;
2. usuario existente;
3. usuario activo;
4. rol persistido `ADMIN`;
5. `canAccessAttendance` estrictamente verdadero.

Ante errores de persistencia, ausencia de identidad o campos faltantes, el acceso se deniega.

## Persistencia y sesión

La columna `AppUser.canAccessAttendance` inicia en `false`. El login la copia a la sesión y `dispatchAuditMiddleware` la refresca desde base de datos en cada solicitud administrativa relevante, por lo que una revocación no depende de que el usuario cierre sesión.

## Interfaz DEV

El panel de Usuarios muestra Asistencia dentro de `Permisos del panel`, tanto al crear como al editar. Los checkboxes no se renderizan para administradores no DEV y el backend ignora cualquier intento de esos actores por enviar manualmente los campos de permisos.

## Protección en servidor

`requireAttendanceAccess` se ejecuta en el panel, geocodificación y configuración por punto. Ocultar el botón es solo una ayuda visual; la decisión efectiva siempre se toma en el servidor.

## Rollback

Revertir el PR retira la autoridad y la UI nuevas. Si la migración ya fue aplicada, la columna puede permanecer sin uso durante el rollback; no contiene datos operativos ni modifica asistencias existentes.
