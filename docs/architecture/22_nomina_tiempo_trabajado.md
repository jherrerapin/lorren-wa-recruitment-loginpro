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

No se redondea cada jornada antes de consolidar. Primero se suman los minutos del periodo y luego se generan las horas decimales con hasta cuatro decimales.

## Periodos

El portal permite:

- semanal: lunes a domingo;
- quincenal: días 1 a 15 o 16 al último día del mes;
- personalizado: máximo 62 días.

Para calcular correctamente un corte quincenal o personalizado, la consulta incorpora hasta seis días anteriores al inicio visible. Esos minutos no se exportan, pero sí se utilizan para saber cuánto llevaba trabajado el auxiliar en la semana que cruza el límite del corte.

## Política por cliente

DEV puede configurar por cliente:

- horas ordinarias semanales;
- horas ordinarias diarias;
- máximo de horas extra diarias y semanales;
- inicio y final de jornada nocturna;
- primer día de la semana;
- día de descanso obligatorio;
- reconocimiento de llegada anticipada;
- descuento por almuerzo iniciado sin regreso;
- prioridad cuando un domingo también es festivo.

La política se conserva mediante eventos auditados `DISPATCH_PAYROLL_POLICY`. La política inicial queda versionada como `CO-2026-07`.

## Clasificación

El motor recorre cada minuto efectivo de las jornadas y mantiene acumulados diarios y semanales. Separa:

- ordinario o extra;
- diurno o nocturno;
- ordinario, descanso obligatorio o festivo;
- compensado o no compensado.

Conceptos producidos:

- HEDO, HENO, HEDD, HEND, HEDF, HENF;
- RNO;
- RDD, RND, RDF, RNF;
- RDDC, RNDC, RDFC, RNFC.

Una fracción se asigna a un único concepto. Por ejemplo, una hora extra nocturna dominical se reporta como HEND y no se duplica en HENO, RNO o RND.

## Almuerzo

- Almuerzo completo: se restan los minutos realmente transcurridos entre inicio y regreso.
- Sin almuerzo: no se descuenta tiempo.
- Almuerzo abierto: se aplica el descuento configurado, inicialmente 90 minutos, y se crea una novedad bloqueante para revisión.

## Novedades

El módulo identifica, entre otras:

- jornada incompleta;
- jornada sin validación administrativa o automática;
- tiempo guardado diferente al calculado;
- almuerzo abierto;
- jornadas superpuestas;
- exceso del límite extra diario;
- exceso del límite extra semanal;
- compensatorio pendiente.

La tabla y los archivos muestran el estado y las novedades. En esta primera etapa se permite descargar el archivo para pruebas, pero cada fila conserva `Estado` y `Novedades` para impedir que se confunda un cálculo provisional con uno listo para pago.

## Compensatorios

El portal permite marcar por auxiliar y fecha:

- pendiente;
- no compensado;
- compensado.

La decisión queda auditada en `DISPATCH_PAYROLL_COMPENSATION`. Mientras esté pendiente, la fila se considera con novedades.

## Exportaciones

Se ofrecen:

- CSV separado por punto y coma y codificado para Excel;
- Excel `.xlsx` con encabezados, filtro y horas decimales.

Cada fila incluye identificación, rango, horas ordinarias, total trabajado, horas extra, los quince códigos, estado y novedades.

## Alcance de esta entrega

La entrega calcula y exporta cantidades de horas. No liquida dinero ni aplica el salario del auxiliar. La aplicación de porcentajes y valores monetarios queda fuera del motor hasta conocer el formato definitivo del proveedor de nómina.
