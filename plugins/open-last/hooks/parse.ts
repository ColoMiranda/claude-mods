// "Output is being written to: /…/tasks/bwlbmkhlu.output." in a background
// Bash result's text.
export function outputPath(text: string): string | undefined {
  return /Output is being written to: (\S+?\.output)\b/.exec(text)?.[1]
}

export function taskId(text: string): string | undefined {
  return /running in background with ID: (\w+)/.exec(text)?.[1]
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})(\/[^\s'"<>)\]]*)?/

// The first local URL a dev server printed, as a Link takes it:
// "  ➜  Local:   http://127.0.0.1:4321/docs" -> http://localhost:4321/docs.
export function localUrl(log: string): { url: string; port: number } | undefined {
  const m = LOCAL_URL.exec(log.replace(ANSI, ''))
  if (!m) return undefined
  const port = Number(m[1])
  return { url: `http://localhost:${port}${m[2] ?? '/'}`, port }
}

// The port a server command names, for a server whose output is buffered
// (python's http.server prints nothing until it exits): "--port 4321",
// "-p 3000", "PORT=8080", "http.server 8765"; a bare http.server is 8000.
// Each flag stands alone (DB_PORT=, PGPORT= and --db-port are not it), and a
// "-p 5432:5432" mapping (docker) names no port of its own.
export function commandPort(command: string): number | undefined {
  const m = /(?:^|\s)(?:PORT=|--port[= ]|-p )["']?(\d{2,5})(?![\w:.])/.exec(command) ?? /http\.server (\d{2,5})\b/.exec(command)
  if (m) return Number(m[1])
  return /http\.server\b/.test(command) ? 8000 : undefined
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

// "/p/.env/x/.." -> "/p/.env", "/p//a/./b/" -> "/p/a/b": the file a spelling
// names once ".", ".." and repeated or trailing slashes are folded, as the
// Write tool and $.fs fold them (links aside).
export function normalizePath(path: string): string {
  const isAbsolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') parts.push(part)
    else if (parts.length > 0 && parts.at(-1) !== '..') parts.pop()
    else if (!isAbsolute) parts.push('..')
  }

  return isAbsolute ? `/${parts.join('/')}` : parts.join('/') || '.'
}

const TEMPLATE = /\.(?:example|sample|template|dist|defaults)$/
const CODE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|cs|c|h|cc|cpp|hpp|scala|zig)$/
const KEY_PART = /(?:^|[._-])(?:rsa|dsa|ecdsa|ed25519)(?:[._-]|$)/
const ID_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)/
const SECRET_NAMES = new Set(['.envrc', '.git-credentials', '.netrc', '.npmrc', '.pypirc', '.pgpass', 'credentials'])
const SECRET_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore)$/

// ponytail: a fixed list of names, any case, on the normalized path: .env,
// *.env and .env.* (not a template ending in .example, .sample, .template,
// .dist or .defaults, nor code such as .env.ts); a private key by its
// algorithm, in a name with no extension (github_rsa, id_ed25519_work) or
// one that starts id_<algorithm> (id_rsa.bak), never a .pub; so rsa.md and
// rsa_keygen.sh stay visible; or by
// extension (.pem, .key, ...); credential files (.envrc, .git-credentials,
// .netrc, .npmrc, .pypirc, .pgpass, credentials, .docker/config.json,
// service-account*.json). Content is not scanned, so a secret copied into a
// normal file (cp .env config.txt) still reaches the patch: the accepted
// limit. Upgrade path: scan the old and new text for key patterns.
export function isSecret(path: string): boolean {
  const lower = normalizePath(path).toLowerCase()
  const name = basename(lower)
  if (name.endsWith('.env')) return true
  if (name.startsWith('.env.')) return !TEMPLATE.test(name) && !CODE.test(name)
  if (!name.endsWith('.pub') && (ID_KEY.test(name) || (KEY_PART.test(name) && !name.includes('.')))) return true

  return (
    SECRET_NAMES.has(name) ||
    SECRET_EXTENSION.test(name) ||
    `/${lower}`.endsWith('/.docker/config.json') ||
    /^service[-_]account.*\.json$/.test(name)
  )
}

// A shell word: quotes and escapes folded in. Dynamic when an unquoted $, `,
// glob or brace makes its value known only at run time.
type Word = { word: string; isDynamic: boolean }
type Token = Word | { op: string }

