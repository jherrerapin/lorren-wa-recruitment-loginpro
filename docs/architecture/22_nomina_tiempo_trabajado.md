# Nómina y tiempo trabajado

## Objetivo

El módulo transforma las marcaciones validadas de Asistencia en horas acumuladas por auxiliar y en conceptos compatibles con el proceso de nómina. La fuente de verdad continúa siendo el tiempo en minutos; la conversión a horas decimales ocurre solamente al mostrar o exportar.

## Acceso

- DEV puede entrar siempre.
- Los demás usuarios no reciben acceso por defecto.
- DEV concede o retira el permiso desde la configuración de usuarios.
- Conceder Nómina activa también Operaciones / Despacho y Asistencia operativa, porque el reporte depende de esos módulos.
- Retirar Nómina no elimina automáticamente otros permisos que el usuario ya tenga.
- El permiso queda registrado como evento auditado `APP_USER_PAYROLL_ACCESS`.
- El enlace de Nómina se inyecta únicamente cuando el permiso efectivo está activo.
- La ruta está anidada bajo `/admin/operaciones/asistencia/nomina`, por lo que también atraviesa la autorización del módulo de Asistencia.

## Unidad de cálculo

Todos los cálculos internos usan minutos enteros:

```text
7 h 30 min = 450 minutos
450 / 60 = 7.5 horas
```

No se redondea cada jornada antes de consolidar. Primero se suman los minutos del periodo y luego se generan las horas decimales.

## Periodos

Nómina combina dos ventanas independientes en un único resultado.

El **periodo general** ofrece:

- primera quincena: días 1 a 15;
- segunda quincena: día 16 al último día del mes;
- personalizado: un día o un rango de máximo 62 días.

El **periodo de horas extras** ofrece:

- semanal: lunes a domingo a partir de la fecha seleccionada;
- personalizado: un día o un rango de máximo 62 días.

Cambiar una ventana no modifica la otra. La fila final por auxiliar conserva días remunerados/no remunerados, permisos, incapacidades, turnos, domingos, festivos, total trabajado, ordinarias y recargos `R*` del periodo general, mientras `Horas extra` y `HEDO`, `HENO`, `HEDD`, `HEND`, `HEDF`, `HENF` provienen exclusivamente del periodo de horas extras. Un auxiliar con actividad relevante solo en la ventana de extras puede aparecer una vez con métricas generales en cero y sus `H*` correspondientes.

La semana de Nómina es una regla fija de lunes a domingo. Las políticas históricas que hayan guardado domingo como inicio se normalizan a lunes al leerse, sin migración de datos.

Para conciliar correctamente cada una de las dos ventanas, `loadPayrollReport()` carga la semana completa de lunes a domingo que toque cada extremo del rango solicitado. Los días fuera de la ventana visible no se muestran ni se exportan como parte de esa ventana, pero sí participan en el balance entre excesos diarios y faltantes diarios de la misma semana. La semana es una **ventana de conciliación**; no existe un umbral de 42 horas que por sí solo cree o elimine horas extra.

La composición de ambos resultados no reclasifica minutos. El motor canónico se ejecuta con cada rango y el adaptador de Nómina sustituye únicamente los campos `H*` y el total de extras por los calculados para la ventana de horas extras; los `R*` y los contadores generales permanecen en su corte original. Las novedades del periodo de extras también se conservan para no ocultar un bloqueo de esa ventana.

El detalle diario sigue exactamente la misma propiedad de métricas que la fila consolidada. Para una fecha presente en ambos resultados existe una sola fila diaria: `Total`, `Ordinarias`, contexto general y `R*` provienen del periodo general, mientras `Extra`, extra no reconocida y `H*` provienen del periodo de extras. Una fecha que solo pertenezca al periodo general conserva sus datos generales y muestra en cero los `H*` que queden fuera del filtro de extras. Una fecha relevante únicamente por extras puede aparecer para explicar esos `H*` y conservar la trazabilidad de marcaciones, pero sus métricas generales y `R*` quedan en cero y no habilita una acción de compensatorio fuera del periodo general. Las novedades fechadas del periodo de extras se asocian a esa misma fecha cuando corresponda. Esta composición es deliberadamente por familias de campos: no debe interpretarse como si `Total` y `Extra` pertenecieran necesariamente a la misma ventana de fechas.

