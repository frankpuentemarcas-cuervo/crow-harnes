# Crow Harness

Aplicación de escritorio **Windows** para trabajar con agentes CLI en varios **hosts Linux**. Conserva el flujo esencial de Orca —hosts, proyectos, pestañas de terminal/editor/navegador y alertas— sin sus módulos de orquestación ni integraciones externas.

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
| Portapapeles | Las terminales de Windows permiten copiar texto seleccionado y pegar desde el portapapeles mediante botones o atajos. Cuando Claude Code ofrece texto mediante OSC 52, Crow habilita **Copiar**, sin permitir que el proceso remoto escriba o lea el portapapeles sin tu acción. `Ctrl+C` copia cuando hay selección propia de xterm y, sin ella, sigue enviando la interrupción al proceso remoto; para copiar texto ofrecido por Claude usá el botón o `Ctrl+Shift+C`. |
| Archivos | Explorador, Monaco, previsualización de imágenes/PDF y escritura con detección de conflicto por hash. Desde el panel lateral podés subir archivos de Windows con el botón **Subir** o arrastrándolos a la lista o a una carpeta; cada archivo permite **Descargar** y **Copiar ruta** (ruta absoluta del servidor). Las transferencias son binarias y no reemplazan archivos remotos existentes. |
| Navegador | Chromium ejecutado **en el host**; el cliente muestra capturas JPEG e intercambia entrada básica. |
| Alertas | Claude `Stop` y Codex `notify` alimentan eventos de fin de turno. En **Notificaciones** podés elegir un sonido MP3, WAV u OGG local (máximo 5 MB y 30 segundos), probarlo y restaurar el tono original. El archivo se copia a los datos locales de la app; no depende de que permanezca en su carpeta de origen. |
| Hooks de estado | En **Editar host** se pueden desactivar los hooks administrados por Crow. Desactivarlos borra su script remoto y evita que se reinstale al reiniciar el servicio; no modifica los hooks de Orca ni de otros programas. Las sesiones nuevas reflejan esperando, trabajando y completado cuando el agente ofrece la señal. |
| Temporizador de caché | La cabecera muestra una cuenta regresiva **estimada** para Claude después de completar un turno, usando 5 minutos o 1 hora según el entorno detectado. No realiza llamadas al proveedor. Se omite para Codex/Antigravity cuando no se conoce un TTL verificable. |
| Acceso móvil LAN | El código actual agrega un gateway HTTPS opcional en Windows: empareja un celular con código de un solo uso y retransmite la **misma PTY remota** por WebSocket a una terminal xterm.js. No abre el token ni el puerto del servicio Linux a la LAN. Solo funciona en la app empaquetada y requiere mantenerla abierta. |
| Actualizaciones | Busca versiones nuevas al iniciar, descarga en segundo plano y permite reiniciar para instalar. Requiere instalar una versión con el actualizador por primera vez. |

## Publicar una actualización

Las versiones Windows se publican en GitHub Releases desde GitHub Actions al subir un tag `vX.Y.Z` que coincida con la versión en `package.json`. El workflow compila el instalador NSIS y publica el `.exe`, `latest.yml` y el mapa de bloques; no requiere guardar un token personal, usa `GITHUB_TOKEN` del workflow.

Para habilitar autoactualizaciones en instalaciones existentes, primero hay que distribuir e instalar Crow Harness **0.1.2** manualmente: las versiones anteriores no tienen cliente de actualizaciones. A partir de 0.1.2, las versiones nuevas se detectan y descargan automáticamente; la app muestra el botón **Reiniciar y actualizar** cuando termina la descarga.

## Puesta en marcha para desarrollo

### 1. Host Linux

Requiere Go 1.26, `curl` y Chromium/Chrome para el navegador. Instalá y autenticá cada agente CLI **en el host**; las credenciales del cliente Windows no se transfieren.
El servicio inicia con un shell de login para heredar el `PATH`; comprobá que `claude`, `codex` y `agy` sean visibles para ese usuario en ese entorno.

```sh
cd remote
mkdir -p "$HOME/.local/bin"
go build -o "$HOME/.local/bin/crowd" ./cmd/crowd
mkdir -p "$HOME/.config/systemd/user"
cp crowd.service "$HOME/.config/systemd/user/crowd.service"
systemctl --user daemon-reload
systemctl --user enable --now crowd.service
```

Para que el servicio siga activo tras cerrar la sesión SSH, habilitá *linger* para ese usuario si el servidor no lo tiene: `loginctl enable-linger "$USER"` (puede requerir autorización administrativa). El servicio escucha **solo** en `127.0.0.1:47321` y crea un token en `~/.local/share/crow-harness/token` con permisos de usuario.

