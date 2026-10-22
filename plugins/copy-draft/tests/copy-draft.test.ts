import type { On, RenderSurface } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Segment } from '../hooks/parse'
import { copiedNote, fencedBlocks, lineCount, pick, segments, tableReplies } from '../hooks/parse'

describe('fencedBlocks', () => {
  // [name, text, the blocks]
  const cases: Array<[string, string, string[]]> = [
    ['no fence', 'Just text, with `inline` code.', []],
    ['a fence', 'Intro\n```\nhello\nworld\n```\nOutro', ['hello\nworld']],
    ['a language tag', '```md\n# Title\n\nbody\n```', ['# Title\n\nbody']],
    ['an info string with spaces', '``` js title="a.js"\nx\n```', ['x']],
    ['a tilde fence', '~~~\na\n~~~', ['a']],
    ['a tilde fence with a tag', '~~~slack\nhi\n~~~', ['hi']],
    ['two blocks, in order', '```\na\n```\ntext\n```sh\nb\n```', ['a', 'b']],
    ['blocks with no text between', '```\na\n```\n```\nb\n```', ['a', 'b']],
    ['an unclosed fence runs to the end', 'Draft:\n```txt\nfirst\nsecond', ['first\nsecond']],
    ['an unclosed fence does not keep the final newline', '```txt\nfirst\nsecond\n\n', ['first\nsecond']],
    ['an unclosed fence with nothing in it', 'text\n```\n', []],
    ['inline triple backticks are not a fence', 'Run ```npm test``` now', []],
    ['a line of triple backticks with more after them', '```not a fence```\nmore text', []],
    ['four backticks hold three', '````md\n```js\ncode\n```\n````', ['```js\ncode\n```']],
    ['a shorter fence does not close a longer one', '````\na\n```\nb\n````', ['a\n```\nb']],
    ['a longer fence closes', '```\na\n`````', ['a']],
    ['a fence with an info string does not close', '```\n```js\nx\n```', ['```js\nx']],
    ['tildes inside backticks', '```\n~~~\nx\n~~~\n```', ['~~~\nx\n~~~']],
    ['backticks inside tildes', '~~~\n```\nx\n```\n~~~', ['```\nx\n```']],
    ['a block in a list takes its indent off', '1. Step\n   ```sh\n   npm i\n     npm test\n   ```\n2. Next', ['npm i\n  npm test']],
    ['windows line endings', '```\r\na\r\nb\r\n```', ['a\nb']],
    ['blank lines inside stay as written', '```\n\nhello\n\n```', ['\nhello\n']],
    ['an empty block is left out', '```\n```\n```\n  \n```\n```\nreal\n```', ['real']],
    ['spaces after the closing fence', '```\na\n```   \ntext', ['a']],
    ['text after the last fence is not in it', '```\na\n```\n\nThanks!', ['a']],
    ['three spaces still open a fence', '   ```\n   a\n   ```', ['a']],
    ['four spaces are an indented code line, not a fence', 'See:\n\n    ```\n\nThen run `make`.\n\n```sh\nmake\n```', ['make']],
    ['an indented example holds no block', 'Example:\n\n    ```js\n    x = 1\n    ```\n\nDone.', []],
    ['a tab is four columns: a tab-indented fence is no fence', '\t```bash\n\tls -la\n\t```', []],
    ['a fence indented four spaces does not close a block', '```\na\n    ```\nb\n```', ['a\n    ```\nb']],
    ['a tab after the closing fence still closes', '```sh\necho a\n```\t\nafter text', ['echo a']],
    ['spaces and a tab after the closing fence', '```\na\n``` \t \ntext', ['a']],
    ['a tilde fence closed with a tab', '~~~\na\n~~~\t', ['a']],
    ['a block inside a blockquote is not seen', '> ```sh\n> rm -rf build\n> ```', []],
    ['a tilde info string with backticks is still a fence', '~~~ `weird`\ncode\n~~~', ['code']],
    ['a fence in a nested list (five spaces)', '1. Step:\n   - sub:\n     ```bash\n     make\n     ```', ['make']],
    ['a fence in a two-level list', '- a\n  - b\n    ```sh\n    x\n    ```', ['x']],
    ['a fence in a three-level list', '1. a\n   - b\n     * c\n       ```\n       deep\n       ```\n', ['deep']],
    ['a nested block takes its whole indent off', '- a\n  - b\n    ```\n    one\n      two\n    ```', ['one\n  two']],
    ['a fence three spaces past the item content', '- a\n     ```\n     x\n     ```', ['x']],
    ['a fence four spaces past the item content is no fence', '- a\n      ```\n      x\n      ```', []],
    ['a fence four spaces past a nested item content is no fence', '1. a\n   - b\n         ```\n         x\n         ```', []],
    ['an ordered item with a wide marker', '10. Step\n    ```sh\n    x\n    ```', ['x']],
    ['a wide marker, three past its content', '10. Step\n       ```\n       x\n       ```', ['x']],
    ['a wide marker, four past its content is no fence', '10. Step\n        ```\n        x\n        ```', []],
    ['an ordered item with a parenthesis', '1) Step\n   ```\n   x\n   ```', ['x']],
    ['a fence indented less than the item content, up to three spaces', '1. Step\n  ```\n  x\n  ```', ['x']],
    ['a paragraph after a list ends it: four spaces are indented code', '- item\n\nSee:\n\n    ```\n    x\n    ```', []],
    ['the item text between the item and the fence is skipped', '1. Step:\n   - sub:\n\n   Para\n     ```\n     z\n     ```', ['z']],
    ['the inside of an earlier block is no list item', '- a\n  ```\n  - fake\n  ```\n\n      ```\n      x\n      ```', ['- fake']],
    ['a fence between a list and an indented fence ends the list', '- a\n\n```\nx\n```\n\n    ```\n    y\n    ```', ['x']],
    ['a fence level with a nested item sits in the item above it', '1. a\n    - b\n    ```\n    x\n    ```', ['x']],
    ['a nested closer closes', '- a\n  - b\n    ```\n    x\n    ```\n    after', ['x']],
    ['less indent than the fence keeps the line as it is', '  ```\n  a\nb\n   c\n  ```', ['a\nb\n c']],
  ]
  for (const [name, text, blocks] of cases) {
    test(name, () => {
      expect(fencedBlocks(text)).toEqual(blocks)
      // The same blocks, cut out of the text, in the same order.
      expect(segments(text).flatMap(part => (part.kind === 'block' ? [part.code] : []))).toEqual(blocks)
    })
  }
})

