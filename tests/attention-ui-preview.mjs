// Development-only browser QA. Does not launch Electron or touch saved settings.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile } from 'node:fs/promises'

const server = await createServer({
  configFile: false, root: process.cwd(), plugins: [react(), {
    name: 'isolated-attention-preview',
    configureServer(vite) {
      vite.middlewares.use('/__attention-test', async (_req, res, next) => {
        try {
          const html = await readFile(new URL('./fixtures/attention-ui.html', import.meta.url), 'utf8')
          res.setHeader('Content-Type', 'text/html')
          res.end(await vite.transformIndexHtml('/__attention-test', html))
        } catch (error) { next(error) }
      })
    }
  }], server: { host: '127.0.0.1', port: 31516, strictPort: true }
})
await server.listen()
console.log('QA aislado: http://127.0.0.1:31516/__attention-test — IPC simulado, sin SSH ni Free LLM')
console.log('Markdown QA: http://127.0.0.1:31516/tests/fixtures/markdown-ui.html — documento ficticio, editor/visor reales')
console.log('Cache QA: http://127.0.0.1:31516/tests/fixtures/cache-ui.html — métricas ficticias, componentes reales')
console.log('Rename QA: http://127.0.0.1:31516/tests/fixtures/rename-ui.html — prompt no soportado, IPC ficticio')
console.log('Continuity QA: http://127.0.0.1:31516/tests/fixtures/continuity-ui.html — eliminación, foco y errores, sin servidores reales')
