# Auditoria de regresion del bot actual

## Objetivo

Definir una revision controlada del bot de reclutamiento despues de los cambios recientes en compuerta contextual, supervision administrativa, recordatorios, audios, visibilidad interna, aprendizajes de Lorren y acceso DEV-only a Operaciones / Despacho.

Este documento no cambia codigo. Sirve como checklist antes de nuevos ajustes funcionales.

## Alcance

Validar que siguen funcionando:

- Login y roles del panel.
- Webhook de WhatsApp.
- Flujo conversacional del candidato.
- Respuestas basadas en vacante asignada.
- Supervision administrativa.
- Recordatorios de entrevista.
- Reenvio de archivos y audios.
- Visibilidad de mensajes internos.
- Gestion de aprendizajes.
- Acceso DEV-only a Operaciones / Despacho.

Fuera de alcance:

- Cambios en Prisma.
- Migraciones.
- Cambios en WhatsApp Cloud API.
- Cambios en FSM.
- Integracion real del codigo de opera-dispatch.

## Checklist base

| Area | Validacion | Resultado esperado | Estado |
|---|---|---|---|
| Arranque | El servidor inicia | Sin errores criticos | Pendiente |
| Salud | GET /health | Responde ok | Pendiente |
| Login | Reclutador inicia sesion | Entra a /admin | Pendiente |
| Login | DEV inicia sesion | Entra a /admin | Pendiente |
| Permisos | Reclutador intenta /admin/monitor | Acceso denegado | Pendiente |
| Permisos | DEV entra a /admin/monitor | Acceso permitido | Pendiente |
| Permisos | Reclutador intenta /admin/operaciones | Acceso denegado | Pendiente |
| Permisos | DEV entra a /admin/operaciones | Acceso permitido | Pendiente |
| Webhook | Verificacion GET de Meta | Responde challenge | Pendiente |
| Webhook | Mensaje POST entrante | Se procesa sin error | Pendiente |

## Checklist flujo candidato

| Escenario | Resultado esperado | Estado |
|---|---|---|
| Candidato nuevo saluda | Bot saluda y usa vacante asignada si existe | Pendiente |
| Candidato pregunta salario | Responde solo desde la vacante asignada | Pendiente |
| Candidato pregunta horario | Responde solo desde la vacante asignada | Pendiente |
| Candidato confirma interes | Solicita datos necesarios | Pendiente |
| Candidato envia datos en desorden | Extrae datos validos sin guardar saludos como nombre | Pendiente |
| Candidato envia datos incompletos | Pide solo faltantes reales | Pendiente |
| Candidato sin vacante asignada | No avanza flujo como si tuviera vacante | Pendiente |
| Falta informacion de vacante | Escala internamente sin inventar | Pendiente |

## Checklist citas y recordatorios

| Escenario | Resultado esperado | Estado |
|---|---|---|
| Candidato agenda entrevista | Se crea reserva activa | Pendiente |
| Candidato confirma asistencia | Se registra confirmacion | Pendiente |
| Candidato cancela | Se cierra la ventana operativa correspondiente | Pendiente |
| Candidato pide reprogramar | Se detecta intencion y no duplica reservas | Pendiente |
| Recordatorio pendiente | Se envia segun politica vigente del codigo | Pendiente |
| Bot pausado con recordatorio operativo | El recordatorio no se bloquea indebidamente | Pendiente |

## Checklist supervision administrativa

| Escenario | Resultado esperado | Estado |
|---|---|---|
| Se crea revision manual | Admin recibe mensaje claro y compacto | Pendiente |
| Motivo tecnico | Se presenta al admin en espanol operativo | Pendiente |
| Admin responde instruccion al candidato | Se envia si corresponde | Pendiente |
| Admin envia acuse corto | No se reenvia al candidato | Pendiente |
| Mensaje interno | No aparece como conversacion visible del candidato | Pendiente |
| Monitor general | No muestra mensajes internos que deban ocultarse | Pendiente |

## Checklist archivos y audios

| Escenario | Resultado esperado | Estado |
|---|---|---|
| Candidato envia hoja de vida PDF | Se procesa o reenvia sin romper flujo | Pendiente |
| Candidato envia DOCX | Se procesa o reenvia sin romper flujo | Pendiente |
| Candidato envia imagen | Se maneja sin romper flujo | Pendiente |
| Candidato envia audio | Se reenvia al administrador como audio | Pendiente |
| Caption de archivo | No se duplica innecesariamente | Pendiente |

## Checklist aprendizajes de Lorren

| Escenario | Resultado esperado | Estado |
|---|---|---|
| DEV entra a /admin/bot-knowledge | Acceso permitido | Pendiente |
| Reclutador entra a /admin/bot-knowledge | Acceso denegado | Pendiente |
| DEV crea aprendizaje | Se guarda correctamente | Pendiente |
| DEV edita aprendizaje | Se actualiza sin perder scope/tags | Pendiente |
| DEV elimina aprendizaje | Se elimina con confirmacion | Pendiente |
| DEV pausa o activa aprendizaje | Sigue funcionando | Pendiente |

## Checklist Operaciones / Despacho

| Escenario | Resultado esperado | Estado |
|---|---|---|
| DEV ve enlace Operaciones / Despacho | Visible | Pendiente |
| Reclutador ve enlace Operaciones / Despacho | No visible | Pendiente |
| DISPATCH_MODULE_URL configurada | Boton abre el modulo externo | Pendiente |
| DISPATCH_MODULE_URL vacia | Muestra modulo pendiente de despliegue | Pendiente |
| URL invalida | No renderiza enlace peligroso | Pendiente |

## Validaciones tecnicas sugeridas

Cuando existan dependencias disponibles:

```bash
npm install
npx prisma generate
npm test
```

Pruebas focales recomendadas:

```bash
node --test test/contextualResponseGate.test.js
node --test test/replySafety.test.js
node --test test/adminSupervisor.test.js
node --test test/interviewScheduler.test.js
node --test test/reminder.test.js
node --test test/interviewLifecycleIntent.test.js
node --test test/internalVisibility.test.js
```

Chequeos sintacticos minimos:

```bash
node --check src/server.js
node --check src/routes/admin.js
node --check src/routes/webhook.js
node --check src/services/adminSupervisor.js
node --check src/services/contextualResponseGate.js
node --check src/services/reminder.js
node --check src/routes/botKnowledgeCrud.js
```

## Criterio antes de nuevos cambios

Antes de nuevos ajustes funcionales, validar como minimo:

- Healthcheck.
- Login reclutador.
- Login DEV.
- Webhook GET de Meta.
- Un candidato nuevo.
- Una FAQ con vacante asignada.
- Una cita activa que requiere revision interna.
- Un audio reenviado al administrador.
- Un aprendizaje editado por DEV.
- Acceso a /admin/operaciones solo como DEV.

## Reglas para futuros PR

- PR pequeno y enfocado.
- Sin cambios de Prisma salvo justificacion explicita.
- Sin tocar WhatsApp o FSM salvo que sea el objetivo exacto.
- Sin mezclar opera-dispatch con la logica del bot.
- Incluir prueba focal o minimo node --check de archivos tocados.
