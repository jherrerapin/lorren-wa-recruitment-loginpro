# Entorno DEV para probar asistencia y nómina

## Objetivo

Permitir que DEV cree jornadas controladas para comprobar el motor de horas sin utilizar ubicaciones, fotografías, notificaciones ni auxiliares reales.

## Solicitud de prueba

En **Operaciones → Crear solicitud**, DEV dispone del check **Solicitud de prueba**. Está activo inicialmente y puede desmarcarse para crear una solicitud operativa normal.

Una solicitud de prueba:

- usa `source = DEV_TEST`;
- no ejecuta autoasignación;
- no envía WhatsApp ni correo;
- solo admite auxiliares con `isTestProfile = true`;
- se administra en `/admin/operaciones/pruebas`;
- queda auditada.

## Jornada manual

Para cada asignación de prueba DEV puede escribir:

- entrada;
- inicio de almuerzo;
- regreso de almuerzo;
- salida del turno.

Las horas se reciben como fecha y hora de Bogotá. El servidor valida la secuencia y rechaza:

- salida anterior a la entrada;
- regreso de almuerzo sin inicio;
- almuerzo fuera de la jornada;
- regreso anterior al inicio.

La sesión se guarda como `DEV_TEST_MANUAL` y `MANUAL_VALIDATED`. Las marcas anteriores de esa misma prueba se reemplazan para permitir repetir escenarios.

Dejar ambos campos de almuerzo vacíos prueba una jornada sin almuerzo. Dejar solamente el regreso vacío prueba un almuerzo abierto y el descuento configurado.

## Aislamiento de Nómina

Los datos se excluyen de los reportes y exportaciones normales cuando se cumple cualquiera de estas condiciones:

- solicitud con `source = DEV_TEST`;
- auxiliar con `isTestProfile = true`;
- sesión con `source = DEV_TEST_MANUAL`.

Solo DEV puede incluirlos usando `includeTest=true`, normalmente desde el botón **Abrir Nómina con pruebas**.

## Permiso independiente

El permiso **Nómina y tiempo trabajado** se concede o retira por usuario desde DEV y se almacena mediante eventos auditados.

Activar Nómina:

- no activa Operaciones / Despacho;
- no activa Asistencia;
- no modifica permisos existentes.

Activar Operaciones o Asistencia tampoco concede Nómina. La ruta conserva su URL histórica, pero las guardas reconocen el permiso propio de Nómina antes de evaluar los módulos operativos.
