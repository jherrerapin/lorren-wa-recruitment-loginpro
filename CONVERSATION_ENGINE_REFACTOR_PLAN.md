# Plan de refactor incremental del núcleo conversacional

> Alcance: solo motor conversacional y servicios listados en la misión. No se ejecutan cambios de código en este PR; este documento congela la auditoría técnica, evidencias y orden de PRs pequeños.

## Nota de preauditoría

- Se revisó `AGENTS.md` antes de modificar archivos.
- `lorren_comportamiento_completo.md` está referenciado por las instrucciones del repo, pero no existe en la raíz ni fue localizado por nombre en el repositorio. La auditoría se basa en el código actual y en las reglas explícitas de la misión.
- Se observó que `transportMode.js` ejecuta importaciones con efectos laterales hacia módulos fuera del núcleo conversacional. No se propone tocar esos módulos en este plan; el hallazgo se limita al riesgo de acoplamiento de importación dentro del archivo en alcance.

## Fase 1 — Mapa real del núcleo conversacional

### 1.1 Ciclo completo de un mensaje entrante hasta la respuesta

El ciclo operativo real alrededor del motor es una composición de clasificación previa, gates determinísticos, decisión LLM y aplicación determinística:

1. **Clasificación liviana de intención**
   - `conversationIntent.js` normaliza texto, detecta saludos, agradecimientos, cierre, no interés, aplazamiento, objeciones, cambio de vacante, CV, confirmación/corrección, FAQ y señales de datos.
   - Entrada: texto + contexto mínimo (`currentStep`, `hasUnsupportedMedia`, `isDoneStep`, `isInitialContact`).
   - Salida: string de intención (`greeting`, `provide_data`, `confirmation_yes`, `no_interest`, `post_completion_ack`, etc.).
   - Efectos secundarios: ninguno.
   - Riesgo: usa patrones regex explícitos para intención macro. Esto no viola por sí solo Think/Act, pero sí debe mantenerse como clasificación de seguridad/enrutamiento, no como conversación completa.

2. **Comprensión de datos del turno**
   - `conversationUnderstanding.js` combina extracción previa de IA (`aiResult`) con parsing local (`parseNaturalData`) y sanitización (`fieldSanitizer.js`).
   - Entrada: texto + `aiResult` opcional + contexto.
   - Salida: objeto con `intent`, `candidateFields`, `fieldConfidence`, `vacancyDetection`, `cityDetection`, `corrections`, `contradictions`, `rejectedFields`.
   - Efectos secundarios: ninguno; solo produce datos candidatos.
   - Contrato clave: los datos aún no se persisten; deben pasar por `act()` o política determinística posterior.

3. **Resolución y gate de vacante**
   - `vacancyResolver.js` busca vacantes, detecta ciudad, rol, zonas y rankea coincidencias activas/inactivas.
   - `vacancyFirstGate.js` decide acciones tempranas cuando no hay vacante confiable, cuando hay vacante inactiva/pausada, o cuando se requiere consentimiento contextual para capturar perfil futuro/alternativo.
   - Entrada: texto, candidato, mensajes recientes, Prisma y hints de vacantes.
   - Salida típica: decisión de gate con acción de vacante, reply, updates o modo de captura.
   - Efectos secundarios: `vacancyResolver.js` lee BD; `vacancyFirstGate.js` puede preparar updates, pero la persistencia debe ocurrir en el orquestador.

4. **Gate contextual de respuesta**
   - `contextualResponseGate.js` decide si el bot debe contestar, callar, responder desde contexto asignado o enviar a revisión humana segura.
   - Entrada: candidato, vacante, booking activo, mensajes recientes, `semanticIntent`, readiness.
   - Salida: `{ shouldReply, allowedAction, reason, responsePurpose, stateUpdates, requiresHumanReview, reply, metadata }`.
   - Efectos secundarios: ninguno.
   - Punto exacto de **no responder**: devuelve `shouldReply: false` + `allowedAction: NO_REPLY` cuando:
     - el último outbound fue manual y no hay acción pendiente real, y la intención es cierre/ack/unclear/provide extra/status;
     - hay entrevista activa en `SCHEDULED`, el mensaje es cierre o no hay acción permitida pendiente;
     - el flujo principal/CV-only está completo, no hay acción pendiente real, y el mensaje es cierre o no exige respuesta útil.

