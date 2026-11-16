/**
 * Build the host plugin bundle: lib/index.js (ESM, dsh-tools left external).
 */

import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'

await mkdir('lib', { recursive: true })

await build({
  bundle: true,
  logLevel: 'warning',
  minify: false,
  legalComments: 'none',
  entryPoints: ['src/host/index.js'],
  outfile: 'lib/index.js',
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['@deepseek-ai/*'],
})

console.info('built: lib/index.js')
