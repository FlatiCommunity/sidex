import { preview } from 'vite';
const server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: false } });
try {
  process.env.SIDEX_PREVIEW_URL = `http://127.0.0.1:${server.httpServer.address().port}`;
  await import('./markdown-preview.mjs');
  await import('./workbench-smoke.mjs');
} finally {
  server.httpServer.closeAllConnections();
  await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
