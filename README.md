# Loginpro WhatsApp Contingency

## Objetivo
Chatbot de reclutamiento por WhatsApp para captar candidatos de pautas publicadas en Meta (Facebook, Instagram). Captura datos del candidato de forma conversacional y natural, y los muestra en un panel administrativo para el equipo de reclutamiento.

## Flujo del bot
1. **Saludo**: El candidato escribe y recibe saludo formal + información de la vacante.
2. **FAQ**: Si el candidato pregunta sobre horarios, salario, ubicación, etc., el bot responde de forma natural.
3. **Captura de datos**: Cuando confirma interés, el bot pide datos (nombre, documento, edad, ciudad, barrio). El candidato puede enviarlos en cualquier formato y orden.
4. **Confirmación**: El bot muestra los datos capturados para que el candidato los confirme.
5. **Agendamiento**: Si la vacante tiene agenda automática, el bot agenda la entrevista y envía confirmación con dirección y horario.
6. **Cierre**: Confirma registro e indica fecha de entrevista.

## Requisitos
- Node.js 20+
- PostgreSQL 15+
- Cuenta Meta con WhatsApp Cloud API habilitada

## Arranque local
1. Copia `.env.example` a `.env` y configura las variables
2. Instala dependencias: `npm install`
3. Inicia PostgreSQL (puedes usar Docker): `docker compose up -d`
4. Ejecuta migraciones:
   ```bash
   npx prisma generate
   npx prisma migrate dev
   ```
5. Arranca: `npm run dev`

## Endpoints
- `/health` — Health check (consulta la base de datos)
- `/webhook` — Webhook de WhatsApp (GET verificación, POST mensajes)
- `/admin` — Panel administrativo (protegido con Basic Auth)

## Roles de acceso al panel

El panel administrativo tiene dos roles con diferentes niveles de acceso:

### Reclutador (`ADMIN_USER` / `ADMIN_PASS`)
- Listado de candidatos con filtros por estado, vacante y texto libre
- Detalle del candidato (sin historial de conversación)
- Cambio de estado del candidato
- Gestión de entrevistas: marcar Asistió / No asistió
- Reagendamiento manual de entrevistas (si la vacante tiene agenda habilitada)
- Descargar Excel con candidatos
- Botón de WhatsApp para contactar candidatos directamente
- Subir y descargar hoja de vida del candidato
- **No tiene acceso** al Monitor en tiempo real ni a herramientas de desarrollo

### Desarrollador (`DEV_USER` / `DEV_PASS`)
- Todo lo del reclutador
- Historial de conversación completo en el detalle del candidato
- Monitor en tiempo real de mensajes (`/admin/monitor`)
- Botones adicionales en entrevistas: Confirmada, No contesta, Canceló, Reagendó
- Herramientas de vacante: asignar vacante, enviar información, enviar mensajes salientes
- Pausar / reanudar bot por candidato
- Eliminar registro completo del candidato
- Movimientos del reclutador auditados

## Variables de entorno
| Variable | Descripción |
|---|---|
| `PORT` | Puerto del servidor (default: 3000) |
| `DATABASE_URL` | Cadena de conexión PostgreSQL |
| `META_VERIFY_TOKEN` | Token de verificación del webhook en Meta |
| `META_ACCESS_TOKEN` | Token de acceso permanente de WhatsApp Cloud API |
| `META_PHONE_NUMBER_ID` | ID del número de teléfono en Meta |
| `ADMIN_USER` | Usuario del reclutador para el panel administrativo |
| `ADMIN_PASS` | Contraseña del reclutador para el panel administrativo |
| `DEV_USER` | Usuario del desarrollador para el panel administrativo |
| `DEV_PASS` | Contraseña del desarrollador para el panel administrativo |
| `OPENAI_API_KEY` | Clave de OpenAI para procesamiento de mensajes |
| `OPENAI_MODEL` | Modelo a usar (recomendado: `gpt-5.4-mini-2026-03-17`) |
| `OPENAI_ENABLED` | Activa o desactiva el uso de OpenAI (`true`/`false`) |
| `SESSION_SECRET` | String aleatorio seguro para firmar cookies de sesión |
| `R2_ACCOUNT_ID` | Account ID de Cloudflare R2 para almacenamiento de CVs |
| `R2_ACCESS_KEY_ID` | Access Key de Cloudflare R2 |
| `R2_SECRET_ACCESS_KEY` | Secret Key de Cloudflare R2 |
| `R2_BUCKET` | Nombre del bucket R2 |
| `R2_PUBLIC_BASE_URL` | URL pública del bucket (si tiene dominio personalizado) |

## Obtener un token de acceso permanente de Meta (System User Access Token)

El token de desarrollo de WhatsApp Cloud API expira en ~24 horas. Para producción, necesitas un **System User Access Token** que **no expira**. Sigue estos pasos:

### Paso 1: Acceder a Meta Business Suite
1. Ve a [business.facebook.com](https://business.facebook.com)
2. Haz clic en **Configuración del negocio** (Business Settings) en el menú lateral

### Paso 2: Crear un Usuario del Sistema
1. En el menú lateral, ve a **Usuarios** > **Usuarios del sistema**
2. Haz clic en **Agregar** (Add)
3. Asigna un nombre descriptivo (ej: `loginpro-whatsapp-bot`)
4. Selecciona el rol **Admin**
5. Haz clic en **Crear usuario del sistema**

### Paso 3: Asignar activos al usuario
1. Selecciona el usuario del sistema que acabas de crear
2. Haz clic en **Asignar activos** (Assign Assets)
3. Selecciona **Apps** y asigna tu app de WhatsApp
4. Activa **Control total** (Full Control)
5. Guarda los cambios

### Paso 4: Generar el token permanente
1. Con el usuario del sistema seleccionado, haz clic en **Generar token** (Generate Token)
2. Selecciona tu app de WhatsApp
3. Marca los siguientes permisos:
   - `whatsapp_business_messaging` — Enviar y recibir mensajes
   - `whatsapp_business_management` — Administrar la cuenta de WhatsApp Business
4. Haz clic en **Generar token**
5. **Copia el token** — este token **NO expira**

### Paso 5: Configurar en el proyecto
1. Pega el token en la variable de entorno `META_ACCESS_TOKEN`
2. En producción, usa los secrets del proveedor de hosting (Railway, Render, etc.)
3. **Nunca** guardes el token directamente en el código fuente ni en `.env` en el servidor

## Nota crítica
No uses `.env` manual en servidor. En producción, carga todas las variables como secrets del proveedor.
