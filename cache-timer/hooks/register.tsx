import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheStamp, Prefs, Surface, Ttl, TtlPref } from '../types'

const PANE = 'cache-timer'
const STORE_KEY = 'prefs'
const WARN_MS = 60_000
const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

export const SURFACES: readonly Surface[] = ['status', 'band', 'hint', 'mode', 'spinner', 'duration', 'pane', 'toast']

const SURFACE_LABEL: Record<Surface, string> = {
  status: 'Status line',
  band: 'Band above prompt',
  hint: 'Hint line tail',
  mode: 'Footer mode label',
  spinner: 'Spinner',
  duration: 'Turn duration line',
  pane: 'Pane',
  toast: 'Expiry toasts',
}

const TTL_PREFS: readonly TtlPref[] = ['auto', '5m', '1h']

export const DEFAULT_PREFS: Prefs = { surfaces: ['status'], ttl: 'auto' }

const prefsAtom = atom({ plugin: 'cache-timer', key: 'prefs' } as const, DEFAULT_PREFS)
const stampAtom = atom({ plugin: 'cache-timer', key: 'stamp' } as const, null)
const detectedAtom = atom({ plugin: 'cache-timer', key: 'detected' } as const, null)
const nowAtom = atom({ plugin: 'cache-timer', key: 'now' } as const, 0)

/**
 * Where the countdown stands at one moment.
 */
export type Reading =
  | { kind: 'idle' }
  | { kind: 'uncached' }
  | { kind: 'warm'; leftMs: number; expiresAt: number; ttl: Ttl }
  | { kind: 'cold'; expiresAt: number; ttl: Ttl }

/**
 * Formats milliseconds as `m:ss`, or `h:mm:ss` past an hour.
 *
 * @param ms the time left, clamped at zero
 * @returns the clock text
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')

  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/**
 * Formats a turn's duration the way the engine's closing line does.
 *
 * @param ms the duration
 * @returns `3s`, `1m 4s`
 */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)

  return m > 0 ? `${m}m ${total % 60}s` : `${total}s`
}

/**
 * Formats an epoch time as local `HH:MM`.
 *
 * @param ms milliseconds since the epoch
 * @returns the wall-clock time
 */
export function formatTime(ms: number): string {
  const d = new Date(ms)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The TTL the countdown runs on: a fixed preference, else what the
 * transcript showed, else the environment's override, else the API default.
 *
 * @param pref the person's TTL preference
 * @param detected the TTL the last cache write used, when one was seen
 * @param hinted the TTL the environment forces, when it does
 * @returns the TTL
 */
export function effectiveTtl(pref: TtlPref, detected: Ttl | null, hinted: Ttl | null): Ttl {
  if (pref !== 'auto') {
    return pref
  }

  return detected ?? hinted ?? '5m'
}

/**
 * Reads the countdown at `now`.
 *
 * @param stamp the main thread's latest request with usage, or null
 * @param ttl the TTL in force
 * @param now the time, in milliseconds
 * @returns the reading
 */
export function readingAt(stamp: CacheStamp | null, ttl: Ttl, now: number): Reading {
  if (stamp === null) {
    return { kind: 'idle' }
  }
  if (!stamp.isCached) {
    return { kind: 'uncached' }
  }
  const expiresAt = stamp.sentAt + TTL_MS[ttl]
  const leftMs = expiresAt - now

  return leftMs > 0 ? { kind: 'warm', leftMs, expiresAt, ttl } : { kind: 'cold', expiresAt, ttl }
}

/**
 * The short label for one-line surfaces; empty while idle.
 *
 * @param reading the countdown
 * @returns `cache 4:32`, `cache likely expired`, `no cache`, or ''
 */
export function shortLabel(reading: Reading): string {
  switch (reading.kind) {
    case 'idle':
      return ''
    case 'uncached':
      return 'no cache'
    case 'warm':
      return `cache ${formatClock(reading.leftMs)}`
    case 'cold':
      return 'cache likely expired'
  }
}

/**
 * The colour a reading draws in.
 *
 * @param reading the countdown
 * @returns a theme key
 */
export function readingColor(reading: Reading): 'success' | 'warning' | 'error' | 'subtle' {
  if (reading.kind === 'warm') {
    return reading.leftMs > WARN_MS ? 'success' : 'warning'
  }

  return reading.kind === 'cold' ? 'error' : 'subtle'
}

/**
 * Finds the TTL of the latest main-thread cache write in a transcript.
 * Requests that only read the cache say nothing, so the scan goes back to
 * the last one that wrote; a write with 5m tokens counts as 5m, since the
 * conversation's tail is what the next request needs.
 *
 * @param jsonl the transcript file's text
 * @returns the TTL, or null when no write is recorded
 */
export function ttlFromTranscript(jsonl: string): Ttl | null {
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (!line.includes('"cache_creation"')) {
      continue
    }
    const row = parseRow(line)
    const created = row?.isSidechain === true ? undefined : row?.message?.usage?.cache_creation
    if (!created) {
      continue
    }
    if ((created.ephemeral_5m_input_tokens ?? 0) > 0) {
      return '5m'
    }
    if ((created.ephemeral_1h_input_tokens ?? 0) > 0) {
      return '1h'
    }
  }

  return null
}

