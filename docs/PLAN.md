# Plan de entrega de Crow Harness

**Objetivo:** una app Windows centrada en hosts Linux y carpetas de proyecto, con agentes CLI persistentes y una disposición visual inspirada en Orca. El cliente puede desaparecer; el trabajo sigue en el host.

## Alcance y estado

| Hito | Entrega | Estado |
|---|---|---|
| 0. Referencia visual | Capturas de Orca para comparar navegación, densidad, paneles y alertas. | Pendiente: no hay capturas de la instalación del usuario. |
| 1. Transporte | SSH estricto, token local, túnel, reconexión y diálogo para llaves cifradas. | Código inicial; falta prueba real y empaquetar la nueva versión. |
| 2. Sesiones | PTY remoto, log secuenciado, replay y restauración de pestañas. | Código inicial; falta prueba de desconexión/cierre. |
| 3. Workspace | Carpetas, explorador, editor y vista de imágenes/PDF. | Código inicial; falta prueba de conflictos. |
| 4. Navegador | Chromium en servidor, perfil por carpeta, captura e input. | Versión básica; aún no equivale a un navegador fluido. |
| 5. Alertas | Fin de turno para Claude/Codex; fin de proceso para el resto. | Código inicial; falta validar hooks con CLI instalados. |
| 6. Entrega | Pruebas de extremo a extremo, empaquetado Windows y guía de instalación. | Instalador x64 generado; falta probar instalación y host real. |

## Criterios de aceptación

- [ ] Con dos hosts conectados, desconectar uno no afecta las sesiones del otro.
- [ ] Cerrar la app mientras un agente trabaja y reabrirla conserva **el mismo proceso remoto**.
- [ ] Cortar la red durante salida de terminal y volver: no faltan ni se duplican bloques.
- [ ] Si el servicio remoto reinicia, se muestra historial y estado *interrumpido* en lugar de fingir que el proceso sigue vivo.
- [ ] Dos ediciones simultáneas de un archivo producen conflicto explícito, no pérdida silenciosa.
- [ ] `http://localhost` del navegador se resuelve **en el host**, no en Windows.
- [ ] La terminación de un turno genera una sola alerta, incluso después de reconectar.
- [ ] Normal nunca ejecuta opciones de bypass; bypass requiere confirmación visible.
- [ ] La interfaz se coteja con capturas reales de Orca a tamaño de ventana acordado.

## Decisiones pendientes

- Confirmar si también hay que soportar **hosts Windows**; esta base solo implementa Linux.
- Definir qué interacciones del navegador remoto son imprescindibles: la vista actual no contempla vídeo, descargas, uploads ni DevTools.
- Capturar pantallas de Orca para decidir paridad visual; reutilizar su estructura no equivale todavía a identidad pixel a pixel.

## Fuera de alcance inicial

Móvil, worktrees automáticos, GitHub/Linear, relay cloud, orquestación de agentes, cuentas de proveedores, extensiones y modo navegador de alta frecuencia.
