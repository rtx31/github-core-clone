// lib/graphql.ts — GraphQL v4 endpoint (POST /api/graphql).
//
// Minimal hand-rolled parser + executor for the exact documents the suite sends
// (gh's githubv4 shapes + github-mcp-server's, see program/env/src/checks-graphql.ts
// and graphql-client.ts). No full GraphQL: one operation per document (or a JSON array
// of operations for batching), variables, aliases, inline fragments (`... on Type`),
// input objects / enum lists / null variables. Unknown fields answer HTTP 200 with an
// `errors` array naming the field; an unknown repository answers data.repository = null
// with no errors.
//
// Shared by lib/mcp.ts: bearer auth, body reading, JSON replies, the squash-merge
// path (lib/merge.ts does not exist yet — this file owns it until the REST workstream
// lands it) and the pull-request file diff. All reads/writes go through the one
// store in lib/store.ts, so REST / GraphQL / MCP see the same objects and ids.
//
// Router contract (app.ts): `handleGraphQL(req, res)` reads the body, enforces auth
// and writes the reply. `executeGraphQL(body)` is the pure entry point (parsed JSON
// body in, {status, json} out) for a router that already parsed the body.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type Issue, type Pull, type PullFile, type Repo } from './store.ts';
import { invalidateIssue } from './rest.ts';
import { fnv1a64, globalId, RequestIdCounter, VIEWER_LOGIN } from './util.ts';

// ---------------------------------------------------------------------------
// HTTP plumbing shared with lib/mcp.ts
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

/** Read a request body as text (1 MiB cap — GraphQL/MCP documents are small). */
export function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

/** Write a JSON body with the shared headers. */
export function writeJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

/**
 * Bearer authorization (spec §4.2 / §4.6): no token -> false; when
 * MAKEFUN_SHOP_TOKEN is set the header must equal `Bearer <expected>`, otherwise
 * any non-empty Bearer token is accepted.
 */
export function bearerAuthorized(authorization: string | string[] | undefined): boolean {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof header !== 'string' || header === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return header === `Bearer ${expected}`;
  return header.startsWith('Bearer ') && header.slice(7).trim() !== '';
}

// ---------------------------------------------------------------------------
// Git object helpers (minimal: commit/tree parse + build, SHA-1 ids).
// Only what the squash merge and the PR file diff need.
// ---------------------------------------------------------------------------

