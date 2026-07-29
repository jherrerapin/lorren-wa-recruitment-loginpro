# Entorno DEV para probar asistencia, nómina y WhatsApp

## Objetivo

Permitir que DEV cree escenarios controlados para comprobar el motor de horas y el comportamiento de WhatsApp de despacho sin utilizar ubicaciones, fotografías, líneas ni auxiliares reales.

## Solicitud de prueba

En **Operaciones → Crear solicitud**, DEV dispone del check **Solicitud de prueba**. Está activo inicialmente y puede desmarcarse para crear una solicitud operativa normal.

Una solicitud de prueba:

- usa `source = DEV_TEST`;
- no ejecuta autoasignación;
- no envía notificaciones automáticamente;
- solo admite auxiliares con `isTestProfile = true`;
- se administra en `/admin/operaciones/pruebas`;
- queda auditada.

## Jornada manual y cálculo inmediato

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

Después de guardar, el propio entorno DEV ejecuta `loadPayrollReport` con el motor real de Nómina y muestra:

- total trabajado;
- tiempo ordinario;
- horas extra;
- conceptos HEDO, HENO, dominicales, festivos y recargos;
- novedades que impidan exportar.

El rango se construye con las fechas reales de entrada y salida, incluyendo turnos que cruzan medianoche.

## Aislamiento de Nómina

Los datos se excluyen de los reportes y exportaciones normales cuando se cumple cualquiera de estas condiciones:

- solicitud con `source = DEV_TEST`;
- auxiliar con `isTestProfile = true`;
- sesión con `source = DEV_TEST_MANUAL`.

Solo DEV puede incluirlos usando `includeTest=true`. El formulario de Nómina conserva ese valor mediante el check **Incluir datos de prueba**, incluso después de recalcular, modificar políticas, registrar compensatorios o exportar.

## Segunda cuenta de WhatsApp

El entorno DEV permite vincular una segunda cuenta usando la misma tecnología existente: `whatsapp-web.js`, `Client`, `LocalAuth`, Chromium y las mismas reglas de interpretación de confirmaciones.

La sesión de prueba se separa mediante:

- `clientId = dispatch-test`;
- carpeta `dispatch-wweb-auth-test`;
- variable opcional `DISPATCH_TEST_WWEB_AUTH_PATH`;
- estados `DEV_TEST_PENDING`, `DEV_TEST_DELIVERY_UNKNOWN` y `DEV_TEST_CONFIRMED`;
- asignaciones `DEV_TEST_ASSIGNED` y `DEV_TEST_CONFIRMED`.

La cuenta de prueba únicamente puede enviar a asignaciones cuya solicitud sea `DEV_TEST` y cuyo auxiliar tenga `isTestProfile = true`. La cuenta operativa no consulta los estados `DEV_TEST_*`, por lo que una respuesta de prueba no puede confirmar una asignación real.

El QR, estado y cierre de sesión se administran en:

`/admin/operaciones/pruebas/whatsapp`

La sesión solo inicia cuando DEV abre esa pantalla o consulta su estado. Esto evita mantener un segundo proceso Chromium cuando el entorno no se está usando.

## Permiso independiente

El permiso **Nómina y tiempo trabajado** se concede o retira por usuario desde DEV y se almacena mediante eventos auditados.

Activar Nómina:

- no activa Operaciones / Despacho;
- no activa Asistencia;
- no modifica permisos existentes.

Activar Operaciones o Asistencia tampoco concede Nómina. La ruta conserva su URL histórica, pero las guardas reconocen el permiso propio de Nómina antes de evaluar los módulos operativos.
