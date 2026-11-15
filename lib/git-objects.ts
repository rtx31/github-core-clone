// Git object model: SHA-1 ids, exact git byte formats, reachability, ancestry.
//
// Object data is stored WITHOUT the `<type> <size>\0` header (see lib/store.ts);
// the header is added only when hashing or serializing. Every builder here
// produces byte-identical output to the suite client's builders
// (kit program/env/src/git-client.ts), so hashes recompute to ids.
//
// Erasable TypeScript only (node --experimental-strip-types): no enums,
// no parameter properties, no namespaces.

import { createHash } from 'node:crypto';
import type { GitObjectType, Repo } from './store.ts';

export type { GitObjectType };

export const ZERO_OID = '0'.repeat(40);

const HEX40 = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id. */
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** The loose-object header `<type> <size>\0`. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(objectHeader(type, data.length));
  hash.update(data);
  return hash.digest('hex');
}

/** Full loose-object bytes (header + content). */
export function encodeLooseObject(type: GitObjectType, data: Buffer): Buffer {
  return Buffer.concat([objectHeader(type, data.length), data]);
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeEntries(
  a: { name: string; mode: string },
  b: { name: string; mode: string },
): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  /** Headers before the blank line that are not tree/parent/author/committer. */
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  /** Unix seconds. Callers pass a fixed constant, never Date.now(). */
  readonly timestamp?: number;
  /** `+0000` by default, so two runs produce the same bytes. */
  readonly timezone?: string;
}

/** The default identity every generated commit and tag carries. */
export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';

/** Build a commit object's bytes (identical layout to the suite client's buildCommit). */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new Error('buildCommit needs a valid tree id');
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const author = `${fields.author ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Parse a commit object; refuses a malformed header layout. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) {
    if (!isObjectId(parent)) throw new Error('commit has a bad parent id');
  }
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

// ---------------------------------------------------------------------------------------------
// annotated tags
// ---------------------------------------------------------------------------------------------

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export interface BuildTagFields {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly message: string;
  readonly tagger?: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

/** Build an annotated tag object's bytes (identical layout to the suite client's buildTag). */
export function buildTag(fields: BuildTagFields): Buffer {
  if (!isObjectId(fields.object)) throw new Error('buildTag needs a valid object id');
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------------------------
// deltas (defensive: the suite client never sends them, the pack reader resolves them anyway)
// ---------------------------------------------------------------------------------------------

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// reachability and ancestry over a repo's object store
// ---------------------------------------------------------------------------------------------

export interface ReachableOptions {
  /** Skip missing objects instead of throwing (used when probing a partial store). */
  readonly allowMissing?: boolean;
}

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries
 * (gitlinks skipped), tag -> its target, blob -> nothing. Throws on a missing
 * object unless `allowMissing` is set.
 */
export function collectReachable(
  repo: Repo,
  roots: Iterable<string>,
  options: ReachableOptions = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue; // gitlink: names a commit the repo does not hold
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * Follow annotated tags to their ultimate target. Returns null when the chain
 * is broken or cyclic. The returned oid is the target object itself.
 */
export function peelToTarget(repo: Repo, oid: string): string | null {
  const seen = new Set<string>();
  let current = oid;
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
}

/** Peel tags until a commit is reached; null when the target is not a commit. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  const target = peelToTarget(repo, oid);
  if (target === null) return null;
  const object = repo.objects.get(target);
  return object && object.type === 'commit' ? target : null;
}

/** True when `ancestor` is reachable from `descendant` by following parents. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const start = peelToCommit(repo, descendant);
  if (start === null) return false;
  const target = peelToCommit(repo, ancestor) ?? ancestor;
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === target) return true;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/**
 * The merge-base of two commits: a common ancestor minimising
 * (distance from A + distance from B), tie-broken by the smaller maximum
 * distance, then by oid for determinism. Null when there is no common
 * ancestor (unrelated histories) or either side is missing.
 */
export function findMergeBase(repo: Repo, shaA: string, shaB: string): string | null {
  const a = peelToCommit(repo, shaA);
  const b = peelToCommit(repo, shaB);
  if (a === null || b === null) return null;
  if (a === b) return a;

  const distA = new Map<string, number>();
  const queueA: string[] = [a];
  distA.set(a, 0);
  for (let head = 0; head < queueA.length; head += 1) {
    const oid = queueA[head] as string;
    const depth = distA.get(oid) as number;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!distA.has(parent)) {
        distA.set(parent, depth + 1);
        queueA.push(parent);
      }
    }
  }

  const distB = new Map<string, number>();
  const queueB: string[] = [b];
  distB.set(b, 0);
  let best: string | null = null;
  let bestSum = Infinity;
  let bestMax = Infinity;
  for (let head = 0; head < queueB.length; head += 1) {
    const oid = queueB[head] as string;
    const depth = distB.get(oid) as number;
    // A BFS from B visits in non-decreasing distance; once depth alone exceeds
    // the best sum found, no later node can beat it.
    if (depth > bestSum) break;
    const da = distA.get(oid);
    if (da !== undefined) {
      const sum = da + depth;
      const max = Math.max(da, depth);
      if (sum < bestSum || (sum === bestSum && (max < bestMax || (max === bestMax && (best === null || oid < best))))) {
        best = oid;
        bestSum = sum;
        bestMax = max;
      }
    }
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!distB.has(parent)) {
        distB.set(parent, depth + 1);
        queueB.push(parent);
      }
    }
  }
  return best;
}
