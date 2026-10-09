# Free LLM listo al iniciar Crow

Con la clasificación por IA activada, Crow comprueba la API local después de resolver los diálogos de las llaves SSH. Si no responde, intenta abrir Free LLM API y muestra el resultado, sin bloquear las terminales.

## Configuración

En **Notificaciones → Configurar IA · Free LLM**, usá **Abrir Free LLM API al iniciar Crow** y guardá. Viene activado; desmarcalo para que Crow sólo avise. Con la IA desactivada, no se comprueba ni se abre Free LLM.

## Qué esperar

- Si la API ya responde, no se abre otra instancia.
- Si no responde, Crow busca `FreeLLMAPI.exe` en las carpetas habituales de instalación de Windows e intenta abrirlo una sola vez por ejecución de Crow, sin comandos de shell ni argumentos.
- Si no encuentra la instalación o la API sigue apagada, aparece un aviso con **Comprobar de nuevo** y **Configurar IA**. Para instalaciones portables o en otra carpeta, abrí Free LLM manualmente.
- Abrir el programa no activa necesariamente su servidor: si hace falta, habilitalo desde Free LLM. Crow no cambia sus opciones ni cierra Free LLM cuando salís de Crow.
- Las reconexiones SSH no vuelven a lanzar el programa. Las llaves recordadas y los equipos sin hosts también permiten la comprobación inicial.

La comprobación hace un GET local a `/v1/models`, sin claves ni conversaciones. Una respuesta de autenticación 401/403 indica que el servicio responde, **no que tu clave o tus modelos funcionen**. Eso se verifica con **Guardar y probar**, usando tres ejemplos ficticios.
