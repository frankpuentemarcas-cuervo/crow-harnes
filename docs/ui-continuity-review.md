# Continuidad de la interfaz · revisión del 8 de octubre de 2026

Corregidos los flujos de foco, diálogos y estado asíncrono relacionados con eliminar/cerrar y seguir trabajando. El panel lateral es ampliable y conserva su ancho. **Correcciones incluidas en v0.1.21; compilación y publicación mediante GitHub Actions.**

## Hallazgos y correcciones

| Prioridad | Hallazgo verificado en el código | Corrección |
|---|---|---|
| P1 | Cuatro usos de `window.confirm`: eliminar terminal, iniciar bypass, quitar host y descartar edición. | Confirmación HTML asíncrona, Cancelar como foco inicial, Escape y cola de solicitudes; ninguna llamada nativa bloqueante en el renderer. |
| P1 | xterm tomaba el foco sin revisar si el usuario había abierto un formulario mientras terminaba `attach`. | Foco solo dentro de la terminal o desde el cuerpo, sin diálogos abiertos; limpiar los temporizadores de reconexión al cerrar. |
| P1 | Eliminar adoptaba `saved.tabs`, un snapshot que podía restaurar una pestaña cerrada o perder otra abierta durante la petición. | Filtrar la terminal eliminada sobre las pestañas actuales. Invalidar respuestas de sesiones anteriores; conservar aislamiento por host/proyecto. |
| P1 | El editor se desmontaba al cambiar de pestaña/proyecto y perdía el borrador. Reconectar también podía recargarlo. | Mantener editores visitados mientras su vista esté abierta, preservar borradores al reconectar y confirmar antes de cerrar con cambios. No cerrar/quitar host durante un guardado. |
| P2 | Formularios de host/proyecto permitían envíos duplicados; sus errores aparecían detrás del modal. Quitar host no capturaba el rechazo. | Bloqueo por operación, error dentro del formulario y liberación en `finally`, sin perder lo escrito. |
| P2 | La imagen del navegador sobrescribía la URL mientras se escribía. Las respuestas tardías y una segunda navegación podían interferir. | Separar borrador de URL y URL reportada; ignorar respuestas obsoletas, impedir navegaciones simultáneas. Conservar el panel visitado, sin sondeo mientras esté oculto. |
| P2 | Un segundo pedido de frase SSH reemplazaba el host del primero. El acceso móvil podía iniciarse después de cerrar su ventana durante la carga inicial. | Cola de hosts SSH sin duplicados; bloqueo de doble envío. El diálogo móvil permanece ocupado durante toda la operación inicial. |
| P2 | Una consulta fallida de estado de un host impedía completar la inicialización de todos. | El host fallido se muestra desconectado sin abortar la carga del resto. |
| P2 | 258 px debían alojar sangría, nombre, ID, caché, campana y botones invisibles que seguían reservando espacio. | 340 px por defecto; ajuste 280–560 px con arrastre o teclado, persistente y limitado por la ventana. Quitar ID de la fila y ofrecer nombre completo + ID en tooltip. |

**Causa del congelamiento reportado:** el recorrido pasa por una confirmación nativa antes de renombrar. Electron tiene un [reporte oficial de campos no editables tras alert/confirm en Windows](https://github.com/electron/electron/issues/31917). Es una hipótesis sustentada por el recorrido y el síntoma, **no una reproducción del defecto nativo en la versión instalada del usuario**. Se eliminó ese mecanismo y también los riesgos de foco propios de Crow.

## Alcance de la revisión

Revisados los callbacks y efectos del renderer: conexiones, proyectos, terminales, pestañas, editor, explorador, navegador, avisos/caché/sonido, ajustes IA, SSH, móvil y actualizaciones. Consultados los IPC de eliminación/renombrado y la persistencia del workspace. La revisión no certifica ausencia de todos los defectos ni sustituye una prueba integral de servidores, agentes y dispositivos reales.

### Verificación realizada

- **64 pruebas JavaScript**, chequeo de tipos y `git diff --check`.
- Seis regresiones nuevas: prohibición de diálogos nativos, foco tardío, orden de snapshots, ancho inválido/límites, ventana mínima y eliminación sobre pestañas actuales.
- Interfaz real con IPC ficticio y llamadas `confirm/prompt/alert` que lanzan error: eliminar → renombrar, cancelar eliminación → renombrar, conexión retardada 2 s sin quitar foco, guardado/errores recuperables de host/proyecto, confirmación anidada cancelada con Escape, conservación de borrador al cambiar y cierre protegido.
- URL escrita preservada entre actualizaciones y cambios de pestaña; cierre móvil devuelve foco. Ancho y alias sobreviven recarga.
- Teclado del separador y comprobación a **1440×900** y **1050×700**, el mínimo de la ventana Windows: botones del toolbar dentro de la pantalla, ancho efectivo consistente con el separador.
- Datos ficticios, sin SSH real, claves ni conversaciones enviadas a modelos. El aviso de cambio de dependencias de React observado durante HMR pertenece a la modificación de código en vivo, no a un flujo de producción.

### Pendiente antes de certificar producción

1. Instalar una versión publicada y repetir eliminar/cancelar/cerrar → renombrar en Electron Windows. No hay runtime Electron local para esta prueba; no se ejecutaron builds.
2. Probar desconexión/reconexión SSH real, dos hosts pidiendo frase, guardado lento de archivo y cambio de proyecto durante creación de terminal.
3. Validar diálogos nativos de subir/descargar, transferencias largas, navegador remoto real, QR/dispositivo móvil, sonido y notificaciones del sistema.

Se mantienen los timeouts de red existentes. Una transferencia larga no implica un bloqueo global: todavía no tiene un botón de cancelación. Los borradores abiertos se conservan **en RAM**, no son recuperación frente a cerrar Crow o apagar Windows; mantener editores visitados tiene ese costo de memoria.

## Usar el panel lateral

Arrastrá su borde derecho. También podés enfocarlo con Tab y usar flechas, Home/End; doble clic restaura 340 px. Una ventana angosta limita el ancho efectivo para dejar espacio al trabajo. El tooltip conserva el nombre completo y el identificador.

## Próximo paso

Actualizar Windows a v0.1.21 y ejecutar las pruebas pendientes en la aplicación instalada y hosts reales. Este cambio no modifica el servicio Linux ni requiere reiniciar agentes.
