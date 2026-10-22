import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OpenLastServer } from '../types'
import { basename, commandPort, endedTaskIds, isSecret, isTemp, localUrl, normalizePath, outputPath, shellWrites, taskId } from './parse'

const file = atom({ plugin: 'open-last', key: 'file' } as const, null as string | null)
const servers = atom({ plugin: 'open-last', key: 'servers' } as const, [] as OpenLastServer[])
const patch = atom({ plugin: 'open-last', key: 'patch' } as const, null as string | null)
const skipped = atom({ plugin: 'open-last', key: 'skipped' } as const, [] as string[])
const tooLarge = atom({ plugin: 'open-last', key: 'tooLarge' } as const, [] as string[])
const patchError = atom({ plugin: 'open-last', key: 'patchError' } as const, null as string | null)

// ponytail: each file this turn touched, by normalized path, as it was before
// its first Write or Edit: its old text (null: it did not exist), or why the
// patch leaves it out. Held in memory until the main turn ends: a hot reload
// mid-turn loses it, and edits a background agent makes after the turn ends
// count toward the next turn. `landed` holds the paths a Write or Edit
// changed, so a refused one is never named.
type Before = { old: string | null } | { skip: 'secret' | 'large' }
const before = new Map<string, Before>()
const landed = new Set<string>()
const MAX_BYTES = 1_000_000

async function remember($: EngineInterface, path: string) {
  if (!before.has(path)) before.set(path, await recall($, path))
}

// A file's old text, or why the patch leaves it out. A secret is never read,
// nor a link to one (a file not there yet has no realPath: its spelling
// decides). A file that exists but is over 1 MB or cannot be read is too large
// (exists rejects only a network location: one of those is unreadable too).
async function recall($: EngineInterface, path: string): Promise<Before> {
  if (isSecret(path)) return { skip: 'secret' }
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (stat?.realPath !== undefined && isSecret(stat.realPath)) return { skip: 'secret' }
  if (stat === undefined && !(await $.fs.exists(path).catch(() => true))) return { old: null }
  if (stat !== undefined && stat.size > MAX_BYTES) return { skip: 'large' }
  const text = await $.fs.read(path).catch(() => undefined)

  return typeof text === 'string' && text.length <= MAX_BYTES ? { old: text } : { skip: 'large' }
}

// One unified patch of what this turn changed, built with the system's diff,
// written to the user's own temp folder: its path (null when nothing
// changed), and the files whose diff ran past what one run returns. Throws
// when a step fails; the scratch copy of old text is removed either way.
async function writePatch($: EngineInterface, files: ReadonlyArray<readonly [string, string | null]>): Promise<{ path: string | null; tooLarge: string[] }> {
  const dir = ((await $.env.get('TMPDIR')) ?? '/tmp/').replace(/\/?$/, '/')
  const stem = `${dir}open-last-${await $.session.id()}`
  const parts: string[] = []
  const large: string[] = []
  try {
    for (const [path, old] of files) {
      if (old !== null) await $.fs.write(`${stem}.before`, old)
      const isThere = await $.fs.exists(path)
      const ran = await $.process.run([
        'diff', '-u',
        '--label', old === null ? '/dev/null' : `a${path}`,
        '--label', isThere ? `b${path}` : '/dev/null',
        old === null ? '/dev/null' : `${stem}.before`,
        isThere ? path : '/dev/null',
      ])
      if (ran.exitCode > 1) throw new Error(`diff failed on ${basename(path)}: ${ran.stderr.trim()}`)
      if (ran.isStdoutTruncated) large.push(path)
      else parts.push(ran.stdout)
    }
  } finally {
    // The scratch copy holds a file's old text: gone once the patch is built,
    // or once building it failed.
    await $.process.run(['rm', '-f', `${stem}.before`])
  }
  const text = parts.join('')
  if (text.trim() === '') return { path: null, tooLarge: large }
  await $.fs.write(`${stem}.patch`, text)

  return { path: `${stem}.patch`, tooLarge: large }
}

// cmux when it is on PATH, else the Mac's default app for the file or URL.
// Only an absolute path or a localhost URL goes through, so a target can never
// reach `open` or `cmux open` as a flag.
async function open($: EngineInterface, target: string): Promise<string> {
  if (!/^(\/|http:\/\/localhost:)/.test(target)) return `Not opening ${target}: not an absolute path or a localhost URL`
  try {
    if ((await $.process.run(['cmux', 'open', target])).exitCode === 0) return `Opened ${target} in cmux`
  } catch {
    // no cmux on PATH: fall through to the default app
  }
  const ran = await $.process.run(['open', target])

  return ran.exitCode === 0 ? `Opened ${target}` : `Could not open ${target}: ${ran.stderr.trim()}`
}

const names = (paths: readonly string[]) => paths.map(basename).join(', ')
const fileWord = (count: number) => (count === 1 ? 'file' : 'files')

