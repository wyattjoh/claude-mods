import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, PromptDecoration, Register } from 'claude-code'

import type { ActivationNote, DraftSkill, SkillStatus } from '../types'

const NAME = 'multi-skill'

const enabledAtom = atom({ plugin: 'multi-skill', key: 'enabled' } as const, null)
const loadedAtom = atom({ plugin: 'multi-skill', key: 'loaded' } as const, [])
const draftAtom = atom({ plugin: 'multi-skill', key: 'draft' } as const, [])
const notesAtom = atom({ plugin: 'multi-skill', key: 'notes' } as const, [])

const NOTES_STORE_KEY = 'notes'
const MAX_NOTES = 200

// True while a prompt this mod noted is entering, so its stored row binds.
let isAwaitingRow = false

const CANDIDATE =
  /(^|\s)\/([A-Za-z0-9](?:[\w.-]*\w)?(?:\/\w(?:[\w.-]*\w)?)*(?::\w(?:[\w.-]*\w)?)?)(?=$|[\s.,;:!?)\]])/g

const USER_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

const STATUS_COLOR: Record<SkillStatus, 'success' | 'subtle' | 'warning'> = {
  new: 'success',
  loaded: 'subtle',
  unresolved: 'warning',
}

/**
 * A `/skill` token found on a prompt's first line.
 */
export type SkillMatch = {
  name: string
  start: number
  end: number
}

/**
 * A skill file found on disk: its directory, its body, and whether it is a
 * skill (SKILL.md) rather than a legacy command file.
 */
export type ResolvedSkill = {
  dir: string
  body: string
  description: string | undefined
  isSkill: boolean
  unsupported: string[]
}

/**
 * Finds every known `/name` on the first line of `text`, in order, each
 * name once. A slash must start the text or follow whitespace, and the name
 * must end at whitespace, punctuation or the line's end, so paths and URLs
 * never match.
 *
 * @param text the prompt or draft
 * @param known the names that are skills or commands in this session
 * @returns the matches with their offsets into `text`
 */
export function firstLineSkills(text: string, known: ReadonlySet<string>): SkillMatch[] {
  const line = text.split('\n', 1)[0] ?? ''
  const seen = new Set<string>()

  return [...line.matchAll(CANDIDATE)].flatMap(m => {
    const name = m[2] ?? ''
    if (!known.has(name) || seen.has(name)) {
      return []
    }
    seen.add(name)
    const start = (m.index ?? 0) + (m[1] ?? '').length

    return [{ name, start, end: start + 1 + name.length }]
  })
}

/**
 * Splits a markdown file into its YAML frontmatter (flat `key: value` lines
 * only) and its body.
 *
 * @param md the file's text
 * @returns the frontmatter fields and the body after it
 */
