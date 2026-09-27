/**
 * The first message a new session gets: master's ASSIGN prompt, plus the ticket's description and
 * the user's own first instructions when either is given. The ASSIGN prompt says to stop and ask for
 * instructions (its step 3); with either given, the session is told to use them instead of asking.
 */
export function composePrompt(system: string, instructions: string, description = ''): string {
  const sys = system.trim()
  const own = instructions.trim()
  const desc = description.trim()
  if (!own && !desc) return sys
  const what = desc && own ? "The ticket's description and the user's first instructions are" : desc ? "The ticket's description is" : "The user's first instructions are"
  const parts = [`${sys}\n\n${what} below; follow ${desc && !own ? 'it' : 'them'} instead of stopping to ask in step 3.`]
  if (desc) parts.push(`## The ticket's description\n\n${desc}`)
  if (own) parts.push(`## The user's first instructions\n\n${own}`)
  return parts.join('\n\n')
}
