// In-memory store shared by every surface (git / REST / GraphQL / MCP).
//
// One store per trial, fresh per process. No disk, no fsync. All lookups are
// Map-based (O(1)) — the read/write perf workloads are pure in-memory work
// plus HTTP overhead, so the store itself must add no per-request cost.
//
// A repo holds ONE object store shared by git and REST: a REST contents commit
// is a real git commit object (same SHA-1 a clone would compute), so
// GET /commits and a clone of the same repo agree. A PR squash merge writes a
// real squash commit object and moves the default-branch ref — visible to git
// fetch and REST alike.
//
// Determinism: issue/PR numbers increment per repo; global ids are
// deterministic (util.globalId); timestamps come from the monotonic clock.

import { MonoClock, globalId } from './util.ts';

export type Oid = string;
export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  /** Raw object bytes WITHOUT the `type size\0` header (the header is added when hashing/serializing). */
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: string;
  body: string;
  userLogin: string;
  seq: number;
  createdAt: string;
}

export interface Issue {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeCommitSha: string | null;
  files: PullFile[];
  seq: number;
  createdAt: string;
}

export interface Repo {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  id: string;
  /** Loose objects keyed by SHA-1 hex. */
  objects: Map<Oid, GitObject>;
  /** Full ref name (refs/heads/main, refs/tags/v1) -> tip oid. */
  refs: Map<string, Oid>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, Pull>;
  nextPull: number;
  /**
   * Pack cache: key `${tipOid}:${depth}` (depth 0 = full) -> built pack bytes.
   * The clone workload builds the same 200-commit depth-1 pack 50x concurrently;
   * one build serves all 50. Invalidated on any ref move in this repo.
   * Capped (LRU-ish, 64 entries) so the 120 checks' repos cannot grow it unbounded.
   */
  packCache: Map<string, Buffer>;
}

export class Store {
  readonly clock = new MonoClock();
  /** key `owner/name` */
  readonly repos = new Map<string, Repo>();

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      id: globalId('repo', owner, name),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextIssue: 1,
      pulls: new Map(),
      nextPull: 1,
      packCache: new Map(),
    };
    this.repos.set(Store.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.repoKey(owner, name));
  }

  /** All repos owned by `owner`, in creation order. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  /** Any ref move invalidates the repo's pack cache. */
  invalidatePackCache(repo: Repo): void {
    repo.packCache.clear();
  }

  /** Store a git object (idempotent: same oid wins). */
  putObject(repo: Repo, oid: Oid, type: GitObjectType, data: Buffer): void {
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[], userLogin: string): Issue {
    const number = repo.nextIssue;
    repo.nextIssue += 1;
    const now = this.clock.nowIso();
    const issue: Issue = {
      number,
      id: globalId('issue', repo.owner, repo.name, number),
      title,
      body,
      state: 'open',
      labels: [...labels],
      userLogin,
      seq: this.clock.nextSeq(),
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createComment(issue: Issue, body: string, userLogin: string): Comment {
    const comment: Comment = {
      id: globalId('comment', issue.id, issue.comments.length + 1),
      body,
      userLogin,
      seq: this.clock.nextSeq(),
      createdAt: this.clock.nowIso(),
    };
    issue.comments.push(comment);
    return comment;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    headSha: string,
    baseRef: string,
    baseSha: string,
    files: PullFile[],
  ): Pull {
    const number = repo.nextPull;
    repo.nextPull += 1;
    const pull: Pull = {
      number,
      id: globalId('pull', repo.owner, repo.name, number),
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      headSha,
      baseRef,
      baseSha,
      mergeCommitSha: null,
      files,
      seq: this.clock.nextSeq(),
      createdAt: this.clock.nowIso(),
    };
    repo.pulls.set(number, pull);
    return pull;
  }
}

/** The trial's one store. */
export const store = new Store();
