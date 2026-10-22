// A fence opens a line: ``` or ~~~ (three or more), then an optional info string.
// A tab before it makes an indented code line, not a fence.
const OPEN = /^( *)(`{3,}|~{3,})(.*)$/
// It closes on a line of the same character, at least as long, with only spaces
// or tabs after it.
const CLOSE = /^( *)(`{3,}|~{3,})[ \t]*$/
// A list item's first line: its marker and the spaces after it.
const ITEM = /^( *)([-*+]|\d{1,9}[.)])( +)(?=\S)/

// Where the content of the list item a fence sits in starts (a column), or 0
// when it sits in none: the nearest earlier line with less indent than the
// fence, if it is a list item. A line that is not one and has no indent is a
// paragraph, which ends the list; a line that is not one and has some is the
// item's own text, and the search goes on above it.
function listColumn(prior: readonly string[], indent: number): number {
  for (const line of [...prior].reverse()) {
    const lead = line.length - line.trimStart().length
    if (lead >= indent) continue
    const [, pad = '', marker = '', spaces = ''] = ITEM.exec(line) ?? []
    if (marker !== '') return pad.length + marker.length + (spaces.length > 4 ? 1 : spaces.length)
    if (lead === 0) return 0
  }

  return 0
}

// A fence is valid 0 to 3 spaces in, as in CommonMark, counted from the content
// column of the list item it sits in (0 outside any).
const fits = (indent: number, column: number) => indent <= 3 || (indent >= column && indent - column <= 3)

// One fenced block found in a text: the lines it spans (the opening fence to the
// closing one, or to the end when it never closes), the indent its fence had, and
// its code, the lines between the fences as written less that indent.
type Found = { start: number; end: number; indent: number; code: string }

// Every fenced code block of a markdown text, in order, with where it sits. A
// fence closes on the same character at least as long as it opened (so ```` can
// hold ```), the opening fence's indent is taken off each line (a block inside a
// list), an unclosed fence runs to the end, and a block with nothing in it is
// left out. A backtick fence whose info string has a backtick is inline code,
// not a fence.
// ponytail: a fence inside a blockquote ("> ```") is not seen, and CRLF reads as
// LF and the last newline is dropped (both fine to paste). Upgrade path: strip
// the "> " prefixes before the scan.
function scan(lines: readonly string[]): Found[] {
  const found: Found[] = []
  // The lines before this one, for the list search: a fence is its opening line, not its content.
  const prior: string[] = []
  let open: { char: string; size: number; indent: number; column: number; start: number; lines: string[] } | undefined
  const finish = (last: number, isClosed: boolean) => {
    if (!open) return
    // An unclosed fence ends where the text does: its last newline is not content.
    while (!isClosed && open.lines.length > 0 && open.lines[open.lines.length - 1]?.trim() === '') open.lines.pop()
    if (open.lines.some(line => line.trim() !== '')) found.push({ start: open.start, end: last, indent: open.indent, code: open.lines.join('\n') })
    open = undefined
  }

  lines.forEach((line, at) => {
    if (open) {
      const [, pad = '', close = ''] = CLOSE.exec(line) ?? []
      if (close !== '' && close[0] === open.char && close.length >= open.size && fits(pad.length, open.column)) finish(at, true)
      else open.lines.push(line.slice(Math.min(open.indent, line.length - line.trimStart().length)))

      return
    }
    const [, indent = '', fence = '', info = ''] = OPEN.exec(line) ?? []
    const column = fence === '' ? 0 : listColumn(prior, indent.length)
    if (fence !== '' && !(fence[0] === '`' && info.includes('`')) && fits(indent.length, column)) {
      open = { char: fence[0] ?? '`', size: fence.length, indent: indent.length, column, start: at, lines: [] }
      // The fence stands for its block: after it, an earlier list is over.
      prior.push(line)
    } else if (line.trim() !== '') {
      prior.push(line)
    }
  })
  finish(lines.length - 1, false)

  return found
}

// The fenced code blocks of a markdown text, in order, their text without the fences.
export function fencedBlocks(text: string): string[] {
  return scan(text.split(/\r?\n/)).map(one => one.code)
}

// A table row's cells: the line cut at each pipe no backslash escapes, the outer
// pipes dropped, each cell trimmed.
function cells(line: string): string[] {
  let row = line.trim().replace(/\\\|/g, '\u0000')
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|')) row = row.slice(0, -1)

  return row.split('|').map(cell => cell.replace(/\u0000/g, '|').trim())
}

// A delimiter row's cell: dashes, a colon at either end for the alignment.
const RULE = /^:?-+:?$/