## Política por cliente

La referencia operativa de jornada es fija en **7 horas diarias** para el balance de extras. Los valores históricos de horas ordinarias semanales pueden seguir leídos/persistidos por compatibilidad, pero no gobiernan la clasificación de horas extra.

DEV puede configurar por cliente:

- máximo de horas extra diarias y semanales;
- inicio y final de jornada nocturna;
- día de descanso obligatorio;
- reconocimiento de llegada anticipada;
- descuento por almuerzo iniciado sin regreso.

No son configurables el inicio de semana ni la prioridad entre festivo y descanso: la semana siempre inicia el lunes y un día reconocido por el calendario colombiano se presenta como festivo. La política se conserva mediante eventos auditados `DISPATCH_PAYROLL_POLICY`. La política inicial queda versionada como `CO-2026-07`.

## Clasificación y balance de horas extra

El motor recorre cada minuto efectivo de las jornadas. Para cada día **que sí tuvo tiempo trabajado**, usa 420 minutos como referencia:

```text
exceso_día  = max(0, minutos_trabajados - 420)
faltante_día = max(0, 420 - minutos_trabajados)
```

Un día sin jornada trabajada no inventa automáticamente siete horas de faltante. Ausencias, suspensiones, permisos, incapacidades y compensatorios conservan sus autoridades propias; no se convierten aquí en un déficit horario artificial.

Dentro de cada semana lunes a domingo:

1. los minutos posteriores a las primeras 7 horas de cada día forman el pool candidato de horas extra;
2. los faltantes de los demás días trabajados por debajo de 7 horas consumen ese pool;
3. el descuento se aplica únicamente sobre conceptos de hora extra y en este orden: `HEDO → HENO → HEDD → HEND → HEDF → HENF`;
4. nunca se descuentan recargos `R*`;
5. cuando un minuto candidato deja de ser extra por cubrir un faltante, vuelve a su clasificación ordinaria y conserva el recargo nocturno, dominical o festivo que corresponda;
6. solo el remanente **mayor a 30 minutos** se reconoce como hora extra. Un remanente de 30 minutos o menos no aparece como `H*`.

Ejemplos:

```text
10 h + 6 h + 6 h
exceso: 3 h
faltante: 2 h
extra final: 1 h

10 h + 6 h + 6 h + 6 h
exceso: 3 h
faltante: 3 h
extra final: 0 h
```

Los límites configurados de extra diaria y semanal continúan siendo validaciones sobre el **resultado reconocido**; no son el criterio que origina la hora extra.

Además el motor separa:

- diurno o nocturno;
- ordinario, descanso obligatorio o festivo;
- compensado o no compensado únicamente cuando el minuto corresponde al día de descanso obligatorio.

La franja nocturna del motor es 19:00–06:00. La clasificación de descanso/festivo se hace sobre la fecha y hora civil de cada minuto en `America/Bogota`; por eso un turno que cruza medianoche puede cambiar de concepto al comenzar el día siguiente, pero sigue perteneciendo a una sola jornada operativa para el balance de 7 horas, tomando como referencia la fecha de inicio de la jornada.

Conceptos producidos:

- HEDO, HENO, HEDD, HEND, HEDF, HENF;
- RNO;
- RDD, RND, RDF, RNF;
- RDDC, RNDC.

`RDFC` y `RNFC` fueron retirados del contrato de conceptos: un festivo ordinario se reporta como `RDF` o `RNF` y se identifica además con el indicativo `Festivo`. No existen columnas ni generación nueva para conceptos festivos compensados.

Una fracción se asigna a un único concepto. Por ejemplo, una hora extra nocturna en el día de descanso obligatorio se reporta como HEND y no se duplica en HENO, RNO o RND.

## Almuerzo

