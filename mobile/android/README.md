# Lórren · Portal del Auxiliar para Android

Esta carpeta contiene la primera fase de la aplicación Android privada del **mismo Portal del Auxiliar**. No crea un segundo backend de asistencia ni reemplaza las autoridades del servidor.

## Qué hace esta fase

- abre el Portal del Auxiliar existente dentro de un WebView de origen HTTPS controlado;
- acepta una transferencia temporal de sesión por `lorren://portal/transferencia?...` y deja que el endpoint canónico del Portal rote el token y coloque la nueva cookie;
- conserva las capacidades web ya existentes del Portal, incluido almacenamiento local, cámara y geolocalización;
- genera en Android Keystore una clave EC P-256 no exportable para firmar respuestas de presencia;
- usa Google Nearby Connections con `P2P_STAR` para que un encargado descubra varios teléfonos Lórren cercanos sin Internet;
- deja automáticamente a un auxiliar en estado `Listo para asistencia` mientras la app está ejecutándose, existe un contexto de cuadrilla válido y los permisos/radios necesarios están disponibles;
- responde el challenge local firmado sin exigir al auxiliar un botón de preparación por cada verificación;
- muestra en el Portal un panel de prueba con el conteo de teléfonos cuya firma local fue verificada.

**Esta fase no registra asistencia.** El puente nativo declara `attendanceWriter: false`, el JavaScript nativo no llama endpoints de llegada y una prueba de contrato protege esa barrera.

## Qué no hace

- no instala ningún beacon o equipo Bluetooth en una operación;
- no necesita Play Store;
- no contiene APK, AAB, keystore ni clave de firma dentro del repositorio;
- no detecta teléfonos si el sistema cerró por completo la aplicación;
- no identifica a una persona únicamente por el nombre Bluetooth o por RSSI;
- no marca como presente a un teléfono cuya identidad todavía no esté provisionada por el servidor;
- no implementa todavía iPhone, almuerzo grupal ni salida grupal.

## Requisitos de desarrollo

- Android Studio compatible con Android Gradle Plugin 9.3.0;
- JDK 17;
- Android SDK 37 instalado;
- un teléfono Android con Google Play services para las pruebas de Nearby Connections;
- un origen HTTPS del Portal del Auxiliar.

No hay una URL productiva quemada en el proyecto. El origen se entrega al compilar mediante la propiedad Gradle `lorrenPortalBaseUrl`.

Ejemplo con Gradle instalado localmente:

```bash
gradle :app:assembleDebug \
  -PlorrenPortalBaseUrl=[https://portal.example.invalid](https://portal.example.invalid)