/** SHA-1 id of a git object (`type size\0` header + raw bytes). */
export function gitObjectId(type: string, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

function parseCommit(data: Buffer): { tree: string; parents: string[] } {
  const head = data.toString('utf8').split('\n\n')[0] ?? '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

function parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

/** Flatten a tree object into path -> {mode, oid} (recursive, directories expanded). */
function flattenTree(repo: Repo, oid: string, prefix: string, out: Map<string, { mode: string; oid: string }>): void {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') flattenTree(repo, entry.oid, `${prefix}${entry.name}/`, out);
    else out.set(`${prefix}${entry.name}`, { mode: entry.mode, oid: entry.oid });
  }
}

/** Build tree objects bottom-up from a flat path map; returns the root tree oid. */
function buildTreeRecursive(repo: Repo, rel: Map<string, { mode: string; oid: string }>): string {
  const entries: Array<{ mode: string; name: string; oid: string; dir: boolean }> = [];
  const sub = new Map<string, Map<string, { mode: string; oid: string }>>();
  for (const [path, ent] of rel) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      entries.push({ mode: ent.mode, name: path, oid: ent.oid, dir: false });
    } else {
      const dir = path.slice(0, slash);
      let children = sub.get(dir);
      if (children === undefined) {
        children = new Map();
        sub.set(dir, children);
      }
      children.set(path.slice(slash + 1), ent);
    }
  }
  for (const [dir, children] of sub) {
    entries.push({ mode: '40000', name: dir, oid: buildTreeRecursive(repo, children), dir: true });
  }
  // Git tree order: names compared with directories as if they had a trailing '/'.
  entries.sort((a, b) => {
    const an = a.dir ? `${a.name}/` : a.name;
    const bn = b.dir ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  const data = Buffer.concat(parts);
  const oid = gitObjectId('tree', data);
  store.putObject(repo, oid, 'tree', data);
  return oid;
}

/** All ancestors of a commit (BFS over parents). */
function ancestors(repo: Repo, start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  for (let i = 0; i < queue.length; i += 1) {
    const oid = queue[i] as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return seen;
}

/** First common ancestor of two commits (BFS from `b` into `a`'s ancestors). */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aAncestors = ancestors(repo, a);
  const seen = new Set<string>();
  const queue = [b];
  for (let i = 0; i < queue.length; i += 1) {
    const oid = queue[i] as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (aAncestors.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

function sameEntry(
  a: { mode: string; oid: string } | undefined,
  b: { mode: string; oid: string } | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.oid === b.oid && a.mode === b.mode;
}

/**
 * Dry-run 3-way merge of a pull request: merge-base tree vs head tree vs base-tip
 * tree. A path the head changed and the base tip did not takes the head; a path the
 * base tip changed and the head did not keeps the base tip; both changing the same
 * path differently is a conflict.
 */
export function tryMergeTree(
  repo: Repo,
  pull: Pull,
): { conflict: boolean; tree: Map<string, { mode: string; oid: string }> | null } {
  const headObj = repo.objects.get(pull.headSha);
  const baseObj = repo.objects.get(pull.baseSha);
  if (headObj === undefined || baseObj === undefined) throw new Error('Missing commit for pull request');
  const base = mergeBase(repo, pull.baseSha, pull.headSha);
  const baseTree = new Map<string, { mode: string; oid: string }>();
  const headTree = new Map<string, { mode: string; oid: string }>();
  const tipTree = new Map<string, { mode: string; oid: string }>();
  flattenTree(repo, parseCommit(headObj.data).tree, '', headTree);
  flattenTree(repo, parseCommit(baseObj.data).tree, '', tipTree);
  if (base !== null) {
    const baseCommit = repo.objects.get(base);
    if (baseCommit !== undefined) flattenTree(repo, parseCommit(baseCommit.data).tree, '', baseTree);
  }
  const out = new Map(tipTree);
  let conflict = false;
  for (const path of new Set([...baseTree.keys(), ...headTree.keys(), ...tipTree.keys()])) {
    const m = baseTree.get(path);
    const h = headTree.get(path);
    const t = tipTree.get(path);
    if (sameEntry(h, m)) {
      // Head unchanged since the merge base: keep the base tip's version.
    } else if (sameEntry(t, m)) {
      // Base tip unchanged: take the head's version (or its deletion).
      if (h === undefined) out.delete(path);
      else out.set(path, h);
    } else if (sameEntry(h, t)) {
      // Both sides made the same change.
    } else {
      conflict = true;
    }
  }
  return { conflict, tree: conflict ? null : out };
}

function countLines(repo: Repo, oid: string): number {
  const obj = repo.objects.get(oid);
  if (obj === undefined) return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** Changed files between the base tip and the head tip (REST/GraphQL file lists). */
export function computePullFiles(repo: Repo, headSha: string, baseSha: string): PullFile[] {
  const headTree = new Map<string, { mode: string; oid: string }>();
  const baseTree = new Map<string, { mode: string; oid: string }>();
  const headObj = repo.objects.get(headSha);
  const baseObj = repo.objects.get(baseSha);
  if (headObj !== undefined) flattenTree(repo, parseCommit(headObj.data).tree, '', headTree);
  if (baseObj !== undefined) flattenTree(repo, parseCommit(baseObj.data).tree, '', baseTree);
  const files: PullFile[] = [];
  for (const path of [...new Set([...headTree.keys(), ...baseTree.keys()])].sort()) {
    const h = headTree.get(path);
    const b = baseTree.get(path);
    if (h !== undefined && b === undefined) {
      const additions = countLines(repo, h.oid);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (h === undefined && b !== undefined) {
      const deletions = countLines(repo, b.oid);
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (h !== undefined && b !== undefined && h.oid !== b.oid) {
      const additions = countLines(repo, h.oid);
      const deletions = countLines(repo, b.oid);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

/**
 * SQUASH-merge a pull request: one commit on the base branch whose tree is the
 * 3-way merge result, parent = base tip. The PR closes as merged and the squash
 * commit is a real git object, so git fetch and REST see the same state.
 * Throws on a merge conflict (the REST surface answers that with 405).
 */
export function squashMergePull(repo: Repo, pull: Pull): string {
  if (pull.merged) return pull.mergeCommitSha ?? '';
  const outcome = tryMergeTree(repo, pull);
  if (outcome.conflict || outcome.tree === null) {
    throw new Error(`Pull request #${pull.number} has merge conflicts`);
  }
  const treeOid = buildTreeRecursive(repo, outcome.tree);
  const unix = Math.floor(Date.parse(store.clock.nowIso()) / 1000);
  const who = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@users.noreply.github.com> ${unix} +0000`;
  const message = `${pull.title} (#${pull.number})\n`;
  const commitText =
    `tree ${treeOid}\nparent ${pull.baseSha}\nauthor ${who}\ncommitter ${who}\n\n${message}`;
  const commitData = Buffer.from(commitText, 'utf8');
  const commitOid = gitObjectId('commit', commitData);
  store.putObject(repo, commitOid, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  store.invalidatePackCache(repo);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = commitOid;
  return commitOid;
}

/** Mergeable state for an open pull request (dry-run of the 3-way merge). */
function mergeableOf(repo: Repo, pull: Pull): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  try {
    return tryMergeTree(repo, pull).conflict ? 'CONFLICTING' : 'MERGEABLE';
  } catch {
    return 'UNKNOWN';
  }
}

// ---------------------------------------------------------------------------
// Id lookups (scan the store — global ids are deterministic, stored on objects)
// ---------------------------------------------------------------------------

function findRepoByGlobalId(id: string): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | undefined {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === id) return { repo, issue };
    }
  }
  return undefined;
}

function findPullByGlobalId(id: string): { repo: Repo; pull: Pull } | undefined {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === id) return { repo, pull };
    }
  }
  return undefined;
}

/** Stable positive numeric id for a repo (GraphQL databaseId; REST never sees it). */
function databaseIdOf(repo: Repo): number {
  return Number(fnv1a64(`repo:${repo.owner}/${repo.name}`) % 2147483647n) + 1;
}

// ---------------------------------------------------------------------------
// Tokenizer + parser (subset: operations, variables, aliases, arguments,
// inline/named fragments; strings, ints, booleans, null, enums, lists, objects)
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'punct' | 'spread';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[];
}
interface GqlFragment {
  kind: 'fragment';
  name?: string;
  typeCondition?: string;
  selections: GqlSelection[];
}
type GqlSelection = GqlField | GqlFragment;
interface GqlOperation {
  kind: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: Record<string, GqlValue | undefined>;
  selections: GqlSelection[];
}
interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlFragment>;
}

class Parser {
  readonly tokens: Token[];
  pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return tok;
  }
  expect(value: string): Token {
    const tok = this.next();
    if (tok.value !== value) throw new Error(`Expected "${value}" in GraphQL document, got "${tok.value}"`);
    return tok;
  }
  is(value: string): boolean {
    return this.peek()?.value === value;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlFragment>();
    while (this.pos < this.tokens.length) {
      const tok = this.peek() as Token;
      if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const name = this.next().value;
        this.expect('on');
        const typeCondition = this.next().value;
        const selections = this.parseSelectionSet();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selections });
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  parseOperation(): GqlOperation {
    let kind: GqlOperation['kind'] = 'query';
    let name: string | undefined;
    const first = this.peek() as Token;
    if (first.kind === 'name' && (first.value === 'query' || first.value === 'mutation' || first.value === 'subscription')) {
      kind = first.value as GqlOperation['kind'];
      this.next();
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') {
        name = this.next().value;
      }
    }
    const variables: Record<string, GqlValue | undefined> = {};
    if (this.is('(')) {
      this.next();
      while (!this.is(')')) {
        this.expect('$');
        const varName = this.next().value;
        this.expect(':');
        this.skipType();
        if (this.is('=')) {
          this.next();
          variables[varName] = this.parseValue();
        } else {
          variables[varName] = undefined;
        }
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  /** Skip a type expression: Name, [T], T! — the suite's variables need no typing. */
  skipType(): void {
    for (;;) {
      const tok = this.peek();
      if (tok === undefined) throw new Error('Unexpected end of GraphQL document in a type');
      if (tok.value === '[' || tok.value === ']' || tok.value === '!') {
        this.next();
        continue;
      }
      if (tok.kind === 'name') {
        this.next();
        continue;
      }
      return;
    }
  }

  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (!this.is('}')) {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection(): GqlSelection {
    const tok = this.peek() as Token;
    if (tok.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.next().value;
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        return { kind: 'fragment', name: this.next().value, selections: [] };
      }
      throw new Error('Expected a fragment name or "on" after "..."');
    }
    let alias: string | undefined;
    let name = this.next().value;
    if (this.is(':')) {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Record<string, GqlValue> = {};
    if (this.is('(')) {
      this.next();
      while (!this.is(')')) {
        const argName = this.next().value;
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    // Directives (@...) are ignored — the suite sends none.
    while (this.is('@')) {
      this.next();
      this.next();
      if (this.is('(')) {
        this.next();
        while (!this.is(')')) {
          this.next();
          this.expect(':');
          this.parseValue();
        }
        this.expect(')');
      }
    }
    const selections = this.is('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(): GqlValue {
    const tok = this.next();
    if (tok.value === '$') return { kind: 'var', name: this.next().value };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: Number(tok.value) };
    if (tok.value === '[') {
      const items: GqlValue[] = [];
      while (!this.is(']')) items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (tok.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!this.is('}')) {
        const name = this.next().value;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'bool', value: true };
      if (tok.value === 'false') return { kind: 'bool', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`Unexpected value token "${tok.value}" in GraphQL document`);
  }
}

function parseDocument(src: string): GqlDocument {
  return new Parser(tokenize(src)).parseDocument();
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
      return value.value;
    case 'int':
      return value.value;
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, GqlValue>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) out[name] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Schema (introspection surface) + field resolvers
// ---------------------------------------------------------------------------

/** Fields each object type lists for __type (must cover what gh probes). */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Ref: ['id', 'name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'createdAt',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes', 'status'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'LABEL', 'MILESTONE', 'TOPIC'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

interface ExecCtx {
  errors: Array<{ message: string; path?: (string | number)[] }>;
}
type Resolver = (parent: any, args: Record<string, any>, ctx: ExecCtx) => unknown;
interface FieldDef {
  /** Child type name for nested selections; null for scalars. */
  type: string | null;
  resolve: Resolver;
}

function userNode(login: string): Record<string, unknown> {
  return { __type: 'User', id: globalId('user', login), login };
}
function repoNode(repo: Repo): Record<string, unknown> {
  return { __type: 'Repository', repo };
}
function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __type: 'Issue', repo, issue };
}
function pullNode(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __type: 'Pull', repo, pull };
}
function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64url');
}
function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, args: Record<string, any>): Record<string, unknown> {
  let list = [...repo.issues.values()];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const want = new Set(args.states.map((s: unknown) => String(s).toLowerCase()));
    list = list.filter((issue) => want.has(issue.state));
  }
  const direction = (args.orderBy as { direction?: unknown } | undefined)?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => (a.number - b.number) * direction);
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const after = decodeCursor(args.after);
    if (after !== null) {
      const idx = list.findIndex((issue) => issue.number === after);
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    edges: page.map((issue) => ({
      __type: 'IssueEdge',
      node: issueNode(repo, issue),
      cursor: encodeCursor(issue.number),
    })),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null,
      startCursor: page.length > 0 ? encodeCursor(page[0]!.number) : null,
    },
    totalCount: list.length,
  };
}

function pullConnection(repo: Repo, args: Record<string, any>): Record<string, unknown> {
  let list = [...repo.pulls.values()];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const want = new Set(args.states.map((s: unknown) => String(s).toLowerCase()));
    list = list.filter((pull) => {
      const state = pull.merged ? 'merged' : pull.state;
      return want.has(state);
    });
  } else {
    list = list.filter((pull) => pull.state === 'open');
  }
  list.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : list.length;
  const page = list.slice(0, first);
  return {
    __type: 'PullRequestConnection',
    nodes: page.map((pull) => pullNode(repo, pull)),
    edges: page.map((pull) => ({
      __type: 'PullRequestEdge',
      node: pullNode(repo, pull),
      cursor: encodeCursor(pull.number),
    })),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: page.length < list.length,
      hasPreviousPage: false,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null,
      startCursor: page.length > 0 ? encodeCursor(page[0]!.number) : null,
    },
    totalCount: list.length,
  };
}

