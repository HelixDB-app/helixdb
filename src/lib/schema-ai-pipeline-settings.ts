export type SchemaAiPipelineSettings = {
  runFeaturesPhase: boolean
  runDocsPhase: boolean
  runSavingStage: boolean
}

const SCHEMA_AI_PIPELINE_SETTINGS_KEY = 'schema_ai_pipeline_settings_v1'

export const DEFAULT_SCHEMA_AI_PIPELINE_SETTINGS: SchemaAiPipelineSettings = {
  runFeaturesPhase: true,
  runDocsPhase: true,
  runSavingStage: true,
}

function isBrowser(): boolean {
  return typeof window !== 'undefined'
}

export function loadSchemaAiPipelineSettings(): SchemaAiPipelineSettings {
  if (!isBrowser()) return DEFAULT_SCHEMA_AI_PIPELINE_SETTINGS
  try {
    const raw = window.localStorage.getItem(SCHEMA_AI_PIPELINE_SETTINGS_KEY)
    if (!raw) return DEFAULT_SCHEMA_AI_PIPELINE_SETTINGS
    const parsed = JSON.parse(raw) as Partial<SchemaAiPipelineSettings>
    return {
      runFeaturesPhase:
        typeof parsed.runFeaturesPhase === 'boolean'
          ? parsed.runFeaturesPhase
          : DEFAULT_SCHEMA_AI_PIPELINE_SETTINGS.runFeaturesPhase,
      runDocsPhase:
        typeof parsed.runDocsPhase === 'boolean'
          ? parsed.runDocsPhase
          : DEFAULT_SCHEMA_AI_PIPELINE_SETTINGS.runDocsPhase,
      runSavingStage:
        typeof parsed.runSavingStage === 'boolean'
          ? parsed.runSavingStage
          : DEFAULT_SCHEMA_AI_PIPELINE_SETTINGS.runSavingStage,
    }
  } catch {
    return DEFAULT_SCHEMA_AI_PIPELINE_SETTINGS
  }
}

export function saveSchemaAiPipelineSettings(
  settings: SchemaAiPipelineSettings
): void {
  if (!isBrowser()) return
  window.localStorage.setItem(
    SCHEMA_AI_PIPELINE_SETTINGS_KEY,
    JSON.stringify(settings)
  )
}
