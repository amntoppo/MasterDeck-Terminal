/** The id of a note request, as MasterDeck's pump takes it (digits-digits-digits). */
export function noteRequestId(nowMs: number, rand: number): string {
  return `${Math.floor(nowMs / 1000)}-0-${Math.floor(rand * 1_000_000_000)}`
}

/** MasterDeck's answer to a note request, as one line for the transcript. */
export function noteAnswerText(text: string): string {
  try {
    const a = JSON.parse(text) as { ok?: boolean; message?: string; error?: string }
    if (a.ok === true) return a.message ?? 'Added to the note.'
    return `Not saved: ${a.error ?? 'MasterDeck refused it.'}`
  } catch {
    return 'MasterDeck answered something this mod cannot read; look in Notes.'
  }
}
