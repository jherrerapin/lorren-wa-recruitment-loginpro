# Plan técnico de continuidad — Lórren Asistencia Operativa

## 1. Propósito

Este documento permite retomar el desarrollo del módulo de asistencia operativa en otro chat o sesión sin reconstruir el contexto desde cero.

El objetivo comercial es ofrecer a Loginpro Service un módulo propio integrado con Lórren y Operaciones / Despacho, capaz de competir con GeoVictoria no solo en asistencia, sino en control de cobertura, faltantes y reemplazos.

Cadena objetivo:

**Reclutamiento → auxiliar disponible → solicitud de servicio → asignación → confirmación → llegada → asistencia → novedad → reemplazo → cobertura final → reporte.**

---

## 2. Repositorio y estado actual

- Repositorio: `jherrerapin/lorren-wa-recruitment-loginpro`
- Issue principal: `#509`
- PR actual: `#510`
- Rama actual: `feat/509-attendance-foundation`
- PR actual en borrador: `feat: definir validación automática de asistencia operativa`

El PR #510 ya agregó:

- política de dominio pura de validación automática;
- separación entre estado operativo, estado de validación, puntaje y señales de riesgo;
- pruebas unitarias;
- documentación inicial de arquitectura.

El PR #510 todavía no modifica:

- Prisma;
- base de datos;
- rutas;
- vistas;
- sesiones;
- solicitudes;
- asignaciones;
- confirmaciones por WhatsApp;
- comportamiento productivo.

No se debe mezclar el siguiente cambio de persistencia dentro del PR #510. El PR #510 debe conservarse como una entrega pequeña de dominio y documentación.

---

## 3. Decisiones funcionales no negociables

### 3.1 Validación automática

El coordinador no es un aprobador obligatorio.

Una llegada confiable debe quedar marcada automáticamente como:

- `ON_TIME`, o
- `LATE`.

Y su validación debe quedar como:

- `AUTO_VALIDATED`.

El coordinador puede después:

- corregir;
- rechazar;
- reabrir;
- validar una excepción;
- registrar una marcación manual;
- documentar el motivo.

Toda acción manual debe conservar auditoría.

### 3.2 Separación de ciclos de vida

No agregar estados de asistencia a `DispatchAssignment.status`.

`DispatchAssignment.status` continúa representando asignación y confirmación de disponibilidad.

La asistencia tendrá estado propio vinculado a la asignación.

### 3.3 Sin daño a lo existente

Todos los cambios iniciales deben ser:

- aditivos;
- desactivados por defecto;
- reversibles;
- sin eliminación de columnas o datos;
- sin modificar comportamientos actuales de despacho.

### 3.4 Fotografía

La fotografía no será obligatoria en todas las marcaciones.

Se solicitará principalmente cuando exista riesgo:

- dispositivo nuevo;
- celular temporal;
- posible dispositivo compartido;
- GPS impreciso;
- ubicación inconsistente;
- ausencia del identificador de instalación.

En el MVP no se hará reconocimiento facial automático.

### 3.5 Ubicación

La ubicación se captura al marcar entrada y, posteriormente, al marcar salida.

No habrá seguimiento continuo durante toda la jornada en el MVP.

### 3.6 Hora oficial

La hora oficial es la del servidor.

La hora del dispositivo puede guardarse como dato auxiliar, pero nunca decide por sí sola puntualidad, entrada o salida.

### 3.7 Dispositivo principal

Cada auxiliar podrá tener un dispositivo principal, pero una PWA no puede demostrar de forma infalible la identidad física de un celular.

El sistema debe combinar:

- token de instalación;
- sesión persistente;
- historial del dispositivo;
- navegador y sistema operativo;
- WebAuthn cuando se implemente;
- ubicación;
- asignación;
- historial de otros auxiliares asociados al mismo entorno;
- fotografía cuando exista riesgo.

Una passkey autentica fuertemente al auxiliar, pero no debe modelarse como prueba de un teléfono físico único.

### 3.8 Cambio temporal de celular

Un celular nuevo no debe bloquear completamente la operación.

Flujo:

1. registrar intento;
2. solicitar motivo;
3. capturar ubicación;
4. solicitar fotografía o evidencia reforzada;
5. guardar llegada como `ARRIVAL_REPORTED`;
6. dejar validación en `REVIEW_REQUIRED`;
7. permitir decisión posterior del coordinador.

El equipo temporal no queda como principal automáticamente.

---

## 4. Arquitectura objetivo

El módulo se construirá como una extensión aislada de Operaciones / Despacho.