type TranscriptRow = {
  isSidechain?: boolean
  message?: {
    usage?: {
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null
    }
  }
}

function parseRow(line: string): TranscriptRow | undefined {
  try {
    return JSON.parse(line) as TranscriptRow
  } catch {
    return undefined
  }
}

/**
 * The TTL the environment forces on the main conversation, following Claude
 * Code's precedence; null where it leaves the account's default.
 *
 * @param env the variables, unset ones undefined
 * @returns the TTL, or null
 */
export function ttlFromEnv(env: Record<string, string | undefined>): Ttl | null {
  if (isTruthy(env.FORCE_PROMPT_CACHING_5M)) {
    return '5m'
  }
  const explicit = env.CLAUDE_CODE_PROMPT_CACHE_TTL
  if (explicit === '5m' || explicit === '1h') {
    return explicit
  }

  return isTruthy(env.ENABLE_PROMPT_CACHING_1H) ? '1h' : null
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
}

/**
 * What a `/cache-timer` invocation asks for.
 */
export type CommandOutcome = { prefs: Prefs; text: string } | { open: true } | { text: string }

const USAGE =
  'Usage: /cache-timer [all | none | only <s,...> | on <s> | off <s> | toggle <s> | ttl auto|5m|1h | status]\n' +
  `Surfaces: ${SURFACES.join(', ')}`

/**
 * Parses `/cache-timer`'s arguments against the current preferences.
 *
 * @param args what followed the command
 * @param prefs the preferences now
 * @returns new preferences with a summary, a request to open the pane, or text
 */
export function parseCommand(args: string, prefs: Prefs): CommandOutcome {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const names = rest.join(',').split(',').map(s => s.trim()).filter(Boolean)
  const unknown = names.filter(n => !(SURFACES as readonly string[]).includes(n))
  const picked = names.filter((n): n is Surface => (SURFACES as readonly string[]).includes(n))
  const set = (surfaces: Surface[]): CommandOutcome => {
    const next = { ...prefs, surfaces: SURFACES.filter(s => surfaces.includes(s)) }

    return { prefs: next, text: describePrefs(next) }
  }

  switch (verb) {
    case '':
      return { open: true }
    case 'status':
      return { text: describePrefs(prefs) }
    case 'all':
      return set([...SURFACES])
    case 'none':
      return set([])
    case 'ttl': {
      const ttl = rest[0]
      if (!(TTL_PREFS as readonly string[]).includes(ttl ?? '')) {
        return { text: `TTL must be one of ${TTL_PREFS.join(', ')}.\n${USAGE}` }
      }
      const next = { ...prefs, ttl: ttl as TtlPref }

      return { prefs: next, text: describePrefs(next) }
    }
    case 'only':
    case 'on':
    case 'off':
    case 'toggle': {
      if (unknown.length > 0 || picked.length === 0) {
        return { text: `${unknown.length > 0 ? `Unknown surface: ${unknown.join(', ')}\n` : ''}${USAGE}` }
      }
      if (verb === 'only') {
        return set(picked)
      }
      if (verb === 'on') {
        return set([...prefs.surfaces, ...picked])
      }
      if (verb === 'off') {
        return set(prefs.surfaces.filter(s => !picked.includes(s)))
      }

      return set(SURFACES.filter(s => prefs.surfaces.includes(s) !== picked.includes(s)))
    }
    default:
      return { text: USAGE }
  }
}

