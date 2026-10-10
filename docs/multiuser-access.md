# Acceso multiusuario en Crow

## Resultado

Activá **Acceso del host** una vez para reemplazar el token compartido por identidades individuales. El administrador ve todas las terminales; los miembros sólo las propias. El administrador no puede escribir, despertar, borrar ni reasignar terminales ajenas sin el permiso explícito `operateOthers`. Esas operaciones dejan auditoría sin contenido de terminal ni credenciales.

> Compartir el mismo usuario Linux/SSH NO ofrece privacidad frente a alguien que accede al servidor por SSH. Esta opción evita interferencias dentro de Crow. Para una frontera de seguridad real, usá usuarios Linux o contenedores separados.

## Puesta en marcha

1. Actualizá el servicio remoto compatible antes de activar el acceso.
2. Desde una conexión en modo compartido, activá el acceso con el nombre del primer administrador.
3. Creá miembros y concedé carpetas de proyectos específicas, existentes y canónicas.
4. Entregá la credencial de cada miembro por un canal seguro. Sólo se muestra al crearla; Crow la guarda cifrada localmente y el servidor conserva únicamente su hash.
5. Cada miembro pega su credencial en Acceso del host. No se copian automáticamente tokens maestros ni identidades desde archivos SSH.
6. Asigná explícitamente las terminales anteriores. Permanecen visibles para el administrador y no se cierran ni se adjudican automáticamente.

No concedas `/`, el directorio personal completo ni una carpeta que incluya el estado de Crow. El servidor rechaza carpetas que puedan exponer credenciales, historial o metadatos del servicio.

## Alcance

- Permisos verificados por el servicio en listado, eventos, historial/replay, WebSocket, escritura, resize, wake, cierre, hooks, caché y puente MCP.
- Archivos limitados por carpetas canónicas y navegadores con perfiles separados por identidad y proyecto. No constituyen aislamiento de archivos/procesos del mismo UID.
- Revocar una identidad bloquea reconexiones y cierra sus streams; no mata automáticamente los agentes existentes.
- El token compartido deja de autenticar endpoints ordinarios al activar el acceso. No hay desactivación silenciosa ni reinicio automático de una configuración dañada.
- Credenciales ligadas localmente al ID y destino/puertos del host. Cambiar identidad requiere limpiar los caches locales de sesión/eventos en la capa principal.

## Recuperación y despacho ERP

El registro `access.json` requiere revisión manual si está dañado; no se borra ni se vuelve a modo compartido automáticamente. Si se pierde la única credencial administrativa, recuperala mediante un procedimiento administrativo en el servidor, fuera del login normal de Crow. Conservá copias de seguridad seguras del estado; no compartas esos archivos.

`POST /api/task-dispatch` reserva un `jobId` durable antes de crear una terminal. La reserva queda ligada al propietario autenticado, proyecto canónico, agente y hash del prompt aprobado. Un trabajo incierto no vuelve a lanzarse automáticamente. El prompt exacto se entrega como un único argumento después de `--`, con permisos normales de Claude/Codex, nunca como shell ni escritura ciega al PTY.

## Validación pendiente en entorno real

Las pruebas unitarias cubren la matriz de autorización, revocación, replay, roots, hooks, credenciales y reservas. Windows no permite comprobar PTY Linux ni enlaces simbólicos sin privilegios; esas pruebas deben ejecutarse también en Linux antes de desplegar. No se compiló, publicó ni reinició ningún host durante esta implementación.