function fileConnection(pull: Pull, args: Record<string, any>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : pull.files.length;
  const page = pull.files.slice(0, first);
  return {
    __type: 'PullRequestChangedFileConnection',
    nodes: page.map((file) => ({ __type: 'PullFile', file })),
    edges: page.map((file, i) => ({
      __type: 'PullRequestEdge',
      node: { __type: 'PullFile', file },
      cursor: encodeCursor(i + 1),
    })),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: page.length < pull.files.length,
      hasPreviousPage: false,
      endCursor: page.length > 0 ? encodeCursor(page.length) : null,
      startCursor: page.length > 0 ? encodeCursor(1) : null,
    },
    totalCount: pull.files.length,
  };
}

const FIELDS: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User', resolve: () => userNode(VIEWER_LOGIN) },
    repository: {
      type: 'Repository',
      resolve: (_p, args) => {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoNode(repo);
      },
    },
    node: {
      type: 'Node',
      resolve: (_p, args) => {
        const id = String(args.id ?? '');
        for (const repo of store.repos.values()) {
          if (repo.id === id) return repoNode(repo);
          for (const issue of repo.issues.values()) if (issue.id === id) return issueNode(repo, issue);
          for (const pull of repo.pulls.values()) if (pull.id === id) return pullNode(repo, pull);
        }
        return null;
      },
    },
    __type: {
      type: '__Type',
      resolve: (_p, args) => {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] !== undefined || TYPE_ENUMS[name] !== undefined) {
          return { __type: '__Type', name };
        }
        return null;
      },
    },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_p, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
        if (repo === undefined) throw new Error(`Repository not found: ${String(input.repositoryId ?? '')}`);
        const issue = store.createIssue(
          repo,
          String(input.title ?? ''),
          typeof input.body === 'string' ? input.body : '',
          [],
          VIEWER_LOGIN,
        );
        return { __type: 'CreateIssuePayload', issue: issueNode(repo, issue) };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_p, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(String(input.issueId ?? ''));
        if (found === undefined) throw new Error(`Issue not found: ${String(input.issueId ?? '')}`);
        found.issue.state = 'closed';
        found.issue.updatedAt = store.clock.nowIso();
        invalidateIssue(found.issue);
        return { __type: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (_p, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
        if (repo === undefined) throw new Error(`Repository not found: ${String(input.repositoryId ?? '')}`);
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        const headSha = repo.refs.get(`refs/heads/${headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
        if (headSha === undefined) throw new Error(`Head branch not found: ${headRef}`);
        if (baseSha === undefined) throw new Error(`Base branch not found: ${baseRef}`);
        const files = computePullFiles(repo, headSha, baseSha);
        const pull = store.createPull(
          repo,
          String(input.title ?? ''),
          typeof input.body === 'string' ? input.body : '',
          headRef,
          headSha,
          baseRef,
          baseSha,
          files,
        );
        return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_p, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findPullByGlobalId(String(input.pullRequestId ?? ''));
        if (found === undefined) throw new Error(`Pull request not found: ${String(input.pullRequestId ?? '')}`);
        squashMergePull(found.repo, found.pull);
        return { __type: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_p, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(String(input.subjectId ?? ''));
        if (found === undefined) throw new Error(`Issue not found: ${String(input.subjectId ?? '')}`);
        const comment = store.createComment(found.issue, String(input.body ?? ''), VIEWER_LOGIN);
        invalidateIssue(found.issue);
        const node = { __type: 'IssueComment', id: comment.id, body: comment.body, createdAt: comment.createdAt, userLogin: comment.userLogin };
        return {
          __type: 'AddCommentPayload',
          commentEdge: { __type: 'CommentEdge', node, cursor: encodeCursor(found.issue.comments.length) },
          comment: node,
        };
      },
    },
  },
  User: {
    id: { type: null, resolve: (p) => p.id },
    login: { type: null, resolve: (p) => p.login },
  },
  Repository: {
    id: { type: null, resolve: (p) => (p.repo as Repo).id },
    databaseId: { type: null, resolve: (p) => databaseIdOf(p.repo as Repo) },
    name: { type: null, resolve: (p) => (p.repo as Repo).name },
    nameWithOwner: { type: null, resolve: (p) => `${(p.repo as Repo).owner}/${(p.repo as Repo).name}` },
    description: { type: null, resolve: (p) => (p.repo as Repo).description },
    owner: { type: 'User', resolve: (p) => userNode((p.repo as Repo).owner) },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (p) => {
        const repo = p.repo as Repo;
        if (!repo.refs.has(`refs/heads/${repo.defaultBranch}`)) return null;
        return { __type: 'Ref', id: globalId('ref', repo.owner, repo.name, repo.defaultBranch), name: repo.defaultBranch };
      },
    },
    viewerPermission: { type: null, resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: null, resolve: () => true },
    issue: {
      type: 'Issue',
      resolve: (p, args) => {
        const repo = p.repo as Repo;
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : issueNode(repo, issue);
      },
    },
    issues: { type: 'IssueConnection', resolve: (p, args) => issueConnection(p.repo as Repo, args) },
    pullRequests: { type: 'PullRequestConnection', resolve: (p, args) => pullConnection(p.repo as Repo, args) },
    pullRequest: {
      type: 'Pull',
      resolve: (p, args) => {
        const repo = p.repo as Repo;
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : pullNode(repo, pull);
      },
    },
  },
  Ref: {
    id: { type: null, resolve: (p) => p.id },
    name: { type: null, resolve: (p) => p.name },
  },
  Issue: {
    id: { type: null, resolve: (p) => (p.issue as Issue).id },
    number: { type: null, resolve: (p) => (p.issue as Issue).number },
    title: { type: null, resolve: (p) => (p.issue as Issue).title },
    state: { type: null, resolve: (p) => ((p.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED') },
    body: { type: null, resolve: (p) => (p.issue as Issue).body },
    createdAt: { type: null, resolve: (p) => (p.issue as Issue).createdAt },
    updatedAt: { type: null, resolve: (p) => (p.issue as Issue).updatedAt },
  },
  IssueConnection: {
    nodes: { type: 'Issue', resolve: (p) => p.nodes },
    edges: { type: 'IssueEdge', resolve: (p) => p.edges },
    pageInfo: { type: 'PageInfo', resolve: (p) => p.pageInfo },
    totalCount: { type: null, resolve: (p) => p.totalCount },
  },
  IssueEdge: {
    node: { type: 'Issue', resolve: (p) => p.node },
    cursor: { type: null, resolve: (p) => p.cursor },
  },
  Pull: {
    id: { type: null, resolve: (p) => (p.pull as Pull).id },
    number: { type: null, resolve: (p) => (p.pull as Pull).number },
    title: { type: null, resolve: (p) => (p.pull as Pull).title },
    body: { type: null, resolve: (p) => (p.pull as Pull).body },
    state: {
      type: null,
      resolve: (p) => {
        const pull = p.pull as Pull;
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      },
    },
    merged: { type: null, resolve: (p) => (p.pull as Pull).merged },
    headRefName: { type: null, resolve: (p) => (p.pull as Pull).headRef },
    baseRefName: { type: null, resolve: (p) => (p.pull as Pull).baseRef },
    mergeable: { type: null, resolve: (p) => mergeableOf(p.repo as Repo, p.pull as Pull) },
    files: { type: 'PullRequestChangedFileConnection', resolve: (p, args) => fileConnection(p.pull as Pull, args) },
    createdAt: { type: null, resolve: (p) => (p.pull as Pull).createdAt },
  },
  PullRequestConnection: {
    nodes: { type: 'Pull', resolve: (p) => p.nodes },
    edges: { type: 'PullRequestEdge', resolve: (p) => p.edges },
    pageInfo: { type: 'PageInfo', resolve: (p) => p.pageInfo },
    totalCount: { type: null, resolve: (p) => p.totalCount },
  },
  PullRequestEdge: {
    node: { type: 'Pull', resolve: (p) => p.node },
    cursor: { type: null, resolve: (p) => p.cursor },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: 'PullFile', resolve: (p) => p.nodes },
    edges: { type: 'PullRequestEdge', resolve: (p) => p.edges },
    pageInfo: { type: 'PageInfo', resolve: (p) => p.pageInfo },
    totalCount: { type: null, resolve: (p) => p.totalCount },
  },
  PullFile: {
    path: { type: null, resolve: (p) => (p.file as PullFile).filename },
    filename: { type: null, resolve: (p) => (p.file as PullFile).filename },
    additions: { type: null, resolve: (p) => (p.file as PullFile).additions },
    deletions: { type: null, resolve: (p) => (p.file as PullFile).deletions },
    changes: { type: null, resolve: (p) => (p.file as PullFile).changes },
    status: { type: null, resolve: (p) => (p.file as PullFile).status },
  },
  PageInfo: {
    hasNextPage: { type: null, resolve: (p) => p.hasNextPage },
    hasPreviousPage: { type: null, resolve: (p) => p.hasPreviousPage },
    endCursor: { type: null, resolve: (p) => p.endCursor },
    startCursor: { type: null, resolve: (p) => p.startCursor },
  },
  IssueComment: {
    id: { type: null, resolve: (p) => p.id },
    body: { type: null, resolve: (p) => p.body },
    author: { type: 'User', resolve: (p) => userNode(p.userLogin as string) },
    createdAt: { type: null, resolve: (p) => p.createdAt },
  },
  CommentEdge: {
    node: { type: 'IssueComment', resolve: (p) => p.node },
    cursor: { type: null, resolve: (p) => p.cursor },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: (p) => p.issue },
    clientMutationId: { type: null, resolve: () => null },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: (p) => p.issue },
    clientMutationId: { type: null, resolve: () => null },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'Pull', resolve: (p) => p.pullRequest },
    clientMutationId: { type: null, resolve: () => null },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'Pull', resolve: (p) => p.pullRequest },
    clientMutationId: { type: null, resolve: () => null },
  },
  AddCommentPayload: {
    commentEdge: { type: 'CommentEdge', resolve: (p) => p.commentEdge },
    comment: { type: 'IssueComment', resolve: (p) => p.comment },
    clientMutationId: { type: null, resolve: () => null },
  },
  __Type: {
    name: { type: null, resolve: (p) => p.name },
    kind: { type: null, resolve: (p) => (TYPE_ENUMS[p.name as string] !== undefined ? 'ENUM' : 'OBJECT') },
    description: { type: null, resolve: () => null },
    fields: {
      type: '__Field',
      resolve: (p) => (TYPE_FIELDS[p.name as string] ?? []).map((name) => ({ __type: '__Field', name })),
    },
    enumValues: {
      type: '__EnumValue',
      resolve: (p) => (TYPE_ENUMS[p.name as string] ?? []).map((name) => ({ __type: '__EnumValue', name })),
    },
  },
  __Field: {
    name: { type: null, resolve: (p) => p.name },
    description: { type: null, resolve: () => null },
  },
  __EnumValue: {
    name: { type: null, resolve: (p) => p.name },
    description: { type: null, resolve: () => null },
  },
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

function applySelection(
  declaredType: string | null,
  value: unknown,
  selections: GqlSelection[] | undefined,
  variables: Record<string, unknown>,
  fragments: Map<string, GqlFragment>,
  ctx: ExecCtx,
  path: (string | number)[],
): unknown {
  if (value === null || value === undefined) return null;
  if (selections === undefined || selections.length === 0) {
    // An object returned with no sub-selections has nothing to project.
    if (typeof value === 'object' && (value as Record<string, unknown>).__type !== undefined) return null;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      if (item === null || item === undefined) return null;
      const t = (item as Record<string, unknown>).__type as string | undefined ?? declaredType ?? 'Unknown';
      return resolveFields(t, item, selections, variables, fragments, ctx, [...path, i]);
    });
  }
  const t = (value as Record<string, unknown>).__type as string | undefined ?? declaredType ?? 'Unknown';
  return resolveFields(t, value, selections, variables, fragments, ctx, path);
}

function resolveFields(
  typeName: string,
  value: any,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
  fragments: Map<string, GqlFragment>,
  ctx: ExecCtx,
  path: (string | number)[],
): Record<string, unknown> {
  const effective = (value as Record<string, unknown>)?.__type as string | undefined ?? typeName;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      let fragmentSelections: GqlSelection[] | undefined;
      let condition: string | undefined = sel.typeCondition;
      if (sel.name !== undefined) {
        const def = fragments.get(sel.name);
        if (def === undefined) {
          ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path });
          continue;
        }
        fragmentSelections = def.selections;
        condition = def.typeCondition;
      } else {
        fragmentSelections = sel.selections;
      }
      if (condition !== undefined && condition !== effective && condition !== 'Node') continue;
      Object.assign(
        out,
        resolveFields(effective, value, fragmentSelections ?? [], variables, fragments, ctx, path),
      );
      continue;
    }
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    if (sel.name === '__typename') {
      out[key] = effective;
      continue;
    }
    const def = FIELDS[effective]?.[sel.name];
    if (def === undefined) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${effective}".`, path: fieldPath });
      out[key] = null;
      continue;
    }
    let child: unknown;
    try {
      child = def.resolve(value, resolveArgs(sel.args, variables), ctx);
    } catch (err) {
      ctx.errors.push({
        message: err instanceof Error ? err.message : String(err),
        path: fieldPath,
      });
      out[key] = null;
      continue;
    }
    out[key] = applySelection(def.type, child, sel.selections, variables, fragments, ctx, fieldPath);
  }
  return out;
}