export function parseFrontmatter(md: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md)
  if (!match) {
    return { fields: {}, body: md }
  }
  const fields = Object.fromEntries(
    (match[1] ?? '').split(/\r?\n/).flatMap(line => {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line)
      if (!kv) {
        return []
      }

      return [[kv[1] ?? '', (kv[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')]]
    }),
  )

  return { fields, body: md.slice(match[0].length) }
}

/**
 * Lists what a skill relies on that only the engine's own invocation
 * honours, so it works fully only as the prompt's leading `/skill`.
 *
 * @param fields the skill's frontmatter
 * @param body the skill's body
 * @returns the features, in a fixed order; empty when it needs none
 */
export function unsupportedFeatures(fields: Readonly<Record<string, string>>, body: string): string[] {
  const checks: [string, boolean][] = [
    ['allowed-tools', Boolean(fields['allowed-tools']?.trim())],
    ['model', Boolean(fields.model?.trim())],
    ['effort', Boolean(fields.effort?.trim())],
    ['!`cmd`', /!`[^`\n]+`/.test(body)],
    ['arguments', /\$(ARGUMENTS|\d)/.test(body)],
  ]

  return checks.flatMap(([feature, isUsed]) => (isUsed ? [feature] : []))
}

/**
 * Renders a skill the way the engine does for a typed `/skill`: the base
 * directory line for a SKILL.md, then the body with its arguments filled.
 *
 * @param skill the resolved skill
 * @returns the text of the hidden user row the model reads
 */
export function expand(skill: ResolvedSkill): string {
  const body = skill.body
    .trimStart()
    .replaceAll('${CLAUDE_SKILL_DIR}', skill.dir)
    .replaceAll('$ARGUMENTS', '')

  return skill.isSkill ? `Base directory for this skill: ${skill.dir}\n\n${body}` : body
}

/**
 * The visible-command row the engine records before a skill's body.
 *
 * @param name the skill's name
 * @returns the row's text
 */
export function commandRow(name: string): string {
  return `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args></command-args>`
}

/**
 * The hidden note that ties the first line's slash names to the skills.
 *
 * @param names every skill named on the first line
 * @returns the note's text
 */
export function framingNote(names: readonly string[]): string {
  const list = names.map(n => `/${n}`).join(', ')

  return `The user's message names ${list} on its first line. Each is a skill the user invoked; its instructions are loaded in this conversation. Carry out every one of them as if the user had typed it as its own command, applied to the rest of the message.`
}

/**
 * What one prompt's first-line skills came to, for the transcript notice.
 */
export type Activation = {
  leading: string | undefined
  loaded: readonly string[]
  alreadyLoaded: readonly string[]
  missing: readonly string[]
  partial: readonly string[]
}

/**
 * The transcript notice listing the skills a prompt activated: shown under
 * the prompt, never read by the model.
 *
 * @param activation the prompt's skills, by outcome; `partial` entries are
 *   already formatted as `/name (features)`
 * @returns the notice's one line
 */
export function activationNotice(activation: Activation): string {
  const slashed = (names: readonly string[]) => names.map(n => `/${n}`).join(', ')
  const active = [
    ...(activation.leading === undefined ? [] : [`/${activation.leading} (leading)`]),
    ...activation.loaded.map(n => `/${n}`),
  ]
  const parts = [
    active.length > 0 ? active.join(', ') : 'nothing new loaded',
    ...(activation.alreadyLoaded.length > 0 ? [`already loaded: ${slashed(activation.alreadyLoaded)}`] : []),
    ...(activation.missing.length > 0 ? [`not found: ${slashed(activation.missing)}`] : []),
    ...(activation.partial.length > 0 ? [`text only: ${activation.partial.join('; ')}`] : []),
  ]

  return `multi-skill: ${parts.join(' · ')}`
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  return $.fs.read(path).catch(() => undefined)
}

async function readSkillFile($: EngineInterface, path: string): Promise<ResolvedSkill | undefined> {
  const text = await readText($, path)
  if (text === undefined) {
    return undefined
  }
  const { fields, body } = parseFrontmatter(text)

  return {
    dir: dirname(path),
    body,
    description: fields.description,
    isSkill: path.endsWith('/SKILL.md'),
    unsupported: unsupportedFeatures(fields, body),
  }
}

async function firstSkill($: EngineInterface, paths: readonly string[]): Promise<ResolvedSkill | undefined> {
  for (const path of paths) {
    const skill = await readSkillFile($, path)
    if (skill) {
      return skill
    }
  }

  return undefined
}

async function pluginDirArgs($: EngineInterface): Promise<string[]> {
  const walk =
    'p=$$; while [ "$p" -gt 1 ]; do a=$(ps -o args= -p "$p"); case "$a" in *--plugin-dir*) echo "$a"; exit 0;; esac; p=$(ps -o ppid= -p "$p" | tr -d " "); done'
  const ran = await $.process.run(['sh', '-c', walk], { timeoutMs: 5000 }).catch(() => undefined)
  const args = ran?.stdout.trim().split(/\s+/) ?? []

  return args.flatMap((arg, i) => {
    if (arg.startsWith('--plugin-dir=')) {
      return [arg.slice('--plugin-dir='.length)]
    }

    return arg === '--plugin-dir' && args[i + 1] ? [args[i + 1] ?? ''] : []
  })
}

async function pluginRootCandidates($: EngineInterface, home: string, plugin: string): Promise<string[]> {
  const installed = await readText($, `${home}/.claude/plugins/installed_plugins.json`)
  const entries: Record<string, { installPath?: string }[]> = installed
    ? (JSON.parse(installed).plugins ?? {})
    : {}
  const fromInstalled = Object.entries(entries)
    .filter(([key]) => key.split('@')[0] === plugin)
    .flatMap(([, list]) => list.map(one => one.installPath ?? ''))
  const fromEnv = ((await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? '').split(':')
  const fromArgs = await pluginDirArgs($)
  const devMods = `${home}/.claude/dev-mods/${await $.session.id()}`
  const fromDevMods = (await $.fs.list(devMods).catch(() => [])).map(entry => `${devMods}/${entry.name}`)

  return [...fromInstalled, ...fromEnv, ...fromArgs, ...fromDevMods]
    .filter(Boolean)
    .map(root => root.replace(/^~(?=\/)/, home))
}

async function resolvePluginSkill($: EngineInterface, home: string, plugin: string, skill: string) {
  for (const root of await pluginRootCandidates($, home, plugin)) {
    const manifest = await readText($, `${root}/.claude-plugin/plugin.json`)
    const parsed = manifest ? JSON.parse(manifest) : undefined
    if (parsed?.name !== plugin) {
      continue
    }
    const skillDirs = [parsed.skills ?? []].flat().map((dir: string) => `${root}/${dir.replace(/^\.\//, '')}`)
    const found = await firstSkill($, [
      `${root}/skills/${skill}/SKILL.md`,
      ...skillDirs.flatMap(dir => [`${dir}/${skill}/SKILL.md`, `${dir}/SKILL.md`]),
      `${root}/commands/${skill}.md`,
    ])
    if (found) {
      return found
    }
  }

  return undefined
}

async function scanSkillsByName($: EngineInterface, dir: string, name: string) {
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    const skill = await readSkillFile($, `${dir}/${entry.name}/SKILL.md`)
    const text = skill ? await readText($, `${dir}/${entry.name}/SKILL.md`) : undefined
    if (skill && text && parseFrontmatter(text).fields.name === name) {
      return skill
    }
  }

  return undefined
}

/**
 * The directories from `cwd` up to and including `root`, nearest first; just
 * `cwd` when `root` is not one of its ancestors.
 *
 * @param cwd the session's working directory
 * @param root the project's root (its git top level)
 * @returns the directories whose `.claude` folders hold project skills
 */
export function projectDirs(cwd: string, root: string | undefined): string[] {
  const parts = cwd.split('/').filter(Boolean)
  const dirs = parts.map((_, i) => `/${parts.slice(0, parts.length - i).join('/')}`)
  const stop = root === undefined ? -1 : dirs.indexOf(root)

  return stop === -1 ? [cwd] : dirs.slice(0, stop + 1)
}

async function projectRoot($: EngineInterface): Promise<string | undefined> {
  const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 }).catch(() => undefined)
  const root = ran?.exitCode === 0 ? ran.stdout.trim() : ''

  return root || undefined
}

async function resolveSkill($: EngineInterface, name: string, plugin: string | undefined) {
  const home = (await $.env.get('HOME')) ?? ''
  const cwd = await $.session.cwd()
  const [prefix, skill] = name.includes(':') ? name.split(':', 2) : [undefined, name]
  if (!skill) {
    return undefined
  }

  if (prefix !== undefined && plugin !== undefined) {
    return resolvePluginSkill($, home, plugin, skill)
  }

  if (prefix !== undefined) {
    const scoped = await firstSkill($, [
      `${cwd}/${prefix}/.claude/skills/${skill}/SKILL.md`,
      `${cwd}/${prefix}/.claude/commands/${skill}.md`,
      `${cwd}/.claude/commands/${prefix}/${skill}.md`,
      `${home}/.claude/commands/${prefix}/${skill}.md`,
    ])

    return scoped ?? resolvePluginSkill($, home, prefix, skill)
  }

  const local = projectDirs(cwd, await projectRoot($)).flatMap(dir => [
    `${dir}/.claude/skills/${skill}/SKILL.md`,
    `${dir}/.claude/commands/${skill}.md`,
  ])

  return (
    (await firstSkill($, [
      ...local,
      `${home}/.claude/skills/${skill}/SKILL.md`,
      `${home}/.claude/commands/${skill}.md`,
    ])) ?? scanSkillsByName($, `${home}/.claude/skills`, skill)
  )
}

let known: Map<string, string | undefined> | undefined
let resolved = new Map<string, ResolvedSkill | undefined>()

async function knownSkills($: EngineInterface): Promise<Map<string, string | undefined>> {
  if (known) {
    return known
  }
  const list = await $.command.list()
  known = new Map(
    list
      .filter(c => (c.source === 'user' || c.source === 'plugin') && c.name !== NAME)
      .map(c => [c.name, c.plugin]),
  )

  return known
}

async function cachedResolve($: EngineInterface, name: string): Promise<ResolvedSkill | undefined> {
  if (resolved.has(name)) {
    return resolved.get(name)
  }
  const plugins = await knownSkills($)
  const skill = await resolveSkill($, name, plugins.get(name)).catch(() => undefined)
  resolved = new Map(resolved).set(name, skill)

  return skill
}

async function isEnabled($: EngineInterface, options: PluginOptions): Promise<boolean> {
  const enabled = await read($, enabledAtom)

  return enabled ?? options.enabledByDefault === true
}

async function draftSkills($: EngineInterface, text: string): Promise<{ matches: SkillMatch[]; draft: DraftSkill[] }> {
  const names = await knownSkills($)
  const matches = firstLineSkills(text, new Set(names.keys()))
  const loaded = await read($, loadedAtom)
  const draft = await Promise.all(
    matches.map(async (m): Promise<DraftSkill> => {
      if (loaded.includes(m.name)) {
        return { name: m.name, status: 'loaded', unsupported: [] }
      }
      const skill = await cachedResolve($, m.name)
      // The leading /skill is the engine's own invocation: nothing is lost.
      const unsupported = skill && m.start !== 0 ? skill.unsupported : []

      return { name: m.name, status: skill ? 'new' : 'unresolved', unsupported }
    }),
  )

  return { matches, draft }
}

async function haikuNote($: EngineInterface, text: string, skills: readonly { name: string; description: string | undefined }[]) {
  const listing = skills.map(s => `- /${s.name}: ${s.description ?? '(no description)'}`).join('\n')
  const reply = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    timeoutMs: 8000,
    maxTokens: 400,
    system:
      'You write a short hidden note for another AI assistant. The user typed several /skill names on the first line of their message; each skill has already been loaded. In two to four sentences, tell the assistant to carry out each skill as if the user had invoked it directly, and say how each one applies to the request. Do not restate the skills\' instructions. Reply with the note only.',
    prompt: `Skills:\n${listing}\n\nUser message:\n${text.slice(0, 4000)}`,
  })

  return reply.isAnswered && reply.text.trim() ? reply.text.trim() : undefined
}

