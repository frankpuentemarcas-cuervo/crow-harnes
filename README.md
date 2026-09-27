# Crow Harness

Aplicación de escritorio **Windows** para trabajar con agentes CLI en varios **hosts Linux**. Conserva el flujo esencial de Orca —hosts, proyectos, pestañas de terminal/editor/navegador y alertas— sin sus módulos de orquestación, móvil o integraciones externas.

> Última versión publicada: 0.1.2. Los cambios nuevos del código fuente no llegan al instalador hasta publicar otra versión.

## Instalar en Windows

Descargá el instalador más reciente desde [GitHub Releases](https://github.com/frankpuentemarcas-cuervo/crow-harnes/releases). Crea accesos directos en el escritorio y en el menú Inicio. La app necesita el servicio `crowd` en cada host Linux (sección siguiente). El instalador aún no está firmado digitalmente, así que Windows puede mostrar una advertencia de seguridad.

## Qué funciona en esta base

| Área | Comportamiento |
|---|---|
| Hosts | Varios destinos SSH con reconexión automática y estado por host. |
| Telemetría | En el código actual, la cabecera muestra CPU, RAM y uso del disco raíz por host conectado; requiere actualizar también el servicio Linux. |
| Proyectos | Carpetas absolutas del host, sin exigir Git. |
| Agentes | Shell, Claude Code, Codex y Antigravity CLI (`agy`), con modo normal o bypass explícito. |
| Sesiones | El servicio remoto posee los PTY; cerrar la app o perder SSH no mata los agentes. La salida tiene secuencias y log durable. |
| Archivos | Explorador, Monaco, previsualización de imágenes/PDF y escritura con detección de conflicto por hash. |
| Navegador | Chromium ejecutado **en el host**; el cliente muestra capturas JPEG e intercambia entrada básica. |
| Alertas | Claude `Stop` y Codex `notify` alimentan eventos de fin de turno; el código actual agrega un sonido al recibir un fin de turno reciente. |
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

### 2. Cliente Windows

Necesitás Node.js y OpenSSH (`ssh.exe`). Verificá primero que `ssh usuario@servidor` funciona y que la clave del host está en `known_hosts`. Con una llave SSH cifrada, la nueva versión del código muestra un diálogo para su frase; la guarda cifrada mediante DPAPI y la invalida al reiniciar Windows. Las llaves sin cifrar y los hosts que usan `ssh-agent` siguen usando OpenSSH. Una llave cifrada con `ProxyJump`/`ProxyCommand` todavía requiere `ssh-agent`.

```powershell
npm ci
npm run dev
```

En Crow Harness, agregá el destino SSH, conectá el host y registrá una carpeta existente, por ejemplo `/home/usuario/proyecto`. Las carpetas se introducen como rutas **del servidor**, no de Windows.

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
- Los logs de terminal aún no tienen rotación; evitá sesiones indefinidas con salida masiva hasta agregar cuotas.
- La interfaz sigue la estructura de Orca, pero falta cotejarla con capturas de referencia para afirmar paridad visual exacta.

## Próxima verificación

1. Ejecutar servicio y app en un host de prueba.
2. Abrir cada agente, cerrar Windows, reconectar y comprobar que sigue **el mismo PID**.
3. Cortar SSH durante una tarea, recuperar toda la salida sin duplicados y recibir una sola alerta.
4. Probar edición concurrente del mismo archivo y navegación de una web servida en `localhost` **del host**.

El cliente se empaquetó para Windows x64. Todavía no se ejecutó una prueba de instalación ni una prueba de extremo a extremo con un host Linux.