5. **think() — razonamiento conversacional LLM**
   - `conversationEngine.think()` construye el prompt con estado curado de candidato, vacante, readiness, historial, slot y conocimiento manual curado.
   - Entrada: texto entrante, candidato, vacante, mensajes recientes, slot, step, Prisma.
   - Salida esperada del modelo: JSON con `reply`, `nextStep`, `actions`, `extractedFields`, y metadatos/raw.
   - Efectos secundarios: llamada HTTP a OpenAI y lectura de conocimiento (`botKnowledge.js`) vía Prisma; no escribe BD.
   - Punto exacto de **nothing**: el prompt autoriza `actions: [{ type: "nothing" }]` y `reply: ""` cuando el mensaje no requiere respuesta útil o cuando el último mensaje del historial fue humano y no hay nuevo mensaje del candidato. En `act()`, `nothing` no aplica cambios por sí mismo.
   - Guardrail adicional: `applyLoopGuardToDecision()` puede reemplazar el reply del modelo si lo detecta repetitivo y no hay progreso significativo.

6. **act() — efectos determinísticos y guardrails**
   - `conversationEngine.act()` fusiona campos extraídos, normaliza, decide persistencia con `splitFieldDecisions()`, bloquea acciones inválidas y persiste solo lo aprobado.
   - Entrada: acciones, candidato, vacante, campos candidatos, `nextStep`, slot, Prisma.
   - Salida: `{ readiness, blockedActions, finalStep }`.
   - Efectos secundarios: escribe `candidate.update`, cancela/crea bookings al confirmar agenda, actualiza estado, pausa, reminders y step.
   - Punto exacto de **pause_bot**:
     - Acción explícita `pause_bot`: setea `botPaused`, `botPausedAt`, `botPauseReason`, cancela reminder y deja el step según otras reglas.
     - Bloqueo de scheduling con candidata femenina: setea pausa con razón de revisión humana y terminaliza `DONE`.
     - `offer_interview`/`reschedule` sin slot válido: setea pausa por falta de slot válido y cancela reminder.

7. **replySafety — sanitización de salida**
   - `replySafety.js` aplica seguridad final contra drift de readiness, instrucciones inseguras de CV, claims no soportados de vacante/dirección y fuentes manuales autorizadas.
   - Entrada: reply, vacante, candidato, step, source.
   - Salida: reply saneado/fallback.
   - Efectos secundarios: ninguno.

### 1.2 Comparación: `contextualReply.js` vs `contextualResponseGate.js` vs `flowDecider.js`

No son equivalentes, pero hay solapamiento de responsabilidad comunicacional:

- `contextualResponseGate.js` es un **gate determinístico de permiso**: decide si se contesta, se calla, se responde desde datos asignados o se crea revisión segura. No redacta salvo respuestas logísticas/fallback seguras.
- `contextualReply.js` es un **redactor contextual** para situaciones puntuales: adjuntos, correcciones, fallback y mensajes de revisión. Puede usar OpenAI Responses API, pero siempre con payload limitado y fallback determinístico.
- `flowDecider.js` es un **router legacy/de dominio**: dado candidato, vacante e intención, decide la siguiente acción macro (`IDENTIFY_VACANCY`, `COLLECT_DATA`, `REQUEST_CV`, `SCHEDULE_INTERVIEW`). No redacta.

Solapamientos concretos:

- `flowDecider.js` y `conversationEngine.act()` ambos codifican orden de flujo: datos → CV → agenda/cierre. La diferencia es que `act()` es autoridad real de side effects; `flowDecider.js` parece apoyar generación/fallback en `naturalReply.js`.
- `contextualReply.js` y `responsePolicy.js` tienen su propio repeat guard (`>= 0.85` y `>= 0.8`) mientras `conversationEngine.js` usa `>= 0.78`; esto dispersa la definición de repetición.
- `contextualResponseGate.js` y el prompt de `conversationEngine.js` comparten reglas de no pisar humanos y no responder a cierres, pero solo el gate es determinístico.

