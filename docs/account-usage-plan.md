# Uso de cuentas Claude Code y Codex en Crow

Propuesta investigada el 9 de octubre de 2026. La sección siguiente refleja el alcance implementado; la propuesta original se conserva debajo como contexto histórico, no como comportamiento actual.

## Implementado: cuentas globales

Abrí **Cuentas** en la barra superior, elegí Claude Code o Codex, agregá un nombre y pulsá **Iniciar sesión**. Podés registrar varias cuentas del mismo proveedor sin configurar hosts. Usá la cuenta correcta en el navegador de autenticación; Crow no cambia las sesiones de tus otras herramientas.

| Función | Comportamiento |
|---|---|
| Autenticación | CLI oficial instalado localmente: Codex abre su login en navegador; Claude abre una ventana interactiva para `claude auth login`. No se implementa un cliente OAuth propio. |
| Perfiles | Directorios independientes por UUID dentro de `userData/account-profiles`. `CODEX_HOME` / `CLAUDE_CONFIG_DIR` aislados; no se importa la sesión global. |
| Credenciales | Administradas por los CLI en sus perfiles; NO se copian a `accounts.json`, IPC, renderer ni logs. No se promete cifrado de esos archivos. Eliminá una cuenta para quitar también su perfil local una vez cerrada una consulta/login pendiente. |
| Cuotas | Porcentaje usado y restante, ventanas, renovación y fecha de muestra. No son tokens de una conversación ni tiempo de caché. No se suman porcentajes. |
| Actualización | Caché de 3 minutos por cuenta; sólo el panel abierto consulta periódicamente. Dos consultas simultáneas como máximo; solicitudes repetidas se agrupan. Se respeta el backoff de 429. |
| Errores | Fallos temporales conservan la muestra con su fecha original como datos anteriores. Credenciales inválidas descartan las cuotas anteriores; reconectar invalida la muestra antes del login. |

**Fuentes y limitaciones:** Codex usa `account/read` y `account/rateLimits/read` del app-server oficial, sin crear conversaciones ni enviar prompts. Claude consulta el endpoint OAuth **no documentado** `/api/oauth/usage`, con credenciales exclusivamente del perfil creado por Crow. Ese endpoint puede cambiar. Si el CLI guarda credenciales en un formato no compatible, no hay fallback a tu cuenta global. Una credencial Claude vencida requiere reconectar; Crow no implementa renovación OAuth propia. Los proveedores/planes pueden no ofrecer cuotas: se muestra “uso no disponible”, nunca un 0 % inventado. La identidad Claude puede no estar disponible; el nombre lo asignás vos.

