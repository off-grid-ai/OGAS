import { defineConfig } from 'tsup';

// The crypto deps (tweetnacl, tweetnacl-util, js-sha512) are CommonJS. Left
// external, the ESM output emits `import { decodeBase64 } from 'tweetnacl-util'`
// which Node's strict ESM loader rejects (CJS has no named exports), breaking
// every ESM consumer of this package. Bundling them in lets tsup perform the
// CJS -> ESM interop, so the ESM output works. They are tiny, pure, and this
// package is meant to be embedded, so inlining them is the right call.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  noExternal: ['tweetnacl', 'tweetnacl-util', 'js-sha512'],
  // tweetnacl calls require('crypto') at load time for Node's CSPRNG. Bundled
  // into ESM there is no `require`, so esbuild's shim throws. Inject a real
  // createRequire into the ESM output only (CJS already has `require`); esbuild's
  // shim then uses it and the dynamic require resolves.
  esbuildOptions(options, context) {
    if (context.format === 'esm') {
      options.banner = {
        js: "import { createRequire as __ogasCreateRequire } from 'module'; const require = __ogasCreateRequire(import.meta.url);",
      };
    }
  },
});