Conclusión: mantener capas separadas, pero extraer una utilidad compartida de similitud/repetición y documentar que `act()` es la única autoridad de avance persistido.

### 1.3 Comparación: `botAutomationPolicy.js` vs `policyLayer.js` vs `responsePolicy.js`

- `botAutomationPolicy.js`
  - Regla: cuándo una pausa del bot bloquea automatización y cuándo un inbound del candidato puede reanudarla.
  - Entrada: candidato + contexto de dirección.
  - Salida: boolean/update de reanudación.
  - Efectos: ninguno por sí mismo.

- `policyLayer.js`
  - Regla: política de aceptación de campos extraídos, especialmente nombre, edad y género, con evidencia/confianza.
  - Entrada: extracción estructurada + candidato actual.
  - Salida: `persistedFields`, `reviewQueue`, `blocked`, protecciones de descarte.
  - Efectos: ninguno.

- `responsePolicy.js`
  - Regla: fallback de redacción por intención y anti-repetición simple.
  - Entrada: intención de reply, outbound reciente, fallback y resumen contextual.
  - Salida: texto de policy reply.
  - Efectos: ninguno.

Superposiciones/contradicciones:

- La evidencia de género vive en `policyLayer.js`, `fieldSanitizer.js` y el prompt de `buildGenderFlowInstruction()`. Las listas son parecidas, pero no idénticas, lo que permite que una capa sugiera género y otra lo bloquee o que el prompt incentive extracción con expresiones más amplias que las políticas determinísticas.
- La regla “no pisar intervención humana” vive en `botAutomationPolicy.js`, `contextualResponseGate.js`, `conversationEngine.hasRecentHumanIntervention()` y el prompt. Las fuentes manuales no usan exactamente el mismo criterio.
- La regla de anti-repetición vive en `responsePolicy.js`, `contextualReply.js` y `conversationEngine.js` con umbrales diferentes.

Propuesta global: no fusionar todo en un “policy god file”; sí crear pequeñas utilidades explícitas para `replySimilarity`, `manualSourcePolicy` y `genderEvidencePolicy`, usadas por las capas actuales.

### 1.4 Geografía/transporte vs `candidateData.js`

Hallazgos de normalización duplicada:

- `geographyNormalization.js` contiene el catálogo de localidades bogotanas y aliases. `candidateData.js` lo usa para validar/normalizar localidad, pero también implementa limpieza de location, detección de Soacha, chunks de ubicación, secuencias y heurísticas propias.
- `cityOptions.js` normaliza nombres de ciudad para opciones de BD (`normalizeCityKey`), mientras `vacancyResolver.js` tiene su propia normalización de texto/resolver. Son responsabilidades distintas, pero comparten lógica base de quitar tildes/minúsculas/espacios.
- `transportMode.js` es el normalizador determinístico principal de transporte; `candidateData.js` también tiene detectores de keywords/secuencias y una función exportada `normalizeTransportMode()` que delega al normalizador determinístico. Esto está cerca de un buen punto de verdad, pero todavía hay heurísticas de detección repartidas.

Riesgo adicional: `transportMode.js`, pese a ser normalizador puro, importa módulos externos con efectos laterales. Esto hace que importar normalización de transporte arrastre comportamiento no conversacional. Debe eliminarse en un PR separado si no rompe tests, sin tocar los módulos externos.

## Fase 2 y Fase 3 — Hallazgos con plan incremental

### PR 1 — Loop guard conversacional

**HALLAZGO:** `applyLoopGuardToDecision()` solo compara texto del reply contra los últimos tres outbound con `isSubstantiallySimilarReply()` y umbral fijo `0.78`, salvo que detecte progreso por `nextStep`, `extractedFields` o acciones distintas de `nothing`/`request_confirmation`.

**ARCHIVO(S):** `src/services/conversationEngine.js`; tests existentes relacionados en `test/conversationEngineGuardRails.test.js`.

**RIESGO:** Alto. Es impacto directo en UX: puede reemplazar una respuesta correcta por fallback si el candidato pregunta dos veces lo mismo, o dejar pasar bucles parafraseados si el modelo cambia vocabulario.

