import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, PromptEditInput, PromptEditResult } from 'claude-code'

import { expand, firstLineSkills, parseFrontmatter } from './register'

type PromptEdit = (e: PromptEditInput) => Promise<PromptEditResult>
const PRESENTATION = { isFullscreen: false, columns: 80 }

const FILES: Record<string, string> = {
  '/proj/.claude/skills/alpha/SKILL.md':
    '---\nname: alpha\ndescription: Alpha.\ndisable-model-invocation: true\n---\n\nSay ALPHA-7. $ARGUMENTS\n',
  '/proj/.claude/skills/beta/SKILL.md': '---\nname: beta\ndescription: Beta.\n---\n\nSay BETA-9 from ${CLAUDE_SKILL_DIR}.\n',
  '/home/.claude/commands/gamma.md': 'Say GAMMA-3.\n',
}

const KNOWN = new Set(['alpha', 'beta', 'gamma', 'pr', 'web:deploy'])

function world(on: On) {
  mock.env(on, { HOME: '/home' })
  on('command.list', () => ({
    value: [
      { name: 'alpha', description: 'Alpha.', source: 'user' as const },
      { name: 'beta', description: 'Beta.', source: 'user' as const },
      { name: 'gamma', description: 'Gamma.', source: 'user' as const },
      { name: 'ghost', description: 'Ghost.', source: 'user' as const },
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
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('prompt.edit', ($, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)

    return { text, cursor: e.start + e.inputText.length }
  })

  return mock.session(on)
}

function submit(text: string) {
  return { text, wait: false, origin: { kind: 'composer' as const } }
}

function texts(rows: ReturnType<ReturnType<typeof mock.session>['appended']>): string[] {
  return rows.map(row => row.message.content.map(block => ('text' in block ? block.text : '')).join(''))
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

describe('skill files', () => {
  test('parses frontmatter and expands like the engine', () => {
    const { fields, body } = parseFrontmatter(FILES['/proj/.claude/skills/beta/SKILL.md'] ?? '')
    expect(fields.description).toBe('Beta.')
    expect(expand({ dir: '/proj/.claude/skills/beta', body, description: 'Beta.', isSkill: true })).toBe(
      'Base directory for this skill: /proj/.claude/skills/beta\n\nSay BETA-9 from /proj/.claude/skills/beta.\n',
    )
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
  })

  test('skips skills already loaded this session', { options: { enabledByDefault: true } }, async ($, on) => {
    const session = world(on)
    await $.prompt.submit(submit('use /beta'))
    await $.prompt.submit(submit('again /beta'))
    const rows = texts(session.appended())

    expect(rows.filter(r => r.includes('BETA-9'))).toHaveLength(1)
    expect(rows.filter(r => r.includes('names /beta'))).toHaveLength(2)
  })

  test('toasts an unresolvable skill and loads nothing for it', { options: { enabledByDefault: true } }, async ($, on) => {
    const session = world(on)
    await $.prompt.submit(submit('try /ghost'))
    expect(session.appended()).toEqual([])
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
})
