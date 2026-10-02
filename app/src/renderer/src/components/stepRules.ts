/** Which setup wizard steps may be left with Next. Account (0) is skippable, so Skip needs no rule. */
export type StepCtx = { signedIn: boolean; toolsDone: boolean; ghOk: boolean; hasPrimaryRepo: boolean; finding: boolean }

export function canAdvance(step: number, c: StepCtx): boolean {
  switch (step) {
    case 0: return c.signedIn
    case 1: return c.toolsDone
    case 2: return c.ghOk
    case 3: return c.hasPrimaryRepo && !c.finding
    default: return true
  }
}