**IMPACTO EN COMPORTAMIENTO DEL BOT:**

- Falso positivo: candidato pregunta “¿qué documentos llevo?” dos veces; una respuesta legítima con vocabulario similar puede ser reemplazada por “Ya revisé…” y sonar evasiva.
- Falso positivo en respuestas cortas: “Sí, correcto” / “Correcto” comparten casi todos los tokens.
- Falso negativo: “Envíame tu HV en PDF o DOCX” vs “Compárteme tu hoja de vida en formato PDF o Word” pueden ser el mismo bucle con bajo overlap tokenizado.

**PROPUESTA:**

- Agregar heurística complementaria antes de aplicar fallback:
  - no aplicar loop guard si el inbound actual es una pregunta explícita y el reply responde una pregunta de vacante/agenda desde contexto permitido;
  - comparar también `detectedIntent`/acción principal cuando exista en `raw` antes de declarar loop;
  - subir umbral para replies cortos o exigir longitud mínima de tokens para aplicar `0.78`;
  - mantener fallback solo cuando no hay progreso y el mismo propósito de respuesta se repite.
- Extraer utilidad de similitud compartida posteriormente, pero en este PR tocar solo engine y tests.

**TESTS NECESARIOS ANTES DE TOCAR:**

- Misma pregunta logística dos veces debe permitir misma respuesta si `raw.detectedIntent` o semantic purpose indica pregunta.
- Bucle real de pedir el mismo dato faltante tres veces debe activar fallback.
- Replies de menos de 5 tokens no deben activar fallback salvo igualdad exacta.
- Parafraseo de solicitud de HV sin progreso debe activar guard por intención/acción, no solo por overlap.
- Confirmar que `loopGuardApplied` permanece `false` cuando hay `extractedFields` nuevos.

### PR 2 — Orden de resolución de acciones en `act()`

**HALLAZGO:** `act()` calcula `persistedFields` antes del loop, pero el estado final depende de la iteración de `actions`. `terminalStep` gana sobre `requestedStep`; acciones como `mark_no_interest`, `mark_rejected`, `confirm_booking`, `mark_female_pipeline`, `pause_bot`, `request_cv`, `request_confirmation`, `offer_interview` pueden convivir en el array y producir combinaciones no obvias.

**ARCHIVO(S):** `src/services/conversationEngine.js`; tests existentes en `test/conversationEngineGuardRails.test.js`.

**RIESGO:** Alto. El LLM puede devolver acciones en distinto orden; aunque algunos terminales ganan, los side effects acumulados en `pendingUpdate` y bookings pueden variar.

**IMPACTO EN COMPORTAMIENTO DEL BOT:**

- Si `mark_no_interest` llega junto a `save_fields`, los campos se persisten antes de cerrar, lo cual puede ser deseado o no; hoy no queda documentado.
- Si `pause_bot` aparece antes/después de `offer_interview` con bloqueo, la razón final de pausa puede cambiar.
- Si `confirm_booking` y `mark_no_interest` conviven, puede intentar crear booking y luego cerrar interés según orden.

**PROPUESTA:**

- Introducir fase de normalización/priorización de acciones sin cambiar contrato externo:
  1. `save_fields` siempre se procesa como extracción previa.
  2. terminales excluyentes (`mark_no_interest`, `mark_rejected`) cortan agenda.
  3. `mark_female_pipeline` solo después de readiness.
  4. agenda (`confirm_booking`, `offer_interview`, `reschedule`) solo si no hay terminal excluyente.
  5. `pause_bot` tiene prioridad explícita para razón de pausa si es la acción principal.
- Registrar `blockedActions` para acciones descartadas por prioridad.

**TESTS NECESARIOS ANTES DE TOCAR:**

- Arrays con las mismas acciones en distinto orden producen mismo `finalStep`, `pendingUpdate` y `blockedActions`.
- `mark_no_interest + confirm_booking` nunca crea booking.
- `pause_bot + offer_interview` conserva una razón determinística documentada.
- `save_fields` se persiste independientemente del orden, salvo si la política futura decide proteger cierres.
- Candidata femenina nunca llega a `SCHEDULING`/`SCHEDULED` aunque el modelo lo solicite.

