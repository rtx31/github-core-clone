// REST v3 handlers (/api/v3) — the full route table of spec §4.4.
//
// Interface for the router (app.ts): the router calls ONE function and does
// nothing else for this surface:
//
//   import { handleRestRequest } from './lib/rest.ts';
//   if (await handleRestRequest(req, res)) return;   // handled: reply sent
//
// handleRestRequest returns false for any path outside /api/v3 (the router
// then tries the next surface), true once it has sent a reply. It reads the
// request body itself for POST/PUT/PATCH/DELETE; a router that already read
// the body may instead pass { body, bodyParseError } in the context.
//
// Shared discipline (spec §4.2):
//   - Authorization: Bearer <MAKEFUN_SHOP_TOKEN>; when the env var is set the
//     header must equal `Bearer <expected>`; when unset any non-empty Bearer
//     passes. No token -> 401. (GET /api/v3/ and GET /api/v3/meta stay public,
//     as the starter shipped them and api.github.com answers them that way.)
//   - Every reply is application/json with a non-empty X-GitHub-Request-Id
//     (counter; one instance per server, passed in or module-level).
//   - Error bodies are JSON with a string `message`. Unknown route -> JSON 404.
//     Malformed JSON body -> 400. A repo under another owner -> 404, never 403.
//   - Keep-alive: no `Connection: close` is ever sent.
//
// Perf (spec §5): the read workload does 2,000 sequential GETs of one issue
// on one keep-alive connection — each issue's JSON is pre-serialised once per
// mutation into a Buffer (WeakMap<Issue, Buffer>) and served as-is; only the
// X-GitHub-Request-Id header varies per reply. Issue creation stays
// allocation-light: one store.createIssue + one serialisation, no store scans.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store as defaultStore, type Comment, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { RequestIdCounter, VIEWER_LOGIN } from './util.ts';
import {
  buildTreeFromMap,
  createCommit,
  diffTrees,
  flattenTree,
  listCommits,
  putBlob,
  resolveCommit,
  squashMerge,
  treeOidOfCommit,
} from './merge.ts';

export interface RestContext {
  /** Store to use; defaults to the trial's singleton store. */
  store?: Store;
  /** Request-id counter; defaults to one module-level instance. */
  requestIds?: RequestIdCounter;
  /** Pre-parsed request body, when the router already read it. */
  body?: unknown;
  /** True when the router already found the body to be malformed JSON. */
  bodyParseError?: boolean;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const moduleRequestIds = new RequestIdCounter();

/** Cache of pre-serialised single-issue JSON, rebuilt on every mutation. */
const issueCache = new WeakMap<Issue, Buffer>();

type JsonObject = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Reply helpers

function sendBuffer(
  res: ServerResponse,
  ids: RequestIdCounter,
  status: number,
  body: Buffer | null,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': ids.next(),
    ...extraHeaders,
  };
  if (body === null) {
    headers['content-length'] = '0';
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers['content-length'] = String(body.length);
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(
  res: ServerResponse,
  ids: RequestIdCounter,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  sendBuffer(res, ids, status, Buffer.from(JSON.stringify(body), 'utf8'), extraHeaders);
}

function sendError(res: ServerResponse, ids: RequestIdCounter, status: number, message: string): void {
  sendJson(res, ids, status, { message });
}

// ---------------------------------------------------------------------------------------------
// Auth / request plumbing

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined || header === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return header === `Bearer ${expected}`;
  return header.startsWith('Bearer ') && header.slice(7).trim() !== '';
}

interface BodyRead {
  ok: true;
  value: unknown;
  present: boolean;
}
interface BodyFail {
  ok: false;
}

async function readBody(req: IncomingMessage): Promise<BodyRead | BodyFail> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_BODY_BYTES) return { ok: false };
      chunks.push(buf);
    }
  } catch {
    return { ok: false };
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return { ok: true, value: undefined, present: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown, present: true };
  } catch {
    return { ok: false };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function pathSegments(req: IncomingMessage): string[] {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    pathname = '/';
  }
  return pathname.split('/').filter((s) => s !== '').map(decodeSegment);
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** page/per_page with GitHub defaults (per_page 30, page 1). */
function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, intParam(query, 'per_page', 30)));
  const page = Math.max(1, intParam(query, 'page', 1));
  return { page, perPage };
}