describe('segments', () => {
  const prose = (text: string): Segment => ({ kind: 'text', text })
  const block = (source: string, code: string): Segment => ({ kind: 'block', source, code })
  const cases: Array<[string, string, Segment[]]> = [
    ['no fence is one piece of prose', 'Just text.\n\nMore text.', [prose('Just text.\n\nMore text.')]],
    ['prose, a block, prose', 'Here it is:\n\n```\nhi\n```\n\nPush it?', [prose('Here it is:'), block('```\nhi\n```', 'hi'), prose('Push it?')]],
    ['two blocks with nothing between', '```sh\na\n```\n```sh\nb\n```', [block('```sh\na\n```', 'a'), block('```sh\nb\n```', 'b')]],
    ['prose, block, prose, block, prose', 'one\n```\na\n```\ntwo\n```\nb\n```\nthree', [prose('one'), block('```\na\n```', 'a'), prose('two'), block('```\nb\n```', 'b'), prose('three')]],
    ['an unclosed final fence runs to the end', 'Draft:\n```txt\nstill going\n', [prose('Draft:'), block('```txt\nstill going\n', 'still going')]],
    ['a tilde fence keeps its tildes', '~~~sh\nx\n~~~', [block('~~~sh\nx\n~~~', 'x')]],
    ['a longer fence keeps the fence inside it', '````md\n```js\nx\n```\n````', [block('````md\n```js\nx\n```\n````', '```js\nx\n```')]],
    ['an empty block stays in the prose', 'a\n```\n```\nb', [prose('a\n```\n```\nb')]],
    ['blank lines around prose are dropped, inside ones are kept', '\n\nfirst\n\nsecond\n\n```\nx\n```\n\n\n', [prose('first\n\nsecond'), block('```\nx\n```', 'x')]],
    ['prose with nothing in it is skipped', '```\na\n```\n   \n\n```\nb\n```', [block('```\na\n```', 'a'), block('```\nb\n```', 'b')]],
    ['windows line endings', 'a\r\n```\r\nx\r\n```\r\nb', [prose('a'), block('```\nx\n```', 'x'), prose('b')]],
    [
      'a block in a nested list leaves the list its indent: it is a fence of its own',
      '1. Step:\n   - sub:\n     ```bash\n     make\n     ```\n   - after',
      [prose('1. Step:\n   - sub:'), block('```bash\nmake\n```', 'make'), prose('   - after')],
    ],
    [
      'a four-space fence line is prose',
      'See:\n\n    ```\n\nThen run `make`.\n\n```sh\nmake\n```',
      [prose('See:\n\n    ```\n\nThen run `make`.'), block('```sh\nmake\n```', 'make')],
    ],
  ]
  for (const [name, text, expected] of cases) {
    test(name, () => {
      expect(segments(text)).toEqual(expected)
    })
  }
})

