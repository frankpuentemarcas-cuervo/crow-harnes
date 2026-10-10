# Cuotas siempre visibles

Las cuentas Claude / Codex son globales: no pertenecen al host seleccionado ni cambian la autenticación de una terminal.

- **Panel izquierdo:** proyectos arriba con desplazamiento independiente; cuotas ancladas abajo. El ancho inicial es 280 px; se conserva tu ancho guardado.
- **Panel contraído / ventana angosta:** las cuotas pasan a una franja compacta visible; podés volver a mostrar los proyectos.
- **Cuentas:** el engranaje del bloque abre el administrador para agregar, iniciar sesión, actualizar o quitar cuentas.
- **Herramientas secundarias:** configuración reúne hosts, móvil, actualizaciones, diagnóstico e IA; Kanban ERP y avisos siguen accesibles arriba. Las métricas de todos los hosts se abren desde Recursos.

## Lecturas, no estimaciones

Cada ventana muestra porcentaje **usado**, disponible y reinicio informado por el proveedor. Una cuota ausente nunca se representa como 0%. Se identifica la lectura anterior, su antigüedad y el reinicio vencido; no se promedian cuentas ni ventanas. Varias cuentas tienen lista acotada con desplazamiento y contador de agotadas.

Crow consulta cada 3 minutos mientras su ventana está visible, aunque cierres el administrador. El bloque y el administrador comparten el mismo seguimiento, sin duplicar consultas. No abre un login automáticamente ni revela tokens/contraseñas; Claude OAuth sigue siendo una fuente no documentada.

## Tamaño de Windows

El layout usa el área cliente real, no el tamaño total del monitor. La ventana inicial se ajusta al área de trabajo DIP del monitor elegido, incluida su posición en configuraciones multimonitor. Windows conserva su título, menú y barra de tareas nativos; Crow no los recrea ni descuenta la barra dos veces. Terminal: 16 px; explorador: 270 px en pantallas amplias, menor al estrechar.

## Verificación sin datos privados

`node --test --test-concurrency=1 tests/*.test.mjs` y `npm run typecheck`.

`node tests/persistent-quota-browser-qa.mjs` ejecuta React/App real en Vite con **todos los IPC simulados**, captura geometría y verifica ventanas, paneles, cuotas, menús y foco. Requiere Playwright y un Chromium ya disponibles; `CROW_QA_NODE_MODULES`, `CROW_QA_BROWSER` y `CROW_QA_ARTIFACTS` permiten indicar rutas sin instalar paquetes. No lee el perfil de Crow, inicia SSH, autentica cuentas ni compila la app.
