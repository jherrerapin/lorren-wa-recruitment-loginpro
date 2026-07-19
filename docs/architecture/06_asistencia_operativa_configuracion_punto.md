# Asistencia operativa: autoridad de configuración por punto

## Estado

Implementación relacionada con los issues #509 y #521. Continúa las entregas de persistencia (#515) y registro transaccional de llegada (#517).

Esta fase no incorpora rutas ni interfaz. La autoridad permanece sin consumidores productivos hasta el siguiente PR.

## Objetivo

Evitar que una ruta administrativa futura escriba directamente los campos de asistencia de `DispatchOperationPoint` sin validar coherencia.

La autoridad es:

```text
updateDispatchAttendancePointConfig(prisma, input)
```

ubicada en:

```text
src/modules/dispatch-attendance/application/updatePointConfig.js
```

## Campos bajo autoridad

La función puede actualizar exclusivamente:

- `attendanceEnabled`;
- `attendanceLatitude`;
- `attendanceLongitude`;
- `geofenceRadiusMeters`;
- `maxLocationAccuracyMeters`;
- `earlyArrivalWindowMinutes`;
- `lateToleranceMinutes`;
- `absenceGraceMinutes`;
- `attendanceTimezone`;
- `attendancePhotoPolicy`;
- `manualAttendanceAllowed`.

No puede cambiar nombre, ciudad, dirección, contacto, estado general, cliente ni token público del punto.

## Activación segura

Para dejar `attendanceEnabled = true` se requiere:

1. Punto existente y perteneciente al cliente indicado.
2. Punto general activo.
3. Latitud entre -90 y 90.
4. Longitud entre -180 y 180.
5. Radio de geocerca entre 20 y 2.000 metros.
6. Precisión máxima entre 5 y 500 metros.
7. Precisión máxima no superior al radio de geocerca.
8. Tolerancias enteras dentro de 0 a 240 minutos.
9. Minutos para ausencia iguales o posteriores a la tolerancia de tardanza.
10. Zona horaria soportada.
11. Política de fotografía soportada.

## Desactivación y limpieza

Desactivar asistencia no borra automáticamente la configuración. Esto permite apagar temporalmente un punto y reactivarlo después sin volver a capturar coordenadas.

La interfaz futura podrá limpiar explícitamente los valores enviando campos vacíos, pero solamente mientras `attendanceEnabled = false`.

## Booleanos

Los booleanos aceptan únicamente:

- valores JavaScript `true` y `false`;
- cadenas `true`, `false`, `1`, `0`, `on` y `off`.

Valores ambiguos como `yes`, objetos o arreglos se rechazan. La ruta futura deberá enviar campos ocultos para representar de manera explícita los checkboxes desmarcados.

## Política de fotografía

Catálogo inicial:

- `NEVER`: no solicitar evidencia fotográfica por política del punto;
- `RISK_ONLY`: solicitarla únicamente ante señales de riesgo;
- `ALWAYS`: solicitar evidencia en todas las marcaciones del punto.

Esta política define captura de evidencia, no reconocimiento facial. El MVP no compara rostros ni crea plantillas biométricas.

## Zona horaria

El primer alcance soporta únicamente `America/Bogota`. El catálogo está explícito para que una expansión futura agregue zonas de manera deliberada y probada.

## Límites operativos

Los límites son guardas iniciales de producto, no estándares geodésicos universales. Podrán ajustarse con datos del piloto mediante un PR específico y pruebas de regresión.

## Concurrencia

La configuración administrativa no requiere una transacción multitabla. La pertenencia se valida con `(id, clientId)` y la escritura usa el `id` encontrado.

La futura interfaz debe evitar múltiples envíos y mostrar el resultado persistido. Una evolución posterior puede incorporar control optimista con `updatedAt` si el piloto demuestra ediciones concurrentes reales.

## Pruebas

La suite cubre:

- activación válida;
- aislamiento de campos;
- coordenadas inválidas;
- geocerca incompleta;
- límites de radio, precisión y ventanas;
- relación entre tardanza y ausencia;
- punto inactivo;
- pertenencia cliente-punto;
- booleanos ambiguos;
- catálogos cerrados;
- desactivación conservando configuración;
- limpieza explícita mientras está desactivada.

## Siguiente PR

Conectar esta autoridad al formulario existente en **Clientes → Operaciones** mediante un router pequeño y una sección de configuración por punto. Ese PR deberá:

- importar esta autoridad;
- proteger la ruta con el permiso actual de Operaciones;
- enviar booleanos explícitos;
- mostrar errores sin perder los valores;
- no activar ningún punto automáticamente;
- no crear todavía rutas públicas de marcación.

## Rollback

Revertir los archivos de esta entrega. No existen migraciones, rutas ni consumidores runtime.
