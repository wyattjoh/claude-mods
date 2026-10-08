# claude-mods

Claude Code mods (function-hook plugins), published as a marketplace.

## multi-skill

Claude Code only expands the slash command a prompt starts with. A second `/skill` later in the prompt stays plain text, and a skill marked `disable-model-invocation: true` can't be loaded by the model, so one prompt gets at most one user-only skill.

With multi-skill on, every `/skill` on the **first line** of a prompt is treated as if you invoked it:

- Each skill not yet loaded this session is added before your prompt as a hidden row, in the same shape the engine uses for a typed `/skill` (`<command-name>` row, then `Base directory for this skill: …` and the body).
- A short hidden note tells the model which first-line names refer to those skills. Your prompt is sent exactly as typed.
- Skills already loaded this session (typed, via the Skill tool, or by this mod) aren't loaded again. The list resets on `/clear` and after compaction.
- A dim line drawn under your prompt in the chat lists what the turn activated, e.g. `multi-skill: /alpha (leading), /beta · already loaded: /gamma · not found: /ghost`. It is part of how the prompt row is drawn, so it stays with that prompt as you scroll and after a resume; the model never sees it.
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

The extra skills get their text loaded, not the rest of the engine's skill handling: no `` !`cmd` `` shell injection, no `allowed-tools`, `model` or `effort` overrides, and `$ARGUMENTS` is empty. Only the leading `/skill` gets all of that, so put a skill that relies on any of it first. multi-skill flags these as you type: the skill is underlined in the draft and the band says `/x uses model, allowed-tools: put it first`; on submit a toast lists any that still loaded as text only. Skills preloaded into a subagent also count as loaded for the main session.

## Development

Each mod is a folder with `.claude-plugin/plugin.json`, `hooks/hooks.json`, and a hooks module.

```
claude plugin validate <mod>
claude plugin test <mod>
```
