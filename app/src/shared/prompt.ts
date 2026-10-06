/**
 * The first message a new session gets: master's ASSIGN prompt, plus the ticket's description and
 * the user's own first instructions when either is given. The ASSIGN prompt says to stop and ask for
 * instructions (its step 3); with either given, the session is told to use them instead of asking.
 */
export function composePrompt(system: string, instructions: string, description = '', earlier = '', setup = ''): string {
  // `setup`: what MasterDeck already did for the session (the worktree it made), said with the system prompt.
  const sys = [system.trim(), setup.trim()].filter(Boolean).join('\n\n')
  const own = instructions.trim()
  const desc = description.trim()
  const past = earlier.trim()
  const parts = [sys]
  if (own || desc) {
    const what = desc && own ? "The ticket's description and the user's first instructions are" : desc ? "The ticket's description is" : "The user's first instructions are"
    parts[0] = `${sys}\n\n${what} below; follow ${desc && !own ? 'it' : 'them'} instead of stopping to ask in step 3.`
  }
  // Context, not instructions: what earlier sessions on this ticket already did.
  if (past) parts.push(`## What earlier sessions on this ticket did (from their summaries)\n\n${past}`)
  if (desc) parts.push(`## The ticket's description\n\n${desc}`)
  if (own) parts.push(`## The user's first instructions\n\n${own}`)
  return parts.join('\n\n')
}

/** Earlier sessions' summaries as one block for the first prompt (the newest three). */
export function earlierBlock(list: { name: string; at: number; text: string }[]): string {
  return list
    .slice(0, 3)
    .map((e) => `### ${e.name} (${new Date(e.at).toISOString().slice(0, 10)})\n\n${e.text.trim().length > 2500 ? `${e.text.trim().slice(0, 2500)}…` : e.text.trim()}`)
    .join('\n\n')
}
