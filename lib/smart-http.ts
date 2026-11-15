// Git smart-HTTP handlers (protocol v2 upload-pack, v0 receive-pack).
//
// Router contract (app.ts): read the full request body into a Buffer, then
//   const git = await handleGitRequest(req, body);
//   if (git !== null) { res.writeHead(git.status, git.headers); res.end(git.body); return; }
// `handleGitRequest` returns null when the path is not a git smart-HTTP route,
// so the router falls through to its own 404. It never throws: a malformed
// git request is answered 400 and the server stays up.
//
// Auth: the suite's git client sends `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`.
// Authorized iff the header equals `Bearer <expected>` when the env token is
// set, else any non-empty Bearer. No token -> 401. A repo under an owner other
// than VIEWER_LOGIN -> 404, never 403. A missing repo -> 404.
//
// Perf: fetch packs are cached in repo.packCache keyed by the exact fetch
// shape (sorted wants + depth + sorted shallow boundaries) and only for
// have-less fetches — the clone workload's 50 concurrent depth-1 clones of
// one tip share one build. Concurrent builds for the same key singleflight
// through one promise. Any ref move (or newly stored objects) invalidates
// the cache via store.invalidatePackCache.
//
// Erasable TypeScript only (node --experimental-strip-types).

import type { IncomingHttpHeaders } from 'node:http';
import {
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  ZERO_OID,
} from './git-objects.ts';
import { readPack, writePack } from './pack.ts';
import {
  decodePktLines,
  encodePktLine,
  encodePktLines,
  frameSideband,
  pktLineDelim,
  pktLineFlush,
  packetsToLines,
  type GitPacket,
} from './pktline.ts';
import { store, type GitObjectType, type Repo } from './store.ts';
import { VIEWER_LOGIN } from './util.ts';

export interface GitRequestLike {
  readonly method?: string;
  readonly url?: string;
  readonly headers: IncomingHttpHeaders;
}

export interface GitHttpResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

const AGENT = 'makefun-git/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const JSON_TYPE = 'application/json; charset=utf-8';

/** Pack-cache cap (LRU-ish: the oldest key is evicted first). */
const PACK_CACHE_MAX = 64;

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function gitResult(status: number, contentType: string, body: Buffer): GitHttpResult {
  return {
    status,
    headers: { 'content-type': contentType, 'content-length': String(body.length) },
    body,
  };
}

function jsonError(status: number, message: string): GitHttpResult {
  return gitResult(status, JSON_TYPE, Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8'));
}

/** The suite's git client sends `Bearer <MAKEFUN_SHOP_TOKEN>`; see the header comment. */
export function isGitAuthorized(headers: IncomingHttpHeaders): boolean {
  const auth = headerValue(headers, 'authorization');
  if (!auth) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return auth === `Bearer ${expected}`;
  return auth.startsWith('Bearer ') && auth.length > 'Bearer '.length;
}

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The default branch's tip, or the zero oid when the repo (or the branch) is unborn. */
function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

// ---------------------------------------------------------------------------------------------
// fetch object selection (shared by v2 and v0 fetch)
// ---------------------------------------------------------------------------------------------

interface WantRoots {
  readonly tagObjects: string[];
  readonly rootCommits: string[];
  readonly direct: string[];
}

/** Resolve want oids to tag objects, root commits, and directly wanted objects. */
function resolveWantRoots(repo: Repo, wants: readonly string[]): WantRoots {
  const tagObjects: string[] = [];
  const rootCommits: string[] = [];
  const direct = new Set<string>();
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      let current: string | undefined = want;
      const seen = new Set<string>();
      while (current !== undefined && !seen.has(current)) {
        seen.add(current);
        const entry = repo.objects.get(current);
        if (!entry || entry.type !== 'tag') break;
        tagObjects.push(current);
        current = parseTag(entry.data).object;
      }
      const commit = peelToCommit(repo, want);
      if (commit !== null) rootCommits.push(commit);
      else if (current !== undefined) direct.add(current);
    } else if (object.type === 'commit') {
      rootCommits.push(want);
    } else {
      direct.add(want);
    }
  }
  return { tagObjects, rootCommits, direct: [...direct] };
}

