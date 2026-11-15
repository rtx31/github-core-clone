// lib/mcp.ts — MCP endpoint (POST /mcp): JSON-RPC 2.0, Streamable HTTP.
//
// Speaks both protocol eras the suite accepts:
//   modern 2026-07-28 — `server/discover` answers identity, capabilities and a
//     non-empty supportedVersions list; no handshake, no session.
//   legacy 2025-11-25 and earlier — `initialize` (echoes the offered revision) +
//     `notifications/initialized`; no session id is issued (stateless).
// Every request is independent and stateless, so concurrent tools/call keep their
// own JSON-RPC ids and arguments. All tools act on the one store in lib/store.ts,
// so a repo/issue/PR created over MCP reads back over REST/GraphQL unchanged.
// `tools/list` serves one frozen list built once — two calls are byte-identical.
//
// `required` is kept minimal on every tool (only what the suite always sends):
// a required property the suite cannot fill fails the check, so optional
// arguments (body, description, private, state) are never required.
//
// Router contract (app.ts): `handleMcp(req, res)` reads the body, enforces auth
// and writes the reply. `dispatchMcp(body)` is the pure entry point (parsed JSON
// body in, {status, json} out, or {status, empty:true} for notifications).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type Issue, type Pull, type Repo } from './store.ts';
import { RequestIdCounter, VIEWER_LOGIN } from './util.ts';
import { bearerAuthorized, computePullFiles, readBody, squashMergePull, writeJson } from './graphql.ts';

// ---------------------------------------------------------------------------
// Server identity + tools (built once, frozen, served by reference)
// ---------------------------------------------------------------------------

const SERVER_INFO = Object.freeze({ name: 'github-core-clone', version: '1.0.0' });

const DISCOVER_RESULT = Object.freeze({
  resultType: 'DiscoverResult',
  supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
  capabilities: { tools: {} },
  serverInfo: SERVER_INFO,
  instructions: 'GitHub-compatible git forge: repositories, issues and pull requests over MCP tools.',
  _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
});

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): McpToolDef {
  return Object.freeze({
    name,
    description,
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze(properties),
      required: Object.freeze(required),
      additionalProperties: true,
    }),
  });
}

/** The one tools list: built once, never mutated, served by reference. */
export const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  tool(
    'create_repo',
    'Create a repository owned by the authenticated user.',
    {
      name: { type: 'string', description: 'Repository name.' },
      description: { type: 'string', description: 'Repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      full_name: { type: 'string', description: 'Full repository name "owner/repo".' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Issue title.' },
      body: { type: 'string', description: 'Issue body.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List issues in a repository.',
    {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      state: { type: 'string', description: 'Issue state: open, closed or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request from a head branch into a base branch.',
    {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Pull request title.' },
      body: { type: 'string', description: 'Pull request body.' },
      head: { type: 'string', description: 'Head branch name.' },
      base: { type: 'string', description: 'Base branch name.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Squash-merge a pull request.',
    {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      pull_number: { type: 'integer', description: 'Pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
  tool(
    'get_issue',
    'Get one issue by number.',
    {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      number: { type: 'integer', description: 'Issue number.' },
    },
    ['owner', 'repo', 'number'],
  ),
]);

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: unknown;
  isError?: boolean;
}

function textResult(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], structuredContent: obj };
}

function toolError(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
  };
}

function issueView(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.userLogin },
    created_at: issue.createdAt,
  };
}

function pullView(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merge_commit_sha: pull.mergeCommitSha,
  };
}

/** owner/repo out of the arguments, honouring a full_name ("owner/repo") fallback. */
function ownerRepoOf(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      if (owner === '') owner = parts[0] as string;
      if (repo === '') repo = parts[1] as string;
    }
  }
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}