### PR 3 — Consolidación de policies dispersas

**HALLAZGO:** Reglas de automatización, evidencia de campos, respuesta fallback, manual outbound, género y repetición viven en varios archivos y en el prompt. No hay contradicción fatal inmediata, pero sí divergencia de fuentes.

**ARCHIVO(S):** `src/services/botAutomationPolicy.js`, `src/services/policyLayer.js`, `src/services/responsePolicy.js`, `src/services/contextualResponseGate.js`, `src/services/conversationEngine.js`, `src/services/fieldSanitizer.js`.

**RIESGO:** Medio. La dispersión aumenta regresiones cuando se cambia una regla en una capa y otra mantiene una variante antigua.

**IMPACTO EN COMPORTAMIENTO DEL BOT:**

- Puede responder encima de un humano si un source se interpreta manual en una capa y bot en otra.
- Puede aceptar/rechazar género de forma distinta entre prompt, sanitizador y policy.
- Puede variar el tono/fallback por repetir según el submotor que lo redacte.

**PROPUESTA:**

- Crear utilidades pequeñas, no un refactor total:
  - `manualSourcePolicy` para fuente manual/bot/equipo;
  - `replySimilarityPolicy` para normalización y umbrales por longitud;
  - `genderEvidencePolicy` para lista única de evidencia fuerte/ambigua.
- En el primer PR de policy, solo extraer manual source y actualizar tests; luego similitud; luego género.

**TESTS NECESARIOS ANTES DE TOCAR:**

- Tabla de sources: vacío, `admin_*`, `manual_*`, `MANUAL_AUTHORIZED`, `reminder*`, `system*`, source bot normal.
- `hasRecentHumanIntervention()` y `getLastOutboundContext()` deben clasificar igual.
- `responsePolicy`, `contextualReply` y loop guard deben conservar decisiones actuales en casos base.

### PR 4 — Consolidación geografía/transporte

**HALLAZGO:** Existe un punto fuerte para localidad (`geographyNormalization.js`) y transporte (`transportMode.js`), pero `candidateData.js` conserva detección/limpieza propia. Además, el normalizador de transporte no es puro por importaciones con efectos laterales.

**ARCHIVO(S):** `src/services/candidateData.js`, `src/services/geographyNormalization.js`, `src/services/cityOptions.js`, `src/services/transportMode.js`, `src/services/vacancyResolver.js`.

**RIESGO:** Medio. Las diferencias pueden producir que un valor sea aceptado por una ruta y rechazado por otra.

**IMPACTO EN COMPORTAMIENTO DEL BOT:**

- Bogotá: puede pedir “localidad” aunque ya se detectó una localidad como barrio, o rechazar municipio vecino en un punto y aceptarlo en otro.
- Transporte: “no cuento con vehículo”, “voy en Transmi”, “bicivleta” pueden mapear distinto según ruta.
- Importar `candidateData.js` arrastra un normalizador que no debería disparar efectos no conversacionales.

**PROPUESTA:**

- Primero hacer tests de caracterización para localidad/transporte.
- Convertir `transportMode.js` en módulo puro eliminando efectos laterales dentro del archivo en alcance.
- Mover helpers comunes de normalización de texto a utilidades específicas solo si reduce duplicación sin ampliar alcance.
- Mantener `candidateData.js` como orquestador de extracción, pero delegar cada normalización canónica.

**TESTS NECESARIOS ANTES DE TOCAR:**

- Localidades bogotanas exactas y aliases: Suba, Lisboa, Patio Bonito, Puente Aranda, Soacha como no localidad.
- Ciudad: equivalencias con tildes y espacios.
- Transporte: Moto, Bicicleta, Carro, Público, negaciones de vehículo y typos existentes.
- `normalizeCandidateFields()` debe seguir devolviendo los mismos campos para mensajes naturales representativos.

### PR 5 — Robustez de `parseEngineJson()`

