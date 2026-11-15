// Squash merge + the small git-object primitives REST needs.
//
// lib/git-objects.ts (written in parallel by another agent) is the full
// object layer; this module must NOT depend on it, so the pieces REST and
// merge need live here, implemented directly on node:crypto SHA-1:
//   - object ids: SHA-1 of `<type> <len>\0` + raw bytes (exact git format)
//   - blob / tree / commit encode + parse
//   - flatten a tree to path -> blob, rebuild nested trees from a flat map
//   - merge-base (nearest common commit), 3-way tree merge, conflict detection
//   - diff of two trees -> PullFile[] (added/modified/removed + line counts)
//
// Everything works on one Repo's in-memory object map (repo.objects); no
// Store instance is needed here, so there is no import cycle with store.ts.

import { createHash } from 'node:crypto';
import type { PullFile, Repo } from './store.ts';

/** Minimal clock shape: one monotonic ISO timestamp per call (store.clock). */
export interface ClockLike {
  nowIso(): string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface FlatEntry {
  oid: string;
  mode: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** SHA-1 object id for raw `data` of git `type` (header `<type> <len>\0`). */
export function oidFor(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object if absent (same rule as Store.putObject). */
export function putObject(repo: Repo, oid: string, type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): void {
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
}

/** Store a blob, return its oid. */
export function putBlob(repo: Repo, content: Buffer): string {
  const oid = oidFor('blob', content);
  putObject(repo, oid, 'blob', content);
  return oid;
}

/** Encode tree entries (already sorted) to raw tree bytes. */
export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse raw tree bytes into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const mode = data.subarray(i, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Parse raw commit bytes. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** The tree oid of a commit object, or null. */
export function treeOidOfCommit(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const tree = parseCommit(obj.data).tree;
  return tree === '' ? null : tree;
}

/** Commit message of a commit object, or ''. */
export function commitMessageOf(repo: Repo, commitOid: string): string {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return '';
  return parseCommit(obj.data).message;
}

/**
 * Flatten a tree (recursively) to path -> {oid, mode} for blob entries only.
 * A null tree oid flattens to an empty map (unborn / empty tree).
 */
export function flattenTree(repo: Repo, treeOid: string | null): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  if (treeOid === null) return out;
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Git tree sort key: directory names sort as if they ended with '/'. */
function treeSortKey(name: string, isDir: boolean): string {
  return isDir ? `${name}/` : name;
}

interface DirNode {
  files: Map<string, FlatEntry>;
  dirs: Map<string, DirNode>;
}

function buildNode(repo: Repo, node: DirNode): string {
  const entries: TreeEntry[] = [];
  for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
  for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: buildNode(repo, dir) });
  entries.sort((a, b) => {
    const ka = treeSortKey(a.name, a.mode === '40000');
    const kb = treeSortKey(b.name, b.mode === '40000');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const data = encodeTree(entries);
  const oid = oidFor('tree', data);
  putObject(repo, oid, 'tree', data);
  return oid;
}

/**
 * Build (and store) the nested trees for a flat path -> blob map.
 * Returns the root tree oid; the empty map yields the well-known empty tree.
 */
export function buildTreeFromMap(repo: Repo, flat: ReadonlyMap<string, FlatEntry>): string {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  return buildNode(repo, root);
}

/**
 * Build + store a commit object. The timestamp comes from the monotonic
 * clock (deterministic across live/replay), never the wall clock.
 */
export function createCommit(
  repo: Repo,
  opts: { tree: string; parents: readonly string[]; message: string; clock: ClockLike },
): string {
  const epoch = Math.floor(Date.parse(opts.clock.nowIso()) / 1000);
  const ident = `forge <forge@localhost> ${epoch} +0000`;
  let text = `tree ${opts.tree}\n`;
  for (const parent of opts.parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${opts.message}`;
  const data = Buffer.from(text, 'utf8');
  const oid = oidFor('commit', data);
  putObject(repo, oid, 'commit', data);
  return oid;
}

/**
 * Resolve a ref to a commit oid: a branch name, a full ref name, a raw
 * commit oid, or an annotated tag pointing at a commit. Null when unknown.
 */
export function resolveCommit(repo: Repo, ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined || ref === '') return null;
  const headRef = repo.refs.get(`refs/heads/${ref}`);
  if (headRef !== undefined) return headRef;
  const fullRef = repo.refs.get(ref);
  if (fullRef !== undefined) return fullRef;
  const obj = repo.objects.get(ref);
  if (obj === undefined) return null;
  if (obj.type === 'commit') return ref;
  if (obj.type === 'tag') {
    const text = obj.data.toString('utf8');
    const match = /^object ([0-9a-f]{40})$/m.exec(text);
    if (match !== null) {
      const target = match[1] as string;
      const targetObj = repo.objects.get(target);
      if (targetObj !== undefined && targetObj.type === 'commit') return target;
    }
  }
  return null;
}

/** History walk from a tip, newest first (first-parent-first DFS), deduped. */
export function listCommits(repo: Repo, tipOid: string, limit = 30): { sha: string; message: string; tree: string; parents: string[] }[] {
  const out: { sha: string; message: string; tree: string; parents: string[] }[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tipOid];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    out.push({ sha: oid, message: parsed.message, tree: parsed.tree, parents: parsed.parents });
    for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i] as string);
  }
  return out;
}

/** All ancestors of a commit with their BFS distance from it. */
function ancestorDistances(repo: Repo, start: string): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  const queue: string[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head] as string;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    for (const parent of parents) {
      if (!dist.has(parent)) {
        dist.set(parent, (dist.get(oid) as number) + 1);
        queue.push(parent);
      }
    }
  }
  return dist;
}

/**
 * Nearest common ancestor of two commits: the common commit minimising
 * (distance from a + distance from b), ties broken by the smaller max.
 * Null when the histories share nothing.
 */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const distA = ancestorDistances(repo, a);
  const distB = ancestorDistances(repo, b);
  let best: string | null = null;
  let bestSum = Infinity;
  let bestMax = Infinity;
  for (const [oid, da] of distA) {
    const db = distB.get(oid);
    if (db === undefined) continue;
    const sum = da + db;
    const max = Math.max(da, db);
    if (sum < bestSum || (sum === bestSum && max < bestMax)) {
      best = oid;
      bestSum = sum;
      bestMax = max;
    }
  }
  return best;
}

function blobText(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (obj === undefined) return '';
  return obj.data.toString('utf8');
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function countLines(text: string): number {
  return splitLines(text).length;
}

/** Line additions/deletions between two blob texts (LCS; multiset fallback for huge files). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length * b.length > 250_000) {
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of b) {
      const c = counts.get(line) ?? 0;
      if (c > 0) {
        counts.set(line, c - 1);
        common += 1;
      }
    }
    return { additions: b.length - common, deletions: a.length - common };
  }
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, cur[j - 1] as number);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const lcs = prev[b.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

/**
 * Diff two trees (base vs head) into the pull-files shape. Oids may be null
 * (empty tree). Sorted by filename for deterministic output.
 */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): PullFile[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const out: PullFile[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const deletions = countLines(blobText(repo, b.oid));
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b === undefined && h !== undefined) {
      const additions = countLines(blobText(repo, h.oid));
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const d = lineDiff(blobText(repo, b.oid), blobText(repo, h.oid));
      out.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  return out;
}

export type SquashMergeResult =
  | { ok: true; sha: string }
  | { ok: false; conflict: true; message: string };

/**
 * Squash-merge a head commit onto the CURRENT tip of the base branch.
 * 3-way merge: base = merge-base(head, baseTip), ours = baseTip tree,
 * theirs = head tree. A path changed differently on both sides (including
 * delete-vs-modify) is a conflict. On success writes a real squash commit
 * object (single parent = baseTip), moves refs/heads/<baseRef> to it and
 * clears the repo's pack cache.
 */
export function squashMerge(
  repo: Repo,
  opts: { headSha: string; baseTipSha: string; baseRef: string; title: string; number: number; clock: ClockLike },
): SquashMergeResult {
  const baseCommit = mergeBase(repo, opts.headSha, opts.baseTipSha);
  const baseTree = baseCommit === null ? null : treeOidOfCommit(repo, baseCommit);
  const oursTree = treeOidOfCommit(repo, opts.baseTipSha);
  const theirsTree = treeOidOfCommit(repo, opts.headSha);
  const base = flattenTree(repo, baseTree);
  const ours = flattenTree(repo, oursTree);
  const theirs = flattenTree(repo, theirsTree);

  const merged = new Map<string, FlatEntry>(ours);
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path)?.oid ?? null;
    const o = ours.get(path)?.oid ?? null;
    const t = theirs.get(path)?.oid ?? null;
    if (o === t) continue; // identical on both sides (or absent on both)
    if (b === o) {
      // Only theirs changed: take theirs (null = deleted on theirs).
      if (t === null) merged.delete(path);
      else merged.set(path, theirs.get(path) as FlatEntry);
      continue;
    }
    if (b === t) continue; // only ours changed: keep ours
    conflicts.push(path); // both changed differently (incl. delete vs modify)
  }
  if (conflicts.length > 0) {
    conflicts.sort();
    return { ok: false, conflict: true, message: `Merge conflict in ${conflicts.join(', ')}` };
  }
  const tree = buildTreeFromMap(repo, merged);
  const sha = createCommit(repo, {
    tree,
    parents: [opts.baseTipSha],
    message: `Squash merge #${opts.number}: ${opts.title}`,
    clock: opts.clock,
  });
  repo.refs.set(`refs/heads/${opts.baseRef}`, sha);
  repo.packCache.clear();
  return { ok: true, sha };
}
