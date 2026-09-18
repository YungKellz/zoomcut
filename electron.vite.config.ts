import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    },
    resolve: {
      alias: { '@shared': shared }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    },
    resolve: {
      alias: { '@shared': shared }
    }
  },
  renderer: {
    root: 'src/renderer',
    // Bind to IPv4 explicitly: on Windows Vite may listen on [::1] only while Electron
    // resolves "localhost" to 127.0.0.1, which makes the dev window fail to load.
    server: { host: '127.0.0.1', port: 5173 },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': shared
      }
    },
    plugins: [react()]
  }
})
