# Puente MCP de Crow: primer corte de prueba

Publicado desde **v0.1.26 como experimental opt-in, aún no validado con agentes reales**. Un cliente MCP local puede descubrir destinos aprobados, crear una terminal normal vacía de Claude/Codex en cualquier proyecto del catálogo, registrar una terminal existente como orquestador, enviar un saludo fijo y recuperar su resultado correlacionado. No hay despacho libre de tareas, creación de proyectos, cambios de negocio ni acceso shell genérico.

## Arquitectura y autoridad

```text
Cliente compatible (voz opcional del propio cliente)
  → MCP de Crow en Windows, loopback autenticado
    → Connection de Crow: SSH + passphrase existente
      → crowd en el Linux elegido
        → terminal persistente del orquestador
          → [futuro] subproyectos / tareas / terminales
```

Crow es el puente y dueño del catálogo, **no un proyecto operativo del servidor**. No se conecta a otros chats para ejecutar tareas. Tampoco incorpora una interfaz de voz ni promete despertar/hablar en un chat cerrado.

| Autoridad | Persistencia y alcance |
|---|---|
| Hosts y carpetas | `Store` existente, `state.json` del perfil de Crow. Sus UUID se reutilizan; no se copia el inventario en el cliente. |
| Orquestadores | `bridge.json`, mismo `app.getPath('userData')`. Un ID estable por vínculo host/proyecto/terminal. El propietario elige una carpeta existente de Crow como carpeta del orquestador. |
| Solicitudes locales | Mismo registro: instalación + cliente + UUID de solicitud, destino inmutable, estado y resultado mínimo. Las creaciones guardan además el `requestKey` y su clave estable hacia crowd para deduplicar reintentos. Cambiar endpoint SSH/carpeta invalida el vínculo; nunca redirige una solicitud silenciosamente. |
| Ejecución/resultados | Linux: `~/.local/share/crow-harness/bridge-tasks.json`, modo `0600`, intención durable antes de escribir al PTY. |
| Permisos y preferencias | Política del propietario fuera del repo. Cliente estable → grants exactos host/proyecto/terminal/operación para discover/register/hello/result. La creación de terminales **no** requiere permiso por proyecto: cualquier cliente autenticado con su `tokenSha256` puede crear en cualquier proyecto del catálogo. El campo opcional `projectGrants` se conserva sólo por compatibilidad y se **ignora** para la creación. Idioma e intervalo de consulta por cliente; prioridad por destino identificado. No conceden permisos adicionales. |

Este corte tiene **una autoridad en un perfil Windows**, no sincronización multi-PC/multiusuario. Conservá sus archivos al reinstalar. No borres el registro ni cambies identidades para reintentar una tarea: eso destruiría la deduplicación.

## Contrato MCP

Transporte: **Streamable HTTP sin sesiones, respuestas JSON**, SDK oficial `@modelcontextprotocol/sdk` 1.32.1. Endpoint `http://127.0.0.1:47422/mcp` (puerto configurable), sólo `POST`. No acepta origen de navegador, otro `Host`, acceso LAN ni autenticación anónima. No publica túneles externos.

La recuperación depende de herramientas consultables, no de recursos, SSE, suscripciones o notificaciones. Todos los resultados contienen `structuredContent` y JSON textual para clientes que sólo lean texto.

| Herramienta | Efecto |
|---|---|
| `crow_context` | Catálogo autorizado, `catalogId`, revisión, vigencia/disponibilidad, operaciones permitidas, preferencias y solicitudes propias. |
| `crow_create_terminal` | Crea una terminal **nueva, vacía y en modo normal** de Claude o Codex dentro de un proyecto existente del catálogo. Sólo acepta host/proyecto del catálogo, agente Claude/Codex y un `requestKey` UUID idempotente. No acepta ruta, modo, prompt ni crea proyectos. |
| `crow_register_orchestrator` | Vincula una terminal **existente y previamente aprobada**; no crea procesos ni amplía permisos. |
| `crow_send_hello` | Saludo fijo al orquestador, `requestId` UUID obligatorio. No acepta instrucciones libres. |
| `crow_get_result` | Consulta propia por UUID y devuelve referencia exacta host/proyecto/session/carpeta/nombre para localizarla en el sidebar de Crow. No ejecuta nada. |

