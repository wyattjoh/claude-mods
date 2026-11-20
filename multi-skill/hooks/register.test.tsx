import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptEditInput, PromptEditResult } from 'claude-code'

import { expand, firstLineSkills, noteFor, parseFrontmatter, projectDirs, unsupportedFeatures } from './register'

type PromptEdit = (e: PromptEditInput) => Promise<PromptEditResult>
const PRESENTATION = { isFullscreen: false, columns: 80 }

const FILES: Record<string, string> = {
  '/proj/.claude/skills/alpha/SKILL.md':
    '---\nname: alpha\ndescription: Alpha.\ndisable-model-invocation: true\n---\n\nSay ALPHA-7. $ARGUMENTS\n',
  '/proj/.claude/skills/beta/SKILL.md': '---\nname: beta\ndescription: Beta.\n---\n\nSay BETA-9 from ${CLAUDE_SKILL_DIR}.\n',
  '/home/.claude/commands/gamma.md': 'Say GAMMA-3.\n',
  '/proj/.claude/skills/delta/SKILL.md':
    '---\nname: delta\nmodel: opus\nallowed-tools: Bash(git:*)\n---\n\nBranch: !`git branch --show-current`\n',
  // A personal plugin linked into the skills directory (`kit@skills-dir`).
  '/home/.claude/skills/kit/.claude-plugin/plugin.json': '{ "name": "kit" }',
  '/home/.claude/skills/kit/skills/lint/SKILL.md': '---\nname: lint\ndescription: Lint.\n---\n\nSay LINT-5.\n',
}

const DIRS: Record<string, string[]> = {
  '/home/.claude/skills': ['kit', 'plain'],
}

const KNOWN = new Set(['alpha', 'beta', 'gamma', 'pr', 'web:deploy'])

/**
 * The engine beneath the plugin. Given `engine`, a submitted prompt stores
 * its row as the session does, under the id `row-<n>`.
 */
