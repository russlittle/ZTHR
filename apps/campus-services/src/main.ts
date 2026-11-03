import { serve } from '@hono/node-server';
import { SERVICES, SERVICE_IDS } from './index.js';

/** Runs every synthetic campus service on its own port, so anything can call them like real endpoints. */
for (const id of SERVICE_IDS) {
  const s = SERVICES[id];
  const port = Number(process.env[`${id.toUpperCase()}_PORT`] ?? s.port);
  serve({ fetch: s.make().fetch, port });
  console.log(`${s.info.title}: http://localhost:${port}  (openapi: /openapi.json)`);
}
