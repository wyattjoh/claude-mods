/**
 * A place the countdown can be drawn: the plugin status line, the band above
 * the prompt, the hint line's tail, the footer's mode labels, the spinner,
 * the line closing each turn, a pane, or toasts as the entry nears expiry.
 */
export type Surface = 'status' | 'band' | 'hint' | 'mode' | 'spinner' | 'duration' | 'pane' | 'toast'

/**
 * A cache entry's lifetime as the API names it.
 */
export type Ttl = '5m' | '1h'

/**
 * The TTL the countdown runs on: read from the transcript, or fixed.
 */
export type TtlPref = 'auto' | Ttl

/**
 * What the person chose with `/cache-timer`, kept across sessions.
 */
export type Prefs = {
  surfaces: Surface[]
  ttl: TtlPref
}

/**
 * The main thread's latest model request that came back with usage: when it
 * was sent, and whether it read or wrote the prompt cache at all.
 */
export type CacheStamp = {
  sentAt: number
  isCached: boolean
  model: string
}

declare module 'claude-code' {
  interface PluginState {
    'cache-timer': {
      prefs: Prefs
      stamp: CacheStamp | null
      detected: Ttl | null
      now: number
    }
  }
}