`availability` y `freshness` son distintos de `state`. Un resultado conservado sólo se muestra si el host permite verificar la identidad Crow y el acceso actual a esa terminal; desconectado, revocado o con otra identidad se rechaza, sin divulgar el caché. `observedAt` indica cuándo se consultó y `remoteUpdatedAt` cuándo cambió la tarea. `bridgeHello: unsupported` indica soporte no disponible (runtime anterior o buzón que requiere revisión); eso deshabilita el puente, no el resto de Crow. El catálogo siempre lista **todos** los proyectos guardados por host, aunque el host esté offline o su runtime no soporte creación: la disponibilidad de creación no oculta el proyecto. El catálogo informa `bridgeCreate` por host y `canCreate` por proyecto: sólo un host conectado cuya salud expone `bridgeCreateVersion: 1` los marca en verdadero, y `availability`/`bridgeCreate` (más el `canCreate: false` del proyecto) explican por qué no se puede crear ahora. Contra un runtime anterior, `crow_create_terminal` falla con un error claro antes de enviar ninguna petición de sesión: cero POSTs.

## Configuración del piloto (requiere autorización antes de desplegar)

1. Prepará **un entorno vacío de prueba**, no proyectos empresariales. Elegí su host y carpeta en Crow y una terminal Claude/Codex **normal**, con hooks, en esa misma ruta. No se acepta bypass, shell, agente trabajando/subagentes, borrador sin enviar, terminal dormida o interrumpida al despachar. Si está dormida, despertala explícitamente en Crow.
2. El propietario obtiene los UUID locales de host/proyecto y el ID de terminal; están en el estado de Crow/API de sesiones. No pegues el estado completo, token de crowd ni datos SSH en un chat.
3. Creá un token distinto para cada cliente en un entorno local seguro. La política sólo conserva su SHA-256. Ejemplo PowerShell compatible sin imprimir el token:

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes); $rng.Dispose()
$env:CROW_MCP_CLIENT_TOKEN = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
$sha = [Security.Cryptography.SHA256]::Create()
$hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($env:CROW_MCP_CLIENT_TOKEN))).Replace('-','').ToLowerInvariant()
$sha.Dispose()
$hash # Sólo el hash; conservá el token en tu gestor de credenciales, fuera del chat.
```

4. Guardá esta política **fuera del repo**, reemplazando los marcadores con valores aprobados. Limitá sus permisos de archivo al propietario Windows. La edición de esta política es la aprobación humana previa **para el saludo y para crear terminales normales**, no autorización general de producción.

```json
{
  "version": 1,
  "port": 47422,
  "clients": [{
    "id": "centro-control",
    "tokenSha256": "REEMPLAZAR_CON_SHA256_HEX",
    "preferences": { "replyLanguage": "es", "pollingSeconds": 10 },
    "grants": [{
      "hostId": "UUID_HOST",
      "projectId": "UUID_PROYECTO_VACIO",
      "sessionId": "ID_TERMINAL_32_HEX",
      "operations": ["discover", "register", "hello", "result"],
      "priority": 50
    }]
  }]
}
```

`grants` describe exactamente host/proyecto/terminal/operación para discover/register/hello/result; una política antigua sin cambios sigue siendo válida. La creación de terminales **no** requiere una concesión por proyecto: cualquier cliente autenticado por su `tokenSha256` puede crear una terminal normal de Claude/Codex en cualquier proyecto ya presente en el catálogo de Crow, y sólo se rechaza por host/proyecto inexistente o fuera del catálogo, agente distinto de Claude/Codex, destino cambiado/offline o runtime sin `bridgeCreateVersion: 1`. El campo opcional `projectGrants` se conserva para que los archivos de política anteriores sigan cargando, pero está **obsoleto y se ignora** para la creación.

Al crear, Crow resuelve la carpeta desde su propio catálogo (nunca desde el cliente), exige que el host esté conectado y que la identidad Crow actual coincida con la registrada, y sólo genera una terminal normal vacía de Claude o Codex. Crow no borra ni reutiliza una terminal existente por coincidir en carpeta/agente. La operación es idempotente: el `requestKey` UUID se traduce a una clave estable ligada a identidad + host/proyecto + agente, y `crowd` deduplica de forma durable, de modo que un reintento tras una respuesta perdida devuelve la misma terminal (misma clave + mismo cuerpo) o un conflicto (misma clave + otro cuerpo). Los duplicados concurrentes comparten una única terminal.

5. Iniciá Crow v0.1.26 o posterior con `CROW_MCP_CONFIG` apuntando a la ruta absoluta de la política. No hay un panel de configuración MCP; la política se configura explícitamente fuera del repo. Crow debe estar abierto; SSH y passphrase se gestionan **en Crow**, nunca por las herramientas MCP. Para revocar o cambiar permisos/preferencias, editá la política y reiniciá Crow. Cada cliente conserva su configuración de transporte/credencial; el inventario se recupera por herramientas.

### Clientes a validar

Codex local admite Streamable HTTP y un bearer leído de variable de entorno. Configuración en su `config.toml`, iniciándolo desde un entorno que tenga el token correcto:

```toml
[mcp_servers.crow]
url = "http://127.0.0.1:47422/mcp"
bearer_token_env_var = "CROW_MCP_CLIENT_TOKEN"
default_tools_approval_mode = "writes"
```

Usá un nombre de variable/token independiente para otro cliente. Claude Code admite HTTP y expansión de variables en los headers de su `.mcp.json`:

```json
{"mcpServers":{"crow":{"type":"http","url":"http://127.0.0.1:47422/mcp","headers":{"Authorization":"Bearer ${CROW_MCP_CLIENT_TOKEN}"}}}}
```

Estas configuraciones están respaldadas por la [documentación oficial de Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) y la [de Claude Code MCP](https://code.claude.com/docs/en/mcp). **No se ejecutaron sesiones reales de esos productos en esta validación.** No implica soporte de sus clientes cloud, navegadores o todos los clientes MCP. Una skill portable de coordinación está en `integrations/skills/crow-control/SKILL.md`; sólo copia reglas, nunca el catálogo cambiante, y aún no está instalada en ningún cliente.

En esta PC se verificaron `codex-cli 0.128.0` y `Claude Code 2.1.78`: sus ayudas locales admiten HTTP; Codex además confirma `--bearer-token-env-var`. Sólo se consultaron versión/ayuda, **sin modificar sus configuraciones ni usar cuentas/modelos**. La expansión de headers y el flujo completo se deben probar en las versiones instaladas durante el piloto.

## Prueba observable

```text
crow_context {}
crow_create_terminal {hostId, projectId, agent: claude|codex, requestKey: UUID_NUEVO}
crow_context {}                       # la terminal creada ya aparece en el proyecto
crow_register_orchestrator {hostId, projectId, sessionId}
crow_send_hello {orchestratorId: ID_DEVUELTO, requestId: UUID_NUEVO}
crow_get_result {requestId: MISMO_UUID}
```

`crow_create_terminal` reutiliza el mismo `requestKey` al reintentar; no cambies host/proyecto/agente con la misma clave. La terminal creada queda como cualquier otra terminal normal de Crow: visible en el sidebar, con hooks, y controlable por el humano. No acepta rutas ni prompts, y no reutiliza una terminal existente por compartir carpeta.

El saludo pide respuesta exacta `Hola [crow-task:ID]`. Sólo un hook de la terminal correcta con esa respuesta exacta completa el registro y devuelve `Hola`. Texto distinto, ausencia de hook o una pregunta no se interpretan como éxito ni se guardan como resultado. No se persiste texto libre del agente en el buzón. Esto puede quedar pendiente si el modelo no respeta el formato; no se “arregla” adivinando por palabras o leyendo pantallas.

Reintentar el mismo UUID/destino consulta/reutiliza el registro sin volver a escribir al PTY. Cambiar el destino con el mismo UUID se rechaza. La desconexión del cliente/desktop después de aceptación no mata el proceso remoto; se puede consultar luego. Reiniciar **crowd o Linux** no preserva el proceso exacto: tareas pendientes pasan a `uncertain`, sin reenvío automático. Si hubo entrada humana, eliminación o salida del proceso, la tarea se interrumpe. Para una entrega a PTY no existe garantía absoluta de exactamente una ejecución: se prioriza no repetir ante incertidumbre.

**Un prompt que dice “no uses herramientas” NO es un sandbox.** El modo normal del agente tampoco garantiza ausencia de lecturas. La habilitación inicial es exclusivamente en carpetas de prueba sin secretos, con permisos del sistema/agente adecuados. Antes de tareas reales habrá políticas ejecutables de herramientas/archivos/red y aprobación humana ligada a la tarea, no un booleano elegido por el cliente/modelo.

## Evidencia reproducible y límites

```powershell
node --test tests/bridge-mcp.test.mjs
npm test
npm run typecheck
```

Desde `remote/`: `go test ./...` y `go vet ./...`. Sin builds de producto.

- MCP HTTP real contra el gateway: inicialización protocolo `2025-11-25`, descubrimiento de herramientas y cinco operaciones, dos identidades aisladas, reintentos/reinicio y rechazo de lectura offline o con identidad cambiada. El catálogo sigue listando todos los proyectos del host aunque esté offline o su runtime no soporte creación (`canCreate: false`), sin ocultar el proyecto. Incluye creación (`crow_create_terminal`) end-to-end con runtime simulado, creación por un cliente autenticado **sin** grants ni `projectGrants`, política legada sin permiso de escritura, rechazo de host/proyecto no catalogado y agente no soportado antes de cualquier POST, destino cambiado/offline, deduplicación por clave estable ante respuesta perdida y reintentos concurrentes, rechazo cuando el runtime reporta un agente distinto al solicitado, y cero POSTs de sesión contra un runtime sin `bridgeCreateVersion: 1`. **Runtime/agent simulado** en ese test; ningún SSH real.
- Go: buzón con ficheros temporales, reinicio/incertidumbre/fallo de persistencia; registro durable de creación con reintento, conflicto de cuerpo y recuperación `pending → uncertain`; carrera concurrente con la misma clave que genera exactamente un proceso; capacidad de 500 registros que falla cerrado sin podar claves; rechazo de raíz no canónica (enlace simbólico) sin persistir intención ni generar proceso; lápida `uncertain` que sobrevive a un fallo de persistencia y bloquea el reintento; handler autenticado y escritura a pipe con hooks ficticios. Rechazo de free-text, bypass, subagentes, agentes no Claude/Codex y destinos/estados incorrectos.
- Validación local (Windows, PowerShell): typecheck, `node --test tests/bridge-mcp.test.mjs`, `npm test` y `go test ./...` más `go vet ./...` con Go 1.26 windows/amd64; `gofmt -l` sin pendientes. La ejecución paralela por defecto de `npm test` es sensible a tiempos y puede fallar de forma intermitente por una prueba no relacionada del clasificador de atención (411/412 observado aquí); en serie la suite completa pasa (412/412). La prueba de enlace simbólico se salta automáticamente si Windows no permite crear enlaces sin privilegios. La comprobación `-race` necesita CGO y un compilador C, no disponibles en este entorno; queda pendiente en CI/laboratorio.
- Falta prueba integrada Electron instalado + SSH + agente real en un host de laboratorio autorizado; no se verificó UI MCP ni permisos empresariales. Auditoría npm detecta vulnerabilidades existentes del proyecto: no se aplicó `audit fix --force` ni se afirma auditoría completa de seguridad.
- Límites de este piloto: 20 clientes, 100 grants por cliente, 16 solicitudes HTTP simultáneas, 100 orquestadores, 1000 registros de tareas por buzón/registro y 500 registros de creación de terminales. Al alcanzar capacidad se rechaza nuevo trabajo, **no se borran silenciosamente claves de idempotencia**: crear con el registro de creaciones lleno falla con error en lugar de podar una clave, porque perderla permitiría duplicar una terminal para la misma solicitud. No es aún un servicio multiusuario escalado ni hay paginación/retención configurable.

## Próximos cortes verificables

1. **Piloto real autorizado + configuración UI:** elegir carpeta/orquestador en Crow, enrolar/revocar clientes con credenciales seguras, navegar directamente a su terminal y validar Codex/Claude Code instalados. Aprobar laboratorio antes de cualquier actualización de crowd.
2. **Subproyectos y terminales de tarea:** relaciones explícitas `host → orquestador → subproyecto → tarea → terminal`; creación/reutilización controlada por el orquestador bajo scopes. Mantener visibles todas esas terminales en Crow. Incluir identidad estable del runtime Linux para escenarios de migración/clonado de hosts.
3. **Mensajes, resultados y decisiones:** protocolo estructurado versionado con contexto de tarea, estados/heartbeat, preguntas persistentes, respondidas con correlación y aprobaciones firmadas/expirables por operación. Añadir deduplicación, cancelación, límites, paginación/retención y pruebas de concurrencia/fallo de cada transición.
4. **Escala/conectividad:** evaluar persistencia transaccional (p.ej. SQLite), múltiples propietarios/dispositivos y transporte remoto TLS/OAuth sólo si se necesita y autoriza; no abrir el listener Windows a LAN. Recursos/notificaciones opcionales tras negociar y probar capacidades de cada cliente. Consultas/polling siguen siendo la vía de recuperación.

La consulta futura a SD/tareo queda sólo como escenario de diseño: una tarea de sólo lectura con autorización y criterios de asistencias definidos. No se ejecutó ni se considera cubierta por el permiso de saludo.