/**
 * Walk commits from `roots`, following parents up to `depth` generations
 * (depth undefined = the whole history). Returns each included commit with
 * its generation (roots are generation 0). BFS order guarantees the first
 * visit is the smallest generation.
 */
function walkCommits(repo: Repo, roots: readonly string[], depth: number | undefined): Map<string, number> {
  const gen = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = roots.map((oid) => ({ oid, gen: 0 }));
  for (let head = 0; head < queue.length; head += 1) {
    const item = queue[head] as { oid: string; gen: number };
    if (gen.has(item.oid)) continue;
    const object = repo.objects.get(item.oid);
    if (!object || object.type !== 'commit') continue;
    gen.set(item.oid, item.gen);
    if (depth === undefined || item.gen + 1 < depth) {
      for (const parent of parseCommit(object.data).parents) {
        queue.push({ oid: parent, gen: item.gen + 1 });
      }
    }
  }
  return gen;
}

/**
 * Shallow boundary lines for a fetch: `shallow` names the included commits at
 * the depth limit, `unshallow` names old boundaries whose parents are now
 * included (so they stop being shallow). With no depth limit every old
 * boundary that is now fully present is unshallow.
 */
function boundaryInfo(
  repo: Repo,
  commitGen: Map<string, number>,
  shallowIn: readonly string[],
  depth: number | undefined,
): { shallow: string[]; unshallow: string[] } {
  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, gen] of commitGen) if (gen === depth - 1) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const boundary of shallowIn) {
    if (!commitGen.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) {
      if (depth === undefined) unshallow.push(boundary);
      continue;
    }
    if (parents.every((parent) => commitGen.has(parent))) {
      unshallow.push(boundary);
      const index = shallow.indexOf(boundary);
      if (index >= 0) shallow.splice(index, 1);
    }
  }
  shallow.sort();
  unshallow.sort();
  return { shallow, unshallow };
}

interface FetchSelection {
  readonly objects: Array<{ type: GitObjectType; data: Buffer }>;
  readonly shallow: string[];
  readonly unshallow: string[];
}

/**
 * The objects a fetch must send: the depth-limited closure of the wants
 * (commits + their trees/blobs + wanted tag objects), minus the
 * shallow-truncated closure of the haves (a have listed in `shallowIn`
 * contributes itself and its tree, but not its parents — that is what makes
 * `deepen` deliver exactly one more generation).
 */
function selectFetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowIn: readonly string[],
  depth: number | undefined,
  roots?: WantRoots,
): FetchSelection {
  const resolved = roots ?? resolveWantRoots(repo, wants);
  const commitGen = walkCommits(repo, resolved.rootCommits, depth);
  const included = new Set<string>(resolved.direct);
  for (const tag of resolved.tagObjects) included.add(tag);
  for (const oid of commitGen.keys()) included.add(oid);
  // Tree closure of every included commit; shared subtrees are walked once.
  for (const commitOid of commitGen.keys()) {
    const commitObject = repo.objects.get(commitOid);
    if (!commitObject) continue;
    const stack: string[] = [parseCommit(commitObject.data).tree];
    while (stack.length) {
      const treeOid = stack.pop() as string;
      if (included.has(treeOid)) continue;
      const treeObject = repo.objects.get(treeOid);
      if (!treeObject || treeObject.type !== 'tree') continue;
      included.add(treeOid);
      for (const entry of parseTree(treeObject.data)) {
        if (entry.mode === '160000') continue; // gitlink
        const entryObject = repo.objects.get(entry.oid);
        if (!entryObject) continue;
        if (entryObject.type === 'tree') stack.push(entry.oid);
        else included.add(entry.oid);
      }
    }
  }
  // Exclusion: the haves' closure, truncated at the client's shallow boundary.
  const excluded = new Set<string>();
  const shallowSet = new Set(shallowIn);
  for (const have of haves) {
    const stack: string[] = [have];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (excluded.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      excluded.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        if (!shallowSet.has(oid)) for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
  }
  const objects: Array<{ type: GitObjectType; data: Buffer }> = [];
  for (const oid of [...included].sort()) {
    if (excluded.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push({ type: object.type, data: object.data });
  }
  const { shallow, unshallow } = boundaryInfo(repo, commitGen, shallowIn, depth);
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// pack cache with singleflight (concurrent clones for one key share one build)
// ---------------------------------------------------------------------------------------------

const inflightPacks = new WeakMap<Repo, Map<string, Promise<Buffer>>>();

function cachePackKey(wants: readonly string[], depth: number | undefined, shallowIn: readonly string[]): string {
  return `${[...wants].sort().join(',')}:${depth ?? 0}:${[...shallowIn].sort().join(',')}`;
}

async function buildPackSingleflight(repo: Repo, key: string, build: () => Buffer): Promise<Buffer> {
  let perRepo = inflightPacks.get(repo);
  if (!perRepo) {
    perRepo = new Map<string, Promise<Buffer>>();
    inflightPacks.set(repo, perRepo);
  }
  const existing = perRepo.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<Buffer> => {
    const built = build();
    if (repo.packCache.size >= PACK_CACHE_MAX) {
      const oldest = repo.packCache.keys().next().value as string | undefined;
      if (oldest !== undefined) repo.packCache.delete(oldest);
    }
    repo.packCache.set(key, built);
    return built;
  })();
  perRepo.set(key, promise);
  const cleanup = (): void => {
    if (perRepo.get(key) === promise) perRepo.delete(key);
  };
  promise.then(cleanup, cleanup);
  return promise;
}

/**
 * The pack for a fetch plus its shallow/unshallow lines. Have-less fetches
 * are cached (the clone workload); fetches with haves always build fresh,
 * because their object set depends on what the client already holds.
 */
async function fetchPack(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowIn: readonly string[],
  depth: number | undefined,
): Promise<{ pack: Buffer; shallow: string[]; unshallow: string[] }> {
  const roots = resolveWantRoots(repo, wants);
  if (haves.length === 0) {
    const key = cachePackKey(wants, depth, shallowIn);
    const commitGen = walkCommits(repo, roots.rootCommits, depth);
    const { shallow, unshallow } = boundaryInfo(repo, commitGen, shallowIn, depth);
    const cached = repo.packCache.get(key);
    if (cached) return { pack: cached, shallow, unshallow };
    const pack = await buildPackSingleflight(repo, key, () => {
      const selection = selectFetchObjects(repo, wants, haves, shallowIn, depth, roots);
      return writePack(selection.objects);
    });
    return { pack, shallow, unshallow };
  }
  const selection = selectFetchObjects(repo, wants, haves, shallowIn, depth, roots);
  return { pack: writePack(selection.objects), shallow: selection.shallow, unshallow: selection.unshallow };
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

const UPLOAD_V0_CAPS =
  `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`;
const RECEIVE_V0_CAPS = `symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** v0 ref lines; the first line carries the capabilities after a NUL. */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const parts: Buffer[] = [];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return parts;
  }
  parts.push(encodePktLine(`${headOid(repo)} HEAD\0${caps}\n`));
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    parts.push(encodePktLine(`${oid} ${name}\n`));
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) parts.push(encodePktLine(`${peeled} ${name}^{}\n`));
    }
  }
  return parts;
}

function handleInfoRefs(repo: Repo, service: string, isV2: boolean): GitHttpResult {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return jsonError(400, `unknown service ${JSON.stringify(service)}`);
  }
  const contentType = service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD;
  if (service === 'git-receive-pack' || !isV2) {
    // v0 advertisement: `# service=...`, flush, ref lines, flush.
    const body = Buffer.concat([
      encodePktLine(`# service=${service}\n`),
      pktLineFlush(),
      ...v0RefLines(repo, service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS),
      pktLineFlush(),
    ]);
    return gitResult(200, contentType, body);
  }
  // v2 advertisement: service preamble, then `version 2` + capability lines.
  const body = Buffer.concat([
    encodePktLine('# service=git-upload-pack\n'),
    pktLineFlush(),
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn peel symrefs ref-prefix\n'),
    encodePktLine('fetch=shallow\n'),
    encodePktLine('object-format=sha1\n'),
    pktLineFlush(),
  ]);
  return gitResult(200, contentType, body);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: ls-refs (v2) and fetch (v2 + v0)
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  readonly peel: boolean;
  readonly symrefs: boolean;
  readonly unborn: boolean;
  readonly prefixes: string[];
}

function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  return { peel, symrefs, unborn, prefixes };
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): GitHttpResult {
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const symrefAttr = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
  if (repo.refs.size === 0) {
    if (args.unborn && keep('HEAD')) lines.push(`unborn HEAD${symrefAttr}\n`);
  } else {
    if (keep('HEAD')) lines.push(`${headOid(repo)} HEAD${symrefAttr}\n`);
    for (const name of sortedRefNames(repo)) {
      if (!keep(name)) continue;
      const oid = repo.refs.get(name) as string;
      let line = `${oid} ${name}`;
      if (args.peel) {
        const object = repo.objects.get(oid);
        if (object && object.type === 'tag') {
          const peeled = peelToCommit(repo, oid);
          if (peeled !== null) line += ` peeled:${peeled}`;
        }
      }
      lines.push(`${line}\n`);
    }
  }
  const items: Array<string | 'flush'> = [...lines, 'flush'];
  return gitResult(200, UPLOAD_RESULT, encodePktLines(items));
}

