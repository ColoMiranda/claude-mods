export type TeamBoardStatus = 'working' | 'done' | 'blocked'

// `key`: the agent's id when known (a spawn), else the teammate's name.
// `name`: the label (Agent({ name }), else the subagent type).
export type TeamBoardAgent = {
  key: string
  name: string
  doing: string
  status: TeamBoardStatus
  reason?: string
  // From the agent's latest model request (turn.step), else its spawn.
  model?: string
  effort?: string | number
  // Summed over the agent's model requests: input (cache reads and writes
  // included) and output.
  tokensIn?: number
  tokensOut?: number
  // The agent's loop id ($.agent.list()), when the row was keyed by name first
  // (a teammate is seen by its messages before its steps).
  loopId?: string
  // True when `name` is the agent's own (Agent({ name }), a teammate id): the
  // lead can message it by name. False or absent: `name` is its type.
  isNamed?: boolean
  // Epoch milliseconds of the agent's latest work stretch: `startedAt` when it
  // began working, `stoppedAt` when it stopped (unset while it works). A row
  // never seen working has neither.
  startedAt?: number
  stoppedAt?: number
  // The turn of the agent's latest model request (turn.step), the turn the row
  // turned blocked in, and the turn its run finished in (done): a step in that
  // same turn is the agent finishing it, a step in another turn is the agent
  // awake again. A row with no recorded turn counts every step as a new turn.
  lastTurnId?: string
  blockedTurnId?: string
  doneTurnId?: string
  // True after a blocked summary (not an idle note) turned the row blocked: the
  // agent's next idle note is the echo of that turn and cannot clear it.
  isEchoDue?: boolean
}

export type TeamBoardLead = { model?: string; effort?: string | number }

declare module 'claude-code' {
  interface PluginState {
    // `expanded`: the keys of the rows whose note shows in full. `cleared`: the
    // names of agents cleared from the board, whose late messages are not heard.
    'team-board': {
      agents: TeamBoardAgent[]
      hasAutoOpened: boolean
      lead: TeamBoardLead
      frame: number
      expanded: string[]
      cleared: string[]
    }
  }
}