Cuando cambie el código de `remote/`, también hay que volver a compilar y reiniciar `crowd` en cada host. Hacelo cuando no haya agentes trabajando: reiniciar el servicio puede terminar los procesos que contiene.

Para subir o descargar archivos con la nueva versión de Windows también necesitás actualizar `crowd` en cada host Linux. La carga acepta archivos individuales de hasta 512 MiB (máximo 100 por selección); no sube carpetas completas y avisa si un nombre ya existe en el destino. **Copiar ruta** copia la ruta del host Linux, no una ruta de Windows.

**Importante:** instalar o actualizar el `.exe` de Windows **no actualiza** `crowd` en Linux. Si eliminar una terminal devuelve `404 page not found` y CPU/RAM/DISCO siguen en `—`, probablemente estás ejecutando un `crowd` anterior. En el servidor, actualizá primero el código fuente de este repositorio y luego, desde su carpeta `remote/`, ejecutá:

```sh
go build -o "$HOME/.local/bin/crowd.new" ./cmd/crowd
mv "$HOME/.local/bin/crowd.new" "$HOME/.local/bin/crowd"
systemctl --user restart crowd.service
systemctl --user status crowd.service --no-pager
```

Reiniciá el servicio **solo cuando no haya agentes trabajando**: los procesos que mantiene el daemon pueden interrumpirse. Después reconectá el host desde Crow Harness. La nueva app mostrará «Actualizar crowd Linux» en la cabecera si detecta el `404` de las rutas nuevas.

### 2. Cliente Windows

Necesitás Node.js y OpenSSH (`ssh.exe`). Verificá primero que `ssh usuario@servidor` funciona y que la clave del host está en `known_hosts`. Con una llave SSH cifrada, la nueva versión del código muestra un diálogo para su frase; la guarda cifrada mediante DPAPI y la invalida al reiniciar Windows. Las llaves sin cifrar y los hosts que usan `ssh-agent` siguen usando OpenSSH. Una llave cifrada con `ProxyJump`/`ProxyCommand` todavía requiere `ssh-agent`.

```powershell
npm ci
npm run dev
```

En Crow Harness, agregá el destino SSH, conectá el host y registrá una carpeta existente, por ejemplo `/home/usuario/proyecto`. Las carpetas se introducen como rutas **del servidor**, no de Windows.

En una terminal de Windows, seleccioná texto y usá **Copiar**, `Ctrl+C` o `Ctrl+Shift+C`. Para pegar un comando o mensaje, usá **Pegar**, `Ctrl+V`, `Ctrl+Shift+V` o `Shift+Insert`. Pegar no agrega Enter, pero **los saltos de línea que ya estén en el texto pueden ejecutar comandos** según la shell o agente. Sin selección, `Ctrl+C` conserva su función de interrumpir el proceso remoto.

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

- Bypass se confirma por sesión y **no** es predeterminado. Usa las opciones oficiales de cada CLI; concede un alcance mayor al agente.
- El puerto del runtime no se publica: se accede por SSH y requiere token. El usuario SSH mantiene sus permisos normales sobre los archivos del host.
- El navegador remoto es una primera vista interactiva basada en capturas; aún no ofrece vídeo fluido, cargas/descargas, popups ni DevTools. Cada proyecto usa un perfil Chromium remoto.
- La alerta de fin de **turno** está integrada para Claude Code y Codex. Antigravity avisa al salir el proceso; falta una señal estable de fin de turno para su CLI.
- Eliminar una terminal intenta terminar su grupo de procesos y los descendientes que conservan `CROW_SESSION_ID`, borra el log remoto y quita la sesión y las notificaciones locales. Un proceso que se desacople y además limpie esa variable podría escapar: no se puede garantizar limpieza de procesos arbitrarios sin aislamiento por cgroup.
- Cerrar una pestaña solo desconecta la vista. La suspensión **ahorra CPU, no RAM**: la cabecera indica por host cuántas terminales están suspendidas y su memoria aproximada (PSS cuando Linux la ofrece, RSS como alternativa). La shell solo se suspende si está al prompt sin otros procesos de su sesión; Claude/Codex solo después de su señal de fin de turno. Antigravity no se suspende automáticamente hasta contar con una señal fiable de trabajo terminado.
- El contador se actualiza cada 10 segundos y la suspensión se evalúa cada minuto. Falta probar SIGSTOP/SIGCONT y los hooks contra un host Linux real. Al desactivar hooks, las sesiones ya abiertas pueden seguir teniendo comandos de hook cargados en su CLI; iniciá una nueva terminal para que el ajuste sea completamente efectivo. El temporizador no garantiza que la caché exista: el proveedor puede invalidarla, y ajustes que Crow no pueda detectar pueden cambiar el TTL.
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
