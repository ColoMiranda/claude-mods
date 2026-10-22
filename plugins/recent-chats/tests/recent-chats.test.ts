import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ago, chatEnd, chatKeys, ENTRYPOINT, fit, oneLine, openSessions, recentChats, storedSummary, SUMMARY_SYSTEM, summaryPrompt, TITLE_LINE } from '../hooks/parse'

const DIR = '/Users/me/.claude/projects/-Users-me-app/'
// The engine's record of each running session, beside its projects folder.
const SESSIONS = '/Users/me/.claude/sessions'
const NOW = Date.UTC(2026, 9, 5, 15, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
// Session ids as the engine names transcripts.
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const CURRENT = id(99)

// A transcript's records and first entry point, as grep -H prints them.
const titleLine = (n: number, record: Record<string, unknown>) => `${DIR}${id(n)}.jsonl:${JSON.stringify({ ...record, sessionId: id(n) })}`
const entryLine = (n: number, entrypoint: string) => `${DIR}${id(n)}.jsonl:"entrypoint":"${entrypoint}"`

// The folder: this chat, five terminal chats with a title, a headless run,
// a chat that only ran slash commands, two older chats, and a stray file.
const FILES = [
  { name: `${CURRENT}.jsonl`, mtimeMs: NOW },
  { name: `${id(1)}.jsonl`, mtimeMs: NOW - 5 * MIN },
  { name: `${id(2)}.jsonl`, mtimeMs: NOW - 3 * HOUR },
  { name: `${id(3)}.jsonl`, mtimeMs: NOW - 4 * HOUR },
  { name: `${id(4)}.jsonl`, mtimeMs: NOW - 5 * HOUR },
  { name: `${id(5)}.jsonl`, mtimeMs: NOW - DAY },
  { name: `${id(6)}.jsonl`, mtimeMs: NOW - 2 * DAY },
  { name: `${id(7)}.jsonl`, mtimeMs: NOW - 3 * DAY },
  { name: `${id(8)}.jsonl`, mtimeMs: NOW - 4 * DAY },
  { name: 'notes.jsonl', mtimeMs: NOW - MIN },
]
const TITLES = [
  titleLine(99, { type: 'ai-title', aiTitle: 'This chat' }),
  titleLine(1, { type: 'last-prompt', lastPrompt: 'make a table mod' }),
  titleLine(1, { type: 'ai-title', aiTitle: 'Table formatting' }),
  titleLine(1, { type: 'ai-title', aiTitle: 'Table formatting mod for message field' }),
  titleLine(2, { type: 'ai-title', aiTitle: 'Installed mods verification' }),
  titleLine(2, { type: 'custom-title', customTitle: 'Mods check' }),
  titleLine(2, { type: 'last-prompt', lastPrompt: 'do we have all mods?' }),
  titleLine(3, { type: 'ai-title', aiTitle: 'Security review' }),
  titleLine(4, { type: 'last-prompt' }),
  titleLine(5, { type: 'last-prompt', lastPrompt: 'fix the band\n\tplease \u001b[31m' }),
  titleLine(6, { type: 'ai-title', aiTitle: 'Mod ideas brainstorm' }),
  titleLine(7, { type: 'ai-title', aiTitle: 'Old one' }),
  titleLine(8, { type: 'ai-title', aiTitle: 'Oldest' }),
]
// A chat's end as `tail -c` prints it: a cut first line, then a meta line, a
// slash command, a prompt, thinking, a tool call and its result, an answer.
const line = (record: Record<string, unknown>) => JSON.stringify(record)
const chatTail = (n: number) =>
  [
    'cut":"off mid-line"}',
    line({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' } }),
    line({ type: 'user', message: { role: 'user', content: '<command-name>/plugin</command-name>' } }),
    line({ type: 'user', message: { role: 'user', content: `Prompt for chat ${n}` } }),
    line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'secret thoughts' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'tool output' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: `Answer for chat ${n}` }] } }),
  ].join('\n')
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
// The model's answer: a quoted line with an end period and a second line,
// so the band shows `Worked on <title>` once the answer is cleaned.
const answered = (prompt: string) => ({ isAnswered: true as const, text: `"Worked on ${/^Title: (.*)$/m.exec(prompt)?.[1] ?? '?'}."\nMore words`, usage: ZERO })
const failed = { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: ZERO }

