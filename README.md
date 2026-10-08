# Crow Harness

Aplicación de escritorio **Windows** para trabajar con agentes CLI en varios **hosts Linux**. Conserva el flujo esencial de Orca —hosts, proyectos, pestañas de terminal/editor/navegador y alertas— sin sus módulos de orquestación. Permite conectar opcionalmente Free LLM para clasificar las alertas.

> Consultá la última versión publicada en [GitHub Releases](https://github.com/frankpuentemarcas-cuervo/crow-harnes/releases). Los cambios nuevos del código fuente no llegan al instalador hasta publicar otra versión.

## Instalar en Windows

Descargá el instalador más reciente desde [GitHub Releases](https://github.com/frankpuentemarcas-cuervo/crow-harnes/releases). Crea accesos directos en el escritorio y en el menú Inicio. La app necesita el servicio `crowd` en cada host Linux (sección siguiente). El instalador aún no está firmado digitalmente, así que Windows puede mostrar una advertencia de seguridad.

## Qué funciona en esta base

| Área | Comportamiento |
|---|---|
| Hosts | Varios destinos SSH con reconexión automática y estado por host. |
| Telemetría | En el código actual, la cabecera muestra CPU, RAM y uso del disco raíz por host conectado; requiere actualizar también el servicio Linux. |
| Proyectos | Carpetas absolutas del host, sin exigir Git. |
| Agentes | Shell, Claude Code, Codex y Antigravity CLI (`agy`), con modo normal o bypass explícito. |
| Sesiones | El servicio remoto posee los PTY; cerrar la app o perder SSH no mata los agentes. La salida tiene secuencias y log durable. Cambiar entre pestañas conserva la vista de la terminal y, al volver, recupera solo la salida nueva. Cerrar una pestaña sí descarta su vista local, no el proceso remoto. El código actual permite eliminar una terminal y terminar sus procesos remotos. Tras 30 minutos sin entrada/salida y con trabajo completado, suspende sesiones aptas con SIGSTOP y permite reanudar el mismo proceso con SIGCONT. |
| Portapapeles | Las terminales de Windows permiten copiar y pegar mediante botones o atajos. `Ctrl+C` copia la selección visible, conservada tras un redibujado o ofrecida por Claude mediante OSC 52; sin texto seleccionado conserva la interrupción del proceso remoto. `Ctrl+V` pega directamente una sola vez, también en Claude Code. El proceso remoto no escribe ni lee el portapapeles sin tu acción. |
| Archivos | Explorador, Monaco, previsualización de imágenes/PDF y escritura con detección de conflicto por hash. Desde el panel lateral podés subir archivos de Windows con el botón **Subir** o arrastrándolos a la lista o a una carpeta; cada archivo permite **Descargar** y **Copiar ruta** (ruta absoluta del servidor). Las transferencias son binarias y no reemplazan archivos remotos existentes. |
| Navegador | Chromium ejecutado **en el host**; el cliente muestra capturas JPEG e intercambia entrada básica. |
| Alertas | Claude `Stop` y Codex `notify` alimentan eventos de fin de turno. Por defecto se usan reglas locales; opcionalmente Free LLM clasifica semánticamente la última respuesta. Las solicitudes de intervención activan sonido y campanita; los avisos informativos quedan en el historial sin sonido. Los errores de IA generan una revisión preventiva con su motivo. El texto final no se guarda en los eventos remotos ni en las alertas de Windows. En **Notificaciones** podés configurar la IA, elegir un sonido MP3, WAV u OGG local (máximo 5 MB y 30 segundos), probarlo y restaurar el tono original. |
| Hooks de estado | En **Editar host** se pueden desactivar los hooks administrados por Crow. Desactivarlos borra su script remoto y evita que se reinstale al reiniciar el servicio; no modifica los hooks de Orca ni de otros programas. Las sesiones nuevas reflejan esperando, trabajando y completado cuando el agente ofrece la señal. |
| Caché Claude | Desde v0.1.19, métricas nativas por terminal: vencimiento y TTL reportados, tokens reutilizados/escritos/nuevos y causas conocidas del último fallo. Sin métricas, muestra **Sin datos**, no un tiempo estimado. Los avisos son silenciosos y configurables. Requiere actualizar Windows y `crowd` en Linux. |
| Acceso móvil LAN | El código actual agrega un gateway HTTPS opcional en Windows: empareja un celular con código de un solo uso y retransmite la **misma PTY remota** por WebSocket a una terminal xterm.js. No abre el token ni el puerto del servicio Linux a la LAN. Solo funciona en la app empaquetada y requiere mantenerla abierta. |
| Actualizaciones | Busca versiones nuevas al iniciar, descarga en segundo plano y permite reiniciar para instalar. Requiere instalar una versión con el actualizador por primera vez. |

## Publicar una actualización

Las versiones se publican en GitHub Releases desde GitHub Actions al subir un tag `vX.Y.Z` que coincida con la versión en `package.json`. El workflow compila el instalador NSIS y los binarios `crowd` de Linux x86-64/ARM64; publica el `.exe`, `latest.yml`, el mapa de bloques, los binarios Linux y sus sumas SHA-256. No requiere guardar un token personal: usa `GITHUB_TOKEN` del workflow.

Para habilitar autoactualizaciones en instalaciones existentes, primero hay que distribuir e instalar Crow Harness **0.1.2** manualmente: las versiones anteriores no tienen cliente de actualizaciones. A partir de 0.1.2, las versiones nuevas se detectan y descargan automáticamente; la app muestra el botón **Reiniciar y actualizar** cuando termina la descarga.

## Puesta en marcha

### Leer archivos Markdown en el escritorio

Abrí un archivo `.md` (también `.MD`, `.markdown` o `.mdown`) desde el explorador: **Vista previa** muestra títulos, tablas, listas, tareas y bloques de código con formato. Las tablas anchas se desplazan dentro del panel sin desordenar el documento.

Usá **Editar** para cambiar el texto original y **Vista previa** para revisar el mismo borrador, incluso antes de guardarlo. **Guardar** conserva la detección de conflictos existente. Guardá antes de abrir enlaces: los enlaces web se abren en el navegador de Crow y los archivos relativos solo dentro del proyecto. Por seguridad, no se ejecuta HTML ni se cargan imágenes automáticamente. Documentos de más de 250.000 caracteres siguen disponibles en **Editar**, sin vista previa.

### 1. Host Linux — un comando

Conectate por SSH **como el usuario que usará Crow**, sin `sudo`, y ejecutá:

```sh
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/frankpuentemarcas-cuervo/crow-harnes/main/remote/install.sh | bash'
```

Ese mismo comando sirve para instalar o actualizar en cada host Linux x86-64 o ARM64. Descarga el binario publicado en la última versión, verifica su SHA-256, configura `crowd.service` como servicio de usuario y comprueba que responda en `127.0.0.1:47321`. **No requiere Go ni clonar el repositorio.** Podés [revisar el script](remote/install.sh) antes de ejecutarlo. La suma SHA-256 detecta descargas alteradas o incompletas; la confianza en el publicador sigue dependiendo de GitHub y de este repositorio.

Si hace falta mantener el servicio tras cerrar SSH, el instalador intentará habilitar *linger*; puede pedir la contraseña de `sudo` **solo para ese paso**. Si no tiene permiso, mostrará una advertencia. Si ya hay terminales remotas vivas —o no puede verificar su estado— instalará el binario nuevo **sin reiniciar el proceso actual**; repetí el mismo comando cuando esas sesiones terminen para activar la actualización. Reiniciar `crowd` durante una sesión podría matar al agente.

El instalador configura Crow, no instala ni autentica `claude`, `codex`, `agy` o Chromium/Chrome; esos programas deben estar disponibles en el host para usar sus funciones. El servicio inicia con un shell de login para heredar el `PATH`. Instalar o actualizar el `.exe` de Windows **no actualiza** automáticamente los hosts Linux. Para subir o descargar archivos, cada host debe ejecutar la versión correspondiente de `crowd` (archivos individuales de hasta 512 MiB y hasta 100 por selección).

### 2. Cliente Windows

Necesitás Node.js y OpenSSH (`ssh.exe`). Verificá primero que `ssh usuario@servidor` funciona y que la clave del host está en `known_hosts`. Con una llave SSH cifrada, la nueva versión del código muestra un diálogo para su frase; la guarda cifrada mediante DPAPI y la invalida al reiniciar Windows. Las llaves sin cifrar y los hosts que usan `ssh-agent` siguen usando OpenSSH. Una llave cifrada con `ProxyJump`/`ProxyCommand` todavía requiere `ssh-agent`.

```powershell
npm ci
npm run dev
```

En Crow Harness, agregá el destino SSH, conectá el host y registrá una carpeta existente, por ejemplo `/home/usuario/proyecto`. Las carpetas se introducen como rutas **del servidor**, no de Windows.

En una terminal de Windows, seleccioná texto y usá **Copiar**, `Ctrl+C` o `Ctrl+Shift+C`. Para pegar un comando o mensaje, usá **Pegar**, `Ctrl+V`, `Ctrl+Shift+V` o `Shift+Insert`. Pegar no agrega Enter, pero **los saltos de línea que ya estén en el texto pueden ejecutar comandos** según la shell o agente. Sin selección, `Ctrl+C` conserva su función de interrumpir el proceso remoto.

La selección ofrecida por el agente también se copia con `Ctrl+C`; se descarta al iniciar otra selección, escribir o pegar.

QA aislada de teclado: `node tests/terminal-clipboard-electron.mjs` usa Electron y la terminal reales con IPC y
portapapeles ficticios, sin SSH ni configuración guardada. Requiere el binario local de Electron instalado.
Prueba selección, redibujado, interrupción, pegado único, OSC 52 y campos fuera de la terminal; la ventana oculta
no valida los aceleradores del menú de una ventana Windows enfocada ni una sesión Claude remota real.

### Renombrar una terminal

Hacé clic en el lápiz junto a la terminal del panel lateral. En **Renombrar terminal**, escribí el nombre y usá **Guardar** o Enter; **Cancelar** o Escape no modifica nada. El nombre admite hasta 48 caracteres y se conserva al volver a abrir Crow. Dejalo vacío para recuperar el nombre del agente.

El alias es local a Windows y se identifica por host y terminal: no cambia la carpeta ni reinicia el agente remoto. El diálogo corregido está disponible desde v0.1.20; no necesita actualizar `crowd` en Linux.

Desde v0.1.21, el panel lateral recuerda su ancho y se amplía arrastrando el borde derecho, con flechas al enfocarlo o con Home/End. Doble clic restaura el ancho predeterminado. Los nombres completos y sus IDs están disponibles en el tooltip. La [revisión de continuidad de la interfaz](docs/ui-continuity-review.md) detalla las correcciones y las pruebas pendientes en Windows instalado.

### Consultar la caché nativa de Claude

> Disponible desde v0.1.19, pendiente de prueba con Claude en un host real. No requiere instalar `claude-code-templates`.

Actualizá Windows **y** `crowd` en Linux, usá Claude Code **2.1.251+** y abrí una terminal nueva con los hooks de Crow activos. La cuenta regresiva aparece junto a cada terminal Claude y en la cabecera de la terminal seleccionada. Hacé clic para consultar TTL, reutilización de la sesión principal, tokens de la última solicitud y posibles causas del último fallo (estas causas requieren Claude Code 2.1.260+).

En **Notificaciones**, activá o desactivá **Avisos de caché Claude** y elegí la anticipación (15 segundos a 5 minutos; por defecto, 1 minuto). Se muestra un aviso por vencimiento y terminal, sin sonido ni campanita de revisión; mientras el agente figura trabajando, se omite. Los avisos de intervención existentes no cambian.

| Estado | Qué significa |
|---|---|
| Activa + tiempo | Claude reportó una entrada caliente y su vencimiento; el contador descuenta el tiempo sin prolongarlo por latencia o diferencia de reloj. |
| Vencida / fría | El reporte indica caché fría o llegó su vencimiento. **La conversación no se pierde.** |
| No detectada | Claude aún no observó reutilización; no demuestra que el proveedor tenga la caché desactivada. |
| Sin datos / Sin conexión | Faltan campos, hooks, una versión compatible o conexión; Crow no inventa un TTL. |

El porcentaje es acumulado para la **conversación principal**; los tokens corresponden a su última solicitud. No incluyen la caché independiente de subagentes ni garantizan reutilización si cambiás modelo, herramientas o prefijo. No se envían pings, mensajes, `/compact` ni `/clear` automáticamente: podrían consumir cuota y `/compact` tampoco garantiza un procesamiento barato.

El colector lee el JSON oficial de `statusLine`, conserva solo campos permitidos y lo entrega al servicio local autenticado; Windows lo consulta mediante el túnel SSH existente. Las métricas quedan en RAM, no en `sessions.json`, y no se envían a Free LLM ni a otro proveedor. No cambia el tiempo de inactividad de la terminal. Reiniciar el servicio borra la muestra hasta recibir otro reporte.

Se conserva el comando `statusLine` de la configuración de usuario y de la carpeta del proyecto, reenviándole su entrada y salida; no se editan esos archivos. Si no hay un comando propio, se muestra un pie breve de Crow. Una configuración explícitamente desactivada, ilegible o administrada puede impedir la captura: en ese caso se muestran datos desconocidos, sin sustituirlos por el cronómetro anterior.

### Continuar desde el celular en la red local

En la app **instalada** de Windows, tocá el ícono de celular de la cabecera: si hay una sola IPv4 privada, el acceso se activa y aparece el QR automáticamente; si hay varias, elegí la correcta y presioná **Activar acceso**. Con el celular en la misma red, **escaneá el QR**: abrirá Crow y completará el emparejamiento de un solo uso sin escribir la dirección ni el código. Luego elegí host, proyecto y terminal. Si no podés usar la cámara, la opción «No puedo escanear el QR» conserva el acceso manual. Una terminal suspendida se puede reanudar sin perder el proceso.

El acceso se detiene al cerrar Crow o al presionar **Detener acceso**. Detener y volver a activar invalida el emparejamiento anterior. **El QR no elimina la advertencia HTTPS**: el certificado sigue siendo autofirmado. Comprobá que la huella SHA-256 que muestra el navegador coincida con la de Crow antes de aceptar la excepción; no ignores una huella distinta. No compartas capturas del QR: contiene una invitación temporal de un solo uso. Windows Firewall puede pedirte permitir el puerto efímero **solo en redes privadas**. No redirijas ese puerto en el router ni uses una red pública. El modo de desarrollo (`npm run dev`) no expone el gateway móvil.

## Cómo se mantiene el trabajo ante un corte

```text
Electron Windows ── SSH + túnel local ── crowd (Linux) ── PTY ── agente CLI
       │                                      │
       └─ reconecta y pide salida faltante ─┘
```

El runtime remoto conserva el proceso, su sesión y la salida. Cada bloque de terminal lleva un número de secuencia: tras reconectar, el cliente pide solo los bloques posteriores al último recibido. El cierre de la ventana termina **el túnel**, no el runtime. Si el host se reinicia o el runtime muere, el proceso del agente termina; se puede recuperar el historial, pero no el mismo proceso vivo.

## Seguridad y límites actuales

### Alertas inteligentes con Free LLM

En **Notificaciones → Configurar IA · Free LLM**, ingresá la URL base `http://127.0.0.1:31415/v1` y la clave **unificada** que muestra Free LLM en tu Windows. Dejá `auto` para respetar tu cadena activa; `auto:fast` prioriza velocidad entre los modelos habilitados, sin respetar el orden de esa cadena. **Guardar y probar** valida la conexión y tres ejemplos ficticios (pedido de autorización, resultado informativo y lanzamiento de subagente). No envía conversaciones reales durante esa prueba. Luego activá **Clasificación por IA** y guardá: aplica a las próximas respuestas, no reclasifica el historial. Free LLM debe seguir abierto y tener modelos/proveedores disponibles.

La conexión se hace desde Windows, no desde los hosts Linux. La clave se guarda cifrada mediante `safeStorage` de Electron; nunca se devuelve al renderer ni se guarda en texto plano. Si cambiás el puerto o la URL, ingresá nuevamente la clave correspondiente. Una API local **no significa un modelo local**: al activar la opción autorizás enviar la última respuesta a los proveedores configurados en Free LLM. No se manda el historial completo ni los archivos del proyecto, pero la respuesta final podría contener información sensible. El costo y los límites dependen de la cadena que configuraste; Crow no modifica esa cadena.

Actualizá también `crowd` en Linux con el instalador de un comando y abrí terminales con hooks administrados. El servicio mantiene las respuestas en una caché acotada de RAM durante 10 minutos, hasta 128 mensajes de 12.000 caracteres Unicode; se solicitan por SSH solo con IA activada y **no se guardan en `events.jsonl` ni en el historial de alertas de Windows**. Esto no modifica los logs de terminal que ya conserva Crow. Tras reiniciar el servicio, o con un CLI que no entregue texto en su hook, ese texto puede faltar.

La IA solo clasifica: no ejecuta acciones ni concede permisos. Una petición de intervención produce sonido y campana; un informe/progreso no. Mientras analiza se muestra **Analizando respuesta…**. La cola global admite hasta 40 análisis, con dos peticiones simultáneas y un timeout de 15 segundos por petición. Un error de autenticación, cupo, demora, texto ausente/truncado o respuesta incierta genera **Revisión preventiva**, con su motivo en las notificaciones, en vez de silenciar una posible petición. Después de un error se pausan nuevas llamadas durante 30 segundos. Hacer clic en la terminal reconoce también un análisis pendiente, para que su campana no reaparezca al terminar. Desactivar la IA cancela las llamadas pendientes y conserva las reglas locales.

Pruebas de desarrollo sin compilar el instalador: `npm test`, `npm run typecheck` y, dentro de `remote`, `go test -count=1 ./...`. Los tests JavaScript usan el soporte TypeScript de Node (22.18+ o 24). Para revisar JS/CSS reales con IPC simulado, ejecutá `node tests/attention-ui-preview.mjs` y abrí `http://127.0.0.1:31516/__attention-test`; para caché, usá `http://127.0.0.1:31516/tests/fixtures/cache-ui.html`. No usa SSH, claves reales ni modelos. La prueba autenticada contra tu Free LLM y la comprobación de sonido/campana en el Windows instalado requieren configurar tu clave y validar el flujo con un agente real; las pruebas simuladas no sustituyen esa verificación. El reenvío del comando `statusLine` se prueba en Linux; su test POSIX se omite en Windows.

### Otros límites

- Bypass se confirma por sesión y **no** es predeterminado. Usa las opciones oficiales de cada CLI; concede un alcance mayor al agente.
- El puerto del runtime no se publica: se accede por SSH y requiere token. El usuario SSH mantiene sus permisos normales sobre los archivos del host.
- El navegador remoto es una primera vista interactiva basada en capturas; aún no ofrece vídeo fluido, cargas/descargas, popups ni DevTools. Cada proyecto usa un perfil Chromium remoto.
- La alerta de fin de **turno** está integrada para Claude Code y Codex. Antigravity avisa al salir el proceso; falta una señal estable de fin de turno para su CLI.
- Eliminar una terminal intenta terminar su grupo de procesos y los descendientes que conservan `CROW_SESSION_ID`, borra el log remoto y quita la sesión y las notificaciones locales. Un proceso que se desacople y además limpie esa variable podría escapar: no se puede garantizar limpieza de procesos arbitrarios sin aislamiento por cgroup.
- Cerrar una pestaña solo desconecta la vista. La suspensión **ahorra CPU, no RAM**: la cabecera indica por host cuántas terminales están suspendidas y su memoria aproximada (PSS cuando Linux la ofrece, RSS como alternativa). La shell solo se suspende si está al prompt sin otros procesos de su sesión; Claude/Codex solo después de su señal de fin de turno. Antigravity no se suspende automáticamente hasta contar con una señal fiable de trabajo terminado.
- El contador de sesiones suspendidas se actualiza cada 10 segundos y la suspensión se evalúa cada minuto. Falta probar SIGSTOP/SIGCONT y los hooks contra un host Linux real. Al desactivar hooks, las sesiones ya abiertas pueden seguir teniendo comandos cargados en su CLI; iniciá una nueva terminal para que el ajuste sea completamente efectivo. El indicador nativo de caché tampoco garantiza el siguiente acierto: depende del prefijo y del proveedor.
- El acceso móvil depende de que Windows y su túnel SSH sigan activos. No hay acceso fuera de la red local ni servicio en segundo plano cuando se cierra la app. El navegador móvil aún no incluye edición de archivos ni la vista remota de Chromium; el objetivo actual es continuar la conversación con el agente en su PTY exacta. La implementación móvil requiere una prueba de extremo a extremo en teléfonos reales antes de considerarse validada.
- Los logs de terminal aún no tienen rotación; evitá sesiones indefinidas con salida masiva hasta agregar cuotas.
- La interfaz sigue la estructura de Orca, pero falta cotejarla con capturas de referencia para afirmar paridad visual exacta.

## Próxima verificación

1. Ejecutar servicio y app en un host de prueba.
2. Abrir cada agente, cerrar Windows, reconectar y comprobar que sigue **el mismo PID**.
3. Cortar SSH durante una tarea, recuperar toda la salida sin duplicados y recibir una sola alerta.
4. Probar edición concurrente del mismo archivo y navegación de una web servida en `localhost` **del host**.
5. Instalar la próxima versión empaquetada, emparejar un teléfono de prueba en LAN y verificar respuesta, reconexión, huella TLS y revocación del acceso móvil.

El cliente se empaquetó para Windows x64. Todavía no se ejecutó una prueba de instalación ni una prueba de extremo a extremo con un host Linux.
