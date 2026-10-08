import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepInput, TurnUsage } from 'claude-code'

import {
  DEFAULT_PREFS,
  effectiveTtl,
  formatClock,
  parseCommand,
  readingAt,
  shortLabel,
  toPrefs,
  ttlFromEnv,
  ttlFromTranscript,
} from './register'

const START = 1_000_000
const PRESENTATION = { isFullscreen: false, columns: 80 }
const SURFACES = ['terminal', 'desktop'] as const

const CACHED: TurnUsage = {
  model: 'claude-opus-5-5',
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 5000,
  cache_creation_input_tokens: 100,
}

const UNCACHED: TurnUsage = { ...CACHED, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/**
 * The engine beneath the plugin: a mocked clock and store, a status line and
 * toasts recorded, and a model whose next answer's usage the test sets.
 */
function world(on: On, store: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: START })
  mock.env(on, {})
  const stored = new Map(Object.entries(store))
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const drawn: unknown[] = []
  const model: { usage: TurnUsage | null } = { usage: CACHED }
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', ($, e) => {
    stored.set(e.key, e.value)

    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.render', ($, e) => {
    drawn.push(e.props)

    return { type: 'Box', props: {}, children: [] } as never
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: model.usage,
    }
  })

  return { clock, statuses, toasts, model, stored, drawn, lastStatus: () => statuses.at(-1) }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
}

async function step($: Engine, extra: Partial<TurnStepInput> = {}) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...extra })
  for await (const _ of stream) {
    // drain
  }

  return stream.result
}

function run($: Engine, args: string) {
  return $.command.run({ command: 'cache-timer', args, origin: { kind: 'composer' }, presentation: PRESENTATION })
}

describe('helpers', () => {
  test('formats the clock', () => {
    expect(formatClock(300_000)).toBe('5:00')
    expect(formatClock(4_500)).toBe('0:05')
    expect(formatClock(3_600_000)).toBe('1:00:00')
    expect(formatClock(-5)).toBe('0:00')
  })

  test('reads warm, cold, uncached and idle', () => {
    const stamp = { sentAt: 0, isCached: true, model: 'm' }
    expect(readingAt(null, '5m', 0)).toEqual({ kind: 'idle' })
    expect(readingAt({ ...stamp, isCached: false }, '5m', 0)).toEqual({ kind: 'uncached' })
    expect(shortLabel(readingAt(stamp, '5m', 30_000))).toBe('cache 4:30')
    expect(shortLabel(readingAt(stamp, '1h', 30_000))).toBe('cache 59:30')
    expect(shortLabel(readingAt(stamp, '5m', 300_000))).toBe('cache likely expired')
  })

  test('picks the TTL: fixed, detected, then environment, then 5m', () => {
    expect(effectiveTtl('1h', '5m', null)).toBe('1h')
    expect(effectiveTtl('auto', '1h', '5m')).toBe('1h')
    expect(effectiveTtl('auto', null, '1h')).toBe('1h')
    expect(effectiveTtl('auto', null, null)).toBe('5m')
  })

  test('reads Claude Code TTL overrides from the environment', () => {
    expect(ttlFromEnv({})).toBeNull()
    expect(ttlFromEnv({ FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })).toBe('5m')
    expect(ttlFromEnv({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })).toBe('1h')
    expect(ttlFromEnv({ ENABLE_PROMPT_CACHING_1H: 'true' })).toBe('1h')
    expect(ttlFromEnv({ ENABLE_PROMPT_CACHING_1H: '0' })).toBeNull()
  })

  test('finds the last main-thread cache write in a transcript', () => {
    const row = (extra: object, five: number, hour: number) =>
      JSON.stringify({
        ...extra,
        type: 'assistant',
        message: {
          usage: { cache_creation: { ephemeral_5m_input_tokens: five, ephemeral_1h_input_tokens: hour } },
        },
      })
    const jsonl = [row({}, 0, 900), row({}, 0, 0), row({ isSidechain: true }, 400, 0), '{"type":"user"}', ''].join('\n')
    expect(ttlFromTranscript(jsonl)).toBe('1h')
    expect(ttlFromTranscript(`${jsonl}\n${row({}, 50, 0)}`)).toBe('5m')
    expect(ttlFromTranscript('not json\n')).toBeNull()
  })

  test('normalises stored preferences', () => {
    expect(toPrefs(undefined)).toEqual(DEFAULT_PREFS)
    expect(toPrefs({ surfaces: ['band', 'bogus', 'status'], ttl: '1h' })).toEqual({
      surfaces: ['status', 'band'],
      ttl: '1h',
    })
    expect(toPrefs({ surfaces: 'x', ttl: '2h' })).toEqual(DEFAULT_PREFS)
  })
})