**HALLAZGO:** `parseEngineJson()` intenta JSON directo, bloque markdown, objeto balanceado y luego `repairLooseJsonObject()`. La reparación agrega comillas a keys y convierte strings con comillas simples. Aunque la regex de keys está anclada a `{` o `,`, no entiende semántica del campo `reply`; si el modelo devuelve JSON suelto con texto natural parcialmente mal escapado, puede “reparar” algo parseable pero distinto a lo que el modelo quiso decir.

**ARCHIVO(S):** `src/services/conversationEngine.js`; test recomendado nuevo o ampliación en `test/conversationEngineGuardRails.test.js`.

**RIESGO:** Medio. La corrupción silenciosa es menos frecuente con `response_format: json_object`, pero cuando ocurre afecta directamente el reply o acciones.

**IMPACTO EN COMPORTAMIENTO DEL BOT:**

- Reply con comillas o dos puntos sin escape puede fallar y caer a fallback, o peor, parsear con contenido alterado.
- Acciones/campos pueden aceptarse desde un objeto reparado de baja confiabilidad.

**PROPUESTA:**

- Separar niveles de confianza del parse: `strict`, `markdown`, `balanced`, `repaired`.
- Si se usó reparación, validar schema mínimo estricto: `reply` string, `actions` array, `extractedFields` objeto; si el reply contiene patrones sospechosos de truncamiento, fallback.
- Loggear `[ENGINE_PARSE_FAIL]` con `parseStrategy` sin incluir texto sensible.
- Considerar no persistir campos cuando la estrategia sea `repaired`, salvo acciones muy seguras, en un PR posterior.

**TESTS NECESARIOS ANTES DE TOCAR:**

- JSON válido estricto.
- JSON en markdown.
- Objeto balanceado rodeado de texto.
- Keys sin comillas simples reparables.
- Reply con comillas y dos puntos debe no corromperse; si no se puede parsear, fallback seguro.
- JSON reparado debe exponer estrategia para auditoría o al menos no persistir basura.

### PR 6 — Casos de prueba para detección de género

**HALLAZGO:** La instrucción de género del prompt considera “candidata”, “interesada”, “quedo atenta”, etc. `policyLayer.js` exige evidencia parecida. `fieldSanitizer.js` también filtra cortesías. Hay exclusiones para “sí señora”, “gracias señorita”, pero faltan casos ambiguos de tratamiento, citas de terceros o texto sobre la reclutadora.

**ARCHIVO(S):** `src/services/conversationEngine.js`, `src/services/policyLayer.js`, `src/services/fieldSanitizer.js`, pruebas en `test/fieldSanitizer.test.js` y/o `test/conversationEngineGuardRails.test.js`.

**RIESGO:** Bajo/Medio. El guardrail de scheduling femenino es crítico; un falso positivo puede pausar una postulación masculina, y un falso negativo puede agendar automáticamente una candidata.

**IMPACTO EN COMPORTAMIENTO DEL BOT:**

- Falso positivo: candidato escribe “gracias, quedo atento a la señorita” o “mi esposa está interesada” y se marca género incorrecto.
- Falso negativo: candidata escribe una evidencia clara pero no cubierta y se agenda automáticamente.

**PROPUESTA:**

- Antes de tocar regex, agregar suite de caracterización con positivos, negativos y ambiguos.
- Luego extraer lista única de evidencia fuerte/ambigua compartida entre sanitizador/policy/prompt.
- Mantener regla de no inferir por nombre.

**TESTS NECESARIOS ANTES DE TOCAR:**

- Positivos FEMALE: “soy mujer”, “soy candidata”, “estoy interesada en la vacante”, “quedo atenta”, “me postulo como candidata”.
- Positivos MALE: “soy hombre”, “soy candidato”, “estoy interesado en la vacante”, “quedo atento”.
- Negativos/ambiguos: “sí señora”, “gracias señorita”, “la señorita me dijo”, “mi esposa está interesada”, “es para mi hermana”, “quedo atento a la respuesta de la señora”, “candidata es la vacante que vi” si aparece en contexto no personal.

### PR 7 — Fallbacks del loop guard menos robóticos

**HALLAZGO:** `buildLoopGuardReply()` tiene respuestas fijas por step/contexto. Si el guard se activa más de una vez, puede sonar repetitivo y romper la continuidad natural.

