// Bundle the Action into a single committed file (dist/index.js) that GitHub
// runs directly — Actions execute the checked-in bundle, not node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: 'dist/index.js',
  banner: {
    // Shim require() for any CJS dep pulled in transitively under ESM output.
    js: "import { createRequire as _cr } from 'node:module'; const require = _cr(import.meta.url);",
  },
  logLevel: 'info',
});

console.log('Built dist/index.js');
