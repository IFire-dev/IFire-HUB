import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';

// Make Cloudflare bindings available to the existing Express application before
// it loads its configuration and initializes Clerk.
for (const name of [
  'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'ADMIN_USER_IDS', 'ALLOWED_USER_IDS',
  'CLERK_AUTHORIZED_PARTIES', 'ALLOWED_HOSTS', 'NVIDIA_API_KEY', 'VT_API_KEY',
  'HEALTH_ENABLED', 'PORT', 'HOST',
]) {
  if (env[name] !== undefined) process.env[name] = String(env[name]);
}
if (env.HOST === undefined) process.env.HOST = '0.0.0.0';
globalThis.__AI_HUB_CLOUDFLARE_ENV = env;

await import('./server.js');

export default httpServerHandler({ port: Number(process.env.PORT || 3000) });
