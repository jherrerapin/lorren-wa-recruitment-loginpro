# Smoke test controlado de Lórren

**Estado:** Plantilla pendiente de ejecución  
**Issue:** #380  
**Ambiente objetivo inicial:** Producción, con datos ficticios y sin acciones destructivas

## 1. Reglas de ejecución

- Ejecutar en una ventana de bajo tráfico.
- Usar exclusivamente candidatos, teléfonos, documentos y CV ficticios.
- No eliminar información real.
- No cambiar configuración ni variables de producción durante la prueba.
- Registrar el commit desplegado antes de comenzar.
- Detener la prueba ante errores de datos, permisos, mensajería masiva o indisponibilidad.
- Redactar cualquier evidencia que pueda contener datos personales o secretos.

## 2. Datos de la ejecución

| Campo | Valor |
|---|---|
| Fecha y hora de inicio | Pendiente |
| Fecha y hora de finalización | Pendiente |
| Ambiente | Pendiente |
| URL/version | Pendiente |
| Commit desplegado | Pendiente |
| Responsable | Pendiente |
| Teléfono de prueba | Pendiente |
| Candidato ficticio | Pendiente |
| Vacante de prueba | Pendiente |
| Solicitud de despacho de prueba | Pendiente |

## 3. Convención de resultado

- `PASS`: resultado coincide con lo esperado.
- `FAIL`: resultado diferente o error.
- `BLOCKED`: no puede ejecutarse por una dependencia.
- `NOT RUN`: todavía no ejecutado.

## 4. Salud básica

| ID | Prueba | Resultado esperado | Estado | Evidencia/issue |
|---|---|---|---|---|
| SMK-001 | Abrir aplicación | Respuesta sin error 5xx | NOT RUN | |
| SMK-002 | Abrir login | Formulario visible y utilizable | NOT RUN | |
| SMK-003 | Consultar endpoint de salud, si existe | Estado saludable y sin datos sensibles | NOT RUN | |
| SMK-004 | Revisar logs de arranque | Sin error de migración, Prisma o conexión | NOT RUN | |

## 5. Autenticación y autorización

| ID | Prueba | Resultado esperado | Estado | Evidencia/issue |
|---|---|---|---|---|
| SMK-010 | Login con credencial válida | Inicia sesión y dirige al panel autorizado | NOT RUN | |
| SMK-011 | Login con credencial inválida | Rechaza acceso sin revelar detalles internos | NOT RUN | |
| SMK-012 | Acceder a ruta privada sin sesión | Redirige o responde 401/403 | NOT RUN | |
| SMK-013 | Cerrar sesión | Sesión deja de acceder a rutas privadas | NOT RUN | |
| SMK-014 | Recuperación de contraseña controlada | Código válido permite cambiar clave de prueba | NOT RUN | |
| SMK-015 | Reutilizar código de recuperación | Debe rechazarse; si no ocurre, registrar vulnerabilidad | NOT RUN | |

## 6. Reclutamiento por WhatsApp

| ID | Prueba | Resultado esperado | Estado | Evidencia/issue |
|---|---|---|---|---|
| SMK-020 | Enviar primer mensaje desde teléfono de prueba | Se registra mensaje y comienza flujo correspondiente | NOT RUN | |
| SMK-021 | Enviar mensaje duplicado con mismo identificador, mediante simulación segura | No crea efectos duplicados | NOT RUN | |
| SMK-022 | Seleccionar vacante | Vacante queda asociada correctamente | NOT RUN | |
| SMK-023 | Aceptar tratamiento de datos | Consentimiento queda trazable | NOT RUN | |
| SMK-024 | Entregar datos en orden distinto | Conserva datos válidos y solicita únicamente faltantes | NOT RUN | |
| SMK-025 | Adjuntar CV ficticio permitido | Archivo queda asociado y disponible para usuario autorizado | NOT RUN | |
| SMK-026 | Adjuntar archivo no permitido | Se rechaza sin almacenar o ejecutar contenido | NOT RUN | |
| SMK-027 | Hacer pregunta sobre vacante | Responde sin inventar salario, horario, dirección o condiciones | NOT RUN | |
| SMK-028 | Completar registro | Estado final coincide con reglas actuales | NOT RUN | |
| SMK-029 | Intervención manual | Bot se pausa o respeta mensaje humano según política | NOT RUN | |

