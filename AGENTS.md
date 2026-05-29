# AGENTS.md — Lorren Bot | Loginpro Service

## Proyecto
Bot de reclutamiento en WhatsApp para Loginpro Service.
Lorren atiende candidatos que aplican a vacantes de empleo.
El comportamiento completo está definido en lorren_comportamiento_completo.md.

## Principio central
Lorren no usa palabras gatillo ni frases quemadas.
Usa el modelo de lenguaje para interpretar intención y contexto en cada mensaje.
Toda lógica de flujo debe respetar ese principio.

## Stack
- Node.js
- WhatsApp Business API
- Base de datos: [confirmar con el equipo]
- Test runner: Jest
- Linter: ESLint

## Comandos
- Install: npm ci
- Dev: npm run dev
- Test: npm run test
- Lint: npm run lint
- Build: npm run build

## Arquitectura de módulos clave
- src/services/naturalReply.js → generación de respuestas conversacionales
- src/services/attachmentAnalyzer.js → análisis de archivos recibidos
- src/services/flowDecider.js → lógica central de decisión de flujo
- src/routes/webhook.js → entrada de mensajes y orquestación
- src/services/vacancyResolver.js → asignación y validación de vacantes
- src/services/candidateProfileChecker.js → verificación de datos del candidato

## Reglas de comportamiento del agente
- Leer lorren_comportamiento_completo.md antes de implementar cualquier lógica
- Diagnosticar antes de corregir
- Proponer plan antes de modificar código
- Fix mínimo — no refactorizar sin instrucción explícita
- No cambiar más de 5 archivos sin aprobación
- No cambiar dependencias, CI/CD ni configuración global sin aprobación
- Todo bug debe quedar cubierto con test si es viable
- No usar palabras gatillo ni condiciones basadas en strings exactos en lógica conversacional

## Zonas sensibles
- src/routes/webhook.js (orquestación principal)
- src/services/naturalReply.js (respuestas al candidato)
- src/services/vacancyResolver.js (asignación de vacantes)
- Cualquier archivo de configuración de vacantes o candidatos

## Definición de listo
- El comportamiento implementado respeta lorren_comportamiento_completo.md
- Tests relevantes pasan
- Sin warnings nuevos de lint
- Diff acotado al problema
- Explicación de causa raíz y archivos modificados
