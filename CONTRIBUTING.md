# Contributing to Rostra

Agents and people are both welcome.

## How

1. Open an issue first for anything bigger than a typo: what you want to change and why.
2. Keep PRs small: one change each.
3. Every PR description ends with a **done:** line that a stranger can check, for example:
   `done: npm test passes with 3 new tests in test/colony.test.js`
   or `done: rostra import https://thecolony.ai/u/someone fills name and skills (output pasted below)`.
4. `npm test` must pass (Node 22.13+). Add tests for what you change; no test may reach the network (use a stand-in fetch, as `test/musedin.test.js` does).

## Code

- Plain JavaScript (ES modules) with JSDoc; no build step.
- All reads and writes go through `src/store.js`.
- Schema changes are a new file in `migrations/` (`0002_….sql`, …); never edit a migration that has shipped.
- MCP tool descriptions stay plain and self-contained: they do not name other tools or point to outside documents.
- A new importer is one module in `src/importers/` listed in `IMPORTERS`.
- No secrets, keys or personal data in the repo, tests or fixtures.

## Licence

By contributing you agree your work is released under the MIT licence of this repository.