/**
 * One line naming the surfaces on and the TTL preference.
 *
 * @param prefs the preferences
 * @returns the summary
 */
export function describePrefs(prefs: Prefs): string {
  const on = prefs.surfaces.length > 0 ? prefs.surfaces.join(', ') : 'nothing'

  return `Cache timer shows in: ${on}. TTL: ${prefs.ttl}.`
}

/**
 * Normalises a stored preferences value, dropping what is no longer known.
 *
 * @param value what `$.store` held
 * @returns the preferences
 */
export function toPrefs(value: unknown): Prefs {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_PREFS
  }
  const raw = value as { surfaces?: unknown; ttl?: unknown }
  const surfaces = Array.isArray(raw.surfaces)
    ? SURFACES.filter(s => (raw.surfaces as unknown[]).includes(s))
    : DEFAULT_PREFS.surfaces
  const ttl = (TTL_PREFS as readonly unknown[]).includes(raw.ttl) ? (raw.ttl as TtlPref) : DEFAULT_PREFS.ttl

  return { surfaces, ttl }
}

async function savePrefs($: EngineInterface, fn: (prefs: Prefs) => Prefs): Promise<Prefs> {
  const next = await update($, prefsAtom, fn)
  await $.store.set(STORE_KEY, next)
  await refresh($)

  return next
}

let hinted: Ttl | null = null

async function loadHintedTtl($: EngineInterface): Promise<void> {
  hinted = ttlFromEnv({
    FORCE_PROMPT_CACHING_5M: await $.env.get('FORCE_PROMPT_CACHING_5M'),
    CLAUDE_CODE_PROMPT_CACHE_TTL: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    ENABLE_PROMPT_CACHING_1H: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
  })
}

async function ttlNow($: EngineInterface): Promise<Ttl> {
  return effectiveTtl((await read($, prefsAtom)).ttl, await read($, detectedAtom), hinted)
}

async function currentReading($: EngineInterface): Promise<Reading> {
  return readingAt(await read($, stampAtom), await ttlNow($), await read($, nowAtom))
}

let lastWarned: { sentAt: number; soon: boolean; cold: boolean } = { sentAt: -1, soon: false, cold: false }

/**
 * One tick of the clock: moves `now` (redrawing every reader) while the
 * entry is warm, and once more as it turns cold; keeps the status line and
 * raises the toasts.
 */
async function refresh($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const stamp = await read($, stampAtom)
  const prefs = await read($, prefsAtom)
  const ttl = await ttlNow($)
  const reading = readingAt(stamp, ttl, now)
  const shown = readingAt(stamp, ttl, await read($, nowAtom))
  if (reading.kind === 'warm' || reading.kind !== shown.kind) {
    await update($, nowAtom, () => now)
  }

  $.ui.status(prefs.surfaces.includes('status') && reading.kind !== 'idle' ? `⏱ ${shortLabel(reading)}` : undefined)

  if (stamp === null || !prefs.surfaces.includes('toast')) {
    return
  }
  if (lastWarned.sentAt !== stamp.sentAt) {
    lastWarned = { sentAt: stamp.sentAt, soon: false, cold: false }
  }
  if (reading.kind === 'warm' && reading.leftMs <= WARN_MS && !lastWarned.soon) {
    lastWarned = { ...lastWarned, soon: true }
    $.ui.toast(`Prompt cache expires in ${formatClock(reading.leftMs)}`)
  }
  if (reading.kind === 'cold' && !lastWarned.cold) {
    lastWarned = { ...lastWarned, soon: true, cold: true }
    $.ui.toast('Prompt cache has likely expired; the next prompt re-writes it')
  }
}

