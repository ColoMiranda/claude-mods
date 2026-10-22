import type { AgentInfo, TurnCompleteReason } from 'claude-code'

import type { TeamBoardAgent, TeamBoardStatus } from '../types'

// `isIdle`: the idle_notification JSON shape, a follow-up note to the lead.
export type TeamMessage = { name: string; summary?: string; body: string; isIdle?: boolean }

// An unclosed frame ends at the next frame or at the end of the text.
const FRAME =
  /<teammate-message\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(?:<\/teammate-message>|(?=<teammate-message\b)|$)/g
const ATTR = /([\w-]+)=(?:"([^"]*)"|'([^']*)')/g
const ENTITY: Record<string, string> = { '&quot;': '"', '&lt;': '<', '&gt;': '>', '&amp;': '&' }

// ponytail: keyword heuristic over the headline alone (the summary, else the
// body's first line). It skips a keyword negated before it ("sin captcha",
// "nothing was blocked", "not, as far as I can tell, blocked"), said as a
// condition ("when an agent turns blocked"), answered "none" after a colon, or
// followed by solved/handled/fixed; anything phrased otherwise slips through.
// Upgrade path: a structured status field in the teammate's idle notification,
// or a one-line $.model.complete classification of the headline.
const BLOCKED = new RegExp(
  [
    String.raw`(?<!\b(?:sin|no|ni|without|never|nobody|ningun[oa]?|when|if|whether|once|turns?|becomes?|gets?)\b[^.,;:\n]{0,15})`,
    String.raw`(?<!(?:\bnot|\bnothing|n't)\b[^.;:\n]{0,30})`,
    String.raw`\b(?:captcha|capcha|blocked|bloque(?:ad[oa]s?|os?|ó)|eres un bot|(?:i'm|i am|am|still|got)\s+stuck|waiting for you|permission denied|need you to|necesito que|can(?:not|'t) (?:continue|proceed)|no puedo (?:seguir|continuar)|login wall)(?![\wáéíóúñ])`,
    String.raw`(?![^\n]{0,20}?:[\s*_]*(?:ningun[oa]?|none|nada|0)\b)`,
    String.raw`(?![^.\n]{0,30}\b(?:solved|resolved|handled|fixed|cleared|resuelt[oa]|solucionad[oa]|arreglad[oa])\b)`,
  ].join(''),
  'i',
)

// Every teammate frame in a row's text, in order: the idle_notification JSON
// shape (its `result` is the body) and the free-text shape with a summary.
export function parseTeammateMessages(text: string): TeamMessage[] {
  return [...text.matchAll(FRAME)].flatMap(([, attrText = '', inner = '']) => {
    const attrs = attrsOf(attrText)
    const name = attrs.teammate_id

    return name ? [{ ...toMessage(name, inner), summary: attrs.summary }] : []
  })
}

// A frame's attributes, entities decoded.
function attrsOf(attrText: string): Record<string, string | undefined> {
  return Object.fromEntries(
    [...attrText.matchAll(ATTR)].map(([, k, dq, sq]) => [k, (dq ?? sq ?? '').replace(/&(?:quot|lt|gt|amp);/g, one => ENTITY[one] ?? one)]),
  )
}

// One frame's body: an idle_notification's `result`, else the text itself.
export function toMessage(name: string, inner: string): TeamMessage {
  const json = parseJson(inner.trim())
  if (!json) return { name, body: inner.trim() }

  return { name, body: typeof json.result === 'string' ? json.result : '', isIdle: json.type === 'idle_notification' }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith('{')) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// The first non-empty line, markdown emphasis and list marks stripped.