/**
 * Slice `items` to one page and build the Link header for the next page
 * (absolute URL on this server's own origin, from the Host header).
 */
function paginate<T>(
  req: IncomingMessage,
  items: readonly T[],
  query: URLSearchParams,
): { pageItems: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const nextQuery = new URLSearchParams(query);
    nextQuery.set('per_page', String(perPage));
    nextQuery.set('page', String(page + 1));
    const lastPage = Math.ceil(items.length / perPage);
    const lastQuery = new URLSearchParams(query);
    lastQuery.set('per_page', String(perPage));
    lastQuery.set('page', String(lastPage));
    link =
      `<http://${host}/api/v3/user/repos?${nextQuery.toString()}>; rel="next", ` +
      `<http://${host}/api/v3/user/repos?${lastQuery.toString()}>; rel="last"`;
  }
  return { pageItems, link };
}

// ---------------------------------------------------------------------------------------------
// Serialisers (GitHub-shaped JSON; extra fields are harmless to the checks)

export function repoToJson(repo: Repo): JsonObject {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    has_issues: true,
    has_pull_requests: true,
    html_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function labelToJson(name: string, color: string): JsonObject {
  return { name, color };
}

export function issueToJson(issue: Issue, repo: Repo): JsonObject {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelToJson(name, repo.labels.get(name)?.color ?? 'ededed')),
    user: { login: issue.userLogin, type: 'User' },
    assignee: null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

/** Pre-serialised single-issue body; rebuilt only when the issue mutates. */
function cachedIssueBuffer(issue: Issue, repo: Repo): Buffer {
  const cached = issueCache.get(issue);
  if (cached !== undefined) return cached;
  const buf = Buffer.from(JSON.stringify(issueToJson(issue, repo)), 'utf8');
  issueCache.set(issue, buf);
  return buf;
}

/** Invalidate one issue's pre-serialised body (also used by GraphQL mutations). */
export function invalidateIssue(issue: Issue): void {
  issueCache.delete(issue);
}

export function commentToJson(issue: Issue, comment: Comment, index: number): JsonObject {
  return {
    id: index + 1,
    body: comment.body,
    user: { login: comment.userLogin, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `/api/v3/repos/issues/${issue.number}/comments/${index + 1}`,
    url: `/api/v3/repos/issues/${issue.number}/comments/${index + 1}`,
  };
}

export function pullToJson(pull: Pull, repo: Repo): JsonObject {
  const extra = pull as unknown as Record<string, unknown>;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: (extra.merged_at as string | undefined) ?? null,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, type: 'User' },
    created_at: pull.createdAt,
    html_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Small request-scoped helpers

interface Ctx {
  store: Store;
  ids: RequestIdCounter;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringField(body: JsonObject | null, field: string): string | undefined {
  const value = body?.[field];
  return typeof value === 'string' ? value : undefined;
}

function parseLabels(body: JsonObject | null): string[] | null {
  const raw = body?.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') out.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as JsonObject).name === 'string') {
      out.push((item as JsonObject).name as string);
    } else return null;
  }
  return out;
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

// ---------------------------------------------------------------------------------------------
// The dispatcher

/**
 * Handle one HTTP request. Returns true when the path is under /api/v3 and a
 * reply was sent, false otherwise (the router should try the next surface).
 */
export async function handleRestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: RestContext = {},
): Promise<boolean> {
  const ctx: Ctx = { store: context.store ?? defaultStore, ids: context.requestIds ?? moduleRequestIds };
  const segments = pathSegments(req);
  if (segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';
  const query = queryOf(req);

  // GET /api/v3/ — public, as the starter shipped it.
  if (rest.length === 0) {
    if (method !== 'GET') {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    sendJson(
      res,
      ctx.ids,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  // GET /api/v3/meta — public.
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    sendJson(res, ctx.ids, 200, { installed_version: '1.0.0' });
    return true;
  }

  // Everything else needs a bearer token.
  if (!isAuthorized(req)) {
    sendError(res, ctx.ids, 401, 'Requires authentication');
    return true;
  }

  // Read + parse the body for methods that carry one. Malformed JSON -> 400.
  let body: unknown;
  if (BODY_METHODS.has(method)) {
    if (context.bodyParseError === true) {
      sendError(res, ctx.ids, 400, 'Malformed JSON body');
      return true;
    }
    if (context.body !== undefined) {
      body = context.body;
    } else {
      const read = await readBody(req);
      if (!read.ok) {
        sendError(res, ctx.ids, 400, 'Malformed JSON body');
        return true;
      }
      body = read.value;
    }
  }
  const bodyObj = asObject(body);

  // GET /api/v3/user — the token's login.
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    sendJson(res, ctx.ids, 200, { login: VIEWER_LOGIN, type: 'User', html_url: `/api/v3/users/${VIEWER_LOGIN}` });
    return true;
  }

  // /api/v3/user/repos — list (paginated) / create.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = ctx.store.listRepos(VIEWER_LOGIN);
      const { pageItems, link } = paginate(req, all, query);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      sendJson(res, ctx.ids, 200, pageItems.map((repo) => repoToJson(repo)), headers);
      return true;
    }
    if (method === 'POST') {
      const name = stringField(bodyObj, 'name');
      if (name === undefined || name === '') {
        sendError(res, ctx.ids, 422, 'Repository name is required');
        return true;
      }
      if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        sendError(res, ctx.ids, 422, 'Repository already exists');
        return true;
      }
      const description = stringField(bodyObj, 'description') ?? '';
      const isPrivate = typeof bodyObj?.private === 'boolean' ? (bodyObj.private as boolean) : false;
      const repo = ctx.store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
      sendJson(res, ctx.ids, 201, repoToJson(repo));
      return true;
    }
    sendError(res, ctx.ids, 404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{owner}/{name}[...] — everything else.
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    // A repo under a different owner than the token's login -> 404, never 403.
    if (owner !== VIEWER_LOGIN) {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    const repo = ctx.store.getRepo(owner, name);
    if (repo === undefined) {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    const tail = rest.slice(3);
    return handleRepoRoute(req, res, ctx, repo, tail, method, query, bodyObj);
  }

  // Unknown /api/v3 route -> JSON 404.
  sendError(res, ctx.ids, 404, 'Not Found');
  return true;
}

/** Routes under /api/v3/repos/{owner}/{name}/... with the repo resolved. */
async function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  repo: Repo,
  tail: string[],
  method: string,
  query: URLSearchParams,
  bodyObj: JsonObject | null,
): Promise<boolean> {
  // GET/PATCH/DELETE /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, ctx.ids, 200, repoToJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const description = stringField(bodyObj, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof bodyObj?.private === 'boolean') repo.private = bodyObj.private as boolean;
      sendJson(res, ctx.ids, 200, repoToJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(repo.owner, repo.name);
      sendBuffer(res, ctx.ids, 204, null);
      return true;
    }
    sendError(res, ctx.ids, 404, 'Not Found');
    return true;
  }

  // POST /repos/{o}/{r}/git/refs — create a branch.
  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
    if (method !== 'POST') {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    const ref = stringField(bodyObj, 'ref');
    const sha = stringField(bodyObj, 'sha');
    if (ref === undefined || ref === '' || sha === undefined || sha === '') {
      sendError(res, ctx.ids, 422, 'ref and sha are required');
      return true;
    }
    if (!ref.startsWith('refs/')) {
      sendError(res, ctx.ids, 422, 'ref must start with refs/');
      return true;
    }
    if (repo.objects.get(sha) === undefined) {
      sendError(res, ctx.ids, 422, 'sha does not exist in this repository');
      return true;
    }
    if (repo.refs.has(ref)) {
      sendError(res, ctx.ids, 422, 'Reference already exists');
      return true;
    }
    repo.refs.set(ref, sha);
    ctx.store.invalidatePackCache(repo);
    sendJson(res, ctx.ids, 201, { ref, object: { sha, type: 'commit' } });
    return true;
  }

  // GET /repos/{o}/{r}/branches
  if (tail.length === 1 && tail[0] === 'branches') {
    if (method !== 'GET') {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    const branches: JsonObject[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) {
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
      }
    }
    branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    sendJson(res, ctx.ids, 200, branches);
    return true;
  }

  // GET /repos/{o}/{r}/commits[?sha=<ref>]
  if (tail.length === 1 && tail[0] === 'commits') {
    if (method !== 'GET') {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    const refParam = query.get('sha');
    let tip: string | null;
    if (refParam === null) {
      tip = branchTip(repo, repo.defaultBranch) ?? null;
    } else {
      tip = resolveCommit(repo, refParam);
      if (tip === null) {
        sendError(res, ctx.ids, 404, 'Not Found');
        return true;
      }
    }
    if (tip === null) {
      sendJson(res, ctx.ids, 200, []);
      return true;
    }
    const { perPage } = pageParams(query);
    const commits = listCommits(repo, tip, Math.max(1, perPage));
    sendJson(
      res,
      ctx.ids,
      200,
      commits.map((c) => ({
        sha: c.sha,
        commit: {
          message: c.message,
          author: { name: 'forge', email: 'forge@localhost' },
          committer: { name: 'forge', email: 'forge@localhost' },
        },
        parents: c.parents.map((sha) => ({ sha })),
      })),
    );
    return true;
  }

  // /repos/{o}/{r}/contents/{path...}
  if (tail[0] === 'contents') {
    return handleContents(req, res, ctx, repo, tail.slice(1).join('/'), method, query, bodyObj);
  }

  // POST /repos/{o}/{r}/labels
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method !== 'POST') {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    const labelName = stringField(bodyObj, 'name');
    if (labelName === undefined || labelName === '') {
      sendError(res, ctx.ids, 422, 'Label name is required');
      return true;
    }
    const color = stringField(bodyObj, 'color') ?? 'ededed';
    repo.labels.set(labelName, { name: labelName, color });
    sendJson(res, ctx.ids, 201, { name: labelName, color });
    return true;
  }

  // /repos/{o}/{r}/issues...
  if (tail[0] === 'issues') {
    return handleIssues(req, res, ctx, repo, tail.slice(1), method, query, bodyObj);
  }

  // /repos/{o}/{r}/pulls...
  if (tail[0] === 'pulls') {
    return handlePulls(req, res, ctx, repo, tail.slice(1), method, query, bodyObj);
  }

  sendError(res, ctx.ids, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------------------------
// Contents (real git commits in the shared object store)

function contentsCommit(
  ctx: Ctx,
  repo: Repo,
  branch: string,
  tip: string | null,
  flat: Map<string, { oid: string; mode: string }>,
  message: string,
): string {
  const tree = buildTreeFromMap(repo, flat);
  const commitSha = createCommit(repo, {
    tree,
    parents: tip === null ? [] : [tip],
    message,
    clock: ctx.store.clock,
  });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  ctx.store.invalidatePackCache(repo);
  return commitSha;
}

async function handleContents(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  repo: Repo,
  path: string,
  method: string,
  query: URLSearchParams,
  bodyObj: JsonObject | null,
): Promise<boolean> {
  const branchOf = (body: JsonObject | null): string => stringField(body, 'branch') ?? repo.defaultBranch;

  if (method === 'PUT') {
    if (path === '') {
      sendError(res, ctx.ids, 422, 'A file path is required');
      return true;
    }
    const contentB64 = stringField(bodyObj, 'content');
    if (contentB64 === undefined) {
      sendError(res, ctx.ids, 422, 'content is required');
      return true;
    }
    const branch = branchOf(bodyObj);
    const tip = branchTip(repo, branch);
    if (tip === undefined) {
      if (repo.refs.size > 0) {
        sendError(res, ctx.ids, 404, 'Not Found');
        return true;
      }
      // Unborn repo: the first contents commit has no parent / base tree.
      const content = Buffer.from(contentB64, 'base64');
      const blobOid = putBlob(repo, content);
      const flat = new Map<string, { oid: string; mode: string }>([[path, { oid: blobOid, mode: '100644' }]]);
      const commitSha = contentsCommit(ctx, repo, branch, null, flat, stringField(bodyObj, 'message') ?? `Create ${path}`);
      sendJson(res, ctx.ids, 201, {
        content: { name: basename(path), path, sha: blobOid, size: content.length, encoding: 'base64', content: contentB64, type: 'file' },
        commit: { sha: commitSha },
      });
      return true;
    }
    const baseTree = treeOidOfCommit(repo, tip);
    const flat = flattenTree(repo, baseTree);
    const existing = flat.get(path);
    const sha = stringField(bodyObj, 'sha');
    if (sha !== undefined && (existing === undefined || existing.oid !== sha)) {
      sendError(res, ctx.ids, 409, 'sha does not match the current file');
      return true;
    }
    const content = Buffer.from(contentB64, 'base64');
    const blobOid = putBlob(repo, content);
    flat.set(path, { oid: blobOid, mode: '100644' });
    const commitSha = contentsCommit(ctx, repo, branch, tip, flat, stringField(bodyObj, 'message') ?? `Update ${path}`);
    sendJson(res, ctx.ids, existing === undefined ? 201 : 200, {
      content: { name: basename(path), path, sha: blobOid, size: content.length, encoding: 'base64', content: contentB64, type: 'file' },
      commit: { sha: commitSha },
    });
    return true;
  }

  if (method === 'GET') {
    const refParam = query.get('ref');
    let tip: string | null;
    if (refParam === null) {
      tip = branchTip(repo, repo.defaultBranch) ?? null;
    } else {
      tip = resolveCommit(repo, refParam);
    }
    if (tip === null) {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    const tree = treeOidOfCommit(repo, tip);
    const flat = flattenTree(repo, tree);
    const file = flat.get(path);
    if (file !== undefined) {
      const obj = repo.objects.get(file.oid);
      const data = obj === undefined ? Buffer.alloc(0) : obj.data;
      sendJson(res, ctx.ids, 200, {
        type: 'file',
        name: basename(path),
        path,
        sha: file.oid,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      });
      return true;
    }
    // Directory listing: immediate children of `path` ('' = repo root).
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { isDir: boolean; oid: string; size: number }>();
    for (const [fullPath, entry] of flat) {
      if (!fullPath.startsWith(prefix)) continue;
      const rest = fullPath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        const obj = repo.objects.get(entry.oid);
        children.set(rest, { isDir: false, oid: entry.oid, size: obj === undefined ? 0 : obj.data.length });
      } else {
        const dirName = rest.slice(0, slash);
        if (!children.has(dirName)) {
          // The directory's tree oid: build the subtree once (stored, harmless).
          const sub = new Map<string, { oid: string; mode: string }>();
          for (const [p2, e2] of flat) {
            if (p2.startsWith(`${prefix}${dirName}/`)) sub.set(p2.slice(prefix.length + dirName.length + 1), e2);
          }
          children.set(dirName, { isDir: true, oid: buildTreeFromMap(repo, sub), size: 0 });
        }
      }
    }
    if (children.size === 0) {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    const entries: JsonObject[] = [...children.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([childName, child]) => ({
        type: child.isDir ? 'dir' : 'file',
        name: childName,
        path: prefix + childName,
        sha: child.oid,
        size: child.size,
      }));
    sendJson(res, ctx.ids, 200, entries);
    return true;
  }

  if (method === 'DELETE') {
    if (path === '') {
      sendError(res, ctx.ids, 422, 'A file path is required');
      return true;
    }
    const branch = branchOf(bodyObj);
    const tip = branchTip(repo, branch);
    if (tip === undefined) {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    const flat = flattenTree(repo, treeOidOfCommit(repo, tip));
    const existing = flat.get(path);
    if (existing === undefined) {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    const sha = stringField(bodyObj, 'sha');
    if (sha !== undefined && existing.oid !== sha) {
      sendError(res, ctx.ids, 409, 'sha does not match the current file');
      return true;
    }
    flat.delete(path);
    const commitSha = contentsCommit(ctx, repo, branch, tip, flat, stringField(bodyObj, 'message') ?? `Delete ${path}`);
    sendJson(res, ctx.ids, 200, { commit: { sha: commitSha } });
    return true;
  }

  sendError(res, ctx.ids, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------------------------
// Issues

async function handleIssues(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  repo: Repo,
  tail: string[],
  method: string,
  query: URLSearchParams,
  bodyObj: JsonObject | null,
): Promise<boolean> {
  // POST / GET /repos/{o}/{r}/issues
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = stringField(bodyObj, 'title');
      if (title === undefined || title === '') {
        sendError(res, ctx.ids, 422, 'Title is required');
        return true;
      }
      const labels = parseLabels(bodyObj);
      if (labels === null) {
        sendError(res, ctx.ids, 422, 'labels must be an array');
        return true;
      }
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendError(res, ctx.ids, 422, `Label '${label}' does not exist`);
          return true;
        }
      }
      const issue = ctx.store.createIssue(repo, title, stringField(bodyObj, 'body') ?? '', labels, VIEWER_LOGIN);
      sendBuffer(res, ctx.ids, 201, cachedIssueBuffer(issue, repo));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      // state=all (or anything else) keeps every issue.
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, perPage } = pageParams(query);
      const pageItems = issues.slice((page - 1) * perPage, page * perPage);
      sendJson(res, ctx.ids, 200, pageItems.map((issue) => issueToJson(issue, repo)));
      return true;
    }
    sendError(res, ctx.ids, 404, 'Not Found');
    return true;
  }

  // /repos/{o}/{r}/issues/{n}[...]
  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number)) {
    sendError(res, ctx.ids, 404, 'Not Found');
    return true;
  }
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    sendError(res, ctx.ids, 404, 'Not Found');
    return true;
  }

  if (tail.length === 1) {
    if (method === 'GET') {
      // Hot path (read workload): serve the pre-serialised buffer.
      sendBuffer(res, ctx.ids, 200, cachedIssueBuffer(issue, repo));
      return true;
    }
    if (method === 'PATCH') {
      const state = stringField(bodyObj, 'state');
      if (state !== undefined) {
        if (state !== 'open' && state !== 'closed') {
          sendError(res, ctx.ids, 422, 'state must be open or closed');
          return true;
        }
        issue.state = state;
      }
      const title = stringField(bodyObj, 'title');
      if (title !== undefined) issue.title = title;
      const bodyText = stringField(bodyObj, 'body');
      if (bodyText !== undefined) issue.body = bodyText;
      issue.updatedAt = ctx.store.clock.nowIso();
      invalidateIssue(issue);
      sendBuffer(res, ctx.ids, 200, cachedIssueBuffer(issue, repo));
      return true;
    }
    sendError(res, ctx.ids, 404, 'Not Found');
    return true;
  }

  // /repos/{o}/{r}/issues/{n}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const text = stringField(bodyObj, 'body');
      if (text === undefined) {
        sendError(res, ctx.ids, 422, 'Comment body is required');
        return true;
      }
      const comment = ctx.store.createComment(issue, text, VIEWER_LOGIN);
      invalidateIssue(issue); // the issue's comment count changed
      const index = issue.comments.indexOf(comment);
      sendJson(res, ctx.ids, 201, commentToJson(issue, comment, index === -1 ? issue.comments.length - 1 : index));
      return true;
    }
    if (method === 'GET') {
      sendJson(
        res,
        ctx.ids,
        200,
        issue.comments.map((comment, index) => commentToJson(issue, comment, index)),
      );
      return true;
    }
    sendError(res, ctx.ids, 404, 'Not Found');
    return true;
  }

  sendError(res, ctx.ids, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------------------------
// Pull requests

async function handlePulls(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  repo: Repo,
  tail: string[],
  method: string,
  query: URLSearchParams,
  bodyObj: JsonObject | null,
): Promise<boolean> {
  const normalRef = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    return value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
  };

  // POST / GET /repos/{o}/{r}/pulls
  if (tail.length === 0) {
    if (method === 'POST') {
      const head = normalRef(stringField(bodyObj, 'head'));
      const base = normalRef(stringField(bodyObj, 'base'));
      if (head === undefined || head === '' || base === undefined || base === '') {
        sendError(res, ctx.ids, 422, 'head and base are required');
        return true;
      }
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === undefined || baseSha === undefined) {
        sendError(res, ctx.ids, 422, 'head or base branch not found');
        return true;
      }
      const files = diffTrees(repo, treeOidOfCommit(repo, baseSha), treeOidOfCommit(repo, headSha));
      const pull = ctx.store.createPull(
        repo,
        stringField(bodyObj, 'title') ?? '',
        stringField(bodyObj, 'body') ?? '',
        head,
        headSha,
        base,
        baseSha,
        files,
      );
      sendJson(res, ctx.ids, 201, pullToJson(pull, repo));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      const { page, perPage } = pageParams(query);
      const pageItems = pulls.slice((page - 1) * perPage, page * perPage);
      sendJson(res, ctx.ids, 200, pageItems.map((pull) => pullToJson(pull, repo)));
      return true;
    }
    sendError(res, ctx.ids, 404, 'Not Found');
    return true;
  }

  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number)) {
    sendError(res, ctx.ids, 404, 'Not Found');
    return true;
  }
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    sendError(res, ctx.ids, 404, 'Not Found');
    return true;
  }

  // GET /repos/{o}/{r}/pulls/{n}
  if (tail.length === 1) {
    if (method !== 'GET') {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    sendJson(res, ctx.ids, 200, pullToJson(pull, repo));
    return true;
  }

  // GET /repos/{o}/{r}/pulls/{n}/files
  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    sendJson(res, ctx.ids, 200, pull.files);
    return true;
  }

  // PUT /repos/{o}/{r}/pulls/{n}/merge (merge_method=squash)
  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') {
      sendError(res, ctx.ids, 404, 'Not Found');
      return true;
    }
    if (pull.merged || pull.state !== 'open') {
      sendError(res, ctx.ids, 405, 'Pull request is already merged or closed');
      return true;
    }
    const baseTipSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const result = squashMerge(repo, {
      headSha: pull.headSha,
      baseTipSha,
      baseRef: pull.baseRef,
      title: pull.title,
      number: pull.number,
      clock: ctx.store.clock,
    });
    if (!result.ok) {
      sendError(res, ctx.ids, 405, result.message);
      return true;
    }
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = result.sha;
    (pull as unknown as Record<string, unknown>).merged_at = ctx.store.clock.nowIso();
    sendJson(res, ctx.ids, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
    return true;
  }

  sendError(res, ctx.ids, 404, 'Not Found');
  return true;
}

/** Bound handler for routers that prefer a pre-built function. */
export function createRestHandler(context: RestContext = {}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return (req, res) => handleRestRequest(req, res, context);
}
