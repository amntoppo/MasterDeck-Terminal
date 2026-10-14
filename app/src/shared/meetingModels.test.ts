import { describe, expect, it } from 'vitest'
import { defaultModel, MODEL_OPS, MODELS, modelById, modelSize } from './meetingModels'
import { normalizeMeetings } from './meetings'

describe('meetingModels', () => {
  it('each model has a real size, a SHA-256 and the repository URL of its file', () => {
    expect(MODELS.map((m) => m.label)).toEqual(['Best', 'Fast'])
    for (const m of MODELS) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(Number.isInteger(m.bytes) && m.bytes > 100_000_000).toBe(true)
      expect(m.url).toBe(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`)
      expect(m.file).toMatch(/^ggml-[\w.-]+\.bin$/)
      // The id is what settings.meetings.model keeps: normalizeMeetings must accept it.
      expect(normalizeMeetings({ model: m.id }).model).toBe(m.id)
    }
  })

  it('Best on Apple Silicon, Fast on Intel', () => {
    expect(defaultModel('arm64').label).toBe('Best')
    expect(defaultModel('x64').label).toBe('Fast')
  })

  it('looks up only known ids', () => {
    expect(modelById('base')?.file).toBe('ggml-base.bin')
    for (const bad of ['../x', '', null, 3, 'ggml-base.bin']) expect(modelById(bad)).toBeNull()
  })

  it('sizes read as MB or GB', () => {
    expect(modelSize(574_041_195)).toBe('574 MB')
    expect(modelSize(147_951_465)).toBe('148 MB')
    expect(modelSize(1_600_000_000)).toBe('1.6 GB')
    expect(MODEL_OPS).toContain('download')
  })
})
