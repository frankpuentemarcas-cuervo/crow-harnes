# Diagnosticar una alerta de Crow

El diagnóstico permite comparar **lo que recibió el clasificador**, su decisión y lo que pasó con el sonido. No modifica la decisión del agente ni reenvía los registros a Free LLM.

## Activar y revisar

1. Abrí **Diagnóstico de alertas** en la cabecera de Crow, junto a Notificaciones.
2. Activá **Guardar diagnóstico de próximas respuestas**. La captura viene desactivada y requiere el cifrado seguro de Windows.
3. Reproducí el caso, pulsá **Actualizar** y seleccioná la terminal/evento. Compará texto, motivo declarado por el modelo y secuencia del sonido.

No recupera respuestas anteriores. Si no hay registro para una respuesta nueva, verificá también los hooks y la conexión: un log del clasificador no puede capturar un evento que nunca llegó.

## Qué significa cada dato

| Dato | Interpretación |
|---|---|
| Modelo solicitado / reportado | `auto` puede ser la estrategia solicitada; el modelo reportado es lo que devuelve la API, no una comprobación independiente del proveedor. |
| Decisión / motivo / justificación | Resultado del modelo. La justificación es breve y puede ser incorrecta; no es su razonamiento interno. Si falta el motivo, se indica sin inventarlo. |
| Cola / API / HTTP | Espera local, duración del intento y estado HTTP cuando hubo respuesta. Los fallos usan el motivo de la alerta preventiva. |
| Etapa / código / transporte | Separa configuración, entrada, solicitud, HTTP, lectura, JSON HTTP, contenido, JSON del modelo y decisión inválida. Transporte distingue timeout, cancelación y códigos conocidos (p. ej. `ECONNREFUSED`); el resto figura como `unknown`, sin mensajes ni stacks. |
| Respuesta de la API | Bytes recibidos (parciales si falla la lectura), caracteres del contenido y `finish_reason` conocido. `length` es evidencia de un límite reportado, NO prueba que ese límite causó el error. Campos ausentes en registros anteriores. |
| Texto truncado / redactado | El análisis recibe como máximo 24.000 caracteres. El log indica truncamiento y oculta claves configuradas y patrones comunes de credenciales. No promete detectar todo secreto presente en texto libre. |
| Sonido pendiente / informativo / revisado / repetido / restaurado / antiguo | Motivo por el cual no se programó audio. |
| Sonido programado / finalizado / error | Estado de Web Audio. **No prueba que los altavoces sonaran**, ni observa el volumen o silenciamiento de Windows. |

## Privacidad y retención

- Cada evento se cifra con `Electron.safeStorage` en la subcarpeta `alert-audit` del perfil de Crow. El texto y la justificación no se guardan en `state.json`, no van a los avisos generales ni al móvil, y nunca se escriben como logs en el repositorio.
- Hasta **7 días desde la recepción original**, **500 eventos** o **20 MiB**: se eliminan los más antiguos al llegar a un límite. Se aplica al arrancar, al usar el registro y cada minuto con Crow abierto. Cerrado, Crow no puede borrar archivos; los expira al volver a abrir.
- Desactivar pausa la captura. **Borrar registros** elimina el historial e invalida actualizaciones pendientes para que no lo reconstruyan.
- **Exportar todos…** requiere confirmación y elegir un archivo. El JSON exportado contiene texto privado **sin cifrar**; revisalo antes de compartirlo. Crow no sube el archivo ni elimina copias exportadas.
- No se registran cabeceras HTTP ni claves configuradas. El texto empresarial sigue siendo sensible aunque algunas credenciales estén redactadas.

Los errores del diagnóstico no deben interrumpir las terminales ni cambiar una clasificación válida. El panel muestra problemas de almacenamiento o descifrado; un registro dañado se conserva hasta su expiración o borrado manual.

No se captura la respuesta cruda del proveedor. Estos datos identifican la etapa y clase de fallo; no permiten reconstruir el JSON inválido ni garantizar la causa exacta del contenido. No cambian la decisión, el fallback ni el sonido.
