# Portal del Auxiliar: salida y horas netas

## Objetivo

Completar la jornada iniciada con la marcación de llegada mediante una marcación de salida, conservando las mismas garantías de propiedad de asignación, dispositivo, geocerca, evidencia, idempotencia y funcionamiento offline.

## Referencia funcional

GeoVictoria configura la colación como parte del turno. Puede ser inexistente, libre por una duración total o fija con inicio y fin. La primera entrega de Lórren implementa la alternativa libre: el administrador define una duración no remunerada y el sistema la descuenta entre la primera llegada y la salida final.

## Estados

1. Antes de la llegada: `Registrar llegada`.
2. Después de la llegada: `Registrar salida`.
3. Después de la salida: jornada finalizada y tiempo neto visible.

No se permite salida sin llegada, salida anterior a la llegada ni una segunda salida. La misma clave de idempotencia reproduce el resultado sin duplicar la marca.

## Cálculo

- tiempo bruto = salida reportada - llegada reportada;
- descanso descontado = mínimo entre minutos configurados y tiempo bruto;
- tiempo neto = tiempo bruto - descanso descontado.

`DispatchAttendanceSession.workedMinutes` conserva el resultado neto. El tiempo bruto y el descuento histórico se reconstruyen con las dos marcas y el valor neto persistido, por lo que un cambio posterior de política no reescribe la jornada ya cerrada.

## Política de descanso

La tabla SQL administrada `DispatchAttendanceBreakPolicy` se relaciona uno a uno con `DispatchServiceRequest` y aplica denegación de descuento por defecto:

- `NONE`: 0 minutos;
- `FLEXIBLE`: entre 1 y 240 minutos no remunerados.

El panel de Asistencia permite modificarla antes de la salida. Esta tabla se encapsula detrás de `dispatchAttendanceBreakPolicyRepository.js`; no se accede desde vistas ni desde el navegador.

## Jornadas nocturnas

El cálculo usa fechas absolutas. `buildDispatchAttendanceExpectedWindow()` ya lleva el final al día siguiente cuando `endTime <= startTime`, evitando separar incorrectamente una salida posterior a medianoche.

## Seguridad

La salida exige:

- sesión vigente del Portal del Auxiliar;
- asignación perteneciente al `workerId` de la sesión;
- llegada previa;
- dispositivo activado;
- ubicación y precisión;
- selfie cuando la política del punto la exige;
- consentimiento para la fotografía;
- clave idempotente.

La evidencia se almacena en una ruta separada `departure/`. Una salida offline conserva hora, GPS y selfie localmente; al sincronizarse siempre requiere revisión por no disponer de una fuente horaria web protegida.

## Panel administrativo

La tarjeta comprimida muestra llegada, salida y tiempo neto. Al desplegarla muestra:

- tiempo bruto;
- descanso descontado;
- tiempo neto pagable;
- política configurada;
- fotografía de llegada;
- fotografía de salida;
- señales de geocerca, precisión y revisión.

## Alcance laboral

El módulo calcula tiempo operativo neto. No determina por sí solo horas extra, recargos nocturnos, dominicales o festivos, porque esos conceptos requieren reglas legales y contractuales adicionales, acumulados semanales, calendario y autoridad de nómina.

## Fase posterior

- colación fija con horario esperado;
- marcas `BREAK_START` y `BREAK_END`;
- alertas por salida faltante;
- corrección administrativa de salida;
- cierre de periodos y exportación a nómina;
- aplicación Android con reloj monotónico y firma del dispositivo.
