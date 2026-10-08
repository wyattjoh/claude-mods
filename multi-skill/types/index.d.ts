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

declare module 'claude-code' {
  interface PluginState {
    'multi-skill': {
      enabled: boolean | null
      loaded: string[]
      draft: DraftSkill[]
    }
  }
}