Referencia de arquitectura multicuenta: [shuvquota](https://github.com/shuv1337/shuvquota). No se instala ni se copia su identificador OAuth. La autenticación permanece a cargo de cada CLI oficial. Validación automática con adaptadores simulados; login y comparación con cuotas reales quedan pendientes de prueba manual autorizada. No se modifican `crowd`, terminales ni campanas.

## Propuesta histórica por host (reemplazada en esta entrega)

Objetivo original: mostrar cuánto queda de las cuotas y cuándo se restablecen, sin reemplazar las terminales ni exportar credenciales.

## Qué mostrar primero

- Indicadores compactos de Claude y Codex en la cabecera del host seleccionado: porcentaje **usado**, ventana y próxima renovación.
- Panel de detalle: cuotas disponibles, fuente, última actualización y estado de conexión. Una ausencia de datos nunca equivale a 0% usado.
- Identificar la cuenta o perfil que utiliza cada terminal. No asumir que todas las terminales de un host usan la misma cuenta ni que distintos hosts usan cuentas distintas.
- Mostrar contexto/tokens de la conversación como métricas separadas, en una segunda etapa. No convertir tokens, coste estimado ni tiempo de caché en porcentaje de la suscripción.

Los ejemplos visuales deberán rotularse como ficticios; las ventanas Codex se nombran según `windowDurationMins`, no suponiendo siempre cinco horas o una semana.

## Fuentes verificadas

| Proveedor | Fuente | Alcance y límites |
|---|---|---|
| Claude | JSON oficial de `statusLine`: `rate_limits.five_hour` y `seven_day`, `used_percentage` y `resets_at` | La documentación los condiciona a Pro/Max o gateway, después de la primera respuesta; cada ventana puede faltar. No está garantizado para todo plan o versión. |
| Codex | JSON-RPC de `codex app-server`: `account/read`, `account/rateLimits/read` y `account/rateLimits/updated` | Cuotas ChatGPT con `usedPercent`, `windowDurationMins`, `resetsAt` y múltiples buckets cuando están disponibles. No promete cuotas de suscripción para API key o proveedor externo. |

- [Claude: status line](https://code.claude.com/docs/en/statusline).
- [Claude: uso y costes](https://code.claude.com/docs/en/costs): el coste de sesión es estimado, no una factura Pro/Max.
- [OpenAI: Codex App Server](https://learn.chatgpt.com/docs/app-server).

Verificación local de herramientas, sin leer credenciales: Windows tiene Codex 0.128.0 y Claude 2.1.78. El esquema generado por ese Codex confirma `account/rateLimits/read`, pero no contiene el más reciente `account/usage/read`. **No se verificaron las versiones de los servidores Linux**. La implementación debe detectar capacidades, no asumir las del sitio de documentación actual.

## Implementación recomendada

### 1. Ampliar la captura Claude existente

Crow ya instala por proceso un wrapper `statusLine` para la caché y conserva el comando previo del usuario. Ampliar el parser para extraer únicamente cuotas validadas, identificador de conversación y fecha; no guardar el JSON original. Recibir esos datos en `crowd` por el endpoint autenticado de loopback.

Separar las cuotas de `PromptCache`: una cuota válida no debe perderse porque un campo de caché sea desconocido. Preservar configuración original y modo normal/bypass. Si la captura está desactivada, administrada o no soportada, mostrar el motivo y no reinstalarla a escondidas.

La lectura representa la última muestra que Claude entrega. Reejecutar el script o consultar Crow no garantiza que Claude consulte otra vez las cuotas de la cuenta. Mostrar antigüedad; no enviar `/usage`, prompts o pings automáticamente. Las terminales existentes pueden requerir un nuevo proceso para incorporar configuración de captura, sin forzar cierre ni perder trabajo.

### 2. Añadir un adaptador Codex de consulta

Ejecutar un auxiliar `codex app-server` **en el host donde está autenticado Codex**, respetando usuario, perfil/configuración y `CODEX_HOME` de la sesión. Hacer handshake `initialize` / `initialized` y permitir sólo las consultas de cuenta/cuotas necesarias.

No iniciar ni reanudar conversaciones ni enviar `turn/start`. No reemplazar la TUI/PTTY. No copiar `auth.json` ni tokens a Windows: el CLI administra su autenticación. Comprobar consumo de recursos y efectos de inicialización del auxiliar antes de producción.

Compartir consultas por perfil, coalescer solicitudes y limitar concurrencia; nunca crear un auxiliar por terminal. Usar caché de alrededor de 60 segundos, timeout y backoff ante errores/429. Cerrar el auxiliar tras inactividad o apagado del servicio; una desconexión no debe cerrar terminales. Detectar cambios de cuenta y descartar muestras asociadas a la cuenta anterior.

`thread/tokenUsage/updated` no garantiza observar otra TUI desde un auxiliar independiente. El consumo específico de terminal se valida aparte antes de prometerlo; no reanudar una conversación real sólo para obtener telemetría.

### 3. Modelo común y transporte

`AccountUsage`: proveedor, perfil opaco, identidad verificada si está disponible, ventanas/buckets, porcentaje usado, duración, reset, fuente, fecha de muestra y estado (`available`, `stale`, `unsupported`, `auth-required`, `disconnected`). Conservar campos ausentes como ausentes.

Exponer una API de lectura autenticada de `crowd`; reutilizar túnel SSH, IPC de Electron y UI React. No abrir un puerto público ni construir un proxy JSON-RPC genérico. No enviar estos datos a Free LLM.

Por defecto separar muestras por host/perfil. Agrupar entre hosts sólo con identidad fiable o vinculación explícita del usuario. **No sumar ni promediar porcentajes** de una misma cuenta: son snapshots compartidos. Resolver ventanas equivalentes usando la muestra más reciente y su procedencia; no deducir renovación o cuota disponible sólo del reloj.

Telemetría no modifica `lastActivity`, estado del agente, suspensión o señales de revisión. Los avisos de cuota son independientes de las campanas de intervención y deben evitar duplicados por cuenta/ventana. Su activación queda configurable.

## Entrega y validación

1. Validar versiones y muestras sanitizadas en un host Claude y uno Codex, con autorización para consultar sus cuotas. Sólo números y metadatos permitidos; sin conversaciones, claves ni inferencias de prueba.
2. Implementar ambos adaptadores, endpoint y panel de cuotas. Mantener fuera el consumo detallado por terminal y el cambio de cuentas.
3. Probar campos ausentes, 0%/100%, cuenta sin suscripción, múltiples buckets, versiones viejas, claves vencidas, cambio de cuenta, perfiles distintos, misma cuenta en varios hosts, reinicios, desconexiones y límites de consultas.
4. Comparar con los medidores oficiales de los CLI, comprobar conservación del `statusLine` propio y medir CPU/RAM. Verificar que la captura no mantiene vivas terminales inactivas ni afecta copiar/pegar, campanas o sonido.
5. La entrega requerirá actualizar Windows y `crowd` Linux. No reiniciar el servicio con sesiones vivas ni sustituir procesos existentes por la fuerza.

## Pendiente para ejecutar

Confirmar capacidades reales en Linux y acceso a muestras numéricas. En esta investigación no se consultaron cuotas privadas, no se modificaron perfiles, no se implementó la función ni se compiló/publicó nada.