const ENTRYPOINTS = [entryLine(99, 'cli'), entryLine(1, 'cli'), entryLine(2, 'cli'), entryLine(3, 'sdk-py'), entryLine(4, 'cli'), entryLine(5, 'cli'), entryLine(6, 'cli'), entryLine(7, 'cli'), entryLine(8, 'cli')]

describe('parse', () => {
  test('the newest five chats with a title; this chat, headless runs and stray files left out', () => {
    const others = FILES.filter(file => file.name !== `${CURRENT}.jsonl`)
    expect(recentChats(others, TITLES.join('\n'), ENTRYPOINTS.join('\n'), 5)).toEqual([
      { id: id(1), title: 'Table formatting mod for message field', at: NOW - 5 * MIN },
      { id: id(2), title: 'Mods check', at: NOW - 3 * HOUR },
      { id: id(5), title: 'fix the band please [31m', at: NOW - DAY },
      { id: id(6), title: 'Mod ideas brainstorm', at: NOW - 2 * DAY },
      { id: id(7), title: 'Old one', at: NOW - 3 * DAY },
    ])
    expect(recentChats(others, TITLES.join('\n'), ENTRYPOINTS.join('\n'), 2).map(chat => chat.id)).toEqual([id(1), id(2)])
  })

  test('a title: /rename first, then the auto title, then the last prompt', () => {
    const files = [{ name: `${id(1)}.jsonl`, mtimeMs: 1 }]
    const title = (...records: Record<string, unknown>[]) => recentChats(files, records.map(record => titleLine(1, record)).join('\n'), '', 5)[0]?.title
    expect(title({ type: 'last-prompt', lastPrompt: 'p' }, { type: 'ai-title', aiTitle: 'a' }, { type: 'custom-title', customTitle: 'c' })).toBe('c')
    expect(title({ type: 'last-prompt', lastPrompt: 'p' }, { type: 'ai-title', aiTitle: 'a' })).toBe('a')
    expect(title({ type: 'last-prompt', lastPrompt: 'p' })).toBe('p')
    // A blank title counts as none.
    expect(title({ type: 'custom-title', customTitle: ' \n ' }, { type: 'ai-title', aiTitle: 'a' })).toBe('a')
    expect(title({ type: 'last-prompt' })).toBeUndefined()
  })

  test('only engine-named transcripts and whole records count', () => {
    const files = [
      { name: 'x;rm -rf ~.jsonl', mtimeMs: 3 },
      { name: 'ABCDEF01-0000-4000-8000-000000000000.jsonl', mtimeMs: 2 },
      { name: `${id(2)}.jsonl`, mtimeMs: 1 },
    ]
    const lines = [
      `${DIR}x;rm -rf ~.jsonl:{"type":"ai-title","aiTitle":"bad"}`,
      `${DIR}ABCDEF01-0000-4000-8000-000000000000.jsonl:{"type":"ai-title","aiTitle":"upper"}`,
      `${DIR}${id(2)}.jsonl:{"type":"ai-title","aiTitle":"cut off`,
      `${DIR}${id(2)}.jsonl:{"type":"ai-title","aiTitle":"whole"}`,
      'grep: /gone.jsonl: No such file or directory',
    ]
    expect(recentChats(files, lines.join('\n'), '', 5)).toEqual([{ id: id(2), title: 'whole', at: 1 }])
  })

  test('the grep patterns find the engine records, never the same text quoted in a message', () => {
    const title = new RegExp(TITLE_LINE)
    expect(title.test('{"type":"ai-title","aiTitle":"x","sessionId":"s"}')).toBe(true)
    expect(title.test('{"type":"custom-title","customTitle":"x","sessionId":"s"}')).toBe(true)
    expect(title.test('{"type":"last-prompt","lastPrompt":"x","leafUuid":"u","sessionId":"s"}')).toBe(true)
    expect(title.test('{"type":"user","message":{"content":"{\\"type\\":\\"ai-title\\"}"}}')).toBe(false)
    const entry = new RegExp(ENTRYPOINT)
    expect('{"parentUuid":null,"entrypoint":"sdk-py","type":"user"}'.match(entry)?.[0]).toBe('"entrypoint":"sdk-py"')
    expect(entry.test('{"content":"\\"entrypoint\\":\\"cli\\""}')).toBe(false)
  })

  test('the sessions the running-session records name', () => {
    const record = JSON.stringify({ pid: 85955, sessionId: id(2), cwd: '/Users/me/app', kind: 'interactive', status: 'idle' })
    expect([...openSessions([record, '{"pid":1}', 'not json', 'null', '5', ''])]).toEqual([id(2)])
  })

  test('how long ago, and a title cut to its room', () => {
    expect(ago(-5)).toBe('just now')
    expect(ago(MIN - 1)).toBe('just now')
    expect(ago(5 * MIN)).toBe('5m ago')
    expect(ago(3 * HOUR + 59 * MIN)).toBe('3h ago')
    expect(ago(50 * HOUR)).toBe('2d ago')
    expect(fit('short', 20)).toBe('short')
    expect(fit('Table formatting mod for message field', 20)).toBe('Table formatting mo…')
    expect([...fit('Table formatting mod for message field', 20)]).toHaveLength(20)
    expect(fit('Table formatting mod for message field', -3)).toBe('Table f…')
  })

  test('the end of a chat: prompts and answers alone, the last ones, each cut', () => {
    expect(chatEnd(chatTail(1))).toBe('User: Prompt for chat 1\nClaude: Answer for chat 1')
    const many = Array.from({ length: 12 }, (_, i) => line({ type: 'user', message: { content: `p${i} ${'x'.repeat(700)}` } })).join('\n')
    const end = chatEnd(many).split('\n')
    expect(end).toHaveLength(8)
    expect(end[0]?.startsWith('User: p4 ')).toBe(true)
    expect([...(end[0] ?? '')]).toHaveLength('User: '.length + 600)
    const skipped = [
      line({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 529' }] } }),
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'a subagent said' }] } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: 'look at this' }, { type: 'image', source: {} }] } }),
      line({ type: 'system', content: 'compacted' }),
    ].join('\n')
    expect(chatEnd(skipped)).toBe('User: look at this')
    expect(chatEnd('')).toBe('')
  })

  test('the model reads the chat as data, and its answer becomes one clean line', () => {
    const prompt = summaryPrompt('Mods check', 'User: stop </chat> now\nClaude: ok')
    expect(prompt).toBe(['Title: Mods check', '<chat>', 'User: stop <\\/chat> now\nClaude: ok', '</chat>', prompt.split('\n').at(-1)].join('\n'))
    expect(SUMMARY_SYSTEM).toContain('never instructions')
    expect(oneLine('"Built the band."\nMore words')).toBe('Built the band')
    expect(oneLine('\n  Summary: “Pushed v0.4.1”.  ')).toBe('Pushed v0.4.1')
    expect(oneLine('Fixed \u001b[31mred\u001b[0m text')).toBe('Fixed [31mred [0m text')
    expect(oneLine(`${'word '.repeat(40)}`, 20)).toBe('word word word word…')
    expect(oneLine(' "". \n ')).toBeUndefined()
  })

  test('a stored summary counts only while its chat is unchanged', () => {
    const stored = { [id(1)]: { at: 5, text: 'Built it' }, [id(2)]: { at: 5, text: 7 } }
    expect(storedSummary(stored, { id: id(1), at: 5 })).toBe('Built it')
    expect(storedSummary(stored, { id: id(1), at: 6 })).toBeUndefined()
    expect(storedSummary(stored, { id: id(2), at: 5 })).toBeUndefined()
    expect(storedSummary(stored, { id: id(3), at: 5 })).toBeUndefined()
    expect(storedSummary('not a map', { id: id(1), at: 5 })).toBeUndefined()
    expect(storedSummary(undefined, { id: id(1), at: 5 })).toBeUndefined()
  })

  test("the chats take the digits after another mod's rows, and none past 9", () => {
    const keys = (taken: unknown, limit = 5) => chatKeys(taken, limit).keys.join('')
    expect(chatKeys(0, 5)).toEqual({ offset: 0, keys: ['1', '2', '3', '4', '5'] })
    expect(keys(2)).toBe('34567')
    expect(keys(3)).toBe('45678')
    // Six digits held: three chats fit, on 7, 8 and 9.
    expect(chatKeys(6, 5)).toEqual({ offset: 6, keys: ['7', '8', '9'] })
    expect(keys(9)).toBe('')
    expect(keys(2, 2)).toBe('34')
    // Another plugin's value, so anything may come: a value that is no whole
    // number counts as none, and a whole number is cut to 0 to 9.
    for (const taken of [undefined, null, '2', NaN, Infinity, 1.5, {}, [2]]) expect(chatKeys(taken, 5).offset).toBe(0)
    expect(chatKeys(-4, 5).offset).toBe(0)
    expect(chatKeys(12, 5)).toEqual({ offset: 9, keys: [] })
  })
})

