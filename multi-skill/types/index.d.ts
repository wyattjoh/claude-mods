/**
 * Whether a first-line skill will be loaded on submit, was already loaded
 * this session, or has no SKILL.md the mod can find.
 */
export type SkillStatus = 'new' | 'loaded' | 'unresolved'

/**
 * One `/skill` matched on the draft's first line, for the band above the
 * prompt.
 */
export type DraftSkill = {
  name: string
  status: SkillStatus
  /**
   * What the skill relies on that is lost when it isn't the leading
   * `/skill` (`allowed-tools`, `model`, ...); empty when nothing is.
   */
  unsupported: string[]
}

/**
 * The skills one prompt activated, drawn under that prompt's transcript row.
 */
export type ActivationNote = {
  /**
   * The stored prompt row's id, once the row is kept; null until then.
   */
  uuid: string | null
  /**
   * The prompt as typed, for a row whose id never bound.
   */
  text: string
  /**
   * The session the prompt was typed in; the text fallback stays inside it.
   */
  sessionId: string
  /**
   * The line drawn under the row.
   */
  line: string
}

declare module 'claude-code' {
  interface PluginState {
    'multi-skill': {
      enabled: boolean | null
      loaded: string[]
      draft: DraftSkill[]
      notes: ActivationNote[]
    }
  }
}
