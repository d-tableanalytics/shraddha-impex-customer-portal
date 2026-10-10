/**
 * Module hook for maintenance scripts: replaces backend/server.js with a stub.
 *
 * utils/notify.js imports `io` from server.js, and server.js starts the whole
 * server when imported — port, sockets, crons. A script that only needs a
 * service must never do that, so any import of server.js resolves here.
 *
 *   register('./lib/stub-server.mjs', import.meta.url);   // before any import
 */
const STUB = 'data:text/javascript,'
  + encodeURIComponent('export const io = { emit() {}, to() { return { emit() {} }; } };');

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  if (/\/backend\/server\.js$/.test(resolved.url)) return { url: STUB, shortCircuit: true };
  return resolved;
}