/**
 * Reads the last cache write's TTL from the transcript. The turn's last
 * response can land in the file just after Stop fires, so a miss is tried
 * once more two seconds later.
 */
async function detectTtl($: EngineInterface, transcriptPath: string, isRetry: boolean): Promise<void> {
  const prefs = await read($, prefsAtom)
  if (prefs.ttl !== 'auto' || transcriptPath === '') {
    return
  }
  const text = await transcriptTail($, transcriptPath)
  const ttl = ttlFromTranscript(text)
  $.ui.log(`cache-timer: transcript TTL ${ttl ?? 'not found'} (${text.length} chars read)`, { to: 'debug' })
  if (ttl === null) {
    if (!isRetry) {
      $.clock.after(2000, () => detectTtl($, transcriptPath, true))
    }

    return
  }
  await update($, detectedAtom, () => ttl)
  await refresh($)
}

/**
 * The transcript's text, or its last 2 MiB once it outgrows what `$.fs.read`
 * takes (4 MiB); a cut first line fails to parse and is skipped.
 */
async function transcriptTail($: EngineInterface, path: string): Promise<string> {
  const whole = await $.fs.read(path).catch(() => undefined)
  if (typeof whole === 'string') {
    return whole
  }
  const ran = await $.process.run(['tail', '-c', '2097152', path], { timeoutMs: 5000 }).catch(() => undefined)

  return ran?.exitCode === 0 ? ran.stdout : ''
}

async function openPane($: EngineInterface, focus: boolean): Promise<void> {
  await $.ui.open(focus ? { id: PANE, title: 'Cache timer', focus: true } : { id: PANE, title: 'Cache timer' })
}

async function isOn($: EngineInterface, surface: Surface): Promise<boolean> {
  return (await read($, prefsAtom)).surfaces.includes(surface)
}