describe('tables', () => {
  const prose = (text: string): Segment => ({ kind: 'text', text })
  const table = (source: string, reply: string): Segment => ({ kind: 'table', source, reply })
  const R = '| # | Problem |\n|---|---|\n| R22 | Two readings |\n| R23 | No number |'
  const cases: Array<[string, string, Segment[]]> = [
    ['prose, a table, prose', `Minors:\n\n${R}\n\nApprove?`, [prose('Minors:'), table(R, 'R22 - \nR23 - '), prose('Approve?')]],
    ['no outer pipes, and alignment colons', 'a | b\n:--- | :---:\nx | y', [table('a | b\n:--- | :---:\nx | y', 'x - ')]],
    ['a table right under a line of text', 'Here:\n| a | b |\n|---|---|\n| x | y |', [prose('Here:'), table('| a | b |\n|---|---|\n| x | y |', 'x - ')]],
    ['the rows end at a line with no pipe', '| a |\n|---|\n| x |\nafter\n\n| b |', [table('| a |\n|---|\n| x |', 'x - '), prose('after\n\n| b |')]],
    ['two tables', '| a |\n|---|\n| x |\n\n| b |\n|---|\n| y |\n| z |', [table('| a |\n|---|\n| x |', 'x - '), table('| b |\n|---|\n| y |\n| z |', 'y - \nz - ')]],
    ['a table and a block', '| a |\n|---|\n| x |\n\n```\ncode\n```', [table('| a |\n|---|\n| x |', 'x - '), { kind: 'block', source: '```\ncode\n```', code: 'code' }]],
    ['a table in a block is code', '```\n| a |\n|---|\n| x |\n```', [{ kind: 'block', source: '```\n| a |\n|---|\n| x |\n```', code: '| a |\n|---|\n| x |' }]],
    ['windows line endings', '| a |\r\n|---|\r\n| x |', [table('| a |\n|---|\n| x |', 'x - ')]],
  ]
  for (const [name, text, expected] of cases) {
    test(name, () => {
      expect(segments(text)).toEqual(expected)
    })
  }

  // [name, text]: all of it prose.
  const notTables: Array<[string, string]> = [
    ['no delimiter row', '| a | b |\n| x | y |'],
    ['a delimiter row with another number of cells', '| a | b |\n|---|\n| x | y |'],
    ['a header and a delimiter row, but no row', '| a | b |\n|---|---|\n\nText.'],
    ['a setext heading', 'Title\n---\nmore'],
    ['four spaces in: an indented code line', '    | a |\n    |---|\n    | x |'],
    ['in a blockquote', '> | a |\n> |---|\n> | x |'],
    ['a pipe in prose', 'Use a | b, then\n--- done'],
  ]
  for (const [name, text] of notTables) {
    test(`not a table: ${name}`, () => {
      expect(segments(text)).toEqual([prose(text)])
    })
  }

  // [name, the rows under a two-cell header, the reply lines]
  const replies: Array<[string, string, string]> = [
    ['the first cell, as written', '| R22 | x |\n| r23 | y |', 'R22 - \nr23 - '],
    ['an empty first cell: the row number', '|  | x |\n| R2 | y |\n| | z |', '1 - \nR2 - \n3 - '],
    ['bold and code marks are dropped', '| **R22** | x |\n| `open-last` | y |', 'R22 - \nopen-last - '],
    ['an escaped pipe stays in its cell', '| a \\| b | x |', 'a | b - '],
    ['40 characters stay whole', `| ${'x'.repeat(40)} | y |`, `${'x'.repeat(40)} - `],
    ['over 40 are cut to 39 and …', `| ${'x'.repeat(41)} | y |`, `${'x'.repeat(39)}… - `],
    ['the cut keeps whole characters', `| ${'😀'.repeat(41)} | y |`, `${'😀'.repeat(39)}… - `],
    ['the cut drops the spaces before the …', `| ${'x'.repeat(38)} more words | y |`, `${'x'.repeat(38)}… - `],
  ]
  for (const [name, rows, lines] of replies) {
    test(`reply lines: ${name}`, () => {
      expect(tableReplies(`| a | b |\n|---|---|\n${rows}`)).toEqual([lines])
    })
  }
})