interface FetchArgs {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallowIn: string[];
  readonly depth: number | undefined;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | undefined;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      if (isObjectId(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      if (isObjectId(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isObjectId(oid)) shallowIn.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // thin-pack / no-progress / ofs-delta / filter / done / agent / object-format: ignored.
  }
  return { wants, haves, shallowIn, depth };
}

async function serveFetch(repo: Repo, args: FetchArgs, version: 2 | 0): Promise<GitHttpResult> {
  const { pack, shallow, unshallow } = await fetchPack(repo, args.wants, args.haves, args.shallowIn, args.depth);
  if (version === 0) {
    // v0: NAK/ACK + shallow/unshallow text lines, then the sideband pack.
    const parts: Buffer[] = [];
    const acks = args.haves.filter((have) => repo.objects.has(have));
    if (acks.length === 0) parts.push(encodePktLine('NAK\n'));
    else for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(frameSideband(1, pack));
    parts.push(pktLineFlush());
    return gitResult(200, UPLOAD_RESULT, Buffer.concat(parts));
  }
  // v2: acknowledgments / shallow-info / wanted-refs / packfile sections.
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  const acks = args.haves.filter((have) => repo.objects.has(have));
  if (acks.length === 0) {
    parts.push(encodePktLine('NAK\n'));
  } else {
    for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    parts.push(encodePktLine('ready\n'));
  }
  parts.push(pktLineDelim());
  parts.push(encodePktLine('shallow-info\n'));
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(pktLineDelim());
  parts.push(encodePktLine('wanted-refs\n'));
  for (const want of args.wants) {
    for (const name of sortedRefNames(repo)) {
      if (repo.refs.get(name) === want) parts.push(encodePktLine(`${want} ${name}\n`));
    }
  }
  parts.push(pktLineDelim());
  parts.push(encodePktLine('packfile\n'));
  parts.push(frameSideband(1, pack));
  parts.push(pktLineFlush());
  return gitResult(200, UPLOAD_RESULT, Buffer.concat(parts));
}

async function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): Promise<GitHttpResult> {
  if (body.length === 0) return jsonError(400, 'empty upload-pack request');
  let packets: GitPacket[];
  try {
    packets = decodePktLines(body).packets;
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : 'malformed pkt-line stream');
  }
  const lines = packetsToLines(packets);
  const commandLine = (lines[0] ?? '').replace(/\n$/, '');
  if (isV2) {
    if (commandLine === 'command=ls-refs') return handleLsRefs(repo, parseLsRefsArgs(lines.slice(1)));
    if (commandLine === 'command=fetch') return serveFetch(repo, parseFetchArgs(lines.slice(1)), 2);
    return jsonError(400, `unknown v2 command ${JSON.stringify(commandLine)}`);
  }
  const args = parseFetchArgs(lines);
  if (args.wants.length === 0) return jsonError(400, 'v0 fetch names no wanted object');
  return serveFetch(repo, args, 0);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0 only): parse the pushed pack, store objects, fast-forward only
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function parsePushCommands(lines: readonly string[]): PushCommand[] | null {
  const commands: PushCommand[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === '') continue;
    const withoutCaps = line.split('\0')[0] as string;
    const parts = withoutCaps.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) return null;
    if (!ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
  }
  return commands;
}

