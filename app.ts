// The HTTP router: dispatches to the four surfaces and answers the JSON 404
// for everything else. The entry <-> env lifecycle lives in main.ts (keep it
// as it is); this file is the server.
//
// Routing order matters: /healthz first (the env's boot probe), then REST
// (which reads its own body and returns false outside /api/v3), then GraphQL
// and MCP (which read their own bodies), then git smart HTTP (the router
// reads the body into a Buffer first, per lib/smart-http.ts's contract).
// A handler that throws never kills the connection: the router answers a
// JSON 500 instead.
//
// Erasable TypeScript only (node --experimental-strip-types).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRestHandler } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleGitRequest } from './lib/smart-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Collect the full request body (for git smart HTTP, which wants a Buffer). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A git smart-HTTP route: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack. */
const GIT_ROUTE = /^\/[^/]+\/[^/]+\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const handleRest = createRestHandler();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3: reads its own body; false = not /api/v3.
        if (await handleRest(req, res)) return;

        // GraphQL v4: reads its own body.
        if (method === 'POST' && path === '/api/graphql') {
          await handleGraphQL(req, res);
          return;
        }

        // MCP: reads its own body.
        if (method === 'POST' && path === '/mcp') {
          await handleMcp(req, res);
          return;
        }

        // Git smart HTTP: the router reads the body first (see lib/smart-http.ts).
        if (GIT_ROUTE.test(path)) {
          const body = await readBody(req);
          const git = await handleGitRequest(req, body);
          if (git !== null) {
            res.writeHead(git.status, git.headers);
            res.end(git.body);
            return;
          }
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