Capas recomendadas:

```text
src/modules/dispatch-attendance/
  domain/
    attendanceValidationPolicy.js
    attendanceStates.js
    attendanceRiskPolicy.js
    attendanceDistance.js
  application/
    registerArrival.js
    registerDeparture.js
    reviewAttendance.js
    detectAbsences.js
    calculateCoverage.js
    activateReplacement.js
  infrastructure/
    attendanceRepository.js
    deviceRepository.js
    evidenceStorage.js
    mapProvider.js
  http/
    publicAttendanceRoutes.js
    adminAttendanceRoutes.js
```

No mover ni reescribir el módulo actual de despacho para introducir asistencia.

---

## 5. Modelo de datos propuesto

Los nombres definitivos deben validarse contra el esquema Prisma antes de implementar.

### 5.1 Extensión de `DispatchOperationPoint`

Campos aditivos sugeridos:

```text
attendanceEnabled           Boolean   default false
attendanceLatitude          Decimal?
attendanceLongitude         Decimal?
geofenceRadiusMeters        Int?
maxLocationAccuracyMeters   Int?
earlyArrivalWindowMinutes   Int       default 60
lateToleranceMinutes        Int       default 10
absenceGraceMinutes         Int       default 15
timezone                    String    default America/Bogota
photoPolicy                 String    default RISK_ONLY
manualAttendanceAllowed     Boolean   default true
```

Regla: si `attendanceEnabled = false`, la operación actual sigue funcionando exactamente como hoy.

### 5.2 `DispatchAttendanceSession`

Una sesión de asistencia por asignación.

Campos sugeridos:

```text
id
assignmentId unique
expectedStartAt
expectedEndAt
attendanceStatus
validationStatus
punctualityStatus
riskScore
riskFlags Json
arrivalReportedAt
arrivalValidatedAt
checkOutReportedAt
checkOutValidatedAt
workedMinutes
source
createdAt
updatedAt
```

Relación uno a uno con `DispatchAssignment`.

### 5.3 `DispatchAttendanceMark`

Cada intento o marcación recibida.

Campos sugeridos:

```text
id
attendanceSessionId
markType                 ARRIVAL | DEPARTURE
idempotencyKey           unique
serverReceivedAt
clientCapturedAt
latitude
longitude
accuracyMeters
distanceToPointMeters
insideGeofence
installationId
workerDeviceId
ipAddress
userAgent
persistentStorageAvailable
photoStorageKey
challengeId
riskScore
riskFlags Json
validationDecision
createdAt
```

No sobrescribir intentos anteriores.

### 5.4 `DispatchWorkerDevice`

Campos sugeridos:

```text
id
workerId
installationPublicIdHash
credentialId
status                   MAIN | TEMPORARY | REVOKED | BLOCKED
trustLevel
firstSeenAt
lastSeenAt
temporaryUntil
revokedAt
revokedByUsername
metadata Json
createdAt
updatedAt
```

No guardar secretos o tokens sin hash.

### 5.5 `DispatchAttendanceReview`

Campos sugeridos:

```text
id
attendanceSessionId
attendanceMarkId
reviewAction
fromAttendanceStatus
fromValidationStatus
toAttendanceStatus
toValidationStatus
reason
notes
actorUsername
actorRole
createdAt
```

### 5.6 Auditoría

Cada corrección debe crear un evento nuevo. Nunca reemplazar silenciosamente el valor anterior.

No reutilizar `DevAuditEvent` como autoridad permanente del dominio de asistencia sin antes validar su propósito. Es preferible una auditoría propia o un contrato de auditoría compartido explícito.

### 5.7 Periodos de asistencia

No es parte del primer PR de persistencia, pero el modelo debe permitir posteriormente:

```text
OPEN
UNDER_REVIEW
CLOSED
REOPENED
```

Una reapertura debe exigir motivo y conservar la versión anterior.

---

## 6. Estados previstos

### 6.1 Estado operativo de asistencia

```text
PENDING
ARRIVAL_REPORTED
ON_TIME
LATE
ABSENT
CHECKED_OUT
CANCELLED
```

### 6.2 Estado de validación

```text
AUTO_VALIDATED
REVIEW_REQUIRED
MANUALLY_VALIDATED
REJECTED
CORRECTED
```

### 6.3 Estado de dispositivo

```text
MAIN
TEMPORARY
REVOKED
BLOCKED
```

### 6.4 Regla importante

No crear un único campo ambiguo que mezcle:

