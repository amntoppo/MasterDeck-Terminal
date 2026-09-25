/**
 * The first message a new session gets: master's ASSIGN prompt, plus the user's own first
 * instructions when he wrote any. The ASSIGN prompt says to stop and ask for instructions (its
 * step 3); with instructions given, the session is told to use them instead of asking.
 */
export function composePrompt(system: string, instructions: string): string {
  const sys = system.trim()
  const own = instructions.trim()
  if (!own) return sys
  return `${sys}\n\nThe user's first instructions are below; follow them instead of stopping to ask in step 3.\n\n## The user's first instructions\n\n${own}`
}