const durationExpiry = new Map<string, number | null>()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_KEY)
    const prefs = await update($, prefsAtom, () => toPrefs(stored))
    await loadHintedTtl($)
    await $.command.register({
      name: 'cache-timer',
      description: 'Pick where the prompt-cache countdown shows (no argument opens the settings pane)',
      argumentHint: '[all | none | only <s,...> | on|off|toggle <s> | ttl auto|5m|1h | status]',
    })
    $.clock.every(1000, () => refresh($))
    if (prefs.surfaces.includes('pane')) {
      void openPane($, false)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, stampAtom, () => null)
      await refresh($)
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, stampAtom, () => null)
      await refresh($)
    }

    return result
  })

  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    if (e.agentId === undefined && usage !== null) {
      const isCached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens > 0
      await update($, stampAtom, () => ({ sentAt, isCached, model: usage.model }))
      await refresh($)
    }

    return result
  })

  on('classic.Stop', async ($, e, next) => {
    await detectTtl($, e.transcript_path, false)

    return next(e)
  })

  on('command.run', { command: 'cache-timer' }, async ($, e) => {
    const outcome = parseCommand(e.args, await read($, prefsAtom))
    if ('open' in outcome) {
      await openPane($, true)

      return { text: 'Opened the cache timer settings pane.' }
    }
    if ('prefs' in outcome) {
      const prefs = await savePrefs($, () => outcome.prefs)
      if (prefs.surfaces.includes('pane')) {
        await openPane($, false)
      }
    }

    return { text: outcome.text }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await isOn($, 'band'))) {
      return next(e)
    }
    const reading = await currentReading($)
    if (reading.kind === 'idle') {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>Prompt cache </Text>
        <Text color={readingColor(reading)}>{bandText(reading)}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!(await isOn($, 'hint'))) {
      return next(e)
    }
    const label = shortLabel(await currentReading($))
    if (label === '') {
      return next(e)
    }
    const tail = e.props.tail ? `${e.props.tail} · ${label}` : ` · ${label}`

    return next({ ...e, props: { ...e.props, tail } })
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!(await isOn($, 'mode'))) {
      return next(e)
    }
    const label = shortLabel(await currentReading($))

    return label === '' ? next(e) : next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!(await isOn($, 'spinner'))) {
      return next(e)
    }
    const label = shortLabel(await currentReading($))

    return label === '' ? next(e) : next({ ...e, props: { ...e.props, suffix: `${e.props.suffix} · ${label}` } })
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (!(await isOn($, 'duration'))) {
      return next(e)
    }
    if (!durationExpiry.has(e.requestId)) {
      const reading = await currentReading($)
      durationExpiry.set(e.requestId, reading.kind === 'warm' ? reading.expiresAt : null)
    }
    const expiresAt = durationExpiry.get(e.requestId)
    if (expiresAt === null || expiresAt === undefined) {
      return next(e)
    }
    const { Text } = $.ui.resolve(e)

    return (
      <Text dimColor>
        {`✻ ${e.props.word} for ${formatDuration(e.props.durationMs)} · cache warm until ${formatTime(expiresAt)}`}
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const prefs = await read($, prefsAtom)
    const stamp = await read($, stampAtom)
    const detected = await read($, detectedAtom)
    const reading = await currentReading($)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={readingColor(reading)}>
            {reading.kind === 'idle' ? 'No main-thread request yet' : bandText(reading)}
          </Text>
          <Text dimColor>
            TTL {prefs.ttl}
            {prefs.ttl === 'auto' ? ` (${detected === null ? 'not seen yet' : `last write ${detected}`})` : ''}
            {stamp === null ? '' : ` · ${stamp.model}`}
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text dimColor>Show in</Text>
          {SURFACES.map(s => (
            <Button
              key={`surface-${s}`}
              plain
              label={`${prefs.surfaces.includes(s) ? '✓' : '·'} ${SURFACE_LABEL[s]}`}
              onPress={() => toggleSurface($, s)}
            />
          ))}
        </Box>
        <Box gap={1}>
          <Text dimColor>TTL</Text>
          {TTL_PREFS.map(t => (
            <Button
              key={`ttl-${t}`}
              label={t}
              variant={prefs.ttl === t ? 'primary' : 'secondary'}
              onPress={() => setTtl($, t)}
            />
          ))}
        </Box>
        <Box gap={1}>
          <Button key="all" label="All" onPress={() => setSurfaces($, [...SURFACES])} />
          <Button key="none" label="None" onPress={() => setSurfaces($, [])} />
        </Box>
      </Box>
    )
  })
}

function bandText(reading: Reading): string {
  switch (reading.kind) {
    case 'idle':
      return ''
    case 'uncached':
      return 'not in use (nothing was cached)'
    case 'warm':
      return `${formatClock(reading.leftMs)} left · ${reading.ttl} TTL · until ${formatTime(reading.expiresAt)}`
    case 'cold':
      return `likely expired at ${formatTime(reading.expiresAt)} · ${reading.ttl} TTL`
  }
}

async function toggleSurface($: EngineInterface, surface: Surface): Promise<void> {
  await savePrefs($, prefs => ({
    ...prefs,
    surfaces: SURFACES.filter(s => (s === surface ? !prefs.surfaces.includes(s) : prefs.surfaces.includes(s))),
  }))
}

async function setTtl($: EngineInterface, ttl: TtlPref): Promise<void> {
  await savePrefs($, prefs => ({ ...prefs, ttl }))
}

async function setSurfaces($: EngineInterface, surfaces: Surface[]): Promise<void> {
  await savePrefs($, prefs => ({ ...prefs, surfaces }))
}