describe('the small parts', () => {
  test('lines', () => {
    expect(lineCount('a')).toBe(1)
    expect(lineCount('a\nb\n')).toBe(3)
  })

  test('the note', () => {
    expect(copiedNote('a\nb\nc')).toBe('Copied 3 lines')
    expect(copiedNote('a')).toBe('Copied 1 line')
  })

  test('the block or table a /copy-block or /reply-table argument names', () => {
    expect(pick(3, '', 'block')).toEqual({ index: 2 })
    expect(pick(3, ' 1 ', 'block')).toEqual({ index: 0 })
    expect(pick(3, '3', 'block')).toEqual({ index: 2 })
    expect(pick(3, '4', 'block')).toEqual({ error: 'No block 4: the last answer has 3 blocks.' })
    expect(pick(3, '0', 'block')).toEqual({ error: 'No block 0: the last answer has 3 blocks.' })
    expect(pick(1, '2', 'block')).toEqual({ error: 'No block 2: the last answer has 1 block.' })
    expect(pick(3, 'two', 'block')).toEqual({ error: 'Usage: /copy-block [n], n from 1 to the number of blocks.' })
    expect(pick(3, '-1', 'block')).toEqual({ error: 'Usage: /copy-block [n], n from 1 to the number of blocks.' })
    expect(pick(0, '', 'block')).toEqual({ error: 'No code block in the last answer.' })
    expect(pick(0, '1', 'block')).toEqual({ error: 'No code block in the last answer.' })
    expect(pick(2, '', 'table')).toEqual({ index: 1 })
    expect(pick(2, '3', 'table')).toEqual({ error: 'No table 3: the last answer has 2 tables.' })
    expect(pick(1, '2', 'table')).toEqual({ error: 'No table 2: the last answer has 1 table.' })
    expect(pick(2, 'x', 'table')).toEqual({ error: 'Usage: /reply-table [n], n from 1 to the number of tables.' })
    expect(pick(0, '', 'table')).toEqual({ error: 'No table in the last answer.' })
  })
})

const fence = (body: string) => '```\n' + body + '\n```'
const TEAM = { command: 'copy-block', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

// What the buttons need beneath them: the turn's own result, a clipboard that
// takes the text (or not), a prompt box that holds a draft and takes the reply
// lines (or not), and the engine's own row for an answer.
function stub(on: On) {
  const copies: Array<{ text: string; surface: string | undefined }> = []
  const toasts: string[] = []
  const clipboard = { isCopied: true }
  const fills: Array<{ text: string; mode: string }> = []
  const box = { text: '', isFilled: true }
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.copy', (_$, e) => {
    copies.push({ text: e.text, surface: e.surface })

    return { value: clipboard.isCopied ? { isCopied: true as const } : { isCopied: false as const, reason: 'no-clipboard' as const } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', (_$, e) => {
    fills.push({ text: e.text, mode: e.mode })

    return { isFilled: box.isFilled }
  })
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'Text', children: ['ENGINE ROW'] }))

  return { copies, toasts, clipboard, fills, box }
}
const complete = ($: Engine, answer: string, extra: { agentId?: string; reason?: 'answer' | 'aborted' | 'error' } = {}) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...extra })
const run = ($: Engine, args: string) => $.command.run({ ...TEAM, args })
const mountRow = ($: Engine, text: string, surface: RenderSurface = 'terminal', isFirstOfReply = true) =>
  $.ui.mount({ plugin: 'copy-draft', surface, component: 'AssistantMessage', props: { text, isFirstOfReply } })

