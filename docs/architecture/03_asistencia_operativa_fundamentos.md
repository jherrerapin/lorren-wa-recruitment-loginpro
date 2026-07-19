# Asistencia operativa: fundamentos de validación automática

## Estado

Diseño inicial relacionado con el issue #509. Esta fase introduce reglas de dominio aisladas; todavía no conecta formularios, rutas HTTP, Prisma ni pantallas productivas.

## Decisión principal

El coordinador **no es un paso obligatorio** para confirmar cada asistencia.

Una llegada puede quedar validada automáticamente cuando todas las señales mínimas son confiables:

- la asignación está activa;
- el punto tiene asistencia habilitada;
- no existe una llegada previa;
- el dispositivo está autorizado;
- la geocerca está configurada;
- la ubicación está dentro del radio permitido;
- la precisión del GPS está dentro del máximo aceptado;
- no existen señales de dispositivo compartido ni pérdida de almacenamiento persistente.

En ese caso el resultado es:

- `attendanceStatus`: `ON_TIME` o `LATE`;
- `validationStatus`: `AUTO_VALIDATED`;
- `riskScore`: `0`;
- `riskFlags`: vacío.

## Papel del coordinador

El coordinador conserva autoridad para:

- revisar marcaciones riesgosas;
- validar o rechazar una llegada reportada;
- corregir una asistencia auto-validada cuando exista evidencia posterior;
- reabrir una decisión;
- documentar el motivo del cambio;
- autorizar o revocar dispositivos en fases posteriores.

Toda corrección deberá ser auditable, pero no debe convertir el flujo normal en una cola de aprobaciones manuales.

## Separación de ciclos de vida

`DispatchAssignment.status` sigue representando asignación y confirmación de disponibilidad. No se le agregan estados de llegada.

La asistencia tendrá cuatro conceptos separados:

1. `attendanceStatus`: situación operativa de la llegada.
2. `validationStatus`: forma en que fue aceptada, enviada a revisión o rechazada.
3. `riskScore`: valor numérico entre 0 y 100.
4. `riskFlags`: causas concretas que explican el riesgo.

Esta separación evita que una corrección de asistencia altere la cobertura o confirmación actual de despacho.

## Resultados de la política inicial

### Auto-validación

Una marcación confiable queda confirmada sin intervención humana. Si supera la tolerancia configurada, se auto-valida como tardía.

### Revisión requerida

La llegada puede registrarse provisionalmente como `ARRIVAL_REPORTED` cuando existe una asignación válida, pero aparece alguna señal como:

- dispositivo no autorizado;
- geocerca ausente;
- ubicación no disponible;
- marcación fuera del radio;
- precisión GPS insuficiente;
- posible dispositivo compartido;
- almacenamiento persistente no disponible.

Una fotografía reciente puede reducir la incertidumbre, pero no elimina las señales ni autoriza automáticamente el dispositivo.

### Rechazo

La política no registra una nueva llegada cuando:

- la asignación no está activa;
- la asistencia no está habilitada para el punto;
- ya existe una llegada y el intento es duplicado.

La idempotencia definitiva deberá resolverse también mediante restricciones y transacciones en la capa de persistencia.

## Seguridad de esta fase

- No modifica routers ni vistas existentes.
- No cambia `DispatchAssignment.status`.
- No realiza escrituras en base de datos.
- No habilita marcaciones en producción.
- No recolecta ubicación, fotografías, IP ni identificadores de dispositivos.
- La política es una función pura y puede probarse sin servicios externos.

## Próximas entregas recomendadas

1. Modelo Prisma aditivo para configuración del punto, asistencia, intentos y revisiones.
2. Servicio transaccional e idempotente que aplique la política y persista una llegada.
3. Registro de dispositivo principal y autorizaciones temporales.
4. Portal móvil del auxiliar con geolocalización.
5. Evidencia fotográfica solo cuando las reglas la exijan.
6. Vista del coordinador para excepciones y correcciones.
7. Dashboard de cobertura real por cliente, punto y solicitud.
