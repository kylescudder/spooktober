import { build } from 'esbuild'

// The maintenance commands use the app's server code, bundled for the same image.
await build({
  entryPoints: ['src/server/cli.ts'],
  outfile: '.output/database.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  external: ['pg-native']
})