**ARCHIVO(S):** `src/services/conversationEngine.js`; posible reutilización futura de `responsePolicy.js`.

**RIESGO:** Bajo/Medio. No corrompe estado, pero degrada percepción humana del bot.

**IMPACTO EN COMPORTAMIENTO DEL BOT:** Candidato puede recibir dos veces “Ya revisé lo que enviaste…” o una frase no ajustada a su pregunta real, generando sensación robótica.

**PROPUESTA:**

- Agregar 2–3 variantes por contexto y seleccionar evitando outbound reciente con la misma utilidad de similitud.
- Incluir microcontexto seguro: dato faltante, CV, vacante no asignada, sin inventar.
- No usar OpenAI para este fallback; mantener determinístico.

**TESTS NECESARIOS ANTES DE TOCAR:**

- Dos activaciones consecutivas no devuelven la misma variante si hay alternativa.
- ASK_CV siempre mantiene PDF/DOCX y nunca foto/imagen.
- Sin vacante pide ciudad/vacante sin solicitar datos no permitidos.

### PR 8 — Robustez de humano vs bot en historial

**HALLAZGO:** `conversationEngine.hasRecentHumanIntervention()` considera outbound humano cuando `rawPayload.source` está vacío. `contextualResponseGate.js` tiene una lógica más rica: vacío también es manual, `admin_*`/`manual_*` son manuales, `reminder*` es reminder, `system*` es system, otros son bot. La divergencia puede clasificar diferente mensajes manuales enviados desde el mismo canal.

**ARCHIVO(S):** `src/services/conversationEngine.js`, `src/services/contextualResponseGate.js`, `src/services/botAutomationPolicy.js`.

**RIESGO:** Medio. El bot puede pisar un mensaje humano o callarse cuando debería continuar.

**IMPACTO EN COMPORTAMIENTO DEL BOT:**

- Si un recruiter envía manualmente desde un canal con `source` poblado como bot-like, el engine lo verá como Bot/Equipo y puede contradecirlo.
- Si un outbound automático llega sin source por error, el engine lo verá como Humano y bloqueará continuidad.

**PROPUESTA:**

- Extraer política única de actor/source.
- Guardar/usar `rawPayload.actor` o `actorRole` cuando exista antes de inferir por source.
- Agregar tests de matriz de source y actor.

**TESTS NECESARIOS ANTES DE TOCAR:**

- Último outbound sin source → humano/manual por compatibilidad actual.
- `admin_*`, `manual_*`, `MANUAL_AUTHORIZED` → humano/recruiter.
- `reminder*`, `system*`, source bot normal → no humano.
- `rawPayload.actor: RECRUITER` gana sobre source ambiguo.

## Orden de ejecución recomendado

1. PR 1: Loop guard con tests de regresión.
2. PR 2: Orden determinístico de acciones en `act()`.
3. PR 3a: Política única de manual source/human intervention.
4. PR 3b: Política única de similitud/repetición.
5. PR 4: Normalización geografía/transporte y pureza del normalizador.
6. PR 5: Parse JSON con estrategia/confianza y logs.
7. PR 6: Tests y consolidación de evidencia de género.
8. PR 7: Variantes determinísticas de fallback del loop guard.

## Redundancias concretas detectadas

- Normalización de texto sin tildes/minúsculas/espacios se repite en `conversationIntent.js`, `contextualResponseGate.js`, `contextualReply.js`, `responsePolicy.js`, `conversationEngine.js`, `geographyNormalization.js`, `transportMode.js`, `cityOptions.js`, `vacancyResolver.js` y `fieldSanitizer.js`.
- Similitud por overlap de tokens existe en `conversationEngine.js`, `contextualReply.js` y `responsePolicy.js` con umbrales diferentes.
- Evidencia de género existe en prompt de `conversationEngine.js`, `policyLayer.js` y `fieldSanitizer.js`.
- Detección de actor humano/manual existe en `conversationEngine.js`, `contextualResponseGate.js` y `botAutomationPolicy.js`.
- Flujo datos → CV → agenda/cierre existe en `flowDecider.js`, `readinessGuard.js`, `schedulingGuard.js` y `conversationEngine.act()`; la autoridad real debe seguir siendo `act()` + guards determinísticos.