- presencia;
- puntualidad;
- validación;
- riesgo;
- corrección manual.

---

## 7. Política de riesgo

La política existente del PR #510 es la base inicial.

Señales actuales:

- asignación inactiva;
- asistencia no habilitada;
- intento duplicado;
- geocerca no configurada;
- ubicación ausente;
- fuera de geocerca;
- precisión insuficiente;
- dispositivo no autorizado;
- posible dispositivo compartido;
- almacenamiento persistente no disponible.

Señales futuras:

- cambios frecuentes de dispositivo;
- dos auxiliares usando la misma instalación;
- operaciones incompatibles por distancia y tiempo;
- múltiples intentos fallidos;
- ubicación técnica repetida de forma sospechosa;
- IP o red incoherente;
- evidencia fotográfica ausente cuando era requerida;
- reto de fotografía vencido;
- asignación solapada.

No afirmar que una PWA detecta con certeza GPS falso o modo incógnito.

Los nombres correctos de las señales deben expresar incertidumbre:

- `LOCATION_INCONSISTENCY_SIGNAL`;
- `PERSISTENT_STORAGE_UNAVAILABLE`;
- `SHARED_DEVICE_SIGNAL`.

No usar nombres acusatorios como `FRAUD_CONFIRMED` salvo decisión humana sustentada.

---

## 8. Geocerca y cálculo de distancia

El cálculo debe hacerse en el servidor con coordenadas almacenadas del punto y coordenadas recibidas del dispositivo.

Usar Haversine u otra función geodésica probada.

Guardar:

- coordenadas originales;
- precisión recibida;
- distancia calculada;
- radio configurado;
- resultado de geocerca;
- versión de la regla aplicada.

La precisión GPS es un radio estimado, no una certeza.

Regla inicial propuesta:

- precisión buena: auto-validación posible;
- precisión intermedia: evaluar según radio y otras señales;
- precisión deficiente: revisión;
- ubicación ausente: revisión o rechazo según política.

Los umbrales deben ser configurables, no constantes universales.

---

## 9. Autenticación del Portal del Auxiliar

Flujo recomendado:

1. Lórren envía invitación por WhatsApp.
2. El enlace contiene un token de activación de un solo uso y corta duración.
3. El servidor intercambia el token por una sesión segura.
4. El token desaparece de la URL mediante redirección.
5. Se crea un identificador de instalación.
6. La sesión se guarda en cookie `HttpOnly`, `Secure` y `SameSite`.
7. Se registra el dispositivo principal después de completar activación.

No usar únicamente:

- número de cédula;
- contraseña fácil;
- token permanente en URL;
- fingerprint de navegador.

WebAuthn o passkeys pueden agregarse después como autenticación reforzada.

---

## 10. Contratos HTTP propuestos

Los nombres exactos pueden ajustarse a la convención existente.

### 10.1 Administración

```text
GET  /admin/operaciones/puntos/:id/asistencia
POST /admin/operaciones/puntos/:id/asistencia/configuracion
GET  /admin/operaciones/solicitudes/:id/asistencia
POST /admin/operaciones/asistencias/:id/revisar
POST /admin/operaciones/asistencias/:id/corregir
POST /admin/operaciones/asistencias/:id/reabrir
```

### 10.2 Portal del auxiliar

```text
GET  /operaciones/portal/activar/:token
GET  /operaciones/portal/asignaciones
GET  /operaciones/portal/asignaciones/:id
POST /operaciones/portal/asignaciones/:id/llegada
POST /operaciones/portal/asignaciones/:id/salida
POST /operaciones/portal/dispositivo/cambio-temporal
POST /operaciones/portal/evidencias/fotografia
```

### 10.3 Reglas para rutas de marcación

- autenticación obligatoria;
- autorización por trabajador y asignación;
- idempotency key obligatoria;
- validación de ventana horaria;
- hora oficial del servidor;
- rate limiting;
- límites de tamaño de fotografía;
- MIME validado;
- no confiar en campos calculados por el cliente;
- cálculo de distancia y riesgo en servidor;
- transacción única al persistir decisión.

---

## 11. Evidencia fotográfica

Para captura en vivo usar `getUserMedia()` cuando el navegador lo permita.

Flujo de riesgo:

1. generar reto aleatorio en servidor;
2. abrir cámara;
3. mostrar reto;
4. capturar fotografía;
5. subir evidencia con token de un solo uso;
6. asociar evidencia con asignación, dispositivo, ubicación y hora;
7. guardar archivo en almacenamiento privado;
8. ofrecer URL firmada y temporal al coordinador.

