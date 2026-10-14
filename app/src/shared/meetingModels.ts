/**
 * The speech models meetings can transcribe with: whisper.cpp's GGML files from its model
 * repository on Hugging Face. `bytes` and `sha256` are the repository's LFS size and oid for each
 * file (https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main, 2026-10-10); a
 * download that does not match both is thrown away.
 */
export interface SpeechModel {
  /** Stored in settings.meetings.model. */
  id: string
  label: string
  hint: string
  /** The file's name in the repository and under MASTERDECK_HOME/meetings/models. */
  file: string
  bytes: number
  sha256: string
  url: string
}

const REPO = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export const MODELS: readonly SpeechModel[] = [
  {
    id: 'large-v3-turbo-q5_0',
    label: 'Best',
    hint: 'The most accurate. Best on Apple Silicon.',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    bytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    url: `${REPO}/ggml-large-v3-turbo-q5_0.bin`,
  },
  {
    id: 'base',
    label: 'Fast',
    hint: 'Smaller and quicker, less accurate. Best on Intel.',
    file: 'ggml-base.bin',
    bytes: 147_951_465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    url: `${REPO}/ggml-base.bin`,
  },
]

export function modelById(id: unknown): SpeechModel | null {
  return MODELS.find((m) => m.id === id) ?? null
}

/** Best on Apple Silicon (Metal), Fast on Intel (the CPU only). */
export function defaultModel(arch: string): SpeechModel {
  return modelById(arch === 'arm64' ? 'large-v3-turbo-q5_0' : 'base')!
}

/** "574 MB": a model's size as the setup screen shows it. */
export function modelSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

/** A download's progress (event meetings:modelProgress, the window only). */
export interface ModelProgress {
  id: string
  received: number
  total: number
  state: 'downloading' | 'done' | 'failed' | 'cancelled'
  message?: string
}

/** The answer of meetings:model: the models on disk, the one picked, a download running, the speech engine. */
export interface ModelsInfo {
  ok: true
  /** settings.meetings.model, or null before one was picked. */
  picked: string | null
  /** The model this Mac starts with (defaultModel). */
  suggested: string
  models: { id: string; label: string; hint: string; bytes: number; ready: boolean }[]
  downloading: ModelProgress | null
  /** Whether whisper-cli was found (the app's own, MASTERDECK_WHISPER or one on PATH). */
  engine: boolean
  message?: string
}
export type ModelsAnswer = ModelsInfo | { ok: false; message: string }

export type ModelOp = 'status' | 'pick' | 'download' | 'cancel' | 'remove'
export const MODEL_OPS: readonly ModelOp[] = ['status', 'pick', 'download', 'cancel', 'remove']
