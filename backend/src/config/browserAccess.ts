import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from './env.js';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
export function frontendOrigins(configured: string): string[] {
  const url = new URL(configured);
  if (!loopbackHosts.has(url.hostname)) return [url.origin];
  return [...loopbackHosts].map(host => { const alias = new URL(url); alias.hostname = host; return alias.origin; });
}
const allowed = new Set(frontendOrigins(config.FRONTEND_ORIGIN));
export const isFrontendOrigin = (origin?: string) => !!origin && allowed.has(origin);
export const isLocalHost = (hostname: string) => loopbackHosts.has(hostname);

export async function registerBrowserAccess(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.origin && !isFrontendOrigin(request.headers.origin)) return reply.code(403).send({ error: 'Origin is not allowed' });
    if (config.HOST === '127.0.0.1' && !isLocalHost(request.hostname)) return reply.code(403).send({ error: 'Host is not allowed' });
  });
  await app.register(cors, { origin: [...allowed], maxAge: 600, methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'] });
}
