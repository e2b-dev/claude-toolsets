/** A token-scoped loopback viewer. The E2B traffic token never reaches the browser. */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

export interface LocalViewer {
  url: string;
  stop(): Promise<void>;
}
export async function localViewer(config: {
  host: string;
  trafficToken: string;
  page: string;
  websocketRoutes: readonly string[];
  upstreamPrefix?: string;
  prefix?: string;
}): Promise<LocalViewer> {
  const prefix = config.prefix ?? `/s/${randomBytes(32).toString('base64url')}/`;
  let origin = '';
  const peers = new Set<WebSocket>();
  const connections = new Set<Socket>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const headers = { 'e2b-traffic-access-token': config.trafficToken };
  const upstreamUrl = (path: string) =>
    `https://${config.host}${config.upstreamPrefix ?? '/'}${path.slice(prefix.length)}`;
  const allowed = (path: string | undefined, requestOrigin: string | undefined) =>
    path?.startsWith(prefix) && (!requestOrigin || requestOrigin === origin);
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' || !allowed(request.url, request.headers.origin)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const upstream = await fetch(upstreamUrl(request.url!), { headers, signal: AbortSignal.timeout(10_000) });
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length > 8 * 1024 * 1024) {
        response.writeHead(502).end();
        return;
      }
      const forwarded = new Headers(upstream.headers);
      forwarded.delete('content-encoding');
      forwarded.delete('content-length');
      forwarded.set('referrer-policy', 'no-referrer');
      forwarded.set('cache-control', 'no-store');
      response.writeHead(upstream.status, Object.fromEntries(forwarded));
      response.end(body);
    } catch {
      response.writeHead(502).end();
    }
  });
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    const route = request.url?.slice(prefix.length).split('?')[0];
    if (
      !allowed(request.url, request.headers.origin) ||
      request.headers.origin !== origin ||
      !config.websocketRoutes.includes(route!)
    ) {
      socket.destroy();
      return;
    }
    const upstream = new WebSocket(upstreamUrl(request.url!).replace('https:', 'wss:'), {
      headers,
      handshakeTimeout: 10_000,
      maxPayload: 8 * 1024 * 1024,
    });
    peers.add(upstream);
    upstream.on('close', () => peers.delete(upstream));
    upstream.on('error', () => socket.destroy());
    upstream.once('open', () =>
      sockets.handleUpgrade(request, socket, head, (downstream) => {
        downstream.on('message', (data, binary) => {
          if (upstream.bufferedAmount > 1024 * 1024) downstream.close(1009);
          else if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        });
        upstream.on('message', (data, binary) => {
          if (downstream.bufferedAmount > 8 * 1024 * 1024) downstream.close(1009);
          else if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
        });
        downstream.on('close', () => upstream.close());
        downstream.on('error', () => upstream.close());
        upstream.on('close', () => downstream.close());
      }),
    );
    socket.on('close', () => upstream.close());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Viewer did not bind');
  origin = `http://127.0.0.1:${address.port}`;
  const page = new URL(config.page, `${origin}${prefix}`);
  if (page.searchParams.has('path')) page.searchParams.set('path', `${prefix}websockify`.slice(1));
  let closing: Promise<void> | undefined;
  return {
    url: page.href,
    stop: () =>
      (closing ??= (async () => {
        for (const client of sockets.clients) client.terminate();
        for (const peer of peers) peer.terminate();
        sockets.close();
        server.close();
        server.closeAllConnections();
        // HTTP closeAllConnections excludes upgraded sockets. Destroy them explicitly too.
        for (const socket of connections) socket.destroy();
        // Bun's HTTP close callback can remain pending after WebSocket upgrades.
        server.unref();
      })()),
  };
}
