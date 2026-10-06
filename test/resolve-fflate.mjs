// Lets node resolve the browser import-map name "fflate" to the vendored copy.
import { registerHooks } from 'node:module';

const fflate = new URL('../vendor/fflate.js', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'fflate') return { url: fflate, shortCircuit: true };
    return next(spec, ctx);
  },
});
