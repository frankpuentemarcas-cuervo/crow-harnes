# Prueba de chat Android sin SSH

## Vincular el emulador

1. En Crow Windows, generá un QR nuevo en **Acceso móvil**.
2. En Android, abrí **Ajustes → Pruebas de chat → Vincular emulador con QR**.
3. Elegí **Importar imagen del QR (sin cámara)** y seleccioná su PNG/JPEG/WebP.
4. Revisá los equipos y confirmá el vínculo. El dispositivo se identifica como
   **Pruebas de Crow**, para que puedas reconocerlo y desvincularlo después.

La imagen se decodifica localmente con [jsQR](https://github.com/cozmo/jsQR).
Se conservan las validaciones normales de vencimiento, destino, certificado y
permisos. Importarla NO vincula automáticamente ni autoriza enviar mensajes.
No compartas públicamente el QR: contiene una invitación temporal de acceso.

El agente de QA puede operar esta misma interfaz con el emulador y Appium local.
No hay una API de depuración remota, acceso especial para IA ni exportación de
credenciales. La vinculación normal habilita la prueba a través del relay; no
requiere acceso SSH del agente de QA al servidor.

## Una instrucción, tres comprobaciones

1. Elegí una terminal de Claude/Codex **dedicada a pruebas**, que tenga chat
   estructurado y permiso de escritura. No se crean ni cierran terminales.
2. Abrí **Prueba de envío y respuesta**. Revisá en Terminal que el agente esté
   esperando una instrucción y que no haya un borrador pendiente.
3. Autorizá el mensaje y tocá **Enviar una prueba**. Consume cuota del proveedor.

Se utiliza exactamente el mismo envío del chat normal: un mensaje, sin
reintentos ni un Enter adicional. La instrucción pide una respuesta con un código
único y pide no usar herramientas ni ejecutar comandos; sigue siendo una petición
al agente, no una garantía de su comportamiento.

- **Entrega a terminal:** el backend confirmó la escritura al PTY. No significa
  que Claude haya aceptado la instrucción.
- **Aceptación:** apareció el mensaje exacto en el historial durable del agente.
- **Respuesta:** después de esa aceptación apareció la respuesta con el código
  exacto de esta prueba. Un estado global «trabajando» no cuenta como confirmación.

La observación dura hasta 90 segundos. Si no hay aceptación, revisá si el texto
quedó en el borrador. Si hubo aceptación sin respuesta, puede haber una demora del
agente o del historial. Una respuesta diferente no demuestra un fallo de transporte.
Ante pérdida de conexión se sigue consultando el historial; NO se reenvía la
instrucción. Cambiar a Terminal cancela la observación, no el mensaje ni el proceso.

## Informe y límites

**Copiar informe sin credenciales** exporta únicamente el ID de prueba, resultado,
tiempos observados desde Android y si faltó confirmación del transporte. No incluye
QR, tokens, endpoints, nombres de proyectos, errores crudos ni conversaciones.
Los tiempos incluyen red, consulta del historial y ejecución del agente; no son
mediciones puras de latencia de red. El informe vive en memoria hasta salir del chat.

Las regresiones locales usan la interfaz real con transporte simulado. No
reemplazan una prueba del APK vinculado a un Claude Code real y autenticado.