describe('the last answer\'s blocks', () => {
  test('a new answer replaces them; one with no block empties them', async ($, on) => {
    stub(on)
    await complete($, `${fence('old one')}\n${fence('old two')}`)
    await complete($, `${fence('new one')}\n${fence('new two')}\n${fence('new three')}`)
    expect(await run($, '1')).toEqual({ text: 'Copied 1 line' })
    expect(await run($, '4')).toEqual({ text: 'No block 4: the last answer has 3 blocks.' })
    await complete($, 'Nothing to copy this time.')
    expect(await run($, '')).toEqual({ text: 'No code block in the last answer.' })
  })

  test('only the main loop answers: a subagent turn, an interrupted turn and a failed one leave the blocks as they were', async ($, on) => {
    const { copies } = stub(on)
    await complete($, fence('the draft'))
    await complete($, fence('a subagent draft'), { agentId: 'a1' })
    await complete($, fence('half an answer'), { reason: 'aborted' })
    await complete($, '', { reason: 'error' })
    expect(await run($, '')).toEqual({ text: 'Copied 1 line' })
    expect(copies.map(one => one.text)).toEqual(['the draft'])
  })

  test('turn.complete still answers with the turn\'s own result', async ($, on) => {
    stub(on)
    expect(await complete($, fence('x'))).toEqual({ text: fence('x') })
  })
})

