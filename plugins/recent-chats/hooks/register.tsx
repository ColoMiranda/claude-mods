import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RecentChat } from '../types'
import { ago, chatEnd, chatKeys, ENTRYPOINT, fit, oneLine, openSessions, recentChats, storedSummary, SUMMARY_SYSTEM, summaryPrompt, TITLE_LINE } from './parse'

const chats = atom({ plugin: 'recent-chats', key: 'chats' } as const, [] as RecentChat[])
// How many digit keys the www mod's task rows hold: a number it publishes, unset
// where that mod is not installed or shows no rows. Not in this plugin's
// contract, so the read casts the ref.
const wwwTaskKeys = { plugin: 'www', key: 'taskKeys' } as const
const SHOWN = 5
// ponytail: only the newest 20 transcripts are read; raise it when headless
// runs crowd the folder's chats out of them.
const CANDIDATES = 20
const GREP_MS = 5_000
// The end of a chat the summary is written from: its last messages fit in
// far less, but a long tool result near the end can take most of it.
const TAIL_BYTES = 1_048_576
const SUMMARY_MS = 20_000

// Set once the session moved on (a prompt, a pick, another start): an offer
// still loading then is dropped, so a slow read never brings the band back,
// and no summary call starts.
let isClosed = false
// Set by session.start: true where a person is at the prompt (the REPL), so a
// -p or SDK run never spends a model call.
let isInteractive = false
// The loaded offer, waiting for session.start to say a person is there.
let pending: { dir: string; chats: RecentChat[] } | undefined

// The chats a running session has open, from the engine's record of each
// process (<config>/sessions/<pid>.json, beside <config>/projects/): one
// resumed here too would have two sessions writing it. ponytail: a record a
// crashed process left behind hides its chat until the engine clears it.
async function openChats($: EngineInterface, transcriptDir: string): Promise<Set<string>> {
  const config = /^(.*)[\\/]projects[\\/][^\\/]+[\\/]$/.exec(transcriptDir)?.[1]
  if (config === undefined) return new Set()
  const dir = `${config}/sessions/`
  const records = (await $.fs.list(dir).catch(() => [])).filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))

  return openSessions(await Promise.all(records.map(entry => $.fs.read(`${dir}${entry.name}`).catch(() => ''))))
}