- Almuerzo completo: se restan los minutos realmente transcurridos entre inicio y regreso una sola vez; el tiempo efectivo resultante es el que se compara con la referencia diaria de 7 horas.
- Sin almuerzo: no se descuenta tiempo.
- Almuerzo abierto: se aplica el descuento configurado, inicialmente 90 minutos, y se crea una novedad bloqueante para revisión.

## Novedades

El módulo identifica, entre otras:

- jornada incompleta;
- jornada sin validación administrativa o automática;
- tiempo guardado diferente al calculado;
- almuerzo abierto;
- jornadas superpuestas;
- remanente candidato que no supera el umbral mínimo de reconocimiento;
- exceso del límite extra diario;
- exceso del límite extra semanal;
- compensatorio pendiente exclusivamente para el día de descanso obligatorio.

Un festivo no genera `COMPENSATION_PENDING`. La tabla conserva el estado y el detalle de novedades para revisión operativa. El Excel `.xlsx` descargable no incluye columnas `Estado` ni `Novedades`; retirarlas es una decisión de presentación y no elimina el estado ni las novedades del cálculo o del runtime.

## Compensatorios

El compensatorio se administra únicamente para el día de descanso obligatorio. El portal permite marcar por auxiliar y fecha:

- pendiente;
- no compensado;
- compensado.

La decisión queda auditada en `DISPATCH_PAYROLL_COMPENSATION`. Mientras un día de descanso obligatorio esté pendiente, la fila se considera con novedades.

Los festivos no usan este flujo: se muestran con el indicativo `Festivo`, sus minutos se clasifican como festivos y el backend rechaza nuevos intentos de guardar un estado de compensatorio para esa fecha. Eventos históricos de compensatorio asociados a un festivo no gobiernan el cálculo actual.

## Calendario

Los rangos personalizados del periodo general y de horas extras usan un **solo calendario por selección**, sin campos visibles separados `Desde` / `Hasta`. Un primer día puede aplicarse como fecha única; una segunda selección define el rango. El modo semanal de extras toma la fecha elegida y resuelve la semana completa lunes–domingo.

El calendario no depende de librerías externas. La cabecera siempre se ordena:

`Lun · Mar · Mié · Jue · Vie · Sáb · Dom`

Esto evita depender del primer día de semana que el navegador o el sistema operativo elijan para un `<input type="date">` nativo.

## Exportaciones

Se ofrecen:

- CSV separado por punto y coma y codificado para Excel mediante el endpoint heredado;
- Excel `.xlsx` con encabezados, filtro y horas decimales.

El botón **Excel** abre primero un personalizador. Desde allí se puede elegir:

- uno o varios auxiliares que ya formen parte del cálculo visible;
- las columnas de identificación y corte;
- días, permisos, incapacidades, turnos y descansos;
- horas ordinarias, total trabajado y total de extras;
- conceptos `H*` de horas extra;
- conceptos `R*` de recargo.

Todas las opciones aparecen marcadas inicialmente, por lo que el usuario puede obtener el mismo contenido completo que antes o reducirlo a lo estrictamente necesario. La selección de auxiliares es únicamente una proyección del reporte ya calculado: no vuelve a clasificar horas ni permite incorporar una persona que esté fuera de los filtros actuales.

La lista de columnas permitidas vive en la misma autoridad que construye el XLSX, `src/routes/dispatchPayroll.js`. El servidor ignora claves de columna que no estén en esa lista y no permite generar una descarga personalizada sin al menos una columna; cuando el reporte contiene filas también exige al menos un auxiliar válido. `Estado` y `Novedades` continúan fuera del XLSX y no aparecen como opciones seleccionables.

La exportación usa exactamente el mismo resultado combinado que la tabla: rango general para contadores, ordinarias y `R*`, y rango independiente de extras para `HorasExtraTotal` y `H*`. El encabezado del XLSX identifica ambos rangos. El endpoint CSV heredado conserva su contrato actual y no se muestra como botón en la interfaz.

## Alcance de esta entrega

La entrega calcula y exporta cantidades de horas. No liquida dinero ni aplica el salario del auxiliar. La aplicación de porcentajes y valores monetarios queda fuera del motor hasta conocer el formato definitivo del proveedor de nómina.