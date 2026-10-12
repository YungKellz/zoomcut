import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

/**
 * The MCP stdio bridge (src/mcp/zoomcut-mcp.ts) as one self-contained CommonJS file,
 * out/mcp/zoomcut-mcp.cjs: no node_modules next to it, so it can sit in the installer's resources
 * folder and run under ZoomCut.exe (ELECTRON_RUN_AS_NODE=1) or plain node. `npm run build` builds
 * it after the app bundles.
 */
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  define: { __ZOOMCUT_VERSION__: JSON.stringify(pkg.version) },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: resolve('src/mcp/zoomcut-mcp.ts'),
    outDir: 'out/mcp',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      // zod's tree-shaking hints sit where rollup cannot read them: harmless, and noisy on every build
      onwarn(warning, warn) {
        if (warning.code !== 'INVALID_ANNOTATION') warn(warning)
      },
      output: { format: 'cjs', entryFileNames: 'zoomcut-mcp.cjs', inlineDynamicImports: true }
    }
  }
})
