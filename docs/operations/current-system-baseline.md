# Línea base operativa actual de Lórren

**Estado:** Pendiente de validación manual  
**Fecha de creación:** 2026-07-10  
**Issue:** #380

## 1. Propósito

Registrar una versión conocida del sistema y el comportamiento que debe preservarse durante la estabilización. Este documento no afirma que todos los flujos estén funcionando; cada resultado debe comprobarse y acompañarse de evidencia.

## 2. Candidato de baseline

- **Rama de producción:** `main`
- **Commit desde el que se creó la rama de estabilización:** `b94cfa3c9f20a32b45b106d398334f4874e55d4c`
- **Rama de documentación:** `chore/stabilization-foundation`
- **Estado del candidato:** Pendiente de smoke test completo y confirmación operativa.
- **Tag definitivo:** Pendiente. No crear hasta completar las verificaciones.

## 3. Componentes identificados

| Componente | Función general | Dependencias principales | Criticidad | Estado validado |
|---|---|---|---|---|
| Servidor Express | Rutas, sesiones, vistas y montaje de módulos | PostgreSQL, EJS | Crítica | Pendiente |
| Webhook Meta | Recibir mensajes y eventos de WhatsApp Cloud API | Meta, PostgreSQL, OpenAI, almacenamiento | Crítica | Pendiente |
| Motor conversacional | Interpretar turnos, producir respuesta y acciones | OpenAI, reglas determinísticas, PostgreSQL | Crítica | Pendiente |
| Reclutamiento | Candidatos, vacantes, postulaciones, agenda y mensajes | PostgreSQL, Meta | Crítica | Pendiente |
| Panel administrativo | Gestión operativa y revisión de candidatos | Sesiones, PostgreSQL, EJS | Alta | Pendiente |
| Despacho | Solicitudes, auxiliares, asignaciones y confirmaciones | PostgreSQL, WhatsApp Web | Crítica | Pendiente |
| WhatsApp Web despacho | Envío y recepción operacional | Chromium, sesión LocalAuth | Crítica | Pendiente |
| Worker/JobQueue | Procesamiento asíncrono | PostgreSQL, servicios externos | Crítica | Pendiente |
| Almacenamiento de CV | Guardar y descargar documentos | R2 y/o PostgreSQL | Alta | Pendiente |
| Autenticación | Login, recuperación y sesiones | PostgreSQL, session store | Crítica | Pendiente |

## 4. Integraciones externas

Registrar para cada integración solamente el nombre de la variable o recurso. No copiar secretos.

| Integración | Ambiente producción identificado | Ambiente de prueba separado | Responsable | Estado |
|---|---|---|---|---|
| PostgreSQL/Railway | Pendiente | Pendiente | Jhon | Pendiente |
| Meta WhatsApp Cloud API | Pendiente | Pendiente | Jhon | Pendiente |
| OpenAI | Pendiente | Pendiente | Jhon | Pendiente |
| Cloudflare R2 | Pendiente | Pendiente | Jhon | Pendiente |
| WhatsApp Web despacho | Pendiente | Pendiente | Jhon | Pendiente |
| Railway deploy | Identificado de forma general | Pendiente | Jhon | Pendiente |

## 5. Procesos críticos que deben preservarse

### Reclutamiento

- recepción de un mensaje nuevo;
- identificación o selección de vacante;
- autorización para tratamiento de datos;
- captura y actualización de datos del candidato;
- recepción y asociación de CV;
- respuesta de preguntas sobre vacante;
- agendamiento;
- recordatorio;
- confirmación, cancelación o reprogramación;
- intervención humana y pausa del bot;
- visualización en panel.

### Despacho

- creación de solicitud de servicio;
- creación o selección de auxiliar;
- asignación;
- envío de programación;
- confirmación o rechazo;
- actualización de estados;
- visualización operativa;
- cancelación sin contabilizar asignaciones inactivas.

### Administración y seguridad

- login válido e inválido;
- recuperación de contraseña;
- autorización por rol;
- cierre de sesión;
- trazabilidad de acciones;
- descarga autorizada de CV;
- rechazo de acceso no autorizado.

## 6. Comportamientos que no deben cambiar accidentalmente

Antes de modificar un módulo se debe documentar:

- entrada utilizada;
- estado previo;
- respuesta enviada;
- cambios de base de datos;
- eventos o trabajos creados;
- estado final;
- efecto visible en panel;
- llamadas a servicios externos.

## 7. Evidencia requerida

Para cada prueba conservar:

- fecha y hora;
- ambiente;
- commit desplegado;
- usuario de prueba;
- identificador ficticio del caso;
- captura o log redactado;
- resultado esperado;
- resultado obtenido;
- responsable;
- incidencia asociada si falla.

No adjuntar tokens, contraseñas, documentos reales ni conversaciones completas con información personal.

## 8. Criterio para crear el tag baseline

El tag se crea únicamente cuando:

- el smoke test crítico está completo;
- no existen fallos bloqueantes conocidos;
- el backup se generó;
- una restauración fue probada;
- el commit desplegado coincide con el commit documentado;
- operaciones confirma que los flujos principales están utilizables.

Nombre sugerido:

```text
baseline-loginpro-2026-07
```

## 9. Resultado de la validación

- **Fecha:** Pendiente
- **Commit validado:** Pendiente
- **Resultado global:** Pendiente
- **Fallos conocidos aceptados temporalmente:** Pendiente
- **Aprobación de producto:** Pendiente
- **Aprobación técnica:** Pendiente