describe('the buttons under a draft in the chat', () => {
  // What a row draws, top to bottom: the bullet, each piece of markdown, each button, the engine's own row.
  const drawn = async (row: Awaited<ReturnType<typeof mountRow>>) =>
    (await row.findAll({}))
      .filter(one => one.type === 'Button' || one.type === 'Markdown' || (one.type === 'Text' && (one.text === 'ENGINE ROW' || one.text === '⏺')))
      .map(one => (one.type === 'Button' ? `button:${one.key}:${one.text}` : one.type === 'Markdown' ? `md:${one.text}` : one.text))
  const TABLE = '| # | Problem |\n|---|---|\n| R22 | Two readings |\n| R23 | No number |'

  test('a button right under its block, before the prose that follows it', async ($, on) => {
    stub(on)
    const row = await mountRow($, 'Here it is:\n\n```\nhi there\n```\n\nPush copy-draft 0.3.0?')
    expect(await drawn(row)).toEqual(['⏺', 'md:Here it is:', 'md:```\nhi there\n```', 'button:copy-1:copy', 'md:Push copy-draft 0.3.0?'])
    expect((await row.find({ type: 'Button' }))?.props.hotkey).toBeUndefined()
    await row.unmount()
  })

  test('several blocks: copy 1, copy 2, copy 3, each under its own block; a press copies that block, from this row\'s own text', async ($, on) => {
    const { copies, toasts } = stub(on)
    // The state holds another answer's blocks: the buttons do not read it.
    await complete($, `${fence('state one')}\n${fence('state two')}`)
    const row = await mountRow($, `Three:\n\n${fence('first')}\n\nthen\n\n${fence('second\n  indented\nsecond end')}\n\nand\n\n~~~sh\nthird\n~~~\n\nend`)
    expect(await drawn(row)).toEqual([
      '⏺',
      'md:Three:',
      'md:```\nfirst\n```',
      'button:copy-1:copy 1',
      'md:then',
      'md:```\nsecond\n  indented\nsecond end\n```',
      'button:copy-2:copy 2',
      'md:and',
      'md:~~~sh\nthird\n~~~',
      'button:copy-3:copy 3',
      'md:end',
    ])

    await row.press({ key: 'copy-2' })
    await row.press({ key: 'copy-3' })
    await row.press({ key: 'copy-1' })
    expect(copies).toEqual([
      { text: 'second\n  indented\nsecond end', surface: 'terminal' },
      { text: 'third', surface: 'terminal' },
      { text: 'first', surface: 'terminal' },
    ])
    expect(toasts).toEqual(['Copied 3 lines', 'Copied 1 line', 'Copied 1 line'])
    await row.unmount()
  })

  test('the bullet opens the reply only: the first row has it, a later one is indented the same', async ($, on) => {
    stub(on)
    for (const isFirst of [true, false]) {
      const row = await mountRow($, '```\nhi\n```', 'terminal', isFirst)
      expect((await drawn(row))[0] === '⏺').toBe(isFirst)
      expect((await row.findAll({ type: 'Box' })).some(one => one.props.minWidth === 2)).toBe(true)
      // The bullet's column beside a column that takes the rest.
      const boxes = await row.findAll({ type: 'Box' })
      expect(boxes.some(one => one.props.flexDirection === 'row')).toBe(true)
      expect(boxes.some(one => one.props.flexDirection === 'column' && one.props.flexGrow === 1)).toBe(true)
      await row.unmount()
    }
  })

  test('a block in a nested list is drawn as a fence of its own, under it', async ($, on) => {
    const { copies } = stub(on)
    const row = await mountRow($, '1. Step:\n   - sub:\n     ```bash\n     make\n     ```\n   - after')
    expect(await drawn(row)).toEqual(['⏺', 'md:1. Step:\n   - sub:', 'md:```bash\nmake\n```', 'button:copy-1:copy', 'md:   - after'])
    await row.press({ key: 'copy-1' })
    expect(copies.map(one => one.text)).toEqual(['make'])
    await row.unmount()
  })

  test('an unclosed final fence gets its button at the end', async ($, on) => {
    const { copies } = stub(on)
    const row = await mountRow($, 'Draft:\n```txt\nstill going')
    expect(await drawn(row)).toEqual(['⏺', 'md:Draft:', 'md:```txt\nstill going', 'button:copy-1:copy'])
    await row.press({ key: 'copy-1' })
    expect(copies.map(one => one.text)).toEqual(['still going'])
    await row.unmount()
  })

  test('a failed copy says why', async ($, on) => {
    const { toasts, clipboard } = stub(on)
    clipboard.isCopied = false
    const row = await mountRow($, '```\nhi\n```')
    await row.press({ key: 'copy-1' })
    expect(toasts).toEqual(['Could not copy: no-clipboard'])
    await row.unmount()
  })

  test('markdown that cannot be drawn (too long, or a control character) falls back: the engine\'s row, the buttons under all of it', async ($, on) => {
    const { copies } = stub(on)
    const fallbacks = [
      `${'a'.repeat(10001)}\n\n${fence('x')}`,
      `${fence('x')}\n\n${'b'.repeat(10001)}`,
      `Here:\n\n${fence('y'.repeat(9995))}`, // the block with its fences is 10003 characters
      `Escape \u001b[31m here\n\n${fence('x')}`,
    ]
    for (const [i, text] of fallbacks.entries()) {
      const row = await mountRow($, text)
      expect(await drawn(row)).toEqual(['ENGINE ROW', 'button:copy-1:copy'])
      await row.press({ key: 'copy-1' })
      expect(copies.at(-1)?.text).toBe(i === 2 ? 'y'.repeat(9995) : 'x')
      await row.unmount()
    }
    // At the limit it still draws in pieces.
    for (const text of [`${'a'.repeat(10000)}\n\n${fence('x')}`, `Here:\n\n${fence('y'.repeat(9992))}`]) {
      const edge = await mountRow($, text)
      expect((await drawn(edge))[0]).toBe('⏺')
      await edge.unmount()
    }
  })

  test('a reply button right under its table, before the prose that follows it; a press fills the box with one line per row', async ($, on) => {
    const { fills, toasts } = stub(on)
    const row = await mountRow($, `Minors:\n\n${TABLE}\n\nApprove?`)
    expect(await drawn(row)).toEqual(['⏺', 'md:Minors:', `md:${TABLE}`, 'button:reply-1:reply', 'md:Approve?'])
    await row.press({ key: 'reply-1' })
    expect(fills).toEqual([{ text: 'R22 - \nR23 - ', mode: 'replace' }])
    expect(toasts).toEqual([])
    await row.unmount()
  })

  test('tables and a block in one row: reply 1, copy, reply 2, each under its own part; a press fills from its own table', async ($, on) => {
    const { fills, copies } = stub(on)
    const row = await mountRow($, `One:\n\n| a |\n|---|\n| x |\n\n${fence('code')}\n\nTwo:\n\n| b |\n|---|\n| y |\n| z |`)
    expect(await drawn(row)).toEqual([
      '⏺',
      'md:One:',
      'md:| a |\n|---|\n| x |',
      'button:reply-1:reply 1',
      'md:```\ncode\n```',
      'button:copy-1:copy',
      'md:Two:',
      'md:| b |\n|---|\n| y |\n| z |',
      'button:reply-2:reply 2',
    ])
    await row.press({ key: 'reply-2' })
    await row.press({ key: 'copy-1' })
    await row.press({ key: 'reply-1' })
    expect(fills.map(one => one.text)).toEqual(['y - \nz - ', 'x - '])
    expect(copies.map(one => one.text)).toEqual(['code'])
    await row.unmount()
  })

  test('what the person typed stays: the lines go under it, on a line of their own', async ($, on) => {
    const { fills, box } = stub(on)
    const row = await mountRow($, TABLE)
    for (const typed of ['Notes:', 'Notes:\n', '  \n ']) {
      box.text = typed
      await row.press({ key: 'reply-1' })
    }
    expect(fills).toEqual([
      { text: '\nR22 - \nR23 - ', mode: 'append' },
      { text: 'R22 - \nR23 - ', mode: 'append' },
      { text: 'R22 - \nR23 - ', mode: 'replace' },
    ])
    await row.unmount()
  })

  test('a box that does not take the lines says so', async ($, on) => {
    const { toasts, box } = stub(on)
    box.isFilled = false
    const row = await mountRow($, TABLE)
    await row.press({ key: 'reply-1' })
    expect(toasts).toEqual(['Could not fill the prompt box.'])
    await row.unmount()
  })

  test('a table in markdown that cannot be drawn: the engine\'s row, its reply button under all of it', async ($, on) => {
    const { fills } = stub(on)
    const row = await mountRow($, `Escape \u001b[31m here\n\n${TABLE}\n\n${fence('x')}`)
    expect(await drawn(row)).toEqual(['ENGINE ROW', 'button:copy-1:copy', 'button:reply-1:reply'])
    await row.press({ key: 'reply-1' })
    expect(fills.map(one => one.text)).toEqual(['R22 - \nR23 - '])
    await row.unmount()
  })

  test('no block and no table, no button: the engine\'s row is passed untouched', async ($, on) => {
    stub(on)
    for (const text of ['No code here.', 'Only `inline` code and ```triple``` inline.', '    ```\n    indented, no fence\n    ```', '```\n```', '| a | b |\n|---|---|', 'a | b, and c | d']) {
      const row = await mountRow($, text)
      expect(await drawn(row)).toEqual(['ENGINE ROW'])
      expect((await row.findAll({})).map(one => one.type)).toEqual(['Text'])
      await row.unmount()
    }
  })

  test('off the terminal, the engine\'s row is passed untouched', async ($, on) => {
    stub(on)
    for (const surface of ['desktop', 'mobile', 'vscode'] as const) {
      for (const text of ['Here:\n\n```\nhi\n```\n\nDone', `Here:\n\n${TABLE}`]) {
        const row = await mountRow($, text, surface)
        expect(await drawn(row)).toEqual(['ENGINE ROW'])
        await row.unmount()
      }
    }
  })
})