// Longest first, so ">>" is never read as two ">".
const OPS = ['&>>', '<<-', '<<<', '&&', '||', '>>', '>|', '&>', '>&', '<&', '<<', ';', '|', '&', '(', ')', '<', '>', '\n']
const REDIRECT_OUT = new Set(['>', '>>', '>|', '&>', '&>>', '>&'])
const REDIRECT_IN = new Set(['<', '<<', '<<-', '<<<', '<&'])
// Words that run the command after them: `sudo sed -i ...` is sed.
const PREFIXES = new Set(['sudo', 'command', 'env', 'nohup', 'time', 'exec', '{', '!'])

// The index of the ")" that closes the "(" at `open`, quotes skipped.
function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1)
      if (close === -1) break
      i = close
    } else if (c === '(') depth += 1
    else if (c === ')' && --depth === 0) return i
  }
  return text.length - 1
}

// A command's words and operators, as sh splits them. A heredoc's body is
// dropped, so a ">" inside it is never read as a redirect; a digit word right
// before a redirect is its file descriptor ("2>err"), dropped too.
function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  const heredocs: Array<{ tag: string; isTabbed: boolean }> = []
  let awaitsTag: boolean | undefined
  let word = ''
  let hasWord = false
  let isDynamic = false
  let isQuoted = false
  const end = () => {
    if (hasWord) {
      tokens.push({ word, isDynamic })
      if (awaitsTag !== undefined) heredocs.push({ tag: word, isTabbed: awaitsTag })
      awaitsTag = undefined
    }
    word = ''
    hasWord = false
    isDynamic = false
    isQuoted = false
  }
  let i = 0
  while (i < command.length) {
    const c = command[i]!
    if (c === '\\') {
      if (command[i + 1] !== '\n') word += command[i + 1] ?? ''
      hasWord ||= command[i + 1] !== '\n'
      isQuoted = true
      i += 2
    } else if (c === "'") {
      const close = command.indexOf("'", i + 1)
      const stop = close === -1 ? command.length : close
      word += command.slice(i + 1, stop)
      hasWord = isQuoted = true
      i = stop + 1
    } else if (c === '"') {
      for (i += 1; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === '\\' && '"\\$`\n'.includes(command[i + 1] ?? 'x')) i += 1
        else if (command[i] === '$' || command[i] === '`') isDynamic = true
        word += command[i]
      }
      hasWord = isQuoted = true
      i += 1
    } else if (c === '$' && command[i + 1] === '(') {
      const stop = closing(command, i + 1)
      word += command.slice(i, stop + 1)
      hasWord = isDynamic = true
      i = stop + 1
    } else if (c === '`') {
      const close = command.indexOf('`', i + 1)
      const stop = close === -1 ? command.length : close
      word += command.slice(i, stop + 1)
      hasWord = isDynamic = true
      i = stop + 1
    } else if (c === '#' && !hasWord) {
      while (i < command.length && command[i] !== '\n') i += 1
    } else if (c === ' ' || c === '\t') {
      end()
      i += 1
    } else {
      const op = OPS.find(one => command.startsWith(one, i))
      if (op === undefined) {
        if ('$*?[{'.includes(c)) isDynamic = true
        word += c
        hasWord = true
        i += 1
        continue
      }
      if ((REDIRECT_OUT.has(op) || REDIRECT_IN.has(op)) && /^\d+$/.test(word) && !isQuoted) hasWord = false
      end()
      tokens.push({ op })
      i += op.length
      if (op === '<<' || op === '<<-') awaitsTag = op === '<<-'
      if (op !== '\n') continue
      // The heredoc bodies start on the line after their "<<TAG".
      for (const { tag, isTabbed } of heredocs.splice(0)) {
        while (i < command.length) {
          const nl = command.indexOf('\n', i)
          const stop = nl === -1 ? command.length : nl
          const line = command.slice(i, stop)
          i = stop + 1
          if ((isTabbed ? line.replace(/^\t+/, '') : line) === tag) break
        }
      }
    }
  }
  end()

  return tokens
}