export interface GraphQLResult {
  data: unknown;
  errors?: Array<{ message: string; path?: (string | number)[] }>;
}

function executeOperation(
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): GraphQLResult {
  let doc: GqlDocument;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let op: GqlOperation | undefined;
  if (operationName !== undefined) {
    op = doc.operations.find((entry) => entry.name === operationName);
  } else {
    op = doc.operations[0];
  }
  if (op === undefined) {
    return { data: null, errors: [{ message: `Unknown operation${operationName !== undefined ? ` "${operationName}"` : ''}` }] };
  }
  if (op.kind === 'subscription') {
    return { data: null, errors: [{ message: 'Subscriptions are not supported' }] };
  }
  const ctx: ExecCtx = { errors: [] };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveFields(rootType, { __type: rootType }, op.selections, variables, doc.fragments, ctx, []);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/**
 * Pure entry point: a parsed JSON body (one operation or a batch array) in,
 * {status, json} out. No auth here — the HTTP handler enforces it.
 */
export function executeGraphQL(body: unknown): { status: number; json: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (entry === null || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).query !== 'string') {
        return { data: null, errors: [{ message: 'Each batched operation needs a query string' }] } as GraphQLResult;
      }
      const record = entry as Record<string, unknown>;
      const variables = record.variables !== null && typeof record.variables === 'object'
        ? (record.variables as Record<string, unknown>)
        : {};
      return executeOperation(
        record.query as string,
        variables,
        typeof record.operationName === 'string' ? record.operationName : undefined,
      );
    });
    return { status: 200, json: results };
  }
  if (body === null || typeof body !== 'object' || typeof (body as Record<string, unknown>).query !== 'string') {
    return { status: 400, json: { message: 'GraphQL request body needs a query string' } };
  }
  const record = body as Record<string, unknown>;
  const variables = record.variables !== null && typeof record.variables === 'object'
    ? (record.variables as Record<string, unknown>)
    : {};
  return {
    status: 200,
    json: executeOperation(
      record.query as string,
      variables,
      typeof record.operationName === 'string' ? record.operationName : undefined,
    ),
  };
}

// ---------------------------------------------------------------------------
// HTTP handler (what app.ts calls)
// ---------------------------------------------------------------------------

const graphqlRequestIds = new RequestIdCounter();

/** POST /api/graphql: bearer auth, JSON body, one result (or a batch array). */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = graphqlRequestIds.next();
  if (req.method !== 'POST') {
    writeJson(res, 405, { message: 'Method Not Allowed' }, requestId);
    return;
  }
  if (!bearerAuthorized(req.headers.authorization)) {
    writeJson(res, 401, { message: 'Requires authentication' }, requestId);
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    writeJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    writeJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
    return;
  }
  const { status, json } = executeGraphQL(parsed);
  writeJson(res, status, json, requestId);
}