// The tables in lines[from, to), as GFM reads them: a header row at most three
// spaces in (four make an indented code line), then a delimiter row with as many
// cells, then the rows. Both first lines hold a pipe, so a setext heading
// ("Title" over "---") is no table. A table with no row is left out: there is
// nothing to reply to.
// ponytail: the rows end at a blank line or a line with no pipe, where GFM also
// takes a line of plain text as a row; and a table in a list item is read as if
// it stood alone. Upgrade path: the list search scan() does.
function tables(lines: readonly string[], from: number, to: number): Array<{ start: number; end: number; rows: string[][] }> {
  const found: Array<{ start: number; end: number; rows: string[][] }> = []
  for (let at = from; at + 2 < to; at++) {
    const head = lines[at] ?? ''
    const rule = lines[at + 1] ?? ''
    if (!/^ {0,3}\S/.test(head) || !head.includes('|') || !rule.includes('|')) continue
    const marks = cells(rule)
    if (marks.length !== cells(head).length || !marks.every(mark => RULE.test(mark))) continue
    let end = at + 1
    while (end + 1 < to && (lines[end + 1] ?? '').includes('|')) end++
    if (end === at + 1) continue
    found.push({ start: at, end, rows: lines.slice(at + 2, end + 1).map(cells) })
    at = end
  }

  return found
}

// The lines /reply-table puts in the prompt box for a table, one per row, for
// the person to finish: the row's first cell (bold and code marks dropped, cut
// to 40 characters) or, when that is empty, the row's number; then " - ".
function replyLines(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row, at) => {
      const label = [...((row[0] ?? '').replace(/\*\*|`/g, '').trim() || String(at + 1))]

      return `${label.length > 40 ? `${label.slice(0, 39).join('').trimEnd()}…` : label.join('')} - `
    })
    .join('\n')
}

// A text cut at its fenced blocks and its tables: the prose between them; each
// block as markdown (its fences, dedented to the fence's own indent, so it still
// reads as a fence away from the list it sat in) with its code; and each table
// as written, with the lines /reply-table puts in the prompt box for it.
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'block'; source: string; code: string }
  | { kind: 'table'; source: string; reply: string }

export function segments(text: string): Segment[] {
  const lines = text.split(/\r?\n/)
  const out: Segment[] = []
  const plain = (from: number, to: number) => {
    const piece = lines.slice(from, to)
    while (piece.length > 0 && piece[0]?.trim() === '') piece.shift()
    while (piece.length > 0 && piece[piece.length - 1]?.trim() === '') piece.pop()
    if (piece.length > 0) out.push({ kind: 'text', text: piece.join('\n') })
  }
  // The prose between two blocks, cut at its tables.
  const prose = (from: number, to: number) => {
    let next = from
    for (const one of tables(lines, from, to)) {
      plain(next, one.start)
      out.push({ kind: 'table', source: lines.slice(one.start, one.end + 1).join('\n'), reply: replyLines(one.rows) })
      next = one.end + 1
    }
    plain(next, to)
  }
  let next = 0
  for (const one of scan(lines)) {
    prose(next, one.start)
    const source = lines
      .slice(one.start, one.end + 1)
      .map(line => line.slice(Math.min(one.indent, line.length - line.trimStart().length)))
      .join('\n')
    out.push({ kind: 'block', source, code: one.code })
    next = one.end + 1
  }
  prose(next, lines.length)

  return out
}

export function lineCount(block: string): number {
  return block.split('\n').length
}

// "Copied 12 lines", "Copied 1 line".
export function copiedNote(block: string): string {
  const n = lineCount(block)
  return `Copied ${n} ${n === 1 ? 'line' : 'lines'}`
}

// The reply lines of each table of a markdown text, in order.
export function tableReplies(text: string): string[] {
  return segments(text).flatMap(part => (part.kind === 'table' ? [part.reply] : []))
}

// The block or table a /copy-block or /reply-table argument names, 0-based: the
// last with none, else n (1 is the first); or what to tell the person.
export function pick(count: number, arg: string, what: 'block' | 'table'): { index: number } | { error: string } {
  if (count === 0) return { error: `No ${what === 'block' ? 'code block' : 'table'} in the last answer.` }
  const text = arg.trim()
  if (text === '') return { index: count - 1 }
  if (!/^\d+$/.test(text)) return { error: `Usage: /${what === 'block' ? 'copy-block' : 'reply-table'} [n], n from 1 to the number of ${what}s.` }
  const n = Number(text)
  if (n < 1 || n > count) return { error: `No ${what} ${n}: the last answer has ${count} ${count === 1 ? what : `${what}s`}.` }

  return { index: n - 1 }
}
