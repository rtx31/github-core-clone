// Deterministic helpers shared by every surface.
//
// The suite's checks name the token's owner from the env's one seeded scenario
// (program/env/src/wire.ts): SCENARIO_SEED is a FIXED constant, the viewer is
// users[0] of generateUsers(scenarioRng('users'), 12). The bearer token in a
// trial is `shpat_` + random hex and encodes nothing, so the ONLY way the
// entry can know its own login is to recompute the scenario. This module
// vendors that computation (FNV-1a + splitmix64 finalizer + xorshift64*,
// verified against wire.ts: viewer = adaiversen, stranger = olgabauer).
//
// Determinism rules (spec §1): no wall clock — timestamps come from
// MAKEFUN_TRIAL_NOW plus a monotonic sequence counter (fixed epoch fallback
// for local runs); no unseeded randomness — ids and request ids come from
// counters and stable encodings.

const U64_MASK = 0xffffffffffffffffn;

/** FNV-1a, 64-bit (wire.ts). */
export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer (wire.ts mix64). */
export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The contest's fixed scenario seed (wire.ts SCENARIO_SEED). */
export const SCENARIO_SEED = 0x6a09e667f3bcc909n;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** xorshift64* (wire.ts Rng), only the methods the scenario needs. */
export class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

/** The seed a named stream starts from (wire.ts scenarioSeedFor). */
export function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/**
 * The scenario's users, in order (wire.ts generateUsers with SCENARIO_USERS=12).
 * users[0] is the viewer (the token's owner), users[1] the teammate,
 * users[2] the stranger (owns repos the token must NOT see).
 */
export function scenarioUsers(): string[] {
  const rng = new ScenarioRng(scenarioSeedFor('users'));
  const used = new Set<string>();
  const users: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push(login);
  }
  return users;
}

const USERS = scenarioUsers();
/** The login the bearer token owns (GET /api/v3/user, GraphQL viewer). */
export const VIEWER_LOGIN = USERS[0] as string;
/** Another user's login; repos under it are 404 for this token. */
export const STRANGER_LOGIN = USERS[2] as string;

/** Opaque deterministic global id: base64url of `kind:part:part...`. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64url');
}

/**
 * Monotonic deterministic clock. Base is MAKEFUN_TRIAL_NOW when set
 * (milliseconds since epoch, or an ISO string), else the scenario epoch
 * 2025-01-01T00:00:00Z. Each call advances one second, so timestamps are
 * strictly increasing in request order and identical across live/replay.
 */
export class MonoClock {
  #baseMs: number;
  #seq = 0;
  constructor() {
    const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
    let base = Date.parse('2025-01-01T00:00:00Z');
    if (/^\d+$/.test(raw)) base = Number(raw);
    else if (raw !== '' && Number.isFinite(Date.parse(raw))) base = Date.parse(raw);
    this.#baseMs = base;
  }
  /** Next timestamp (ISO string), strictly increasing. */
  nowIso(): string {
    this.#seq += 1;
    return new Date(this.#baseMs + this.#seq * 1000).toISOString();
  }
  /** Next bare sequence number (for sort order / counters). */
  nextSeq(): number {
    this.#seq += 1;
    return this.#seq;
  }
}

/** Request-id counter: every reply carries a non-empty X-GitHub-Request-Id. */
export class RequestIdCounter {
  #n = 0;
  next(): string {
    this.#n += 1;
    return `req_${this.#n.toString(36)}`;
  }
}
