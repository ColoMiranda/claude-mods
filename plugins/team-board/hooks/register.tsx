import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TeamBoardAgent, TeamBoardLead } from '../types'
import {
  SPINNER,
  STATE,
  addCleared,
  applyMessage,
  applyTaskNote,
  countLine,
  dropCleared,
  durationLabel,
  effortLabel,
  endTurn,
  finishRun,
  foldLine,
  heardFrom,
  markStep,
  markWorking,
  modelLabel,
  parseTaskNotes,
  parseTeammateMessages,
  reconcile,
  replyPrefix,
  replyText,
  rowFor,
  stamp,
  toMessage,
  tokenLabel,
  workedMs,
} from './parse'

const PANE = 'team'
const TITLE = 'TEAM'
const agents = atom({ plugin: 'team-board', key: 'agents' } as const, [])
const hasAutoOpened = atom({ plugin: 'team-board', key: 'hasAutoOpened' } as const, false)
const lead = atom({ plugin: 'team-board', key: 'lead' } as const, {} as TeamBoardLead)
const frame = atom({ plugin: 'team-board', key: 'frame' } as const, 0)
const expanded = atom({ plugin: 'team-board', key: 'expanded' } as const, [])
const cleared = atom({ plugin: 'team-board', key: 'cleared' } as const, [])

// The spinner's timer runs only while an agent works. A reload cancels the
// module's timers, and session.start restarts this one if it still has work.
let tick: { cancel: () => void } | undefined
function syncTick($: EngineInterface, list: readonly TeamBoardAgent[]) {
  const isWorking = list.some(one => one.status === 'working')
  if (isWorking && !tick) tick = $.clock.every(120, () => void update($, frame, n => (n + 1) % SPINNER.length))
  if (!isWorking && tick) {
    tick.cancel()
    tick = undefined
  }
}

// The origin kinds of a row from an agent: a teammate's drain stamps none, and
// another session's rows are peer rows. Any other kind is someone else's.
const AGENT_ORIGINS: ReadonlySet<string> = new Set(['unclassified', 'peer', 'peer-send-message'])

// Color means state only: names stay plain, so a teammate's own color (red,
// green) never reads as blocked or done.
const STATUS_COLOR = { working: 'yellow', done: 'green', blocked: 'red' } as const

// A row's more/less button: its note shows in full, or folds back to the line.
function toggleNote($: EngineInterface, key: string) {
  return update($, expanded, keys => (keys.includes(key) ? keys.filter(one => one !== key) : [...keys, key]))
}

// The clear button and /team clear: finished rows leave the board and close
// their notes, and their names are remembered (see addCleared).
async function clearDone($: EngineInterface) {
  let gone: TeamBoardAgent[] = []
  const kept = await update($, agents, list => {
    gone = list.filter(one => one.status === 'done')
    return list.filter(one => one.status !== 'done')
  })
  await update($, cleared, names => addCleared(names, gone, kept))
  await update($, expanded, keys => keys.filter(key => !gone.some(one => one.key === key)))
  await syncStatus($, kept)
}

// The reply button: the row's prefix ("Tell scout: ") goes in the prompt box
// ahead of what the person has typed, which stays. The mod sends nothing.
async function replyTo($: EngineInterface, agent: TeamBoardAgent) {
  const prefix = replyPrefix(agent)
  const { text } = await $.prompt.read()
  // An empty read can be a refused one (another plugin hooks prompt.read), and
  // a replace would wipe the draft: insert at the cursor instead.
  const filled =
    text === ''
      ? await $.prompt.fill({ text: prefix, mode: 'insert' })
      : await $.prompt.fill({ text: replyText(prefix, text) })
  if (!filled.isFilled) $.ui.toast(`Could not write "${prefix.trimEnd()}" in the prompt box`)
}

// This plugin's status line under the prompt. A clear is skipped while no line
// is up, which keeps a drawn pane from calling it on every spinner tick. It
// starts as maybe up: a reload does not unpin the line the old module set.
let isStatusUp = true
function setStatus($: EngineInterface, text: string | undefined) {
  if (text === undefined && !isStatusUp) return
  isStatusUp = text !== undefined
  $.ui.status(text)
}

// How many times the Pane render has run. syncStatus reads it before it awaits
// the panes: a draw during the wait is newer than the answer it brings.
let draws = 0

// One line under the prompt while the pane waits undrawn (narrow terminal).
// The terminal widening places the pane without an event of its own: the Pane
// render clears the line then (nothing else fires on a placement). If it drew
// while the panes were being asked, the answer is stale: the pane is placed.
async function syncStatus($: EngineInterface, list: readonly TeamBoardAgent[]) {
  const drawn = draws
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  const isWaiting = pane?.isPlaced === false && list.length > 0 && draws === drawn
  setStatus($, isWaiting ? `team: ${countLine(list)}` : undefined)
}