No guardar imágenes en campos binarios de Prisma si ya existe almacenamiento S3/R2.

No implementar comparación facial automática en el MVP.

Debe existir alternativa no biométrica:

- validación presencial;
- registro asistido;
- código temporal;
- evidencia manual del coordinador.

---

## 12. Mapas

Crear una abstracción `MapProvider`.

Contrato sugerido:

```text
geocodeAddress()
reverseGeocode()
buildNavigationUrl()
renderConfigurationMap()
```

Para el piloto:

- geocodificar cada punto una sola vez;
- guardar coordenadas;
- permitir ajuste manual del marcador;
- no cargar un mapa interactivo en cada marcación;
- usar enlace externo para navegación;
- configurar cuotas y alertas.

No acoplar el dominio a Google Maps, Mapbox u otro proveedor.

---

## 13. Funcionamiento sin conexión

No prometer marcación offline confirmada en el MVP web.

Estados de interfaz:

```text
PENDING_LOCAL_CAPTURE
PENDING_UPLOAD
RECEIVED_BY_SERVER
```

Una captura local no debe mostrarse como asistencia confirmada hasta recibir respuesta del servidor.

Background Sync puede usarse como mejora progresiva, pero no como requisito funcional porque no está disponible de forma uniforme en todos los navegadores.

---

## 14. Orden exacto de implementación

Cada fase debe tener issue y PR separados. No mezclar migración, interfaz, autenticación y reemplazos en un solo PR.

### PR 0 — Fundamentos de dominio

Estado: PR #510 abierto en borrador.

Incluye:

- política pura;
- estados;
- riesgo inicial;
- pruebas;
- documentación.

Acción pendiente:

- revisar diff;
- confirmar CI;
- resolver observaciones;
- marcar listo;
- fusionar antes de iniciar persistencia, salvo que el repositorio exija otra secuencia.

### PR 1 — Esquema aditivo de asistencia

Incluye:

- campos opcionales de configuración en punto;
- modelos de sesión, marcación, dispositivo y revisión;
- migración aditiva;
- índices y restricciones;
- sin rutas productivas;
- asistencia deshabilitada por defecto.

Pruebas:

- `npx prisma validate`;
- migración en base vacía;
- migración sobre snapshot compatible;
- generación de Prisma Client;
- prueba de rollback lógico.

### PR 2 — Repositorio y servicio transaccional

Incluye:

- creación idempotente de sesión;
- registro de intento;
- cálculo de distancia;
- ejecución de política;
- persistencia atómica;
- protección contra doble llegada.

No incluye interfaz.

### PR 3 — Configuración administrativa del punto

Incluye:

- activar/desactivar asistencia;
- coordenadas;
- radio;
- precisión máxima;
- tolerancias;
- política de fotografía;
- validaciones y auditoría.

Debe estar oculto o deshabilitado donde no exista permiso.

### PR 4 — Activación y dispositivo principal

Incluye:

- invitación por WhatsApp;
- token de activación;
- sesión persistente;
- identificador de instalación;
- registro, revocación y cambio permanente;
- protección contra reutilización de token.

### PR 5 — Portal móvil de asignaciones

Incluye:

- PWA o web móvil;
- asignaciones activas;
- cliente, punto, dirección, fecha y hora;
- botón de navegación;
- estado de confirmación;
- todavía sin marcación productiva si la ruta no está lista.

### PR 6 — Marcación de llegada

Incluye:

- solicitud de ubicación;
- envío seguro;
- cálculo server-side;
- auto-validación;
- llegada tardía;
- respuesta visible al auxiliar;
- idempotencia;
- eventos de auditoría.

### PR 7 — Cambio temporal y evidencia de riesgo

Incluye:

- motivo de cambio;
- dispositivo temporal;
- fotografía en vivo;
- reto;
- almacenamiento R2;
- `REVIEW_REQUIRED`;
- autorizaciones por operación, por día o permanentes.

### PR 8 — Centro de revisión del coordinador

Incluye:

- lista de excepciones;
- detalle GPS;
- precisión;
- distancia;
- dispositivo;
- fotografía;
- riesgo;
- validar;
- rechazar;
- corregir;
- reabrir;
- auditoría.

No convertir esta vista en requisito para asistencias normales.

### PR 9 — Ausencias y cobertura

Incluye:

- job o scheduler de ausencia;
- cálculo de requeridos, asignados, confirmados y presentes;
- alerta de faltante;
- cobertura inicial y actual;
- vista por solicitud.