// The last turn that changed files, in cmux's diff view; without cmux (or
// with its browser off), the patch file itself. Says what the patch left out,
// and when the last turn's patch could not be built (the one before stays).
async function diff($: EngineInterface): Promise<string> {
  const path = await read($, patch)
  const secret = await read($, skipped)
  const large = await read($, tooLarge)
  const error = await read($, patchError)
  if (path === null) {
    if (error !== null) return `Could not build the last turn's patch: ${error}`
    const only = [secret.length > 0 && `secret files (${names(secret)})`, large.length > 0 && `files too large or unreadable (${names(large)})`].filter(Boolean)
    return only.length > 0 ? `The last turn changed only ${only.join(' and ')}, so there is nothing to show` : 'No changes recorded yet'
  }
  const left = [
    secret.length > 0 && `${secret.length} secret ${fileWord(secret.length)}: ${names(secret)}`,
    large.length > 0 && `${large.length} ${fileWord(large.length)} too large or unreadable: ${names(large)}`,
  ].filter(Boolean)
  const notes = [error !== null && `the last turn's patch could not be built: ${error}`, left.length > 0 && `skipped ${left.join('; ')}`].filter(Boolean)
  const note = notes.length > 0 ? ` (${notes.join('; ')})` : ''
  const what = error === null ? "the last turn's changes" : 'the previous changes'
  try {
    if ((await $.process.run(['cmux', 'diff', path, '--title', 'Last turn'])).exitCode === 0) return `Opened ${what} in cmux${note}`
  } catch {
    // no cmux on PATH: open the patch instead
  }

  return `${await open($, path)}${note}`
}

// A Write or Edit that landed: the band's file, and a change the patch
// accounts for.
async function wrote($: EngineInterface, path: string) {
  landed.add(path)
  await update($, file, () => path)
}

// The files a shell command writes, as absolute paths: a relative spelling is
// the session's cwd's, a ~ is HOME (none: left out), a temp folder's file left out.
async function shellTargets($: EngineInterface, command: string): Promise<string[]> {
  const spellings = shellWrites(command)
  if (spellings.length === 0) return []
  const cwd = await $.session.cwd()
  const home = spellings.some(one => one.startsWith('~')) ? await $.env.get('HOME').catch(() => undefined) : undefined
  const paths = spellings.flatMap(one => {
    if (one.startsWith('~')) return home === undefined ? [] : [`${home}${one.slice(1)}`]
    return [one.startsWith('/') ? one : `${cwd}/${one}`]
  })

  return paths.map(normalizePath).filter(path => !isTemp(path))
}

// The pids listening on a TCP port; with no port, on any.
async function listeners($: EngineInterface, port?: number): Promise<string[]> {
  const found = await $.process.run(port === undefined ? ['lsof', '-nP', '-t', '-iTCP', '-sTCP:LISTEN'] : ['lsof', '-ti', `tcp:${port}`, '-sTCP:LISTEN'])
  return found.stdout.split(/\s+/).filter(Boolean)
}

// Kills the server's own pids that still listen on its port, never another
// process that took the port since, then drops it from the band.
async function stop($: EngineInterface, server: OpenLastServer): Promise<string> {
  const listening = await listeners($, server.port)
  // An entry from before 0.3.3 has no pids: nothing of it is killed.
  const pids = (server.pids ?? []).filter(pid => listening.includes(pid))
  if (pids.length > 0) await $.process.run(['kill', ...pids])
  await update($, servers, list => list.filter(one => one.taskId !== server.taskId))

  return pids.length > 0 ? `Stopped ${server.url}` : `${server.url} was not running`
}