export function headline(text: string): string {
  const line = text.split('\n').find(one => one.trim() !== '') ?? ''
  return line.replace(/[*_`#>]/g, '').replace(/^\s*[-\d.]+\s+/, '').trim()
}

// The headline of `text` when it trips the heuristic, else undefined. Pass
// the summary when there is one, else the body.
export function blockedReason(text: string): string | undefined {
  const line = headline(text)
  return BLOCKED.test(line) ? line : undefined
}

// The row a message updates: `key` when the caller knows it (a subagent's
// id), else the latest row labelled with the sender's name. A message that
// reads as blocked blocks the row; one that does not clears it, bar one case:
// a blocked summary (not an idle note) is followed by an idle note that echoes
// the same turn ("Report sent to team-lead."), which may refresh blocked but
// never clears it. Every message after the echo that is not blocked does. A
// row an idle note blocked has no echo due.
export function applyMessage(agents: readonly TeamBoardAgent[], m: TeamMessage, key?: string): TeamBoardAgent[] {
  const prev = key !== undefined ? agents.find(a => a.key === key) : agents.findLast(a => a.name === m.name)
  const said = blockedReason(m.summary ?? m.body)
  const isEcho = m.isIdle === true && prev?.status === 'blocked' && prev.isEchoDue === true
  const reason = said ?? (isEcho ? prev?.reason : undefined)
  const status: TeamBoardStatus = reason !== undefined ? 'blocked' : 'done'
  const next: TeamBoardAgent = {
    ...prev,
    key: prev?.key ?? key ?? m.name,
    name: prev?.name ?? m.name,
    // A row a teammate message starts is named by it; a row that exists keeps
    // what made it (a subagent's own last message carries only its label).
    isNamed: prev ? prev.isNamed : true,
    doing: m.summary ?? (headline(m.body) || prev?.doing || ''),
    status,
    reason,
    isEchoDue: status === 'blocked' && !m.isIdle ? true : undefined,
    blockedTurnId: status === 'blocked' ? prev?.lastTurnId : undefined,
  }

  return prev ? agents.map(a => (a === prev ? next : a)) : [...agents, next]
}

// The row an agent id names: its key (a spawn's id), else its loop id (a row a
// teammate's message keyed by name first).
export function rowFor(agents: readonly TeamBoardAgent[], id: string): TeamBoardAgent | undefined {
  return agents.find(a => a.key === id || a.loopId === id)
}

// An agent's run ended and left its last words (its turn.complete answer, its
// SubagentStop message): done or blocked as
// applyMessage reads them, and the turn it ended in (given, else its latest
// step's) recorded, so a late step in that turn cannot wake it (see markStep).
// A row blocked in that same turn stays as it is when the words are not
// blocked: a teammate that said it was stuck mid-turn ends the turn on
// something like "Report sent." Applied twice (a SubagentStop, then the
// turn.complete with the same words), it lands the same row.
// Never adds a row: an id the board does not know is not an agent of its own.
export function finishRun(agents: readonly TeamBoardAgent[], key: string, m: TeamMessage, turnId?: string): TeamBoardAgent[] {
  const prev = agents.find(a => a.key === key)
  if (!prev) return [...agents]
  const turn = turnId ?? prev.lastTurnId
  const isHeld = prev.status === 'blocked' && turn !== undefined && prev.blockedTurnId === turn && blockedReason(m.summary ?? m.body) === undefined
  if (isHeld) return [...agents]

  return applyMessage(agents, m, key).map(a =>
    a.key !== key ? a : a.status === 'done' ? { ...a, doneTurnId: turn ?? a.doneTurnId } : { ...a, blockedTurnId: turn ?? a.blockedTurnId },
  )
}

// An agent's run ended in a known state with no words to read (a task
// notification, an interrupt, an API error): `reason` is a blocked row's note,
// and the note it was doing stays. The turn is recorded as finishRun does.
// Never adds a row.
export function endRun(agents: readonly TeamBoardAgent[], key: string, status: 'done' | 'blocked', reason?: string, turnId?: string): TeamBoardAgent[] {
  const prev = agents.find(a => a.key === key)
  if (!prev) return [...agents]
  const turn = turnId ?? prev.lastTurnId
  const next: TeamBoardAgent = {
    ...prev,
    status,
    reason: status === 'blocked' ? reason : undefined,
    isEchoDue: undefined,
    blockedTurnId: status === 'blocked' ? (turn ?? prev.blockedTurnId) : undefined,
    doneTurnId: status === 'done' ? (turn ?? prev.doneTurnId) : undefined,
  }

  return agents.map(a => (a === prev ? next : a))
}

// How a turn of an agent's loop ended (its turn.complete). An answer is its
// last words (finishRun); an interrupt is done; an API error or a refusal left
// the work unfinished and needs the lead: blocked, with a short reason.
export type TurnEnd = { reason: TurnCompleteReason; answer: string; turnId: string; refusal?: string | null }
export function endTurn(agents: readonly TeamBoardAgent[], key: string, name: string, end: TurnEnd): TeamBoardAgent[] {
  if (end.reason === 'answer') return finishRun(agents, key, toMessage(name, end.answer), end.turnId)
  if (end.reason === 'aborted') return endRun(agents, key, 'done', undefined, end.turnId)
  const reason = end.reason === 'error' ? 'Stopped on an API error' : `Refused${end.refusal ? `: ${end.refusal}` : ''}`

  return endRun(agents, key, 'blocked', reason, end.turnId)
}

// The engine's note to the lead when a background task stops: an agent's, or a
// background shell's. `id` is the task's id (a spawned agent's agentId);
// `toolUseId` the Agent call's, which keys a spawn that returned no agentId.
export type TaskNote = { id?: string; toolUseId?: string; status?: string; summary?: string }

const TASK_NOTE = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g
// Each tag's first occurrence: the engine writes them in a fixed order, the
// free text (`<result>`, which may quote anything) last.
const tagText = (inner: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(inner)?.[1]?.trim()

export function parseTaskNotes(text: string): TaskNote[] {
  return [...text.matchAll(TASK_NOTE)].map(([, inner = '']) => ({
    id: tagText(inner, 'task-id'),
    toolUseId: tagText(inner, 'tool-use-id'),
    status: tagText(inner, 'status'),
    summary: tagText(inner, 'summary'),
  }))
}

// A task note against the board. Completed is done, but only for a row still
// working: a row its turn.complete already finished keeps its
// note, and a blocked one its block. Failed is blocked, its summary the reason
// (the lead has to look); killed is done, as the person stopped it. A task the
// board does not know (a background shell, a cleared agent) changes nothing.
export function applyTaskNote(agents: readonly TeamBoardAgent[], note: TaskNote): TeamBoardAgent[] {
  const prev = (note.id !== undefined ? rowFor(agents, note.id) : undefined) ?? agents.find(a => a.key === note.toolUseId)
  if (!prev) return [...agents]
  if (note.status === 'failed') return endRun(agents, prev.key, 'blocked', note.summary || 'Failed')
  if (note.status === 'killed') return endRun(agents, prev.key, 'done')
  if (note.status === 'completed' && prev.status === 'working') return endRun(agents, prev.key, 'done')

  return [...agents]
}

// A row still working whose agent $.agent.list() says has stopped (events the
// board missed while it reloaded, or a row stuck by an older version): done,
// or blocked when it failed. A row the list does not name is left as it is:
// one keyed by a teammate's name or a spawn's tool_use_id is not listed by
// that key, so not being listed proves nothing.
export function reconcile(agents: readonly TeamBoardAgent[], infos: readonly AgentInfo[]): TeamBoardAgent[] {
  return agents.reduce<TeamBoardAgent[]>((acc, a) => {
    const info = a.status === 'working' ? infos.find(one => one.id === a.key || one.id === a.loopId) : undefined
    if (info?.status === 'failed') return endRun(acc, a.key, 'blocked', 'Failed')
    if (info?.status === 'completed' || info?.status === 'killed') return endRun(acc, a.key, 'done')
    return acc
  }, [...agents])
}

// An agent started, or was handed new work: working, blocked and done cleared.
export function markWorking(agents: readonly TeamBoardAgent[], key: string, patch: Partial<TeamBoardAgent> = {}): TeamBoardAgent[] {
  const prev = agents.find(a => a.key === key)
  const next: TeamBoardAgent = {
    name: key,
    doing: '',
    ...prev,
    ...patch,
    key,
    status: 'working',
    reason: undefined,
    isEchoDue: undefined,
    blockedTurnId: undefined,
    doneTurnId: undefined,
  }

  return prev ? agents.map(a => (a === prev ? next : a)) : [...agents, next]
}

// A step of an agent's loop (`patch.lastTurnId` is the step's turn): working.
// A blocked row stays blocked through a step in the turn it turned blocked, the
// agent finishing the turn in which it said it was stuck, and a finished row
// stays done through a step in the turn it finished in, a late step of a run
// that already ended; a step in another turn means the agent is awake again. A
// row with no recorded turn (a peer) counts every step as a new turn. Model,
// effort and loop id land either way.
export function markStep(agents: readonly TeamBoardAgent[], key: string, patch: Partial<TeamBoardAgent> = {}): TeamBoardAgent[] {
  const prev = agents.find(a => a.key === key)
  const heldTurn = prev?.status === 'blocked' ? prev.blockedTurnId : prev?.status === 'done' ? prev.doneTurnId : undefined
  const isSameTurn = heldTurn !== undefined && heldTurn === patch.lastTurnId
  if (!isSameTurn) return markWorking(agents, key, patch)

  return agents.map(a => (a === prev ? { ...prev, ...patch, key } : a))
}

// Stamps a row an update just wrote against the row it replaced: entering
// working starts a stretch (and clears the last stop), leaving working ends
// it, any other change keeps the stamps. A row never seen working has neither.
export function stamp(agent: TeamBoardAgent, prev: TeamBoardAgent | undefined, now: number): TeamBoardAgent {
  const wasWorking = prev?.status === 'working'
  if (agent.status === 'working' && !wasWorking) return { ...agent, startedAt: now, stoppedAt: undefined }
  if (agent.status !== 'working' && wasWorking) return { ...agent, stoppedAt: now }

  return agent
}

// How long the latest work stretch ran: up to `now` while the agent works,
// else up to when it stopped. Undefined for a row never seen working.
export function workedMs(agent: TeamBoardAgent, now: number): number | undefined {
  const end = agent.status === 'working' ? now : agent.stoppedAt
  return agent.startedAt === undefined || end === undefined ? undefined : end - agent.startedAt
}

// A clear remembers the names of the rows it removes, bar a name a remaining
// row has: a late message from a cleared agent (the idle note it sends after
// it finishes) must not bring its row back.
export function addCleared(cleared: readonly string[], gone: readonly TeamBoardAgent[], kept: readonly TeamBoardAgent[]): string[] {
  const names = gone.map(a => a.name).filter(name => !kept.some(a => a.name === name))
  return [...new Set([...cleared, ...names])]
}

// An agent back on the board (a message or a step brought its row back, in any
// state) is heard again: its name leaves the cleared list.
export function dropCleared(cleared: readonly string[], agents: readonly TeamBoardAgent[]): string[] {
  return cleared.filter(name => !agents.some(a => a.name === name))
}

// The messages that count. A cleared agent is silent only for the idle note it
// sends after it finished, and only if that note is not blocked: a real message,
// or a blocker, brings its row back.
export function heardFrom(messages: readonly TeamMessage[], cleared: readonly string[]): TeamMessage[] {
  return messages.filter(m => !(cleared.includes(m.name) && m.isIdle && blockedReason(m.summary ?? m.body) === undefined))
}

// Each state's icon and word, in the pane, the fold line and the footer.
export const STATE = {
  done: { icon: '✔', label: 'DONE' },
  working: { icon: '▶', label: 'WORKING' },
  blocked: { icon: '✖', label: 'BLOCKED' },
} as const

export function countLine(agents: readonly TeamBoardAgent[]): string {
  const parts = (['done', 'working', 'blocked'] as const)
    .map(status => [agents.filter(a => a.status === status).length, status] as const)
    .filter(([n]) => n > 0)
    .map(([n, status]) => `${STATE[status].icon}${n} ${STATE[status].label}`)

  return parts.length === 0 ? 'NO AGENTS YET' : parts.join('  ')
}

// "claude-opus-5-5" -> "OPUS 5.5", "claude-haiku-4-5-20251001" -> "HAIKU 4.5",
// "sonnet" -> "SONNET"; anything else upper-cased as given.
export function modelLabel(model: string | undefined): string {
  if (!model) return '?'
  const m = /^(?:claude-)?([a-z]+)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?(?:\[.*\])?$/i.exec(model)
  if (!m) return model.toUpperCase()
  const [, family = '', major, minor] = m
  return [family.toUpperCase(), major && (minor ? `${major}.${minor}` : major)].filter(Boolean).join(' ')
}

// The spinner a working agent shows in place of its icon, one frame per tick.
export const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

// 950 -> "950", 45123 -> "45.1k", 2300000 -> "2.3M".
export function tokenLabel(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// 45000 -> "45s", 133000 -> "2m 13s", 3840000 -> "1h 04m"; a clock set back
// reads "0s".
export function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return `${seconds}s`
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function effortLabel(effort: string | number | undefined): string {
  return effort === undefined ? '?' : String(effort).toUpperCase()
}

// One dim transcript line per message: "✔ QA-PAGES-B DONE Round 3 verified".
export function foldLine(m: TeamMessage): string {
  const reason = blockedReason(m.summary ?? m.body)
  const s = STATE[reason !== undefined ? 'blocked' : 'done']

  return `${s.icon} ${m.name.toUpperCase()} ${s.label} ${reason ?? m.summary ?? headline(m.body)}`
}

// What a reply to the row starts the prompt with. A row keyed by something
// other than its name (a spawn or loop id) names the id too, so the lead can
// message that agent and not its type.
export function replyPrefix(agent: TeamBoardAgent): string {
  return agent.isNamed === true || agent.key === agent.name ? `Tell ${agent.name}: ` : `Tell ${agent.name} (${agent.key}): `
}

// A reply prefix at the start of a draft: "Tell scout: " or "Tell scout (a1): ".
const REPLY_PREFIX = /^Tell [^:\n]{1,80}: /

// The prompt box after a reply: `prefix` ahead of the draft, which stays. One
// reply prefix the draft already starts with, whoever it names, is swapped, not
// stacked.
export function replyText(prefix: string, draft: string): string {
  return prefix + draft.replace(REPLY_PREFIX, '')
}