// Every status change comes through here, so this is the one place that stamps
// when a row starts or stops working (the pane reads the stamps).
async function change($: EngineInterface, fn: (list: TeamBoardAgent[]) => TeamBoardAgent[]) {
  const now = await $.clock.now()
  let before: TeamBoardAgent[] = []
  const after = await update($, agents, list => {
    before = list
    return fn(list).map(agent => stamp(agent, list.find(one => one.key === agent.key), now))
  })

  for (const agent of after) {
    const was = before.find(one => one.key === agent.key)
    if (agent.status === 'blocked' && was?.status !== 'blocked') {
      $.ui.toast(`${agent.name.toUpperCase()} BLOCKED: ${agent.reason ?? ''}`, { timeoutMs: 10000 })
    }
  }
  if (after.length > 0 && !(await read($, hasAutoOpened))) {
    await $.ui.open({ id: PANE, title: TITLE })
    await update($, hasAutoOpened, () => true)
  }
  // An agent that works again is heard again.
  await update($, cleared, names => dropCleared(names, after))
  syncTick($, after)
  await syncStatus($, after)
}

// The teammate messages in a row's text, as the board hears them: a cleared
// agent's idle note that is not blocked is not heard (see heardFrom).
async function hearText($: EngineInterface, text: string) {
  const messages = parseTeammateMessages(text)
  if (messages.length === 0) return
  const heard = heardFrom(messages, await read($, cleared))
  if (heard.length > 0) await change($, list => heard.reduce((acc, m) => applyMessage(acc, m), list))
}