async function appendRow($: EngineInterface, text: string) {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

async function saveNotes($: EngineInterface, change: (notes: ActivationNote[]) => ActivationNote[]) {
  await update($, notesAtom, notes => change(notes).slice(-MAX_NOTES))
  await $.store.set(NOTES_STORE_KEY, await read($, notesAtom))
}

async function restoreNotes($: EngineInterface) {
  if ((await read($, notesAtom)).length > 0) {
    return
  }
  const stored = await $.store.get(NOTES_STORE_KEY)
  if (Array.isArray(stored)) {
    await update($, notesAtom, () => stored as ActivationNote[])
  }
}

/**
 * The note to draw under a prompt row: the one bound to the row's id, else
 * the latest this session recorded for the same prompt text.
 *
 * @param notes every recorded note
 * @param requestId the row's id
 * @param text the row's text
 * @param sessionId the session drawing the row
 * @returns the note, or undefined when the row activated nothing
 */
export function noteFor(
  notes: readonly ActivationNote[],
  requestId: string,
  text: string,
  sessionId: string,
): ActivationNote | undefined {
  return notes.find(n => n.uuid === requestId) ?? notes.findLast(n => n.sessionId === sessionId && n.text === text)
}

async function setDraft($: EngineInterface, draft: DraftSkill[]) {
  const current = await read($, draftAtom)
  if (JSON.stringify(current) !== JSON.stringify(draft)) {
    await update($, draftAtom, () => draft)
  }
}

async function resetSession($: EngineInterface) {
  resolved = new Map()
  await update($, loadedAtom, () => [])
  await update($, draftAtom, () => [])
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    known = undefined
    await restoreNotes($)
    await $.command.register({
      name: NAME,
      description: 'Load every /skill on a prompt\'s first line',
      argumentHint: '[on|off|status]',
    })

    return next(e)
  })

  on('command.run', { command: NAME }, async ($, e) => {
    const arg = e.args.trim()
    const wasEnabled = await isEnabled($, options)
    const enabled = arg === 'on' ? true : arg === 'off' ? false : arg === 'status' ? wasEnabled : !wasEnabled
    await update($, enabledAtom, () => enabled)
    known = undefined
    resolved = new Map()
    await setDraft($, [])
    const loaded = await read($, loadedAtom)
    const tail = loaded.length > 0 ? ` Loaded this session: ${loaded.map(n => `/${n}`).join(', ')}.` : ''

    return { text: `multi-skill is ${enabled ? 'on' : 'off'}.${tail}` }
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    await update($, loadedAtom, list => (list.includes(e.skill) ? list : [...list, e.skill]))

    return result
  })

  on('prompt.edit', async ($, e, next) => {
    const result = await next(e)
    if (!(await isEnabled($, options))) {
      return result
    }
    const { matches, draft } = await draftSkills($, result.text)
    await setDraft($, draft)
    const decorations: PromptDecoration[] = matches.map((m, i) => ({
      start: m.start,
      end: m.end,
      bold: true,
      underline: (draft[i]?.unsupported.length ?? 0) > 0,
      color: STATUS_COLOR[draft[i]?.status ?? 'new'],
    }))

    return { ...result, decorations: [...(result.decorations ?? []), ...decorations] }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const draft = await read($, draftAtom)
    if (e.props.hasSurvey || draft.length === 0 || !(await isEnabled($, options))) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box gap={1}>
        <Text dimColor>multi-skill</Text>
        {draft.map(skill => (
          <Text color={STATUS_COLOR[skill.status]}>
            /{skill.name}
            {skill.status === 'loaded' ? ' (loaded)' : skill.status === 'unresolved' ? ' (not found)' : ''}
          </Text>
        ))}
        {draft
          .filter(skill => skill.unsupported.length > 0)
          .map(skill => (
            <Text color="warning">
              /{skill.name} uses {skill.unsupported.join(', ')}: put it first
            </Text>
          ))}
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    // Only the person invokes user-only skills: never a peer, channel,
    // notification, scheduled task or plugin whose text names one.
    if (!USER_ORIGINS.has(e.origin.kind) || !(await isEnabled($, options))) {
      return next(e)
    }
    await setDraft($, [])
    const names = await knownSkills($)
    const matches = firstLineSkills(e.text, new Set(names.keys()))
    if (matches.length === 0) {
      return next(e)
    }
    const loaded = await read($, loadedAtom)
    const toLoad = matches.filter(m => m.start !== 0 && !loaded.includes(m.name))
    const found = await Promise.all(toLoad.map(async m => ({ name: m.name, skill: await cachedResolve($, m.name) })))
    const missing = found.filter(f => f.skill === undefined).map(f => f.name)
    const usable = matches.filter(m => !missing.includes(m.name))
    const isOnlyLead = usable.length === 0 || (usable.length === 1 && usable[0]?.start === 0)

    const rows = found.flatMap(({ name, skill }) => (skill ? [commandRow(name), expand(skill)] : []))
    const added = found.flatMap(f => (f.skill ? [f.name] : []))
    await update($, loadedAtom, list => [...list, ...added.filter(n => !list.includes(n))])

    if (!isOnlyLead) {
      const described = await Promise.all(
        usable.map(async m => ({ name: m.name, description: (await cachedResolve($, m.name))?.description })),
      )
      const note =
        options.haikuNote === true
          ? ((await haikuNote($, e.text, described).catch(() => undefined)) ?? framingNote(usable.map(m => m.name)))
          : framingNote(usable.map(m => m.name))
      rows.push(note)
    }

    if (missing.length > 0) {
      $.ui.toast(`multi-skill: no SKILL.md found for ${missing.map(n => `/${n}`).join(', ')}`)
    }
    const partial = found.flatMap(({ name, skill }) =>
      skill && skill.unsupported.length > 0 ? [`/${name} (${skill.unsupported.join(', ')})`] : [],
    )
    if (partial.length > 0) {
      $.ui.toast(`multi-skill: loaded as text only, put first for full support: ${partial.join('; ')}`)
    }

    const line = activationNotice({
      leading: matches[0]?.start === 0 ? matches[0].name : undefined,
      loaded: added,
      alreadyLoaded: matches.filter(m => m.start !== 0 && loaded.includes(m.name)).map(m => m.name),
      missing,
      partial,
    })
    const sessionId = await $.session.id()
    await saveNotes($, notes => [...notes, { uuid: null, text: e.text, sessionId, line }])

    // Typed mid-turn, rows appended now would land inside the running turn;
    // ride along as the prompt's context instead.
    if (e.turnId === undefined) {
      for (const row of rows) {
        await appendRow($, row)
      }
    }
    isAwaitingRow = true
    try {
      return await next(e.turnId === undefined ? e : { ...e, context: [...(e.context ?? []), ...rows] })
    } finally {
      isAwaitingRow = false
    }
  }).catch(($, e, next) => next(e))

  // The prompt's own row (typed, or a leading /command) takes the pending
  // note's id, so the line draws under exactly that row.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const isPromptRow = e.door === 'prompt' || e.door === 'command'
    if (isAwaitingRow && isPromptRow && stored.uuid !== undefined) {
      isAwaitingRow = false
      const uuid = stored.uuid
      await saveNotes($, notes => {
        const at = notes.findLastIndex(n => n.uuid === null)

        return at === -1 ? notes : notes.map((n, i) => (i === at ? { ...n, uuid } : n))
      })
    }

    return stored
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const note = noteFor(await read($, notesAtom), e.requestId, e.props.text, await $.session.id())
    if (!note) {
      return next(e)
    }
    const row = await next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {row}
        <Text dimColor>{note.line}</Text>
      </Box>
    )
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await resetSession($)

    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await resetSession($)
    }

    return next(e)
  })
}