function world(on: On, engine?: Engine) {
  let rows = 0
  on('prompt.submit', async ($, e) => {
    if (engine) {
      rows += 1
      await engine.session.append({
        message: { type: 'user', role: 'user', content: [{ type: 'text', text: e.text }] },
        door: 'prompt',
        origin: { kind: 'composer' },
        uuid: `row-${rows}`,
      })
    }

    return { text: e.text }
  })
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.text}</Text>
  })
  mock.env(on, { HOME: '/home' })
  on('command.list', () => ({
    value: [
      { name: 'alpha', description: 'Alpha.', source: 'user' as const },
      { name: 'beta', description: 'Beta.', source: 'user' as const },
      { name: 'gamma', description: 'Gamma.', source: 'user' as const },
      { name: 'ghost', description: 'Ghost.', source: 'user' as const },
      { name: 'delta', description: 'Delta.', source: 'user' as const },
      { name: 'kit:lint', description: 'Lint.', source: 'plugin' as const, plugin: 'kit' },
      { name: 'compact', description: 'Compact.', source: 'builtin' as const },
    ],
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.id', () => ({ value: 'sid' }))
  on('fs.read', ($, e) => {
    const text = FILES[e.path]

    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.list', ($, e) => ({ value: (DIRS[e.path] ?? []).map(name => ({ name })) }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('prompt.edit', ($, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)

    return { text, cursor: e.start + e.inputText.length }
  })

  mock.store(on)

  return mock.session(on)
}

/**
 * The multi-skill line drawn under a prompt row, or undefined when none is.
 */
async function lineUnder($: Engine, requestId: string, text: string): Promise<string | undefined> {
  const ui = await $.ui.mount({
    plugin: 'multi-skill',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text, origin: { kind: 'composer' }, isExpanded: false },
    requestId,
  })
  const line = await ui.find({ type: 'Text', text: /^multi-skill:/ })
  await ui.unmount()

  return line?.text
}

function submit(text: string) {
  return { text, wait: false, origin: { kind: 'composer' as const } }
}

type Rows = ReturnType<ReturnType<typeof mock.session>['appended']>

function texts(rows: Rows, type: 'user' | 'system' = 'user'): string[] {
  return rows
    .filter(row => row.message.type === type)
    .map(row => row.message.content.map(block => ('text' in block ? block.text : '')).join(''))
}

describe('firstLineSkills', () => {
  test('finds known names on the first line only, once each, with offsets', () => {
    const matches = firstLineSkills('/alpha then /beta, and /alpha again\n/gamma', KNOWN)
    expect(matches).toEqual([
      { name: 'alpha', start: 0, end: 6 },
      { name: 'beta', start: 12, end: 17 },
    ])
  })

  test('ignores paths, URLs, slash-joined words and unknown names', () => {
    const line = 'see /tmp/x and/or https://x.dev/pr /alpha/b /nope /pr.'
    expect(firstLineSkills(line, KNOWN).map(m => m.name)).toEqual(['pr'])
  })

  test('matches plugin and directory-scoped names', () => {
    expect(firstLineSkills('run /web:deploy now', KNOWN).map(m => m.name)).toEqual(['web:deploy'])
  })
})

describe('projectDirs', () => {
  test('walks up to the project root and no further', () => {
    expect(projectDirs('/w/repo/app/src', '/w/repo')).toEqual(['/w/repo/app/src', '/w/repo/app', '/w/repo'])
  })

  test('stays in the working directory outside a project', () => {
    expect(projectDirs('/tmp/a/b', undefined)).toEqual(['/tmp/a/b'])
    expect(projectDirs('/tmp/a/b', '/elsewhere')).toEqual(['/tmp/a/b'])
  })
})

describe('skill files', () => {
  test('parses frontmatter and expands like the engine', () => {
    const { fields, body } = parseFrontmatter(FILES['/proj/.claude/skills/beta/SKILL.md'] ?? '')
    expect(fields.description).toBe('Beta.')
    const skill = { dir: '/proj/.claude/skills/beta', body, description: 'Beta.', isSkill: true, unsupported: [] }
    expect(expand(skill)).toBe(
      'Base directory for this skill: /proj/.claude/skills/beta\n\nSay BETA-9 from /proj/.claude/skills/beta.\n',
    )
  })

  test('lists the features only a leading /skill gets', () => {
    const delta = parseFrontmatter(FILES['/proj/.claude/skills/delta/SKILL.md'] ?? '')
    expect(unsupportedFeatures(delta.fields, delta.body)).toEqual(['allowed-tools', 'model', '!`cmd`'])
    const alpha = parseFrontmatter(FILES['/proj/.claude/skills/alpha/SKILL.md'] ?? '')
    expect(unsupportedFeatures(alpha.fields, alpha.body)).toEqual(['arguments'])
    expect(unsupportedFeatures({ effort: 'high' }, 'Use $1.')).toEqual(['effort', 'arguments'])
    expect(unsupportedFeatures({}, 'Plain text, a `code` span and a ! mark.')).toEqual([])
  })
})

describe('prompt.submit', () => {
  test('does nothing while off', async ($, on) => {
    const session = world(on)
    await $.prompt.submit(submit('do it /alpha /beta'))
    expect(session.appended()).toEqual([])
  })

  test('/multi-skill on, then loads each first-line skill but the leading one', async ($, on) => {
    const session = world(on)
    const toggled = await $.command.run({
      command: 'multi-skill',
      args: 'on',
      origin: { kind: 'composer' },
      presentation: PRESENTATION,
    })
    expect(toggled.text).toContain('on')

    await $.skill.prompt({ skill: 'alpha', text: 'Say ALPHA-7.' })
    await $.prompt.submit(submit('/alpha go /beta /gamma\nsecond /ghost'))
    const rows = texts(session.appended())

    expect(rows).toHaveLength(5)
    expect(rows[0]).toContain('<command-name>/beta</command-name>')
    expect(rows[1]).toContain('Base directory for this skill: /proj/.claude/skills/beta')
    expect(rows[3]).toBe('Say GAMMA-3.\n')
    expect(rows[4]).toContain('/alpha, /beta, /gamma')
    expect(rows.join('')).not.toContain('ghost')
    expect(await lineUnder($, 'unbound', '/alpha go /beta /gamma\nsecond /ghost')).toBe(
      'multi-skill: /alpha (leading), /beta, /gamma',
    )
    // The line is drawn under the prompt row, never stored as a row of its own.
    expect(texts(session.appended(), 'system')).toEqual([])
  })

  test('skips skills already loaded this session', { options: { enabledByDefault: true } }, async ($, on) => {
    const session = world(on)
    await $.prompt.submit(submit('use /beta'))
    await $.prompt.submit(submit('again /beta'))
    const rows = texts(session.appended())

    expect(rows.filter(r => r.includes('BETA-9'))).toHaveLength(1)
    expect(rows.filter(r => r.includes('names /beta'))).toHaveLength(2)
    expect(await lineUnder($, 'unbound', 'use /beta')).toBe('multi-skill: /beta')
    expect(await lineUnder($, 'unbound', 'again /beta')).toBe('multi-skill: nothing new loaded · already loaded: /beta')
  })

  test('notes skills that loaded as text only', { options: { enabledByDefault: true } }, async ($, on) => {
    world(on)
    await $.prompt.submit(submit('go /delta'))
    expect(await lineUnder($, 'unbound', 'go /delta')).toBe(
      'multi-skill: /delta · text only: /delta (allowed-tools, model, !`cmd`)',
    )
  })

  test('ignores prompts the person did not send', { options: { enabledByDefault: true } }, async ($, on) => {
    const session = world(on)
    await $.prompt.submit({ text: 'hi /alpha /beta', wait: false, origin: { kind: 'peer' } })
    await $.prompt.submit({ text: 'hi /alpha /beta', wait: false, origin: { kind: 'channel', server: 'slack' } })
    expect(session.appended()).toEqual([])
  })

  test('loads a skill from a plugin linked into ~/.claude/skills', { options: { enabledByDefault: true } }, async ($, on) => {
    const session = world(on)
    await $.prompt.submit(submit('check /kit:lint'))
    const rows = texts(session.appended())

    expect(rows[1]).toBe(
      'Base directory for this skill: /home/.claude/skills/kit/skills/lint\n\nSay LINT-5.\n',
    )
    expect(await lineUnder($, 'unbound', 'check /kit:lint')).toBe('multi-skill: /kit:lint')
  })

  test('toasts an unresolvable skill and loads nothing for it', { options: { enabledByDefault: true } }, async ($, on) => {
    const session = world(on)
    await $.prompt.submit(submit('try /ghost'))
    expect(texts(session.appended())).toEqual([])
    expect(await lineUnder($, 'unbound', 'try /ghost')).toBe('multi-skill: nothing new loaded · not found: /ghost')
  })
})

describe('prompt.edit', () => {
  test('decorates first-line skills by status', { options: { enabledByDefault: true } }, async ($, on) => {
    world(on)
    await $.skill.prompt({ skill: 'alpha', text: 'x' })
    const draft = 'x /alpha /beta /ghost'
    // The kit's typings leave `edit` off `$.prompt`; the engine still runs it.
    const edit = ($.prompt as unknown as { edit: PromptEdit }).edit
    const box = await edit({
      origin: { kind: 'composer' },
      text: draft,
      cursor: draft.length,
      start: draft.length,
      end: draft.length,
      inputText: ' ',
    })

    expect(box.decorations?.map(d => [d.start, d.color])).toEqual([
      [2, 'subtle'],
      [9, 'success'],
      [15, 'warning'],
    ])
  })

  test('underlines a later skill that needs to lead, not a leading one', { options: { enabledByDefault: true } }, async ($, on) => {
    world(on)
    const edit = ($.prompt as unknown as { edit: PromptEdit }).edit
    const typed = (text: string) =>
      edit({ origin: { kind: 'composer' }, text, cursor: text.length, start: text.length, end: text.length, inputText: ' ' })

    const later = await typed('x /beta /delta')
    expect(later.decorations?.map(d => [d.start, d.underline])).toEqual([
      [2, false],
      [8, true],
    ])
    const leading = await typed('/delta x')
    expect(leading.decorations?.map(d => d.underline)).toEqual([false])
  })
})

describe('UserMessage', () => {
  test('draws the line under the prompt row it was recorded for', { options: { enabledByDefault: true } }, async ($, on) => {
    world(on, $)
    await $.prompt.submit(submit('go /beta'))
    await $.prompt.submit(submit('plain prompt'))

    expect(await lineUnder($, 'row-1', 'go /beta')).toBe('multi-skill: /beta')
    expect(await lineUnder($, 'row-2', 'plain prompt')).toBeUndefined()
  })

  test('finds the row by its id even when the drawn text differs', { options: { enabledByDefault: true } }, async ($, on) => {
    world(on, $)
    await $.prompt.submit(submit('go /beta'))

    expect(await lineUnder($, 'row-1', '/beta as drawn')).toBe('multi-skill: /beta')
  })

  test('matches by text only within the session that noted it', () => {
    const notes = [
      { uuid: 'row-9', text: 'go /beta', sessionId: 'old', line: 'multi-skill: /beta' },
    ]
    expect(noteFor(notes, 'row-9', 'anything', 'new')?.line).toBe('multi-skill: /beta')
    expect(noteFor(notes, 'row-1', 'go /beta', 'new')).toBeUndefined()
    expect(noteFor(notes, 'row-1', 'go /beta', 'old')?.line).toBe('multi-skill: /beta')
  })

  test('draws nothing extra for a row it never noted', async ($, on) => {
    world(on, $)
    expect(await lineUnder($, 'other', 'hello')).toBeUndefined()
  })
})