describe('copying', () => {
  test('/copy-block with no argument copies the last block, with n the n-th, exactly as written, and answers as the button toasts', async ($, on) => {
    const { copies, toasts } = stub(on)
    const last = '  indented line\n\n\tTabbed line  \nlast'
    await complete($, `${fence('first')}\n${fence('second\nsecond again')}\n${fence(last)}`)

    expect(await run($, '')).toEqual({ text: 'Copied 4 lines' })
    expect(await run($, '1')).toEqual({ text: 'Copied 1 line' })
    expect(await run($, ' 2 ')).toEqual({ text: 'Copied 2 lines' })
    expect(copies.map(one => one.text)).toEqual([last, 'first', 'second\nsecond again'])
    // The command sets no surface, so the session's first is used.
    expect(copies.every(one => one.surface === undefined)).toBe(true)
    // The same words the button toasts.
    const row = await mountRow($, fence(last))
    await row.press({ key: 'copy-1' })
    expect(toasts).toEqual(['Copied 4 lines'])
    await row.unmount()
  })

  test('/copy-block says what is wrong, and copies nothing: n out of range, not a number, no block', async ($, on) => {
    const { copies } = stub(on)
    expect(await run($, '')).toEqual({ text: 'No code block in the last answer.' })
    await complete($, `${fence('first')}\n${fence('second')}`)
    expect(await run($, '3')).toEqual({ text: 'No block 3: the last answer has 2 blocks.' })
    expect(await run($, '0')).toEqual({ text: 'No block 0: the last answer has 2 blocks.' })
    expect(await run($, 'last')).toEqual({ text: 'Usage: /copy-block [n], n from 1 to the number of blocks.' })
    expect(copies).toEqual([])
  })

  test('/copy-block says so when the copy fails', async ($, on) => {
    const { clipboard } = stub(on)
    clipboard.isCopied = false
    await complete($, fence('a draft'))
    expect(await run($, '')).toEqual({ text: 'Could not copy: no-clipboard' })
  })

  test('the commands are registered when the session starts', async ($, on) => {
    stub(on)
    const registered: Array<{ name: string; argumentHint?: string }> = []
    on('command.register', (_$, e) => {
      registered.push({ name: e.name, argumentHint: e.argumentHint })

      return { value: { command: e.name } }
    })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    expect(registered).toEqual([
      { name: 'copy-block', argumentHint: '[n]' },
      { name: 'reply-table', argumentHint: '[n]' },
    ])
  })
})

