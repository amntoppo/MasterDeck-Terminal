/**
 * Does the end of a Claude Code screen look like a permission or choice prompt? Typing a message
 * followed by Enter there would pick an option instead of sending the message.
 */
export function looksLikePrompt(screenTail: string): boolean {
  // Strip ANSI escape codes, keep the last ~40 lines of text.
  const text = screenTail.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
  const tail = text.split(/\r?\n/).slice(-40).join('\n')
  return (
    /Do you want to (proceed|make this edit|create|run|allow|continue)/i.test(tail) ||
    /❯\s*1\.\s*(Yes|Allow)/.test(tail) ||
    /\b1\.\s*Yes\b[\s\S]{0,200}\b2\.\s*(Yes|No)/.test(tail) ||
    /Esc to cancel · Tab to amend/i.test(tail)
  )
}
