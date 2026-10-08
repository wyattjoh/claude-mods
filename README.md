# claude-mods

Claude Code mods (function-hook plugins), published as a marketplace.

## multi-skill

Claude Code only expands the slash command a prompt starts with. A second `/skill` later in the prompt stays plain text, and a skill marked `disable-model-invocation: true` can't be loaded by the model, so one prompt gets at most one user-only skill.

With multi-skill on, every `/skill` on the **first line** of a prompt is treated as if you invoked it:

- Each skill not yet loaded this session is added before your prompt as a hidden row, in the same shape the engine uses for a typed `/skill` (`<command-name>` row, then `Base directory for this skill: …` and the body).
- A short hidden note tells the model which first-line names refer to those skills. Your prompt is sent exactly as typed.
- Skills already loaded this session (typed, via the Skill tool, or by this mod) aren't loaded again. The list resets on `/clear` and after compaction.
- While you type, matched skills on the first line are highlighted (green: will load, dim: already loaded, yellow: no SKILL.md found) and listed in a band above the prompt.

### Install

```
/plugin install multi-skill --marketplace wyattjoh/claude-mods
```

Or run it from a checkout: `claude --plugin-dir ./multi-skill`.

### Use

It's off until you turn it on for the session:

```
/multi-skill on       # or off, status; no argument toggles
```

Settings (in `/config`, or `pluginConfigs` in settings):

| Option | Default | Effect |
| --- | --- | --- |
| `enabledByDefault` | `false` | Start every session with multi-skill on |
| `haikuNote` | `false` | Have Haiku write the hidden note, tying each skill to your request; falls back to the fixed note if Haiku fails or takes more than 8s |

### Where skills are found

- Plain names: `.claude/skills/<n>/SKILL.md` and `.claude/commands/<n>.md` in the working directory and each parent up to the git root (the working directory alone outside a repo), then `~/.claude/skills`, `~/.claude/commands`, then any `~/.claude/skills/*/SKILL.md` whose frontmatter `name` matches.
- Directory-scoped `a/b:n`: `<cwd>/a/b/.claude/skills/<n>`, and `commands/a/b/n.md`-style command folders.
- Plugin `p:n`: the plugin's root from `installed_plugins.json`, `CLAUDE_CODE_PLUGIN_DIRS`, the session's `--plugin-dir` flags, or the session's dev-mods folder; then `skills/<n>/SKILL.md`, the manifest's `skills` dirs, or `commands/<n>.md`.

A plugin root only counts when its `.claude-plugin/plugin.json` names that plugin.

Only prompts you send count (typed, Remote Control, or `claude -p`/SDK). Messages from peer sessions, MCP channels, task notifications, and scheduled tasks never load skills.

### Limits

The extra skills get their text loaded, not the rest of the engine's skill handling: no `` !`cmd` `` shell injection, no `allowed-tools`, `model` or `effort` overrides, and `$ARGUMENTS` is empty. Skills preloaded into a subagent also count as loaded for the main session.

## cache-timer

Shows how long the main conversation's prompt cache entry stays warm, so you know whether your next prompt reads the cache or pays to write it again.

The countdown starts when each main-thread model request is sent, since the API measures an entry's lifetime from the start of the request that read or wrote it. Subagent requests have caches of their own and don't count. A request that cached nothing shows `no cache`. Once the TTL has passed it shows `likely expired`: the API deletes entries promptly, not instantly. `/clear` and compaction reset it until the next request.

### Install

```
/plugin install cache-timer --marketplace wyattjoh/claude-mods
```

Or run it from a checkout: `claude --plugin-dir ./cache-timer`.

### Use

`/cache-timer` with no argument opens a settings pane. Its buttons toggle each surface and pick the TTL. Arguments do the same from the prompt:

```
/cache-timer all                 # every surface at once, to compare
/cache-timer only hint,band      # just these
/cache-timer on toast            # add one; off and toggle work the same
/cache-timer ttl 1h              # auto (default), 5m or 1h
/cache-timer status
```

Choices are saved across sessions. The default is `status`.

| Surface | Where |
| --- | --- |
| `status` | the plugin status line under the prompt |
| `band` | a row above the prompt; it takes the band from other mods while on |
| `hint` | appended to the dim hint line under the prompt (terminal only) |
| `mode` | a label among the footer's mode labels |
| `spinner` | after the spinner word; only shows while a turn runs, when the cache is fresh anyway |
| `duration` | the `Baked for 3s` line closing each turn, with the time the cache stays warm until |
| `pane` | the settings pane, opened with each session (it needs 144 columns when nobody asked for it) |
| `toast` | a toast a minute before expiry and one on expiry |

### TTL

Claude Code's main conversation uses a 1h TTL on a subscription within its included usage and 5m otherwise, and settings or env vars can change that. Under `auto` the mod reads the TTL of the last cache write from the transcript after each turn. Before the first write it falls back to `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL` or `ENABLE_PROMPT_CACHING_1H`, then to 5m. Set `ttl 5m` or `ttl 1h` to fix it.

## Development

Each mod is a folder with `.claude-plugin/plugin.json`, `hooks/hooks.json`, and a hooks module.

```
claude plugin validate <mod>
claude plugin test <mod>
```