// ponytail: once a second for 60s, takes the first local URL the task's
// output prints, else the port its command names, and adopts the server once
// a pid that listened on no TCP port before the command ran listens there;
// `stop` kills only those pids. A server slower than that, or one with
// neither, never shows; a shared daemon that starts listening for the command
// (Docker's backend) still counts as new, and a server that restarts under a
// new pid is not stopped. Upgrade path: stop the background task itself.
function watch($: EngineInterface, id: string, path: string, command: string, old: ReadonlySet<string>) {
  let tries = 0
  const named = commandPort(command)
  const timer = $.clock.every(1000, () => {
    void (async () => {
      tries += 1
      const log = await $.fs.read(path).catch(() => '')
      const url = localUrl(log)
      const port = url?.port ?? named
      const pids = port === undefined ? [] : (await listeners($, port)).filter(pid => !old.has(pid))
      if (port !== undefined && pids.length > 0) {
        const server = { taskId: id, url: url?.url ?? `http://localhost:${port}/`, port, pids }
        await update($, servers, list => [...list.filter(one => one.port !== port), server])
      }
      if (pids.length > 0 || tries >= 60) timer.cancel()
    })()
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'open', description: 'Open the last file Claude wrote in cmux', immediate: true })
    await $.command.register({ name: 'stop-servers', description: 'Stop the local servers Claude started', immediate: true })
    // Not /diff: that is Claude Code's own command, and a built-in's name is
    // refused (or, registered first, it takes the built-in diff panel away).
    await $.command.register({ name: 'last-diff', description: "Show the last turn's changes in cmux", immediate: true })

    return next(e)
  })

  // The last file written, by the main loop or any agent, under the path the
  // tool lands on: "/p/.env/x/.." is /p/.env.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const path = normalizePath(e.file_path)
    await remember($, path)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await wrote($, path)

    return ran
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const path = normalizePath(e.file_path)
    await remember($, path)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await wrote($, path)

    return ran
  })

  // The main turn ended: its changes become the patch `diff` shows. A turn
  // that changed nothing keeps the last patch; one that changed only files
  // the patch leaves out has none, and `diff` says why. A patch that cannot
  // be built keeps the last one, and `diff` says that too.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || before.size === 0) return done
    const entries = [...before]
    const changed = new Set(landed)
    before.clear()
    landed.clear()
    const olds = entries.flatMap(([path, one]) => ('old' in one ? [[path, one.old] as const] : []))
    const leftOut = (why: 'secret' | 'large') => entries.flatMap(([path, one]) => ('skip' in one && one.skip === why && changed.has(path) ? [path] : []))
    try {
      const built = olds.length > 0 ? await writePatch($, olds) : { path: null, tooLarge: [] }
      const secret = leftOut('secret')
      const large = [...leftOut('large'), ...built.tooLarge]
      if (built.path !== null || secret.length > 0 || large.length > 0) {
        await update($, skipped, () => secret)
        await update($, tooLarge, () => large)
        await update($, patchError, () => null)
        await update($, patch, () => built.path)
      }
    } catch (error) {
      await update($, patchError, () => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '')
    }

    return done
  })

  // A shell command that writes files (sed -i, perl -i, tee, a > or >>
  // redirect) counts as a Write: each file it names is remembered before it
  // runs, so the patch shows it, and becomes the band's file. A file in a temp
  // folder is a log or scratch, never shown. A background command may also be
  // a server: whatever listens before it runs is not its server. Unknown (no
  // lsof): no server is tracked.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const targets = await shellTargets($, e.command).catch(() => [])
    for (const path of targets) await remember($, path)
    const old = e.run_in_background === true ? await listeners($).catch(() => undefined) : undefined
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    for (const path of targets) await wrote($, path)
    const log = outputPath(ran.text ?? '')
    const id = taskId(ran.text ?? '')
    if (old !== undefined && log && id) watch($, id, log, e.command, new Set(old))

    return ran
  })

  // A background task that ended takes its server off the band.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.message.role !== 'user') return stored
    const text = e.message.content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n')
    const ended = text.includes('<task-notification>') ? endedTaskIds(text) : []
    if (ended.length > 0) await update($, servers, list => list.filter(one => !ended.includes(one.taskId)))

    return stored
  })

  on('command.run', { command: 'open' }, async $ => {
    const path = await read($, file)

    return { text: path ? await open($, path) : 'No file written yet in this session' }
  })

  on('command.run', { command: 'last-diff' }, async $ => ({ text: await diff($) }))

  on('command.run', { command: 'stop-servers' }, async $ => {
    const list = await read($, servers)
    const done = await Promise.all(list.map(one => stop($, one)))

    return { text: done.length > 0 ? done.join('\n') : 'No servers running' }
  })

  // These rows over the rest of the band (other plugins' lines), never instead of it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const path = await read($, file)
    const list = await read($, servers)
    const hasPatch = (await read($, patch)) !== null
    if (e.props.hasSurvey || (path === null && list.length === 0)) return next(e)
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    // Nothing beneath (a test's bare engine): these rows alone.
    const rest = await next(e).catch(() => undefined)

    return (
      <Box flexDirection="column" marginTop={1}>
        {path !== null && (
          <Box gap={1}>
            <Text dimColor>FILE</Text>
            <Text wrap="truncate-middle">{basename(path)}</Text>
            <Button key="open-file" label="open" hotkey="o" onPress={async () => $.ui.toast(await open($, path))} />
            {hasPatch && <Button key="diff" label="diff" hotkey="d" onPress={async () => $.ui.toast(await diff($))} />}
          </Box>
        )}
        {list.map((server, i) => (
          <Box gap={1}>
            <Text dimColor>SERVER</Text>
            <Link href={server.url} />
            <Button key={`open-${server.taskId}`} label="open" hotkey={i === 0 ? 's' : undefined} onPress={async () => $.ui.toast(await open($, server.url))} />
            <Button key={`stop-${server.taskId}`} label="stop" hotkey={i === 0 ? 'x' : undefined} onPress={async () => $.ui.toast(await stop($, server))} />
          </Box>
        ))}
        {rest}
      </Box>
    )
  })
}