### PR 10 — Reemplazo asistido

Incluye:

- búsqueda de auxiliares disponibles;
- filtros por ciudad, perfil, transporte, zona e historial;
- exclusión de solapamientos;
- envío por WhatsApp;
- aceptación;
- reasignación;
- actualización de cobertura;
- tiempo de recuperación.

### PR 11 — Marcación de salida

Incluye:

- salida;
- validación;
- duración;
- salida temprana;
- corrección;
- preparación de horas trabajadas.

### PR 12 — Reportes y piloto paralelo

Incluye:

- Excel/CSV por solicitud;
- reporte por auxiliar;
- auditoría;
- indicadores del piloto;
- comparación con GeoVictoria;
- exportación de diferencias.

### Fases posteriores

- cálculo de recargos;
- cierre de periodos;
- prenómina;
- API externa;
- webhooks;
- portal de clientes;
- aplicación Android;
- Play Integrity;
- seguimiento continuo, solo si existe necesidad y autorización;
- reconocimiento facial, solo tras revisión jurídica y operativa.

---

## 15. Pruebas obligatorias

### 15.1 Unitarias

- distancia;
- puntualidad;
- riesgo;
- estados;
- ventanas horarias;
- ausencia;
- cobertura;
- reemplazos compatibles.

### 15.2 Persistencia

- unique por asignación;
- idempotency key;
- concurrencia;
- doble clic;
- reintentos;
- transacción fallida;
- revisión sin sobrescribir historial.

### 15.3 Integración

- asignación real existente;
- punto sin asistencia habilitada;
- punto habilitado;
- usuario sin permiso;
- trabajador accediendo a asignación ajena;
- evidencia privada;
- revocación de dispositivo.

### 15.4 E2E móvil

Probar al menos:

- Chrome Android;
- navegador Samsung cuando sea posible;
- Safari iPhone;
- permisos aceptados;
- permisos rechazados;
- GPS impreciso;
- pérdida de conexión;
- cámara denegada;
- doble marcación;
- celular nuevo.

### 15.5 Seguridad

- tokens vencidos;
- token reutilizado;
- CSRF en administración;
- sesión robada;
- escalamiento horizontal de IDs;
- carga de archivo malicioso;
- MIME falso;
- fotografía demasiado grande;
- acceso no autorizado a URLs firmadas;
- rate limiting;
- logs sin secretos.

### 15.6 Regresión

En cada PR ejecutar las pruebas actuales de:

- despacho;
- solicitudes;
- asignaciones;
- confirmación por WhatsApp;
- dashboard;
- permisos.

---

## 16. Observabilidad

Métricas mínimas:

```text
attendance_arrival_attempts_total
auto_validated_total
review_required_total
rejected_total
duplicate_attempts_total
location_permission_denied_total
location_accuracy_failure_total
unauthorized_device_total
shared_device_signal_total
photo_required_total
manual_corrections_total
absence_detected_total
coverage_shortage_total
replacement_requested_total
replacement_accepted_total
coverage_recovery_minutes
```

Logs estructurados con:

- request ID;
- assignment ID;
- worker ID anonimizable;
- attendance session ID;
- decisión;
- flags;
- duración;
- error.

No registrar tokens, fotografías, coordenadas completas o datos sensibles innecesarios en logs generales.

---

## 17. Despliegue seguro

### Feature flags

La función debe habilitarse por punto de operación:

```text
attendanceEnabled = false
```

Valor por defecto: `false`.

### Piloto paralelo

Ejecutar Lórren y GeoVictoria simultáneamente en puntos seleccionados.

No retirar GeoVictoria al inicio.

### Alcance sugerido

- una ciudad;
- dos a cuatro clientes;
- tres a seis puntos;
- 50 a 100 auxiliares;
- 30 días;
- algunas operaciones nocturnas;
- conectividad variada.

### Rollback

- desactivar asistencia por punto;
- conservar tablas aditivas;
- retirar consumidores runtime;
- no ejecutar eliminación automática de datos;
- revertir PR específico cuando sea posible.

---

## 18. Indicadores del piloto

- tasa de activación del portal;
- tasa de auto-validación;
- tasa de revisión;
- errores de permisos GPS;
- errores de precisión;
- marcaciones duplicadas;
- cambios de celular;
- correcciones manuales;
- ausencias detectadas;
- tiempo de detección;
- tiempo de reemplazo;
- cobertura inicial;
- cobertura final;
- diferencias contra GeoVictoria;
- costo por jornada controlada.