// This folder's last chats, newest first, read from `dir`, the folder that
// holds this session's transcript (the engine's own path, so none is
// guessed). grep, not $.fs.read: that refuses a file over 4 MiB, and a long
// chat is bigger. grep exits 1 when nothing matched and 2 when a file went
// away; what it printed counts either way. ponytail: grep is macOS and Linux only.
async function load($: EngineInterface, dir: string, currentId: string): Promise<RecentChat[]> {
  const [entries, open] = await Promise.all([$.fs.list(dir), openChats($, dir)])
  const files = entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl') && entry.name !== `${currentId}.jsonl`)
    .filter(entry => !open.has(entry.name.slice(0, -'.jsonl'.length)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, CANDIDATES)
  // No file named: grep would read its standard input instead.
  if (files.length === 0) return []
  const paths = files.map(entry => `${dir}${entry.name}`)
  const [titles, entrypoints] = await Promise.all([
    $.process.run(['grep', '-H', '-E', '-e', TITLE_LINE, '--', ...paths], { timeoutMs: GREP_MS }),
    $.process.run(['grep', '-m1', '-H', '-o', '-E', '-e', ENTRYPOINT, '--', ...paths], { timeoutMs: GREP_MS }),
  ])

  return recentChats(files, titles.stdout, entrypoints.stdout, SHOWN)
}

async function offer($: EngineInterface, transcriptPath: string, currentId: string) {
  const cut = Math.max(transcriptPath.lastIndexOf('/'), transcriptPath.lastIndexOf('\\'))
  if (cut < 0) return
  const dir = transcriptPath.slice(0, cut + 1)
  const found = await load($, dir, currentId).catch(() => [])
  if (isClosed || found.length === 0) return
  await update($, chats, () => found)
  pending = { dir, chats: found }
  summarizeWhenReady($)
}

// Starts the summaries once both are known, in either order: the offer is
// loaded, and session.start said a person is at the prompt.
function summarizeWhenReady($: EngineInterface) {
  if (!isInteractive || isClosed || pending === undefined) return
  const { dir, chats: offered } = pending
  pending = undefined
  void summarize($, dir, offered)
}

// One chat's summary, from its end: one small Haiku call (about 100 to 550
// tokens in, 20 out). Undefined when the chat has no text or the call fails.
async function summaryOf($: EngineInterface, dir: string, chat: RecentChat): Promise<string | undefined> {
  const tail = await $.process.run(['tail', '-c', String(TAIL_BYTES), '--', `${dir}${chat.id}.jsonl`], { timeoutMs: GREP_MS })
  const end = chatEnd(tail.stdout)
  if (end === '') return undefined
  const reply = await $.model.complete({
    model: 'haiku',
    system: SUMMARY_SYSTEM,
    prompt: summaryPrompt(chat.title, end),
    effort: 'low',
    maxTokens: 60,
    timeoutMs: SUMMARY_MS,
  })

  return reply.isAnswered ? oneLine(reply.text) : undefined
}

// Each offered chat's one-line summary: the stored one while the chat is
// unchanged, else a new one from the model, none once the band has closed.
// Each shows as it lands. The store then keeps this offer's summaries alone,
// so chats that left the offer drop out, and a failed one is tried again
// next start.
async function summarize($: EngineInterface, dir: string, offered: readonly RecentChat[]) {
  const key = `summaries:${dir}`
  const stored = await $.store.get(key).catch(() => undefined)
  const kept: Record<string, { at: number; text: string }> = {}
  await Promise.all(
    offered.map(async chat => {
      const text = storedSummary(stored, chat) ?? (isClosed ? undefined : await summaryOf($, dir, chat).catch(() => undefined))
      if (text === undefined) return
      kept[chat.id] = { at: chat.at, text }
      if (!isClosed) await update($, chats, list => list.map(one => (one.id === chat.id ? { ...one, summary: text } : one)))
    }),
  )
  await $.store.set(key, kept).catch(() => undefined)
}

async function close($: EngineInterface) {
  isClosed = true
  if ((await read($, chats)).length > 0) await update($, chats, () => [])
}

// Resumes a chat the band offered: `/resume <id>`, as if typed. Where a
// plugin may not run it, the command waits in the prompt box for Enter.
async function resume($: EngineInterface, id: string) {
  await close($)
  try {
    await $.command.run({ command: 'resume', args: id })
  } catch {
    const { isFilled } = await $.prompt.fill({ text: `/resume ${id}` })
    $.ui.toast(isFilled ? 'Press Enter to resume that chat.' : `Could not resume. Run /resume ${id}`)
  }
}

export const register: Register = on => {
  // A fresh start: offer this folder's last chats, read off the start hook so
  // the session never waits on disk. Every other start (a resume, a fork,
  // /clear, a compact) closes the offer. This fires before any surface
  // attaches, so it cannot tell a -p run apart: such a run reads the folder
  // too (two greps) and draws nothing, but calls no model (session.start below).
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source !== 'startup') {
      await close($)
    } else {
      const { transcript_path: path, session_id: id } = e
      $.clock.after(0, () => void offer($, path, id))
    }

    return next(e)
  })

  // Whether a person is at the prompt: only then do summaries cost a model call.
  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    summarizeWhenReady($)

    return next(e)
  })

  // The first prompt starts a new chat: the offer goes.
  on('prompt.submit', async ($, e, next) => {
    await close($)

    return next(e)
  })

  // The offer, over the other mods' rows; a survey holds the band alone.
  // A bare digit in the empty prompt box presses the row with that number.
  // Where the www mod shows task rows, they hold the first digits: the chats
  // take the next ones, and the rows beneath go above the chats.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const offered = await read($, chats)
    if (e.props.hasSurvey || offered.length === 0) return next(e)
    const { offset, keys } = chatKeys((await $.state.get(wwwTaskKeys as never)).value, SHOWN)
    const shown = offered.slice(0, keys.length)
    if (shown.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    // Two lines a chat only where all of them fit (the task rows at least a
    // line each), so no row scrolls out of its number key's reach; else the
    // titles alone.
    const hasRoom = offset + 1 + shown.length * 2 <= e.props.maxRows
    // Nothing beneath (a test's bare engine): the offer alone.
    const rest = await next(e).catch(() => undefined)

    return (
      <Box flexDirection="column">
        {offset > 0 && rest}
        <Text dimColor wrap="truncate-end">
          Resume a recent chat: press its number. Or type to start a new chat.
        </Text>
        {shown.map((chat, i) => {
          const when = ago(now - chat.at)
          // `1: ` before the title, a space and the age after it.
          const room = e.props.bodyColumns - when.length - 4
          return (
            <Box flexDirection="column">
              <Box gap={1}>
                <Button key={`chat-${i + 1}`} plain hotkey={keys[i]} label={fit(chat.title, room)} onPress={() => resume($, chat.id)} />
                <Text dimColor>{when}</Text>
              </Box>
              {hasRoom && chat.summary !== undefined && (
                <Box paddingLeft={3}>
                  <Text dimColor wrap="truncate-end">
                    {chat.summary}
                  </Text>
                </Box>
              )}
            </Box>
          )
        })}
        {offset === 0 && rest}
      </Box>
    )
  })
}