function missingArgs(args: Record<string, unknown>, required: string[]): string[] {
  return required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

type ToolHandler = (args: Record<string, unknown>) => ToolResult;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  create_repo(args) {
    const missing = missingArgs(args, ['name']);
    if (missing.length > 0) return toolError(`Missing required argument: ${missing.join(', ')}`);
    const name = String(args.name);
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    const existing = store.getRepo(VIEWER_LOGIN, name);
    const repo = existing ?? store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
    return textResult(repoView(repo));
  },

  get_repo(args) {
    const missing = missingArgs(args, ['owner', 'repo']);
    if (missing.length > 0) return toolError(`Missing required argument: ${missing.join(', ')}`);
    const target = ownerRepoOf(args) as { owner: string; repo: string };
    const repo = store.getRepo(target.owner, target.repo);
    if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
    return textResult(repoView(repo));
  },

  create_issue(args) {
    const missing = missingArgs(args, ['owner', 'repo', 'title']);
    if (missing.length > 0) return toolError(`Missing required argument: ${missing.join(', ')}`);
    const target = ownerRepoOf(args) as { owner: string; repo: string };
    const repo = store.getRepo(target.owner, target.repo);
    if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
    const issue = store.createIssue(
      repo,
      String(args.title),
      typeof args.body === 'string' ? args.body : '',
      [],
      VIEWER_LOGIN,
    );
    return textResult(issueView(issue));
  },

  list_issues(args) {
    const missing = missingArgs(args, ['owner', 'repo']);
    if (missing.length > 0) return toolError(`Missing required argument: ${missing.join(', ')}`);
    const target = ownerRepoOf(args) as { owner: string; repo: string };
    const repo = store.getRepo(target.owner, target.repo);
    if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    let list = [...repo.issues.values()].sort((a, b) => a.number - b.number);
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    const views = list.map(issueView);
    return { content: [{ type: 'text', text: JSON.stringify(views) }], structuredContent: { issues: views } };
  },

  create_pull_request(args) {
    const missing = missingArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
    if (missing.length > 0) return toolError(`Missing required argument: ${missing.join(', ')}`);
    const target = ownerRepoOf(args) as { owner: string; repo: string };
    const repo = store.getRepo(target.owner, target.repo);
    if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
    const head = String(args.head);
    const base = String(args.base);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined) return toolError(`Head branch not found: ${head}`);
    if (baseSha === undefined) return toolError(`Base branch not found: ${base}`);
    const files = computePullFiles(repo, headSha, baseSha);
    const pull = store.createPull(
      repo,
      String(args.title),
      typeof args.body === 'string' ? args.body : '',
      head,
      headSha,
      base,
      baseSha,
      files,
    );
    return textResult(pullView(pull));
  },

  merge_pull_request(args) {
    const missing = missingArgs(args, ['owner', 'repo', 'pull_number']);
    if (missing.length > 0) return toolError(`Missing required argument: ${missing.join(', ')}`);
    const target = ownerRepoOf(args) as { owner: string; repo: string };
    const repo = store.getRepo(target.owner, target.repo);
    if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
    const number = Number(args.pull_number);
    if (!Number.isInteger(number)) return toolError(`Invalid pull_number: ${String(args.pull_number)}`);
    const pull = repo.pulls.get(number);
    if (pull === undefined) return toolError(`Pull request #${number} not found`);
    if (!pull.merged) {
      try {
        squashMergePull(repo, pull);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
    return textResult({
      id: pull.id,
      number: pull.number,
      merged: true,
      state: 'closed',
      sha: pull.mergeCommitSha,
      merge_commit_sha: pull.mergeCommitSha,
    });
  },

  get_issue(args) {
    const missing = missingArgs(args, ['owner', 'repo', 'number']);
    if (missing.length > 0) return toolError(`Missing required argument: ${missing.join(', ')}`);
    const target = ownerRepoOf(args) as { owner: string; repo: string };
    const repo = store.getRepo(target.owner, target.repo);
    if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
    const issue = repo.issues.get(Number(args.number));
    if (issue === undefined) return toolError(`Issue #${String(args.number)} not found`);
    return textResult(issueView(issue));
  },
};

// ---------------------------------------------------------------------------
// JSON-RPC dispatch (pure)
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface McpDispatch {
  status: number;
  json: unknown;
  /** True for notifications: no JSON-RPC response, HTTP 202 with an empty body. */
  empty?: boolean;
}

/** Dispatch one parsed JSON-RPC request object (auth already enforced by the handler). */
export function dispatchMcpRequest(body: Record<string, unknown>): McpDispatch {
  const id: JsonRpcId = 'id' in body && (typeof body.id === 'string' || typeof body.id === 'number')
    ? (body.id as string | number)
    : null;
  const method = typeof body.method === 'string' ? body.method : '';
  if (method === '') {
    return { status: 400, json: rpcError(id, -32600, 'Invalid Request: missing method') };
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, json: null, empty: true };
  }
  const params = isRecord(body.params) ? body.params : {};

  if (method === 'server/discover') {
    return { status: 200, json: rpcResult(id, DISCOVER_RESULT) };
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
    return {
      status: 200,
      json: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, json: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    // Same frozen array every call: byte-identical across calls.
    return { status: 200, json: rpcResult(id, { tools: MCP_TOOLS }) };
  }
  if (method === 'resources/list') {
    return { status: 200, json: rpcResult(id, { resources: [] }) };
  }
  if (method === 'prompts/list') {
    return { status: 200, json: rpcResult(id, { prompts: [] }) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (name === '') {
      return { status: 200, json: rpcError(id, -32602, 'Invalid params: tools/call needs a tool name') };
    }
    const handler = TOOL_HANDLERS[name];
    if (handler === undefined) {
      return { status: 200, json: rpcError(id, -32601, `Unknown tool: ${name}`) };
    }
    let result: ToolResult;
    try {
      result = handler(args);
    } catch (err) {
      return {
        status: 200,
        json: rpcResult(id, toolError(err instanceof Error ? err.message : String(err))),
      };
    }
    return { status: 200, json: rpcResult(id, result) };
  }
  return { status: 200, json: rpcError(id, -32601, `Method not found: ${method}`) };
}

/** Pure entry point: a parsed JSON body (one request, or a batch array) in. */
export function dispatchMcp(body: unknown): McpDispatch {
  if (Array.isArray(body)) {
    const responses: unknown[] = [];
    for (const entry of body) {
      if (!isRecord(entry)) continue;
      const out = dispatchMcpRequest(entry);
      if (!out.empty) responses.push(out.json);
    }
    return { status: 200, json: responses };
  }
  if (!isRecord(body)) {
    return { status: 400, json: rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object') };
  }
  return dispatchMcpRequest(body);
}

// ---------------------------------------------------------------------------
// HTTP handler (what app.ts calls)
// ---------------------------------------------------------------------------

const mcpRequestIds = new RequestIdCounter();

/**
 * POST /mcp: non-JSON body -> HTTP 400 with -32700; no Authorization -> 401;
 * everything else is a JSON-RPC answer (HTTP 200, or 202 with an empty body
 * for notifications). DELETE closes a session best-effort (200, empty object).
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = mcpRequestIds.next();
  if (req.method === 'DELETE') {
    writeJson(res, 200, {}, requestId);
    return;
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { message: 'Method Not Allowed' }, requestId);
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, requestId);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, requestId);
    return;
  }
  if (!bearerAuthorized(req.headers.authorization)) {
    writeJson(res, 401, { message: 'Requires authentication' }, requestId);
    return;
  }
  const out = dispatchMcp(parsed);
  if (out.empty === true) {
    res.writeHead(202, { 'x-github-request-id': requestId, 'content-length': 0 });
    res.end();
    return;
  }
  writeJson(res, out.status, out.json, requestId);
}