Objetivos iniciales propuestos, sujetos a validación en campo:

- más del 85 % auto-validado;
- menos del 10 % en revisión por problemas técnicos;
- cero daños al despacho existente;
- cero duplicados aceptados;
- 100 % de correcciones auditadas.

---

## 19. Privacidad y cumplimiento

La ubicación y las fotografías son datos personales. El tratamiento debe tener finalidad clara, acceso restringido, seguridad y periodo de conservación.

Los datos biométricos son sensibles. En el MVP:

- no crear plantillas faciales;
- no comparar rostros automáticamente;
- no condicionar toda asistencia a biometría;
- mantener alternativa no biométrica;
- obtener autorización expresa cuando corresponda;
- definir eliminación y consulta.

Para horas y nómina futuras, el modelo debe soportar:

- nombre del trabajador;
- actividad;
- horas;
- distinción diurna/nocturna;
- soporte de modificaciones;
- entrega de registro cuando sea requerido.

Este documento no reemplaza revisión jurídica profesional.

---

## 20. Preguntas pendientes para Loginpro

Antes de cerrar el piloto solicitar:

1. factura o propuesta vigente de GeoVictoria;
2. número de auxiliares activos;
3. marcaciones mensuales;
4. clientes y puntos;
5. funciones realmente utilizadas;
6. entrada, salida y descansos;
7. selfie o reconocimiento facial;
8. integración con nómina;
9. reportes entregados a clientes;
10. proceso actual de corrección;
11. frecuencia de cambios de celular;
12. porcentaje de inasistencia;
13. tiempo de reemplazo;
14. multas por falta de cobertura;
15. zonas sin conectividad;
16. política de datos personales;
17. periodo de conservación de evidencias;
18. responsable interno del piloto.

---

## 21. Qué no hacer

- No reescribir el módulo de despacho.
- No modificar `DispatchAssignment.status` para representar llegada.
- No activar asistencia globalmente.
- No obligar al coordinador a aprobar todas las llegadas.
- No confiar en la hora del celular.
- No confiar en fingerprint como identidad física.
- No afirmar detección infalible de GPS falso.
- No hacer reconocimiento facial en el MVP.
- No mezclar migración, rutas, interfaz y reemplazos en un PR.
- No eliminar datos existentes.
- No almacenar evidencia sensible en logs.
- No prometer funcionamiento offline universal.

---

## 22. Siguiente acción exacta

1. Revisar el PR #510 y confirmar que CI siga exitoso.
2. Mantenerlo pequeño y fusionarlo cuando esté aprobado.
3. Crear un issue nuevo para **esquema aditivo de persistencia de asistencia**.
4. Crear una rama desde la versión actual de `main`.
5. Implementar únicamente PR 1 de este documento.
6. No conectar todavía rutas productivas.
7. Validar Prisma, migración, índices y regresión.
8. Abrir PR en borrador con rollback documentado.

---

## 23. Texto para contextualizar otro chat

Copiar y pegar lo siguiente:

> Estamos trabajando en el repositorio `jherrerapin/lorren-wa-recruitment-loginpro`, proyecto Lórren. Revisa primero `AGENTS.md`, el issue #509, el PR #510 y `docs/product/plan_tecnico_asistencia_operativa.md`. No empieces desde cero ni reescribas despacho. La asistencia debe ser un ciclo independiente de `DispatchAssignment.status`. Una llegada confiable se auto-valida; el coordinador solo revisa excepciones o corrige después con auditoría. Todo debe ser aditivo, desactivado por defecto y sin afectar solicitudes, asignaciones, confirmaciones de WhatsApp ni cobertura actual. El siguiente paso exacto es crear un issue y PR separados para el esquema Prisma aditivo de asistencia, sin rutas ni interfaz productiva. Antes de cambiar código, verifica el estado actual de `main`, conflictos, CI y reglas del repositorio.

---

## 24. Fuentes técnicas y normativas de referencia

- Documentación oficial de GeoVictoria Colombia para control de asistencia y outsourcing.
- Documentación oficial de Jibble sobre GPS, geocercas, reconocimiento facial, offline y reportes.
- MDN: Geolocation API, `accuracy`, cámara y Background Sync.
- W3C WebAuthn Level 3.
- Google Maps Platform: precios, cuotas y límites.
- Android Developers: Play Integrity.
- Ley 1581 de 2012.
- Ley 2466 de 2025.

Validar nuevamente precios, compatibilidad de navegadores y regulación antes de cada fase que dependa de información cambiante.