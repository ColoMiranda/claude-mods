import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderSurface, Register } from 'claude-code'

import { copiedNote, fencedBlocks, pick, segments, tableReplies } from './parse'

// The bullet that opens a reply, as the engine draws it on macOS (elsewhere it is ●).
const BULLET = '⏺'

// Markdown takes at most 10000 characters, and tab and newline as its only control characters.
const drawable = (text: string) => text.length <= 10000 && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)

// The fenced blocks of the last main-loop answer, for /copy-block.
const lastBlocks = atom({ plugin: 'copy-draft', key: 'lastBlocks' } as const, [])
// The reply lines of each table of the last main-loop answer, for /reply-table.
const lastReplies = atom({ plugin: 'copy-draft', key: 'lastReplies' } as const, [])

// Copies `text` on `surface` (left out: the session's first), and says how it went.
async function copyText($: EngineInterface, text: string, surface?: RenderSurface) {
  const copied = await $.ui.copy({ text, surface })

  return copied.isCopied ? copiedNote(text) : `Could not copy: ${copied.reason}`
}

// A copy button's press: the block, and a toast on how it went.
async function copyAndSay($: EngineInterface, text: string, surface: RenderSurface) {
  $.ui.toast(await copyText($, text, surface))
}

// Puts a table's reply lines in the prompt box, under what the person typed so
// nothing of theirs is lost; says why when the box did not take them.
async function fillReply($: EngineInterface, reply: string): Promise<string | undefined> {
  const { text } = await $.prompt.read()
  const filled =
    text.trim() === ''
      ? await $.prompt.fill({ text: reply, mode: 'replace' })
      : await $.prompt.fill({ text: text.endsWith('\n') ? reply : `\n${reply}`, mode: 'append' })

  return filled.isFilled ? undefined : `Could not fill the prompt box${filled.refusal === undefined ? '' : `: ${filled.refusal}`}.`
}

// A reply button's press: the lines in the box, or a toast on why not.
async function fillAndSay($: EngineInterface, reply: string) {
  const problem = await fillReply($, reply)
  if (problem !== undefined) $.ui.toast(problem)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'copy-block', description: 'Copy a fenced code block of the last answer', argumentHint: '[n]', immediate: true })
    await $.command.register({ name: 'reply-table', description: 'Put one line per row of a table of the last answer in the prompt box', argumentHint: '[n]', immediate: true })

    return next(e)
  })

  // The blocks and tables of the main loop's answer, when the turn answered. A
  // subagent's turn is not the person's answer; an interrupted or failed one has
  // none, and the last ones stay.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') {
      await update($, lastBlocks, () => fencedBlocks(e.answer))
      await update($, lastReplies, () => tableReplies(e.answer))
    }

    return done
  })

  on('command.run', { command: 'copy-block' }, async ($, e) => {
    const blocks = await read($, lastBlocks)
    const target = pick(blocks.length, e.args, 'block')

    return { text: 'error' in target ? target.error : await copyText($, blocks[target.index] ?? '') }
  })

  // The filled box shows it worked, so a fill prints nothing.
  on('command.run', { command: 'reply-table' }, async ($, e) => {
    const replies = await read($, lastReplies)
    const target = pick(replies.length, e.args, 'table')
    if ('error' in target) return { text: target.error }
    const problem = await fillReply($, replies[target.index] ?? '')

    return problem === undefined ? {} : { text: problem }
  })

  // A copy button right under each fenced block of an answer row, and a reply
  // button right under each table. Live, a row holds the prose before a block,
  // the block and the prose after it, so the row is drawn here in segments
  // (prose, block or table, its button, prose...) with the bullet and the indent
  // the engine gives it. The buttons read the row's own text, not the state, so
  // older messages keep theirs: "copy" for one block, "copy 1", "copy 2" and so
  // on for several, and "reply", "reply 1"... the same way for tables. The
  // terminal's alone: no other surface has a clipboard path for ui.copy yet.
  // Transcript rows hold no focus, so no hotkeys. A row with no block and no
  // table is passed untouched. When a segment cannot be drawn as markdown (over
  // 10000 characters, or a control character), the engine's row is drawn and
  // the buttons come under all of it.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const parts = e.surface === 'terminal' ? segments(e.props.text) : []
    const blocks = parts.flatMap(part => (part.kind === 'block' ? [part.code] : []))
    const replies = parts.flatMap(part => (part.kind === 'table' ? [part.reply] : []))
    if (blocks.length === 0 && replies.length === 0) return next(e)
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const copyButton = (no: number) => (
      <Button key={`copy-${no}`} label={blocks.length === 1 ? 'copy' : `copy ${no}`} onPress={press => copyAndSay($, blocks[no - 1] ?? '', press.surface)} />
    )
    const replyButton = (no: number) => (
      <Button key={`reply-${no}`} label={replies.length === 1 ? 'reply' : `reply ${no}`} onPress={() => fillAndSay($, replies[no - 1] ?? '')} />
    )

    if (!parts.every(part => drawable(part.kind === 'text' ? part.text : part.source))) {
      const rest = await next(e)

      return (
        <Box flexDirection="column">
          {rest}
          <Box gap={1} marginLeft={2}>
            {blocks.map((_, i) => copyButton(i + 1))}
            {replies.map((_, i) => replyButton(i + 1))}
          </Box>
        </Box>
      )
    }
    let blockNo = 0
    let tableNo = 0

    return (
      <Box flexDirection="row">
        <Box minWidth={2} flexShrink={0}>
          {e.props.isFirstOfReply && <Text>{BULLET}</Text>}
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {parts.map(part =>
            part.kind === 'text' ? (
              <Markdown text={part.text} />
            ) : (
              <Box flexDirection="column">
                <Markdown text={part.source} />
                <Box>{part.kind === 'block' ? copyButton(++blockNo) : replyButton(++tableNo)}</Box>
              </Box>
            ),
          )}
        </Box>
      </Box>
    )
  })
}
