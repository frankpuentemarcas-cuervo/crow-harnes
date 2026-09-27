import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()], build: { rollupOptions: { input: {
    desktop: resolve(import.meta.dirname, 'src/renderer/index.html'),
    mobile: resolve(import.meta.dirname, 'src/renderer/mobile.html')
  } } } }
})