## 7. Agenda y recordatorios

| ID | Prueba | Resultado esperado | Estado | Evidencia/issue |
|---|---|---|---|---|
| SMK-030 | Consultar horarios disponibles | Devuelve opciones válidas para vacante | NOT RUN | |
| SMK-031 | Reservar entrevista | Crea una única cita consistente | NOT RUN | |
| SMK-032 | Intentar repetir reserva | No crea cita duplicada | NOT RUN | |
| SMK-033 | Confirmar asistencia | Actualiza cita y proceso correctamente | NOT RUN | |
| SMK-034 | Rechazar asistencia | Actualiza estado y permite reprogramación según regla | NOT RUN | |
| SMK-035 | Ejecutar recordatorio controlado | Envía una sola vez y registra resultado | NOT RUN | |

## 8. Panel administrativo

| ID | Prueba | Resultado esperado | Estado | Evidencia/issue |
|---|---|---|---|---|
| SMK-040 | Buscar candidato ficticio | Aparece una sola ficha consistente | NOT RUN | |
| SMK-041 | Abrir conversación | Mensajes en orden y sin duplicados visibles | NOT RUN | |
| SMK-042 | Actualizar un campo no crítico | Persiste y aparece correctamente | NOT RUN | |
| SMK-043 | Descargar CV ficticio con autorización | Descarga correcta y acceso auditado | NOT RUN | |
| SMK-044 | Intentar descarga sin autorización | Acceso rechazado | NOT RUN | |

## 9. Despacho

| ID | Prueba | Resultado esperado | Estado | Evidencia/issue |
|---|---|---|---|---|
| SMK-050 | Crear solicitud de servicio ficticia | Solicitud válida y visible | NOT RUN | |
| SMK-051 | Asociar auxiliar ficticio | Relación consistente y única | NOT RUN | |
| SMK-052 | Crear asignación | Estado inicial correcto | NOT RUN | |
| SMK-053 | Enviar programación por canal de prueba | Mensaje correcto y trazable | NOT RUN | |
| SMK-054 | Confirmar asignación | Estado actualizado en panel | NOT RUN | |
| SMK-055 | Rechazar/cancelar asignación | No cuenta como asignación activa | NOT RUN | |
| SMK-056 | Reiniciar controladamente runtime de WhatsApp Web | Recupera sesión sin crear procesos competidores | NOT RUN | |

## 10. Worker y cola

| ID | Prueba | Resultado esperado | Estado | Evidencia/issue |
|---|---|---|---|---|
| SMK-060 | Crear trabajo de prueba idempotente | Se ejecuta una sola vez | NOT RUN | |
| SMK-061 | Forzar fallo temporal controlado | Reintenta según política | NOT RUN | |
| SMK-062 | Reiniciar worker con trabajo pendiente | Trabajo no se pierde | NOT RUN | |
| SMK-063 | Revisar trabajo de adjunto administrativo | No debe marcar éxito sin ejecutar acción | NOT RUN | |

## 11. Cierre

| Campo | Valor |
|---|---|
| Total PASS | Pendiente |
| Total FAIL | Pendiente |
| Total BLOCKED | Pendiente |
| Incidentes creados | Pendiente |
| ¿Apto como baseline? | Pendiente |
| Aprobación de producto | Pendiente |
| Aprobación técnica | Pendiente |

## 12. Criterio de aprobación

El candidato de baseline solo puede aprobarse cuando:

- no existen fallos en salud, login, recepción de mensajes, persistencia, agenda o despacho principal;
- cualquier fallo conocido no crítico está registrado y aceptado explícitamente;
- el backup correspondiente existe;
- se confirmó el commit desplegado;
- se completó una restauración de prueba.