## Contratos y efectos secundarios por archivo en alcance

| Archivo | Contrato principal | Efectos secundarios |
| --- | --- | --- |
| `conversationEngine.js` | `think()` produce decisión LLM; `act()` aplica guardrails y persiste; helpers construyen estado/prompt/parse/safety | OpenAI HTTP en `think`; Prisma update y bookings en `act`; logs |
| `candidateData.js` | parseo/normalización de campos candidato | Ninguno |
| `readinessGuard.js` | calcula missing fields, elegibilidad, readiness y mensajes de faltantes | Ninguno |
| `schedulingGuard.js` | bloquea agenda si falta readiness, CV, slot, vacante o género lo impide | Ninguno |
| `replySafety.js` | sanea reply contra drift, CV inseguro y claims no soportados | Ninguno |
| `naturalReply.js` | generación/fallback natural legacy y frases de entrevista/documentos | OpenAI HTTP en generación |
| `botKnowledge.js` | carga/formatea conocimiento curado para prompt | Lectura Prisma |
| `debugTrace.js` | trazabilidad, inferencias debug, split de persistencia | Ninguno |
| `aiParser.js` | extracción IA auxiliar y utilidades de modelo/temperatura | OpenAI HTTP en parser |
| `vacancyResolver.js` | resolución/ranking de vacantes por texto | Lectura Prisma |
| `vacancyFirstGate.js` | gate temprano de vacante activa/inactiva/alternativa/perfil futuro | Lectura Prisma |
| `vacancyConceptMatcher.js` | alternativa conceptual de vacante | Ninguno |
| `flowDecider.js` | decisión macro legacy de flujo | Ninguno |
| `conversationIntent.js` | intención liviana por texto/contexto | Ninguno |
| `conversationUnderstanding.js` | unifica extracción IA/local y sanitización | Ninguno |
| `contextualReply.js` | redacta respuesta contextual/fallback | OpenAI Responses HTTP opcional |
| `contextualResponseGate.js` | decide permiso de responder/no responder/revisión | Ninguno |
| `interviewScheduler.js` | slots, booking, cancelación, fechas | Lectura/escritura Prisma |
| `interviewLifecycle.js` | reglas de ciclo/confirmación/no respuesta de entrevista | Ninguno |
| `interviewIntentClassifier.js` | clasifica intención de entrevista local + IA | OpenAI parser opcional |
| `cvFlow.js` | validación tipo/extensión CV y pasos post-CV | Ninguno |
| `cvIntelligence.js` | análisis de CV contra candidato | Lectura storage/Prisma; OpenAI HTTP |
| `cvStorage.js` | storage de CV | Escritura/lectura storage y Prisma |
| `cvTextExtraction.js` | extracción texto PDF/DOCX | CPU parsing local |
| `cvMigration.js` | migración de CV binario a storage | Lectura/escritura Prisma/storage |
| `attachmentAnalyzer.js` | clasifica adjuntos | OpenAI Responses HTTP opcional; parsing local |
| `fieldSanitizer.js` | acepta/rechaza campos por evidencia y contexto | Ninguno |
| `reminder.js` | recordatorios proceso/entrevista | WhatsApp outbound, Prisma, jobs |
| `reminderPolicy.js` | política ventana WhatsApp/reminders | Ninguno |
| `geographyNormalization.js` | normaliza localidades Bogotá | Ninguno |
| `cityOptions.js` | opciones/equivalencias de ciudad | Lectura Prisma |
| `transportMode.js` | normaliza transporte | Importaciones con efectos laterales; función pura deseada |
| `silentProfileCapture.js` | captura silenciosa en modo perfil futuro | Ninguno |
| `policyLayer.js` | política de persistencia por evidencia | Ninguno |
| `responsePolicy.js` | fallback replies y repeat guard | Ninguno |
| `botAutomationPolicy.js` | pausa/reanudación de automatización | Ninguno |
| `lorenV2Gate.js` | gate de release/acceso web | Ninguno conversacional directo |
| `multiline.js` | consolidación de mensajes multilínea | Construye hints de contexto de anuncio; sin persistencia |
