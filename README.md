# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/rtx31/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/rtx31/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in Node 22, stdlib only: git smart HTTP (protocol v2 upload-pack, v0 receive-pack), REST v3, GraphQL v4, and an MCP endpoint over one in-memory store. Built for [the contest](https://make.fun/bounty/github-core-clone-01) — a complete entry is scored on 120 conformance checks plus four timed workloads, and the prize goes to whoever beats the reference forge on speed.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own; the flag is harmless there and makes an older local Node work too. There is nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib` and its own modules only, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the HTTP router dispatching to the surfaces below.
- `lib/store.ts`: the one in-memory store (repos, git objects, refs, issues, PRs).
- `lib/util.ts`: deterministic ids, monotonic clock, and the scenario's viewer login.
- `lib/git-objects.ts`: SHA-1 object encode/decode, reachability, merge-base.
- `lib/pack.ts`: pack read/write (full objects; defensive delta apply).
- `lib/pktline.ts`: pkt-line encode/decode, sideband-64k framing.
- `lib/smart-http.ts`: git smart HTTP (upload-pack v2 + v0 fallback, receive-pack v0).
- `lib/rest.ts`: REST v3 routes.
- `lib/merge.ts`: squash merge (merge-base + 3-way tree merge + conflict detection).
- `lib/graphql.ts`: GraphQL v4 (hand-rolled parser for the suite's documents).
- `lib/mcp.ts`: MCP JSON-RPC 2.0, both revision eras, 6 tools.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4gvpf9bn&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