type World = {
  files: { name: string; mtimeMs: number }[]
  titles: string[]
  entrypoints: string[]
  // The running-session records by file name; undefined: no such folder.
  running: Record<string, string> | undefined
  // When set, a plugin's `/resume` is refused, as the engine may.
  resumeFails: boolean
  // What the www mod publishes as its `taskKeys`; undefined: that mod is not here.
  taskKeys: unknown
  // The plugin's store; and what the model answers for a prompt.
  store: Record<string, unknown>
  reply: (prompt: string) => typeof failed | ReturnType<typeof answered>
  listed: string[]
  greps: string[][]
  tailed: string[]
  asked: { model: string; prompt: string; system?: string; effort?: string; maxTokens?: number }[]
  resumed: string[]
  filled: string[]
  toasts: string[]
}

function machine(on: On, setup: Partial<World> = {}) {
  const world: World = {
    files: FILES,
    titles: TITLES,
    entrypoints: ENTRYPOINTS,
    running: { '81754.json': JSON.stringify({ pid: 81754, sessionId: CURRENT, kind: 'interactive' }) },
    resumeFails: false,
    taskKeys: undefined,
    store: {},
    reply: answered,
    listed: [],
    greps: [],
    tailed: [],
    asked: [],
    resumed: [],
    filled: [],
    toasts: [],
    ...setup,
  }
  const clock = mock.clock(on, { now: NOW })
  on('fs.list', ($, e) => {
    world.listed.push(e.path)
    if (e.path !== SESSIONS) return { value: world.files.map(file => ({ ...file, kind: 'file' as const, size: 100, isLink: false })) }
    if (world.running === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: Object.keys(world.running).map(name => ({ name, kind: 'file' as const, size: 10, mtimeMs: NOW, isLink: false })) }
  })
  on('fs.read', ($, e) => {
    const text = e.path.startsWith(`${SESSIONS}/`) ? world.running?.[e.path.slice(SESSIONS.length + 1)] : undefined
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  // tail: a chat's end. grep over the files it names: the fixture's lines
  // for those files alone.
  on('process.run', ($, e) => {
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'tail') {
      const name = String(e.argv.at(-1)).slice(DIR.length)
      world.tailed.push(name)
      return ok(chatTail(Number(name.slice(0, 8))))
    }
    world.greps.push([...e.argv])
    const lines = e.argv.includes(TITLE_LINE) ? world.titles : e.argv.includes(ENTRYPOINT) ? world.entrypoints : []
    const stdout = lines.filter(line => e.argv.some(arg => line.startsWith(`${arg}:`))).join('\n')
    return { value: { exitCode: stdout === '' ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('classic.SessionStart', () => ({}))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('model.complete', ($, e) => {
    world.asked.push({ model: e.model, prompt: e.prompt, system: e.system, effort: e.effort, maxTokens: e.maxTokens })
    return { value: world.reply(e.prompt) }
  })
  // The www mod's value, answered from the world (version 0: never written);
  // any other read goes on.
  on('state.get', ($, e, next) => {
    if (String(e.plugin) !== 'www') return next(e)
    return { value: { value: world.taskKeys, version: world.taskKeys === undefined ? 0 : 1 } }
  })
  on('store.get', ($, e) => ({ value: world.store[e.key] }))
  on('store.set', ($, e) => {
    world.store[e.key] = e.value
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.run', { command: 'resume' }, ($, e) => {
    if (world.resumeFails) throw new Error('resume is not for plugins')
    world.resumed.push(e.args)
    return {}
  })
  on('prompt.fill', ($, e) => {
    world.filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  // The engine's own band: empty.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))

  return { world, clock }
}

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } as const
const START = { source: 'startup', transcript_path: `${DIR}${CURRENT}.jsonl`, session_id: CURRENT } as const
const PROMPT = { text: 'fix the build', wait: false, origin: { kind: 'composer' } } as const

// The band's chat rows on a surface: each Button's key and label.
async function rows($: Engine, surface: 'terminal' | 'desktop' = 'terminal', changed: { hasSurvey?: boolean; bodyColumns?: number; maxRows?: number } = {}) {
  const band = await $.ui.mount({ plugin: 'recent-chats', surface, component: 'AbovePrompt', props: { ...BAND_PROPS, ...changed } })
  const buttons = await band.findAll({ type: 'Button' })
  await band.unmount()
  return buttons.map(button => `${button.key} ${button.text}`)
}

// The band's Buttons in the order drawn: each one's key and hotkey.
async function hotkeys($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const band = await $.ui.mount({ plugin: 'recent-chats', surface, component: 'AbovePrompt', props: BAND_PROPS })
  const buttons = await band.findAll({ type: 'Button' })
  await band.unmount()
  return buttons.map(button => `${button.key}=${button.props.hotkey}`)
}

// The band's summary lines, in row order: every Text but the header and the ages.
async function summaries($: Engine, maxRows = 20) {
  const band = await $.ui.mount({ plugin: 'recent-chats', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, maxRows } })
  const texts = await band.findAll({ type: 'Text' })
  await band.unmount()
  return texts.map(text => text.text).filter(text => !/^Resume a recent chat|ago$|^just now$/.test(text))
}

// A start: the classic event, then session.start when `isInteractive` is
// given (true: a person at the prompt; false: a -p or SDK run).
async function started($: Engine, on: On, setup: Partial<World> = {}, isInteractive?: boolean) {
  const { world, clock } = machine(on, setup)
  await $.classic.SessionStart(START)
  if (isInteractive !== undefined) await $.session.start({ cwd: '/Users/me/app', surface: isInteractive ? 'terminal' : null, isInteractive })
  await clock.settle()
  return world
}

const TITLES_SHOWN = ['Table formatting mod for message field', 'Mods check', 'fix the band please [31m', 'Mod ideas brainstorm', 'Old one']
const titleIn = (prompt: string) => /^Title: (.*)$/m.exec(prompt)?.[1]

describe('hooks', () => {
  test('a fresh start offers the newest five chats, on the terminal and the desktop', async ($, on) => {
    const world = await started($, on)
    expect([...world.listed].sort()).toEqual([DIR.slice(0, -1), SESSIONS].sort())
    // This chat's own transcript is never read, and no file name is taken for an option.
    for (const argv of world.greps) {
      expect(argv).not.toContain(`${DIR}${CURRENT}.jsonl`)
      expect(argv.slice(argv.indexOf('--') + 1).every(path => path.startsWith(DIR))).toBe(true)
    }
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await rows($, surface)).toEqual([
        'chat-1 Table formatting mod for message field',
        'chat-2 Mods check',
        'chat-3 fix the band please [31m',
        'chat-4 Mod ideas brainstorm',
        'chat-5 Old one',
      ])
    }
    const band = await $.ui.mount({ plugin: 'recent-chats', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Text', text: /^Resume a recent chat: press its number/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '5m ago' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '2d ago' })).toBeDefined()
    expect((await band.find({ key: 'chat-3' }))?.props.hotkey).toBe('3')
    await band.unmount()
  })

  test('a chat open in another session is not offered: two sessions would write it', async ($, on) => {
    const running = {
      '81754.json': JSON.stringify({ pid: 81754, sessionId: CURRENT }),
      '85955.json': JSON.stringify({ pid: 85955, sessionId: id(2), status: 'idle' }),
      '85955.ea4fd23c.key': 'not a record',
    }
    const world = await started($, on, { running })
    for (const argv of world.greps) expect(argv).not.toContain(`${DIR}${id(2)}.jsonl`)
    expect(await rows($)).toEqual([
      'chat-1 Table formatting mod for message field',
      'chat-2 fix the band please [31m',
      'chat-3 Mod ideas brainstorm',
      'chat-4 Old one',
      'chat-5 Oldest',
    ])
  })

  test('no running-session records: every chat is offered', async ($, on) => {
    await started($, on, { running: undefined })
    expect(await rows($)).toHaveLength(5)
  })

  test('a narrow band cuts a long title to fit', async ($, on) => {
    await started($, on)
    // 30 columns: `1: `, the title, a space, `5m ago`.
    expect((await rows($, 'terminal', { bodyColumns: 30 }))[0]).toBe('chat-1 Table formatting mo…')
  })

  test('pressing a chat resumes it, and the offer goes', async ($, on) => {
    const world = await started($, on)
    const band = await $.ui.mount({ plugin: 'recent-chats', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    await band.press({ key: 'chat-2' })
    await band.unmount()
    expect(world.resumed).toEqual([id(2)])
    expect(world.filled).toEqual([])
    expect(await rows($)).toEqual([])
  })

  test('where a plugin may not run /resume, the command waits in the prompt box', async ($, on) => {
    const world = await started($, on, { resumeFails: true })
    const band = await $.ui.mount({ plugin: 'recent-chats', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    await band.press({ key: 'chat-1' })
    await band.unmount()
    expect(world.filled).toEqual([`/resume ${id(1)}`])
    expect(world.toasts).toEqual(['Press Enter to resume that chat.'])
  })

  test('the first prompt closes the offer', async ($, on) => {
    await started($, on)
    expect(await rows($)).toHaveLength(5)
    await $.prompt.submit(PROMPT)
    expect(await rows($)).toEqual([])
  })

  test('a prompt sent while the offer still loads: no band after it', async ($, on) => {
    const { clock } = machine(on)
    await $.classic.SessionStart(START)
    await $.prompt.submit(PROMPT)
    await clock.settle()
    expect(await rows($)).toEqual([])
  })

  test('a resume, a fork, /clear or a compact: nothing read, no band', async ($, on) => {
    const { world, clock } = machine(on)
    for (const source of ['resume', 'fork', 'clear', 'compact'] as const) await $.classic.SessionStart({ ...START, source })
    await clock.settle()
    expect(world.listed).toEqual([])
    expect(world.greps).toEqual([])
    expect(await rows($)).toEqual([])
  })

  test('a survey holds the band alone', async ($, on) => {
    await started($, on)
    expect(await rows($, 'terminal', { hasSurvey: true })).toEqual([])
  })

  test('nothing to offer (a headless run, a chat with no prompt): no band', async ($, on) => {
    const world = await started($, on, { files: [FILES[0]!, FILES[3]!, FILES[4]!] })
    expect(world.greps).toHaveLength(2)
    expect(await rows($)).toEqual([])
  })

  test('a folder with no other chat runs no grep', async ($, on) => {
    const world = await started($, on, { files: [FILES[0]!] })
    expect([...world.listed].sort()).toEqual([DIR.slice(0, -1), SESSIONS].sort())
    expect(world.greps).toEqual([])
    expect(await rows($)).toEqual([])
  })
  test('a person at the prompt: Haiku writes one line under each chat, from its end', async ($, on) => {
    const world = await started($, on, {}, true)
    expect(await summaries($)).toEqual(TITLES_SHOWN.map(title => `Worked on ${title}`))
    expect(await rows($, 'terminal', { maxRows: 20 })).toHaveLength(5)
    expect(world.asked.map(ask => titleIn(ask.prompt)).sort()).toEqual([...TITLES_SHOWN].sort())
    const ask = world.asked.find(one => titleIn(one.prompt) === 'Mods check')
    expect(ask).toMatchObject({ model: 'haiku', system: SUMMARY_SYSTEM, effort: 'low', maxTokens: 60 })
    expect(ask?.prompt).toContain('<chat>\nUser: Prompt for chat 2\nClaude: Answer for chat 2\n</chat>')
    for (const hidden of ['secret thoughts', 'tool output', 'Caveat', '/plugin', 'cut']) expect(ask?.prompt).not.toContain(hidden)
    // Each offered chat's end is read once; the others never.
    expect([...world.tailed].sort()).toEqual([1, 2, 5, 6, 7].map(n => `${id(n)}.jsonl`))
    expect(world.store[`summaries:${DIR}`]).toEqual(
      Object.fromEntries([[1, 5 * MIN], [2, 3 * HOUR], [5, DAY], [6, 2 * DAY], [7, 3 * DAY]].map(([n, age], i) => [id(n!), { at: NOW - age!, text: `Worked on ${TITLES_SHOWN[i]}` }])),
    )
  })

  test('an unchanged chat keeps its stored line at no cost; a changed one gets a new line; old chats drop out', async ($, on) => {
    const store = {
      [`summaries:${DIR}`]: {
        [id(1)]: { at: NOW - 5 * MIN, text: 'Cached line' },
        [id(2)]: { at: NOW - 9 * HOUR, text: 'Old line' },
        [id(8)]: { at: NOW - 4 * DAY, text: 'Gone' },
      },
    }
    const world = await started($, on, { store }, true)
    expect((await summaries($)).slice(0, 2)).toEqual(['Cached line', 'Worked on Mods check'])
    expect(world.asked).toHaveLength(4)
    expect(world.tailed).not.toContain(`${id(1)}.jsonl`)
    const kept = world.store[`summaries:${DIR}`] as Record<string, { at: number; text: string }>
    expect(Object.keys(kept).sort()).toEqual([1, 2, 5, 6, 7].map(id).sort())
    expect(kept[id(1)]).toEqual({ at: NOW - 5 * MIN, text: 'Cached line' })
    expect(kept[id(2)]).toEqual({ at: NOW - 3 * HOUR, text: 'Worked on Mods check' })
  })

  test('session.start may come before the offer loads: the lines still come', async ($, on) => {
    const { world, clock } = machine(on)
    await $.session.start({ cwd: '/Users/me/app', surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart(START)
    await clock.settle()
    expect(world.asked).toHaveLength(5)
    expect(await summaries($)).toHaveLength(5)
  })

  test('a -p or SDK run calls no model: titles alone', async ($, on) => {
    const world = await started($, on, {}, false)
    expect(world.asked).toEqual([])
    expect(world.tailed).toEqual([])
    expect(await rows($, 'terminal', { maxRows: 20 })).toHaveLength(5)
    expect(await summaries($)).toEqual([])
  })

  test('a failed call shows no line for its chat, and is not stored', async ($, on) => {
    const world = await started($, on, { reply: prompt => (titleIn(prompt) === 'Mods check' ? failed : answered(prompt)) }, true)
    expect(await summaries($)).toEqual(TITLES_SHOWN.filter(title => title !== 'Mods check').map(title => `Worked on ${title}`))
    expect(Object.keys(world.store[`summaries:${DIR}`] as object)).not.toContain(id(2))
    expect(await rows($, 'terminal', { maxRows: 20 })).toHaveLength(5)
  })

  test('a band too short for two lines a chat shows the titles alone', async ($, on) => {
    await started($, on, {}, true)
    // A header and 5 chats of 2 lines: 11 rows.
    expect(await summaries($, 10)).toEqual([])
    expect(await summaries($, 11)).toHaveLength(5)
    expect(await rows($, 'terminal', { maxRows: 10 })).toHaveLength(5)
  })

  test('where the www mod holds digits 1 and 2, the chats take 3 to 7', async ($, on) => {
    const world = await started($, on, { taskKeys: 2 })
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await hotkeys($, surface)).toEqual(['chat-1=3', 'chat-2=4', 'chat-3=5', 'chat-4=6', 'chat-5=7'])
    }
    expect(await rows($)).toHaveLength(5)
    // A value that is no number counts as no rows: the chats take 1 to 5.
    world.taskKeys = 'two'
    expect(await hotkeys($)).toEqual(['chat-1=1', 'chat-2=2', 'chat-3=3', 'chat-4=4', 'chat-5=5'])
  })

  test('no chat takes a key past 9: with six digits held three chats show, with nine none', async ($, on) => {
    const world = await started($, on, { taskKeys: 6 })
    expect(await hotkeys($)).toEqual(['chat-1=7', 'chat-2=8', 'chat-3=9'])
    expect(await rows($)).toHaveLength(3)
    world.taskKeys = 9
    expect(await rows($)).toEqual([])
    const band = await $.ui.mount({ plugin: 'recent-chats', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Text', text: /^Resume a recent chat/ })).toBeUndefined()
    await band.unmount()
  })

  test(
    'the rows beneath go above the chats where the www mod holds digits, else below them',
    {
      plugins: [
        {
          // Beneath the plugin under test: shown only if that plugin draws what is beneath it.
          name: 'neighbor',
          tier: 'append',
          register(on) {
            on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
              const { Box, Text } = $.ui.resolve(e)
              const rest = await next(e).catch(() => undefined)
              return Box({ flexDirection: 'column', children: [Text({ children: 'NEIGHBOR ROW' }), ...(rest ? [rest] : [])] })
            })
          },
        },
      ],
    },
    async ($, on) => {
      const world = await started($, on)
      const texts = async () => {
        const band = await $.ui.mount({ plugin: 'recent-chats', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
        const found = await band.findAll({ type: 'Text' })
        await band.unmount()
        return found.map(one => one.text)
      }
      // No task rows: the chats, then the rest of the band.
      const without = await texts()
      expect(without[0]).toStartWith('Resume a recent chat')
      expect(without.at(-1)).toBe('NEIGHBOR ROW')
      // Task rows: the rest of the band, then the chats.
      world.taskKeys = 2
      const held = await texts()
      expect(held[0]).toBe('NEIGHBOR ROW')
      expect(held[1]).toStartWith('Resume a recent chat')
    },
  )

  test('the task rows count against the room for the summary lines', async ($, on) => {
    const world = await started($, on, {}, true)
    expect(await summaries($, 11)).toHaveLength(5)
    // 2 task rows, a header and 5 chats of 2 lines: 13 rows.
    world.taskKeys = 2
    expect(await summaries($, 12)).toEqual([])
    expect(await summaries($, 13)).toHaveLength(5)
  })

  test('a prompt sent before the offer loads: no chat end read, no model call', async ($, on) => {
    const { world, clock } = machine(on)
    await $.classic.SessionStart(START)
    await $.session.start({ cwd: '/Users/me/app', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(PROMPT)
    await clock.settle()
    expect(world.tailed).toEqual([])
    expect(world.asked).toEqual([])
  })
})