describe('/reply-table', () => {
  const reply = ($: Engine, args: string) => $.command.run({ ...TEAM, command: 'reply-table', args })
  const table = (...rows: string[]) => `| # | x |\n|---|---|\n${rows.map(one => `| ${one} | y |`).join('\n')}`

  test('with no argument it fills the box from the last table, with n the n-th, and prints nothing; a new answer replaces the tables', async ($, on) => {
    const { fills } = stub(on)
    await complete($, table('old'))
    await complete($, `${table('R1', 'R2')}\n\nand\n\n${table('S1')}`)
    expect(await reply($, '')).toEqual({})
    expect(await reply($, ' 1 ')).toEqual({})
    expect(fills).toEqual([
      { text: 'S1 - ', mode: 'replace' },
      { text: 'R1 - \nR2 - ', mode: 'replace' },
    ])
    await complete($, 'No table this time.')
    expect(await reply($, '')).toEqual({ text: 'No table in the last answer.' })
  })

  test('says what is wrong, and fills nothing: n out of range, not a number, no table', async ($, on) => {
    const { fills } = stub(on)
    expect(await reply($, '')).toEqual({ text: 'No table in the last answer.' })
    await complete($, `${table('a')}\n\n${table('b')}`)
    expect(await reply($, '3')).toEqual({ text: 'No table 3: the last answer has 2 tables.' })
    expect(await reply($, 'last')).toEqual({ text: 'Usage: /reply-table [n], n from 1 to the number of tables.' })
    expect(fills).toEqual([])
  })

  test('says so when the box does not take the lines', async ($, on) => {
    const { box } = stub(on)
    box.isFilled = false
    await complete($, table('a'))
    expect(await reply($, '')).toEqual({ text: 'Could not fill the prompt box.' })
  })

  test('only the main loop answers: a subagent turn and an interrupted one leave the tables as they were', async ($, on) => {
    const { fills } = stub(on)
    await complete($, table('mine'))
    await complete($, table('subagent'), { agentId: 'a1' })
    await complete($, table('half'), { reason: 'aborted' })
    await reply($, '')
    expect(fills.map(one => one.text)).toEqual(['mine - '])
  })
})