// A row of the lead's conversation, as the board hears it: the engine's task
// notification when a background task stops (its own origin), the backup to
// turn.complete that touches only rows the board has, and teammate messages
// (hearText). A task notification typed by a person is not heard. A subagent's
// hand-back of its report is not read: its turn.complete, which comes first,
// already carries the same words.
async function hearRow($: EngineInterface, text: string, origin: string) {
  const notes = origin === 'task-notification' ? parseTaskNotes(text) : []
  if (notes.length > 0) await change($, list => notes.reduce(applyTaskNote, list))
  await hearText($, text)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'team',
      description: 'Show or hide the team pane, or clear its finished agents',
      argumentHint: '[clear]',
      immediate: true,
    })
    // Rows still working whose agent has stopped meanwhile (see reconcile).
    if ((await read($, agents)).some(one => one.status === 'working')) {
      const infos = await $.agent.list()
      await change($, list => reconcile(list, infos))
    }
    syncTick($, await read($, agents))

    return next(e)
  })

  on('command.run', { command: 'team' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await clearDone($)
      return {}
    }
    // A pane waiting unplaced counts as hidden: closing it and opening it
    // again from the person's command seats it at any width.
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (pane) await $.ui.close({ id: PANE })
    if (pane?.isPlaced !== true) await $.ui.open({ id: PANE, title: TITLE })
    await syncStatus($, await read($, agents))

    return {}
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    setStatus($, undefined)

    return closed
  })

  // Teammate messages and task notifications in the rows the main
  // conversation stores (see hearRow). Read only: the row goes on unchanged, so
  // the transcript and the model keep every word. It is stored first, so no $
  // call that hangs can hold it back. The board hears it awaited, not left
  // running: two rows heard at once would race, and the later could land first.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && e.message.role === 'user') {
      const text = e.message.content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n')
      await hearRow($, text, e.origin.kind)
    }

    return stored
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.deny === undefined) {
      // Keyed by id so two spawns of one description stay two rows; labelled
      // as UserMessageFrom.name is: the name, else the type.
      const key = spawned.agentId ?? e.tool_use_id
      await change($, list => markWorking(list, key, { name: e.name ?? e.subagentType, isNamed: e.name !== undefined, doing: e.description, model: spawned.model }))
    }

    return spawned
  })

  // An agent's run ended: its last words are its state (see endTurn). Every
  // subagent run and every teammate turn raises it, foreground or background,
  // so this is how the board learns an agent finished. A teammate goes done
  // between turns, and its next turn's step wakes it.
  on('turn.complete', async ($, e, next) => {
    const agent = e.agentId === undefined ? undefined : rowFor(await read($, agents), e.agentId)
    if (agent) {
      const end = { reason: e.reason, answer: e.answer, turnId: e.turnId, refusal: e.reason === 'refusal' ? e.refusal.explanation : undefined }
      await change($, list => endTurn(list, agent.key, agent.name, end))
    }

    return next(e)
  })

  // The same end, where a classic hook is not bypassed: it lands the row first,
  // and turn.complete lands it again the same (see finishRun). A plugin seated
  // above may bypass classic hooks for user plugins, so the board never relies
  // on it.
  on('classic.SubagentStop', async ($, e, next) => {
    const agent = rowFor(await read($, agents), e.agent_id)
    if (agent) await change($, list => finishRun(list, agent.key, toMessage(agent.name, e.last_assistant_message ?? '')))

    return next(e)
  })

  // The lead handing a known agent new work puts it back to working; a cleared
  // one, named as `to`, is back on the board.
  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    const agent = (await read($, agents)).findLast(one => one.name === e.to || one.key === e.to)
    const key = agent?.key ?? ((await read($, cleared)).includes(e.to) ? e.to : undefined)
    if (sent.isDelivered && e.agentId === undefined && key !== undefined) {
      await change($, list => markWorking(list, key))
    }

    return sent
  })

  // Each step of an agent's loop: the agent is working (a blocked or done row
  // stays so through the turn it turned so in, see markStep), on this model
  // and effort, in this turn; after the step, its tokens add to the row. A loop the board does
  // not know yet (a teammate: its spawn fires no agent.spawn) is named by
  // $.agent.list() and joins the row its messages made, or a new one. The
  // lead's model and effort are written only when they change.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    const now = { model: e.model, effort: e.effort }
    if (id === undefined) {
      const was = await read($, lead)
      if (was.model !== now.model || was.effort !== now.effort) await update($, lead, () => now)
      return yield* next(e)
    }

    const step = { ...now, lastTurnId: e.turnId }
    const list = await read($, agents)
    let row = rowFor(list, id)
    if (!row) {
      const info = (await $.agent.list()).find(one => one.id === id)
      const label = info ? (info.name ?? info.type) : undefined
      row = label === undefined ? undefined : list.findLast(one => one.name === label && one.loopId === undefined)
      const key = row?.key ?? id
      if (label !== undefined) await change($, all => markStep(all, key, { name: label, isNamed: row?.isNamed === true || info?.name !== undefined, doing: row?.doing || info?.description || '', loopId: id, ...step }))
    } else if (row.status === 'done' || row.model !== now.model || row.effort !== now.effort || row.lastTurnId !== e.turnId) {
      const key = row.key
      await change($, all => markStep(all, key, step))
    }

    const result = yield* next(e)
    const u = result?.usage
    if (u) {
      const tokensIn = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, agents, all =>
        all.map(one =>
          one.key === id || one.loopId === id
            ? { ...one, tokensIn: (one.tokensIn ?? 0) + tokensIn, tokensOut: (one.tokensOut ?? 0) + u.output_tokens }
            : one,
        ),
      )
    }

    return result
  })

  // Two lines per agent, blocked agents first, a thin rule between agents:
  // who, on what model and at what cost, then the state, how long it has
  // worked and why. The spinner's redraw keeps a working agent's time live. A
  // note the line cannot show whole gets a more/less button (hotkeys 1 to 9,
  // by row) that shows it in full below the line. A blocked agent has a third
  // line with a reply button (hotkey r on the first, as blocked rows sort
  // first), on the terminal only: the other surfaces draw their own composer.
  // The footer has a clear button (hotkey c) while an agent is done.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    // A drawn pane is placed: the count line pinned while it waited is stale.
    draws++
    setStatus($, undefined)
    const list = await read($, agents)
    const boss = await read($, lead)
    const opened = await read($, expanded)
    const spin = SPINNER[await read($, frame)] ?? SPINNER[0]
    const now = await $.clock.now()
    const isNarrow = e.props.bodyColumns < 40
    // The box border and padding take 4 columns.
    const width = e.props.bodyColumns - 4
    const rule = (char: string) => char.repeat(Math.max(width, 8))
    const rows = [...list].sort((a, b) => Number(b.status === 'blocked') - Number(a.status === 'blocked'))
    const totalIn = list.reduce((sum, one) => sum + (one.tokensIn ?? 0), 0)
    const totalOut = list.reduce((sum, one) => sum + (one.tokensOut ?? 0), 0)

    return (
      <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color="yellow">
            TEAM
          </Text>
          <Text dimColor wrap="truncate-end">
            LEAD {modelLabel(boss.model)}·{effortLabel(boss.effort)}
          </Text>
        </Box>
        <Text> </Text>
        {rows.length === 0 && <Text dimColor>NO AGENTS YET</Text>}
        {rows.map((agent, i) => {
          const s = STATE[agent.status]
          const color = STATUS_COLOR[agent.status]
          const hasTokens = agent.tokensIn !== undefined
          const worked = workedMs(agent, now)
          // Line 2 is the state word, the time and the note, as drawn below.
          // A narrow pane drops the note of a row that is not blocked; a wide
          // one cuts it at the edge. Either way the button opens it in full.
          const word = `  ${s.label}`
          const time = worked === undefined ? '' : ` ${durationLabel(worked)}`
          const gap = time === '' ? ' ' : '  '
          const full = agent.status === 'blocked' ? (agent.reason ?? '') : agent.doing
          const isDropped = isNarrow && agent.status !== 'blocked'
          // ponytail: length counts code units, not cells, so wide glyphs (CJK,
          // emoji) can read as fitting. Upgrade path: a cell-width measure, if
          // the engine ever exposes one.
          const isCut = full !== '' && (isDropped || word.length + time.length + gap.length + full.length > width)
          const isOpen = isCut && opened.includes(agent.key)
          const note = isOpen || isDropped ? '' : full

          return (
            <Box flexDirection="column">
              {i > 0 && (
                <Text dimColor wrap="truncate-end">
                  {rule('─')}
                </Text>
              )}
              <Box justifyContent="space-between">
                <Text wrap="truncate-end">
                  <Text color={color}>{agent.status === 'working' ? spin : s.icon} </Text>
                  <Text bold>
                    {agent.name.toUpperCase()}
                  </Text>
                  <Text dimColor>
                    {'  '}
                    {modelLabel(agent.model)} · {effortLabel(agent.effort)}
                  </Text>
                </Text>
                {hasTokens && !isNarrow && (
                  <Text dimColor wrap="truncate-end">
                    in {tokenLabel(agent.tokensIn ?? 0)} · out {tokenLabel(agent.tokensOut ?? 0)}
                  </Text>
                )}
              </Box>
              <Box justifyContent="space-between">
                <Text wrap="truncate-end">
                  <Text bold color={color}>
                    {word}
                  </Text>
                  {time !== '' && <Text color={color}>{time}</Text>}
                  {note !== '' && (
                    <Text dimColor>
                      {gap}
                      {note}
                    </Text>
                  )}
                </Text>
                {isCut && (
                  <Box flexShrink={0} marginLeft={1}>
                    <Button
                      key={`more-${agent.key}`}
                      plain
                      label={isOpen ? 'less' : 'more'}
                      hotkey={i < 9 ? String(i + 1) : undefined}
                      onPress={() => toggleNote($, agent.key)}
                    />
                  </Box>
                )}
              </Box>
              {isOpen && (
                <Box paddingLeft={2}>
                  <Text dimColor wrap="wrap">
                    {full}
                  </Text>
                </Box>
              )}
              {agent.status === 'blocked' && e.surface === 'terminal' && (
                <Box paddingLeft={2}>
                  <Button
                    key={`reply-${agent.key}`}
                    plain
                    label="reply"
                    hotkey={i === 0 ? 'r' : undefined}
                    onPress={() => replyTo($, agent)}
                  />
                </Box>
              )}
            </Box>
          )
        })}
        <Text dimColor wrap="truncate-end">
          {rule('═')}
        </Text>
        <Box flexWrap="wrap" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {countLine(list)}
          </Text>
          {list.some(one => one.status === 'done') && (
            <Box flexShrink={0} marginLeft={1}>
              <Button key="clear" plain label="clear" hotkey="c" onPress={() => clearDone($)} />
            </Box>
          )}
        </Box>
        {totalIn + totalOut > 0 && (
          <Text dimColor wrap="truncate-end">
            TEAM TOKENS in {tokenLabel(totalIn)} · out {tokenLabel(totalOut)}
          </Text>
        )}
      </Box>
    )
  })

  // A row from an agent on the board, or from one cleared from it (its late
  // idle notes), folds to one dim line; ctrl+o (isExpanded) shows the engine's
  // full row. `text` is the body less the engine's framing, summary line
  // included, so the fold reads the body's headline. Only an agent's row
  // folds, by its origin: a person who shares an agent's name (a channel
  // message, say) is drawn as the engine draws it. A block from several
  // senders has no `from`. The fold is the drawing only, never the stored row.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const { text, from, isExpanded, origin } = e.props
    if (isExpanded || from === undefined || !AGENT_ORIGINS.has(origin.kind)) return next(e)
    const isOnBoard = (await read($, agents)).some(one => one.name === from.name)
    if (!isOnBoard && !(await read($, cleared)).includes(from.name)) return next(e)
    const { Text } = $.ui.resolve(e)

    return (
      <Text dimColor wrap="truncate-end">
        {foldLine(toMessage(from.name, text))}
      </Text>
    )
  })
}
