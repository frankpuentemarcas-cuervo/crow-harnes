import React from 'react'
import ReactDOM from 'react-dom/client'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JSONWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CSSWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HTMLWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TSWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { loader } from '@monaco-editor/react'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'json') return new JSONWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CSSWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HTMLWorker()
    if (label === 'typescript' || label === 'javascript') return new TSWorker()
    return new EditorWorker()
  }
}
loader.config({ monaco })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
)
