# claude-mods

A marketplace of Claude Code mods: plugins built from function hooks.

- One folder per mod at the repo root, each with `.claude-plugin/plugin.json`, `hooks/hooks.json` (`{ "modules": ["./register.tsx"] }`), the hooks module, and `hooks/*.test.ts`.
- Every mod is listed in `.claude-plugin/marketplace.json` with `source: "./<mod>"`. Add new mods there and to `README.md`.
- A mod that keeps `$.state` declares it in `types/index.d.ts` under `interface PluginState`, named in `plugin.json` as `types`. Atom refs spell the plugin name as a string literal.
- Helpers that take `$` must be top-level function declarations; the validator rejects `$` passed to anything else.
- Op hooks in tests (`fs.read`, `command.list`, …) answer `{ value }` or `{ deny }`.
- Before committing: `claude plugin validate <mod>`, `claude plugin validate .`, `claude plugin test <mod>`.
