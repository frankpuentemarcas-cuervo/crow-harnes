# ERPNext: Task → revisión → terminal autorizada

Crow consulta **exclusivamente el DocType `Task`** como fuente de trabajo. Las claves ERP y las descripciones almacenadas se cifran con el almacenamiento seguro del usuario local. No escribe estados ni resultados en ERPNext.

## Camino corto

1. En Integraciones, ingresá el origen HTTPS de ERPNext, API Key y API Secret del usuario ERP correspondiente. Probá la conexión.
2. Sincronizá las Tasks accesibles a esa identidad. No se asume que `owner` sea la persona asignada.
3. Vinculá un proyecto ERP con un proyecto autorizado de Crow, o asociá una Task manualmente.
4. Opcionalmente autorizá el envío de título, descripción y nombres de proyectos a Free LLM para sugerir una relación. El proveedor detrás de Free LLM puede recibir contenido empresarial.
5. Revisá el prompt exacto, host, proyecto y agente. La autorización vence en dos minutos y es de un solo uso.
6. Revisá el resultado del agente antes de mover la tarjeta a Finalizadas.

## Qué representa cada estado

| Estado | Significado |
| --- | --- |
| Por revisar | Sin asociación confirmada, o clasificación ambigua/fallida |
| Lista | Proyecto elegido; todavía NO autorizado para ejecutar |
| En ejecución | Despacho persistido y terminal solicitada |
| Revisión humana | Usuario revisa resultado, o entrega incierta |
| Finalizada | Confirmación manual local, no cambio en ERP |

Antes de despachar, Crow vuelve a leer la Task y verifica su detalle/versión, el actor de Crow, la raíz canónica y los permisos del proyecto. Modificaciones, permisos revocados, conexión caída o cambio de identidad/raíz invalidan el paso. La terminal debe arrancar el agente con el prompt como argumento de datos, no como comando shell ni escritura ciega en un PTY.

## Límites deliberados

- Conexión a un origen HTTPS explícito, sin rutas adicionales ni redirecciones. Se admiten servidores LAN con HTTPS; no loopback ni direcciones link-local. No descargar recursos HTML de descripciones.
- Hasta 2000 Tasks, páginas de 100 y consultas completas para detectar eliminaciones/revocaciones. Si se supera el límite, falla sin publicar una sincronización parcial. Todavía no hay cursores incrementales.
- La clasificación es explícita, secuencial y opt-in. Nunca lanza terminales; un identificador fuera de los candidatos autorizados queda para revisión.
- Reiniciar vuelve obsoletos los datos cacheados. Despachos pendientes pasan a entrega incierta; no se reintentan automáticamente.
- El historial mínimo de despachos sobrevive a rotaciones de claves, cambios de identidad y Tasks eliminadas/reincorporadas, sin mostrar descripciones de otra identidad. Una Task ya despachada no permite un segundo envío; todavía no hay una acción explícita de reejecución.
- El registro cifrado admite hasta 64 MB. Si no puede leerse, Crow bloquea cambios y nuevos despachos: reconfigurar las claves no borra el historial. Recuperá el archivo con soporte antes de continuar; eliminarlo manualmente pierde la protección contra duplicados.
- La deduplicación remota debe ser durable por host. No se promete una ejecución única global entre hosts distintos ni instalaciones Crow distintas.
- Compartir usuario Linux no proporciona aislamiento frente a SSH. Las identidades y permisos Crow protegen las rutas de la aplicación, no el sistema operativo.

Referencias: [API REST Frappe](https://docs.frappe.io/framework/user/en/api/rest), [esquema ERPNext Task](https://github.com/frappe/erpnext/blob/develop/erpnext/projects/doctype/task/task.json).