function reportResult(reportLines: readonly string[]): GitHttpResult {
  // report-status is itself a pkt-line stream inside sideband band 1; `unpack ok` first.
  const report = encodePktLines([...reportLines.map((line) => `${line}\n`), 'flush']);
  return gitResult(200, RECEIVE_RESULT, frameSideband(1, report));
}

async function handleReceivePack(repo: Repo, body: Buffer): Promise<GitHttpResult> {
  if (body.length === 0) return jsonError(400, 'empty receive-pack request');
  let packets: GitPacket[];
  let packBytes: Buffer;
  try {
    const decoded = decodePktLines(body, { stopAtFlush: true });
    packets = decoded.packets;
    packBytes = decoded.rest;
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : 'malformed pkt-line stream');
  }
  if (!packets.some((packet) => packet.kind === 'flush')) {
    return jsonError(400, 'receive-pack command list has no terminating flush');
  }
  const commands = parsePushCommands(packetsToLines(packets));
  if (commands === null || commands.length === 0) {
    return jsonError(400, 'receive-pack command list is malformed');
  }
  // Unpack first: a bad pack fails the whole push with `unpack error` and no ref moves.
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      if (!read.checksumOk) {
        return reportResult([`unpack error pack trailer ${read.trailer} does not match its bytes ${read.computedTrailer}`]);
      }
      let storedNew = false;
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) storedNew = true;
        store.putObject(repo, oid, object.type, object.data);
      }
      if (storedNew) store.invalidatePackCache(repo);
    } catch (err) {
      return reportResult([`unpack error ${err instanceof Error ? err.message : 'pack did not parse'}`]);
    }
  }
  // Per-ref decisions, in command order. Fast-forward only.
  const reportLines: string[] = ['unpack ok'];
  let refMoved = false;
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} no such ref`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.delete(command.ref);
        refMoved = true;
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (!newObject) {
      reportLines.push(`ng ${command.ref} missing object`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        refMoved = true;
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
    } else if (command.newOid === current) {
      reportLines.push(`ok ${command.ref}`);
    } else if (command.ref.startsWith('refs/tags/')) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
    } else if (!isAncestor(repo, current, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
    } else {
      repo.refs.set(command.ref, command.newOid);
      refMoved = true;
      reportLines.push(`ok ${command.ref}`);
    }
  }
  if (refMoved) store.invalidatePackCache(repo);
  return reportResult(reportLines);
}

// ---------------------------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------------------------

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

/**
 * Handle one git smart-HTTP request, or return null when the path is not a
 * git route. `body` is the full request body. Never throws.
 */
export async function handleGitRequest(req: GitRequestLike, body: Buffer): Promise<GitHttpResult | null> {
  let pathname: string;
  let serviceParam: string | null;
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    serviceParam = url.searchParams.get('service');
  } catch {
    return null;
  }
  const match = GIT_PATH.exec(pathname);
  if (!match) return null;
  const owner = match[1] as string;
  const repoName = match[2] as string;
  const rest = match[3] ?? '';
  const method = (req.method ?? 'GET').toUpperCase();
  const isInfoRefs = method === 'GET' && rest === '/info/refs';
  const isUpload = method === 'POST' && rest === '/git-upload-pack';
  const isReceive = method === 'POST' && rest === '/git-receive-pack';
  if (!isInfoRefs && !isUpload && !isReceive) return null;
  try {
    if (!isGitAuthorized(req.headers)) return jsonError(401, 'Requires authentication');
    if (owner !== VIEWER_LOGIN) return jsonError(404, 'Not Found');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return jsonError(404, 'Not Found');
    if (isInfoRefs) {
      const isV2 = headerValue(req.headers, 'git-protocol') === 'version=2';
      return handleInfoRefs(repo, serviceParam ?? '', isV2);
    }
    const isV2 = headerValue(req.headers, 'git-protocol') === 'version=2';
    if (isUpload) return handleUploadPack(repo, body, isV2);
    return handleReceivePack(repo, body);
  } catch (err) {
    // A malformed git request must never take the server down.
    return jsonError(400, err instanceof Error ? err.message : 'Bad Request');
  }
}
