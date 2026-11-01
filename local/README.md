# EarlyProof localhost harness

Test the real app (real SQLite, real action handlers, stub Muse) on your machine.

```sh
sh local/setup.sh            # one-time: npm deps (stub links @hatch/space-sdk)
bun local/build-client.ts    # build the client into local/dist
bun local/server.ts          # serve → http://localhost:3107 (PORT=3213 to override)
bun local/smoke.ts           # in-process checks, no port needed
bun run typecheck             # tsc client + server
```

Notes:

- `local/data/app.db` is yours (gitignored via `*.db`). Delete it to reset.
- Muse calls are answered by `local/inference-stub.ts` (`[local-stub]` tagged).
  Rule-gate results are real; stub verdicts are deliberately boring.
- `Bun.serve` needs a free port; if the sandbox/browser can't reach it, use
  `bun local/smoke.ts` for in-process verification instead.
- The stub SDK in `local/stubs/space-sdk` mirrors only the surface the repo
  uses. If server/client imports a new SDK symbol, add it to the stub.
