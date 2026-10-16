# Un QR para Crow Windows y todos los hosts

**Objetivo:** vincular Android una vez y seguir usando las terminales Linux existentes aunque Crow Windows se cierre o la PC se apague.

## Recorrido del usuario

1. Instalá la versión compatible de `crowd` en cada host con el [instalador habitual](../remote/install.sh). El servicio queda activo con `systemd --user` y *linger*.
2. En Windows, conectá los hosts; Crow identifica automáticamente esta instalación. Abrí **Acceso móvil**. Los proyectos están seleccionados inicialmente.
3. Si querés ver las cuotas de cuentas Claude y Codex en Android, activá el permiso opcional antes de generar el QR. Esas muestras provienen de Crow Windows y no están disponibles cuando la PC está apagada. Tocá **Generar QR para Android** y escanealo desde Crow Android. La primera vinculación exige que cada host seleccionado esté conectado; después las terminales de los hosts no dependen de Windows.
4. En Android, elegí el equipo desde **Equipo**. Windows ofrece las funciones completas; cada host Linux permite listar, leer y enviar entrada a sus terminales existentes.
5. Para terminar el vínculo, usá **Desvincular** en Android. Si el equipo está conectado, se revoca también allí. Si está apagado, se destruye la clave no exportable del teléfono, por lo que ese perfil no puede renovar credenciales.

El QR incluye invitaciones temporales de un solo uso, no llaves SSH. El dominio y la ruta WSS del relay Crow ya están configurados; nadie ingresa puertos, URL, ID ni token Pangolin. Cada host crea su propia ruta aleatoria y su certificado TLS fijado, almacenados solo para el usuario Linux con permisos `0600`.

## Qué funciona sin Windows

| Estado | Android |
|---|---|
| Windows encendido y gateway disponible | Funciones concedidas del gateway Windows, incluida creación de sesiones si está autorizada. |
| Windows apagado y host Linux activo | Terminales **existentes** del host: lista, salida y entrada autorizada. No se crean proyectos ni nuevas sesiones. |
| Host Linux apagado o relay caído | Equipo sin conexión; el vínculo y la clave permanecen para reconexión posterior. |

La restricción de creación/cierre no depende de ocultar botones: `crowd` responde `403` a esas rutas en modo host. Los permisos de usuario y proyecto se vuelven a comprobar en cada solicitud y trama de terminal. El relay solo reenvía bytes TLS; no ve salida ni comandos.

## Operación y límites

### Chat y confirmación del envío

- Al entrar o volver a Chat se consulta el tramo final del historial y se muestra la última respuesta capturada. Mientras estás leyendo arriba, las respuestas nuevas no te mueven de lugar: usá **Ir al final**.
- Tu texto aparece inmediatamente con **Enviando**. **Recibido por la terminal** confirma una escritura al PTY, no que el agente ya haya procesado la instrucción. **Agente trabajando** requiere una señal del agente.
- Un estado desconocido no elimina permisos de envío. Podés preparar el siguiente mensaje mientras el agente trabaja; el envío de otro turno espera a que termine. Si la señal queda trabada, revisá Terminal antes de habilitar el envío manual.
- Una desconexión durante el envío puede dejar el resultado sin confirmar. Crow no reenvía comandos automáticamente; el historial puede confirmar la recepción posteriormente.
- Las respuestas se incorporan al cerrar el turno del agente; no se muestra todavía cada token mientras se genera. Claude puede recuperar la última respuesta al iniciar o reanudar con los hooks actualizados, usando únicamente el transcript de esa sesión. No se importan historiales de otras terminales.
- Esta mejora requiere actualizar **Windows, APK y crowd** juntos. Actualizar el binario no reinicia de forma segura agentes que ya están ejecutándose: para activar nuevos hooks, cerrá o reanudá el agente de manera controlada, sin interrumpir tareas activas.

### Servicio y red

- El relay de `crow.frabubu.com` escucha `/v1/tunnel` mediante el proxy TLS existente. El Compose permite hasta 16 rutas y cuatro streams por ruta, sin publicar puertos de los hosts Linux.
- El QR admite Windows más hasta 15 hosts. Si un host no ofrece todavía la API móvil, actualizá `crowd` y volvé a generar el QR; los vínculos anteriores no se borran.
- Publicar una versión nueva **no** actualiza automáticamente `crowd` en hosts activos. El instalador difiere el reinicio cuando detecta sesiones vivas para no matarlas.
- La prueba final en un teléfono físico —emparejar, apagar Windows, leer/escribir terminal y desvincular— requiere participación del usuario. Las pruebas automatizadas no sustituyen esa aceptación.