describe('parseCommand', () => {
  test('no argument opens the pane', () => {
    expect(parseCommand('', DEFAULT_PREFS)).toEqual({ open: true })
  })

  test('all, none, only, on, off, toggle keep the canonical order', () => {
    const prefs = { surfaces: ['status' as const], ttl: 'auto' as const }
    const surfaces = (args: string) => {
      const out = parseCommand(args, prefs)

      return 'prefs' in out ? out.prefs.surfaces : out
    }
    expect(surfaces('all')).toHaveLength(8)
    expect(surfaces('none')).toEqual([])
    expect(surfaces('only hint, band')).toEqual(['band', 'hint'])
    expect(surfaces('on toast')).toEqual(['status', 'toast'])
    expect(surfaces('off status')).toEqual([])
    expect(surfaces('toggle status mode')).toEqual(['mode'])
  })

  test('sets the TTL and refuses unknown input', () => {
    const ttl = parseCommand('ttl 1h', DEFAULT_PREFS)
    expect('prefs' in ttl && ttl.prefs.ttl).toBe('1h')
    expect(parseCommand('ttl 2h', DEFAULT_PREFS)).toEqual({ text: expect.stringContaining('TTL must be') })
    expect(parseCommand('on nowhere', DEFAULT_PREFS)).toEqual({ text: expect.stringContaining('Unknown surface') })
    expect(parseCommand('dance', DEFAULT_PREFS)).toEqual({ text: expect.stringContaining('Usage') })
  })
})

describe('countdown', () => {
  test('a main-thread step starts it; the status line counts down and expires', async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    expect(w.lastStatus()).toBe('⏱ cache 5:00')

    await w.clock.advance(270_000)
    expect(w.lastStatus()).toBe('⏱ cache 0:30')

    await w.clock.advance(31_000)
    expect(w.lastStatus()).toBe('⏱ cache likely expired')
  })

  test('subagent steps and steps without usage leave it alone', async ($, on) => {
    const w = world(on)
    await start($)
    await step($, { agentId: 'sub-1' })
    w.model.usage = null
    await step($)
    expect(w.statuses.every(s => s === undefined)).toBe(true)
  })

  test('a step that cached nothing says so', async ($, on) => {
    const w = world(on)
    w.model.usage = UNCACHED
    await start($)
    await step($)
    expect(w.lastStatus()).toBe('⏱ no cache')
  })

  test('a later step resets the countdown from when it was sent', async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await w.clock.advance(200_000)
    await step($)
    await w.clock.advance(1_000)
    expect(w.lastStatus()).toBe('⏱ cache 4:59')
  })

  test('toasts once near expiry and once on expiry', async ($, on) => {
    const w = world(on, { prefs: { surfaces: ['toast'], ttl: '5m' } })
    await start($)
    await step($)
    await w.clock.advance(301_000)
    expect(w.toasts).toHaveLength(2)
    expect(w.toasts[0]).toContain('expires in')
    expect(w.toasts[1]).toContain('likely expired')
    expect(w.statuses.every(s => s === undefined)).toBe(true)
  })

  test('/clear forgets the request', async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await $.session.end({ reason: 'clear', sessionId: 's', resume: undefined as never })
    expect(w.lastStatus()).toBeUndefined()
  })
})

describe('/cache-timer', () => {
  test('changes and persists the surfaces', async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    const out = await run($, 'only hint,mode')
    expect(out.text).toBe('Cache timer shows in: hint, mode. TTL: auto.')
    expect(w.lastStatus()).toBeUndefined()
    expect(w.stored.get('prefs')).toEqual({ surfaces: ['hint', 'mode'], ttl: 'auto' })
  })

  test('a fixed TTL changes the countdown', async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await run($, 'ttl 1h')
    expect(w.lastStatus()).toBe('⏱ cache 1:00:00')
  })
})

describe('surfaces', () => {
  for (const surface of SURFACES) {
    test(`hint tail and mode label on ${surface}`, async ($, on) => {
      const w = world(on, { prefs: { surfaces: ['hint', 'mode'], ttl: '5m' } })
      await start($)
      await step($)
      await $.ui.render({
        surface,
        component: 'PromptHint',
        requestId: 'hint',
        props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
      })
      await $.ui.render({ surface, component: 'SessionMode', requestId: 'mode', props: { modes: ['focus'] } })
      expect(w.drawn).toEqual([
        { isDraft: false, isWorking: false, hint: '? for shortcuts', tail: ' · cache 5:00' },
        { modes: ['focus', 'cache 5:00'] },
      ])
    })

    test(`settings pane toggles a surface on ${surface}`, async ($, on) => {
      const w = world(on)
      await start($)
      const pane = await $.ui.mount({
        plugin: 'cache-timer',
        surface,
        component: 'Pane',
        requestId: 'cache-timer',
        props: {
          title: 'Cache timer',
          isFocused: true,
          bodyColumns: 60,
          placement: 'inline',
          scroll: { offset: 0, bodyRows: 30, contentRows: 30 },
        } as never,
      })
      expect((await pane.find({ key: 'surface-band' }))?.props.label).toBe('· Band above prompt')
      await pane.press({ key: 'surface-band' })
      expect((await pane.find({ key: 'surface-band' }))?.props.label).toBe('✓ Band above prompt')
      expect(w.stored.get('prefs')).toEqual({ surfaces: ['status', 'band'], ttl: 'auto' })
    })
  }
})