// The files sed -i, perl -i or tee writes, from its arguments: sed's or
// perl's in-place flag in any cluster (-i, -i.bak, -Ei, -pi), BSD sed's
// "-i ''" suffix, and the script that comes first unless -e or -f gave it.
function editedFiles(name: string, args: readonly Word[]): Word[] {
  if (name === 'tee') return args.filter(one => !one.word.startsWith('-'))
  if (name !== 'sed' && name !== 'perl') return []
  let isInPlace = false
  let hasScript = false
  const positional: Word[] = []
  for (let i = 0; i < args.length; i++) {
    const { word } = args[i]!
    if (word === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (word.startsWith('--')) {
      if (word.startsWith('--in-place')) isInPlace = true
      else if (/^--(?:expression|file)=/.test(word)) hasScript = true
      else if (word === '--expression' || word === '--file') hasScript = Boolean(++i)
      continue
    }
    if (!word.startsWith('-') || word === '-') {
      positional.push(args[i]!)
      continue
    }
    for (let j = 1; j < word.length; j++) {
      const flag = word[j]!
      const isLast = j === word.length - 1
      if (flag === 'i') {
        isInPlace = true
        const suffix = args[i + 1]?.word
        if (isLast && name === 'sed' && suffix !== undefined && (suffix === '' || /^\.\w+$/.test(suffix))) i += 1
        break
      }
      if (flag === 'e' || flag === 'f' || (name === 'perl' && flag === 'E')) {
        hasScript = true
        if (isLast) i += 1
        break
      }
      // perl flags that take the rest of the cluster as their value.
      if (name === 'perl' && /[0lMmIxCdD]/.test(flag)) break
    }
  }
  if (!isInPlace) return []

  return hasScript ? positional : positional.slice(1)
}

// ponytail: the files a shell command writes, as spelled, with a literal
// `cd` before them folded in ("cd /p && sed -i '' s/a/b/ x" is /p/x): the
// targets of > and >> (and &>, >|), tee's files, and sed -i or perl -i's
// files, in each command of a list, pipeline or subshell. A ~ stays for the
// caller to expand; a relative spelling is the caller's cwd's. Not followed: a
// glob, a variable or a $(...) in the target, a target after a `cd` that is
// not literal, find -exec and xargs, a script that writes files (python,
// node), cp, mv and rm. Upgrade path: snapshot the tree before each command.
export function shellWrites(command: string): string[] {
  const found: string[] = []
  const dirs: Array<string | undefined> = []
  // '' is the caller's cwd; undefined, a `cd` this cannot follow.
  let dir: string | undefined = ''
  let words: Word[] = []
  const take = ({ word, isDynamic }: Word) => {
    if (isDynamic || word === '' || word.startsWith('/dev/')) return
    const isRooted = word.startsWith('/') || word === '~' || word.startsWith('~/')
    if (isRooted) found.push(word)
    else if (dir !== undefined) found.push(dir === '' ? word : `${dir}/${word}`)
  }
  const flush = () => {
    let first = 0
    while (first < words.length && (PREFIXES.has(words[first]!.word) || /^\w+=/.test(words[first]!.word))) first += 1
    const [head, ...args] = words.slice(first)
    words = []
    if (head === undefined) return
    if (head.word !== 'cd') return void editedFiles(basename(head.word), args).forEach(take)
    const to = args[0]
    if (to === undefined) dir = '~'
    else if (args.length > 1 || to.isDynamic || to.word === '-') dir = undefined
    else if (to.word.startsWith('/') || to.word === '~' || to.word.startsWith('~/')) dir = to.word
    else if (dir !== undefined) dir = dir === '' ? to.word : `${dir}/${to.word}`
  }
  const tokens = tokenize(command)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if ('word' in token) {
      words.push(token)
      continue
    }
    const operand = tokens[i + 1]
    const hasOperand = operand !== undefined && 'word' in operand
    if (REDIRECT_OUT.has(token.op) || REDIRECT_IN.has(token.op)) {
      // ">&2" and ">&-" name a descriptor; ">& file" is bash's "&> file".
      if (hasOperand && REDIRECT_OUT.has(token.op) && !(token.op === '>&' && /^(?:\d+|-)$/.test(operand.word))) take(operand)
      if (hasOperand) i += 1
      continue
    }
    flush()
    if (token.op === '(') dirs.push(dir)
    if (token.op === ')' && dirs.length > 0) dir = dirs.pop()
  }
  flush()

  return [...new Set(found)]
}

// A temp folder's file: a command's log or scratch output, not a change to show.
export function isTemp(path: string): boolean {
  return /^\/(?:private\/)?(?:tmp|var\/folders)\//.test(path)
}

// The task ids a <task-notification> row reports as ended (completed,
// failed, killed): their servers are gone.
export function endedTaskIds(text: string): string[] {
  return [...text.matchAll(/<task-notification>[\s\S]*?<task-id>(\w+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>/g)]
    .filter(([, , status]) => status !== 'running')
    .map(([, id = '']) => id)
}
