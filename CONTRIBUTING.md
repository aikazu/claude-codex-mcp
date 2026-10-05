# Contributing

Thanks for helping out!

1. Fork and create a branch.
2. `npm install` (dev tooling only), then make your change.
3. `npm test` and `npm run lint` must pass. Add or update tests in `test/` —
   they run against `test/fixtures/fake-codex.mjs`, so no Codex account is needed.
4. Keep the runtime dependency-free and shell-free.
5. Open a pull request describing the change and how you verified it.
   For behaviour that depends on the real Codex CLI, mention the Codex version
   and OS you tested with.
