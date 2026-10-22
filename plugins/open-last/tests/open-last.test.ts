import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { commandPort, endedTaskIds, isSecret, isTemp, localUrl, normalizePath, outputPath, shellWrites, taskId } from '../hooks/parse'

// The test runner has timers; the hooks module's typings do not declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown

// A background Bash result (an astro dev server), in the shape Claude Code writes it.
const BG_TEXT =
  'Command running in background with ID: bwlbmkhlu. Output is being written to: /tmp/claude/p/s/tasks/bwlbmkhlu.output. You will be notified when it completes. To check interim output, use Read on that file path.'

describe('parse', () => {
  test('the output path and task id of a background Bash result', () => {
    expect(outputPath(BG_TEXT)).toBe('/tmp/claude/p/s/tasks/bwlbmkhlu.output')
    expect(taskId(BG_TEXT)).toBe('bwlbmkhlu')
    expect(outputPath('hello')).toBeUndefined()
  })

  test('the first local URL a dev server prints, normalized for a Link', () => {
    expect(localUrl('\x1b[32m  ➜  Local:\x1b[39m   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m')).toEqual({ url: 'http://localhost:5173/', port: 5173 })
    expect(localUrl(' astro  v5  ready in 300 ms\n ┃ Local    http://127.0.0.1:4321/docs\n')).toEqual({ url: 'http://localhost:4321/docs', port: 4321 })
    expect(localUrl('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...')).toEqual({ url: 'http://localhost:8000/', port: 8000 })
    expect(localUrl('Serving HTTP on :: port 8766 (http://[::]:8766/) ...')).toEqual({ url: 'http://localhost:8766/', port: 8766 })
    expect(localUrl('compiling...')).toBeUndefined()
  })

  test('the port a server command names', () => {
    expect(commandPort('python3 -m http.server 8765')).toBe(8765)
    expect(commandPort('python3 -m http.server')).toBe(8000)
    expect(commandPort('npx astro dev --port 4321')).toBe(4321)
    expect(commandPort('npx serve -p 3000 dist')).toBe(3000)
    expect(commandPort('PORT=8080 node server.js')).toBe(8080)
    expect(commandPort('npm run dev')).toBeUndefined()
    // Only the flag itself: another variable or a docker mapping names no port of the server's.
    expect(commandPort('export PORT=3000 && npm run dev')).toBe(3000)
    expect(commandPort('npx vite --port=5173')).toBe(5173)
    expect(commandPort('DB_PORT=5432 npm run dev')).toBeUndefined()
    expect(commandPort('PGPORT=5432 npm run dev')).toBeUndefined()
    expect(commandPort('node server.js --db-port 5432')).toBeUndefined()
    expect(commandPort('docker run -p 5432:5432 postgres')).toBeUndefined()
    expect(commandPort('docker run -p 127.0.0.1:5432:5432 postgres')).toBeUndefined()
  })

  test('a path as the tools land on it', () => {
    expect(normalizePath('/p/.env/x/..')).toBe('/p/.env')
    expect(normalizePath('/p//a/./b/')).toBe('/p/a/b')
    expect(normalizePath('/p/.env/')).toBe('/p/.env')
    expect(normalizePath('/../a')).toBe('/a')
    expect(normalizePath('a/../../b')).toBe('../b')
  })

  test('task notifications that end a task', () => {
    const done = '<task-notification>\n<task-id>bwlbmkhlu</task-id>\n<tool-use-id>t</tool-use-id>\n<status>completed</status>\n</task-notification>'
    const killed = '<task-notification>\n<task-id>b2</task-id>\n<status>killed</status>\n</task-notification>'
    expect(endedTaskIds(`${done}\n${killed}`)).toEqual(['bwlbmkhlu', 'b2'])
    expect(endedTaskIds('<task-notification><task-id>b3</task-id><status>running</status></task-notification>')).toEqual([])
  })

  test('the files a shell command writes', () => {
    // In-place edits: BSD and GNU sed, flag clusters, -e scripts, perl -i.
    expect(shellWrites("sed -i '' 's/a/b/' src/x.ts src/y.ts")).toEqual(['src/x.ts', 'src/y.ts'])
    expect(shellWrites("sed -i 's/a/b/' x.ts")).toEqual(['x.ts'])
    expect(shellWrites("sed -i.bak -e 's/a/b/' -e 's/c/d/' x.ts")).toEqual(['x.ts'])
    expect(shellWrites("sed -E -i '' 's/(a)/b/' x.ts")).toEqual(['x.ts'])
    expect(shellWrites("sed -Ei '' 's/a/b/' x.ts")).toEqual(['x.ts'])
    expect(shellWrites("sed --in-place --expression='s/a/b/' x.ts")).toEqual(['x.ts'])
    expect(shellWrites("perl -pi -e 's/a/b/' a.md b.md")).toEqual(['a.md', 'b.md'])
    expect(shellWrites("perl -i.bak -pe 's/a/b/' a.md")).toEqual(['a.md'])
    // Not in place: sed and perl only read.
    expect(shellWrites("sed 's/a/b/' x.ts")).toEqual([])
    expect(shellWrites("sed -n '1,5p' x.ts | head")).toEqual([])
    expect(shellWrites("perl -ne 'print' x.ts")).toEqual([])
    // Redirects and tee; a descriptor or /dev is no file.
    expect(shellWrites('echo hi > out.txt')).toEqual(['out.txt'])
    expect(shellWrites('echo hi >> "with space.txt"')).toEqual(['with space.txt'])
    expect(shellWrites('npm test 2>err.log >/dev/null')).toEqual(['err.log'])
    expect(shellWrites('ls 2>&1 >&2 &>/dev/null')).toEqual([])
    expect(shellWrites('echo hi | tee -a a.txt b.txt')).toEqual(['a.txt', 'b.txt'])
    // A heredoc body is not read: its ">" and "sed -i" are text.
    expect(shellWrites("cat > a.tsx <<'EOF'\n<Box>{a > b}</Box>\nsed -i '' x y\nEOF\necho done > b.txt")).toEqual(['a.tsx', 'b.txt'])
    expect(shellWrites('cat <<-EOF > a.txt\n\tx > y\n\tEOF')).toEqual(['a.txt'])
    // Quotes keep ">" and ";" as text.
    expect(shellWrites(`echo "a > b; c" 'd > e'`)).toEqual([])
    expect(shellWrites("sed -i '' 's/>/;/' x.ts")).toEqual(['x.ts'])
    // A literal cd is followed, in a list, a subshell, and back out of it.
    expect(shellWrites("cd /p && sed -i '' 's/a/b/' x.ts")).toEqual(['/p/x.ts'])
    expect(shellWrites('cd sub; cd deeper && echo > a.txt')).toEqual(['sub/deeper/a.txt'])
    expect(shellWrites('(cd /q && echo > a.txt) && echo > b.txt')).toEqual(['/q/a.txt', 'b.txt'])
    expect(shellWrites('cd "$DIR" && echo > a.txt; echo > /abs.txt')).toEqual(['/abs.txt'])
    expect(shellWrites('cd && echo > a.txt')).toEqual(['~/a.txt'])
    // Prefixes, assignments and ~ stay as spelled.
    expect(shellWrites("LC_ALL=C sudo sed -i '' 's/a/b/' ~/x.conf")).toEqual(['~/x.conf'])
    // Not followed: globs, variables, $(...).
    expect(shellWrites("sed -i '' 's/a/b/' src/*.ts")).toEqual([])
    expect(shellWrites('echo > "$OUT" && echo > $(mktemp)')).toEqual([])
    // Repeats are one file; comments are no command.
    expect(shellWrites('echo a > x; echo b >> x # > y')).toEqual(['x'])
  })

  test('temp folders', () => {
    expect(['/tmp/a', '/private/tmp/a', '/var/folders/x/T/a', '/private/var/folders/a'].every(isTemp)).toBe(true)
    expect(['/p/tmp/a', '/tmpfile', '/Users/m/a'].some(isTemp)).toBe(false)
  })

  test('which files are secret, by base name', () => {
    const secret = [
      '/p/.env', '/p/.env.local', '/p/.env.production', '/p/.Env.Local', '/p/.env.example.local',
      '/p/docker/db.env', '/p/prod.env', '/p/.envrc',
      '/p/tls.pem', '/p/tls.key', '/p/cert.p12', '/p/cert.pfx', '/p/store.jks', '/p/release.keystore',
      '/h/.ssh/id_rsa', '/h/.ssh/id_dsa', '/h/.ssh/id_ecdsa', '/h/.ssh/id_ed25519',
      '/h/.ssh/id_ed25519_work', '/h/.ssh/github_rsa', '/h/.ssh/Id_rsa', '/h/.ssh/id_rsa.bak', '/h/.ssh/deploy-ed25519',
      '/h/.netrc', '/h/.npmrc', '/h/.pypirc', '/h/.pgpass', '/h/.aws/credentials', '/h/.git-credentials',
      '/h/.docker/config.json', '/p/service-account.json', '/p/service-account-prod.json',
      // Spellings the tools fold onto a .env.
      '/p/x/../.env', '/p/.env/', '/p/./.env', '/p//.env', '/p/.env/x/..',
    ]
    const notSecret = [
      '/p/.env.example', '/p/.env.sample', '/p/.env.template', '/p/.env.dist', '/p/.env.defaults', '/p/.env.local.example',
      '/p/.env.ts', '/p/.env.js', '/p/.env.mjs', '/p/.env.cjs', '/p/.env.py', '/p/prod.env.example',
      '/h/.ssh/id_rsa.pub', '/h/.ssh/id_dsa.pub', '/h/.ssh/id_ecdsa.pub', '/h/.ssh/id_ed25519.pub', '/h/.ssh/github_rsa.pub',
      '/p/notes.md', '/p/keys.ts', '/p/.env/notes.md', '/p/environment.ts', '/p/key.ts', '/p/rsa.ts',
      '/p/monkey.pem.md', '/p/credentials.md', '/p/config.json', '/p/account.json',
      // Files about keys, not keys (the review's cases).
      '/p/rsa.md', '/p/ed25519.md', '/p/ecdsa_test_vectors.json', '/p/rsa_keygen.sh', '/p/dsa-interview.txt',
    ]
    expect(secret.filter(path => !isSecret(path))).toEqual([])
    expect(notSecret.filter(path => isSecret(path))).toEqual([])
  })
})

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} } as const

// The world a turn's patch is built in: a fake disk, TMPDIR /t, session s1,
// a diff that prints one hunk header per file, and a log of what ran. Beyond
// plain files: sizes stat reports (a file never read), links (a path and
// where it lands), files that exist but cannot be read, diffs whose output is
// cut, and a diff that throws or exits 2.
function patchWorld(on: On, disk: Record<string, string>) {
  const world = {
    disk,
    runs: [] as string[][],
    reads: [] as string[],
    writes: {} as Record<string, string>,
    toasts: [] as string[],
    denied: new Set<string>(),
    hasCmux: true,
    sizes: {} as Record<string, number>,
    links: {} as Record<string, string>,
    locked: new Set<string>(),
    cut: new Set<string>(),
    fault: undefined as 'throw' | 'exit 2' | undefined,
  }
  const isThere = (path: string) => path in disk || path in world.sizes || path in world.links || world.locked.has(path)
  mock.env(on, { TMPDIR: '/t', HOME: '/h' })
  on('session.id', () => ({ value: 's1' }))
  on('fs.stat', ($, e) => {
    if (!isThere(e.path) || world.locked.has(e.path)) return { deny: world.locked.has(e.path) ? 'EACCES' : 'ENOENT' }
    const size = world.sizes[e.path] ?? disk[e.path]?.length ?? 0
    return { value: { kind: 'file' as const, size, mtimeMs: 0, isLink: e.path in world.links, ...(e.resolve ? { realPath: world.links[e.path] ?? e.path } : {}) } }
  })
  on('fs.read', ($, e) => {
    world.reads.push(e.path)
    return e.path in disk && !world.locked.has(e.path) ? { value: disk[e.path]! } : { deny: 'ENOENT' }
  })
  on('fs.write', ($, e) => {
    world.writes[e.path] = e.text
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: isThere(e.path) }))
  on('tool.call', { tool: 'Write' }, ($, e) => {
    if (world.denied.has(e.file_path)) return { deny: 'denied' }
    disk[normalizePath(e.file_path)] = e.content
    return { result: { type: 'create', filePath: '', content: '' } }
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: { filePath: '', oldString: '', newString: '', originalFile: '', structuredPatch: [], userModified: false, replaceAll: false } }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    world.runs.push([...e.argv])
    const isDiff = e.argv[0] === 'diff'
    if (isDiff && world.fault === 'throw') throw new Error('diff crashed')
    const exitCode = isDiff ? (world.fault === 'exit 2' ? 2 : 1) : e.argv[0] === 'cmux' && !world.hasCmux ? 1 : 0
    const stdout = isDiff && world.fault === undefined ? `@@ ${e.argv[5]} @@\n` : ''
    const stderr = isDiff && world.fault === 'exit 2' ? `diff: ${e.argv[7]}: Permission denied\n` : ''
    const isStdoutTruncated = isDiff && world.cut.has(e.argv[7] ?? '')
    return { value: { exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated: false } }
  })

  return world
}

const TURN = { turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const

describe('hooks', () => {
  test('its slash commands skip the built-in names: Claude Code has its own /diff', async ($, on) => {
    const registered: string[] = []
    // As in a session, the engine refuses a built-in's name.
    on('command.register', ($, e) => {
      if (e.name === 'diff') throw new Error('"/diff" refused: it is the built-in /diff')
      registered.push(e.name)
      return { value: { command: e.name } }
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    expect(registered).toEqual(['open', 'stop-servers', 'last-diff'])
  })

  test('the last written file shows on the band, and /open opens it in cmux, else the default app', async ($, on) => {
    const runs: string[][] = []
    let hasCmux = true
    on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create', filePath: '/p/notes.md', content: '' } }))
    on('process.run', ($, e) => {
      runs.push([...e.argv])
      return { value: { exitCode: e.argv[0] === 'cmux' && !hasCmux ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })

    await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/p/notes.md', content: 'hi' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ plugin: 'open-last', surface, component: 'AbovePrompt', props: BAND_PROPS })
      expect(await band.find({ type: 'Text', text: 'notes.md' })).toBeDefined()
      expect(await band.find({ type: 'Button', key: 'open-file' })).toBeDefined()
      await band.unmount()
    }

    expect((await $.command.run({ command: 'open', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text).toBe('Opened /p/notes.md in cmux')
    hasCmux = false
    expect((await $.command.run({ command: 'open', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text).toBe('Opened /p/notes.md')
    expect(runs).toEqual([['cmux', 'open', '/p/notes.md'], ['cmux', 'open', '/p/notes.md'], ['open', '/p/notes.md']])
  })

  test('the turn\'s changes become one patch, and diff opens it in cmux', async ($, on) => {
    const runs: string[][] = []
    const writes: Record<string, string> = {}
    const disk: Record<string, string> = { '/p/notes.md': 'line one\nline two\n' }
    mock.env(on, { TMPDIR: '/t' })
    on('session.id', () => ({ value: 's1' }))
    on('fs.read', ($, e) => (e.path in writes ? { value: writes[e.path]! } : e.path in disk ? { value: disk[e.path]! } : { deny: 'ENOENT' }))
    on('fs.write', ($, e) => {
      writes[e.path] = e.text
      return { value: undefined }
    })
    on('fs.exists', ($, e) => ({ value: e.path in disk }))
    on('tool.call', { tool: 'Write' }, ($, e) => {
      disk[e.file_path] = e.content
      return { result: { type: 'create', filePath: '', content: '' } }
    })
    on('tool.call', { tool: 'Edit' }, () => ({ result: { filePath: '', oldString: '', newString: '', originalFile: '', structuredPatch: [], userModified: false, replaceAll: false } }))
    on('turn.complete', () => ({ text: '' }))
    on('process.run', ($, e) => {
      runs.push([...e.argv])
      return { value: { exitCode: e.argv[0] === 'diff' ? 1 : 0, stdout: e.argv[0] === 'diff' ? `@@ ${e.argv[5]} @@\n` : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    const turn = { turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const

    expect((await run('last-diff')).text).toBe('No changes recorded yet')

    // Two edits of one file keep its first old text; a new file diffs from /dev/null.
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/p/notes.md', old_string: 'two', new_string: '2' })
    disk['/p/notes.md'] = 'line one\nline 2\n'
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: '/p/notes.md', old_string: 'one', new_string: '1' })
    await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/p/new.md', content: 'hi' })
    // A subagent's turn ending does not close the main turn.
    await $.turn.complete({ ...turn, agentId: 'a1' })
    expect(runs).toEqual([])
    await $.turn.complete(turn)

    expect(writes['/t/open-last-s1.before']).toBe('line one\nline two\n')
    expect(runs).toEqual([
      ['diff', '-u', '--label', 'a/p/notes.md', '--label', 'b/p/notes.md', '/t/open-last-s1.before', '/p/notes.md'],
      ['diff', '-u', '--label', '/dev/null', '--label', 'b/p/new.md', '/dev/null', '/p/new.md'],
      ['rm', '-f', '/t/open-last-s1.before'],
    ])
    expect(writes['/t/open-last-s1.patch']).toBe('@@ b/p/notes.md @@\n@@ b/p/new.md @@\n')

    const band = await $.ui.mount({ plugin: 'open-last', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    await band.press({ key: 'diff' })
    await band.unmount()
    expect(runs.at(-1)).toEqual(['cmux', 'diff', '/t/open-last-s1.patch', '--title', 'Last turn'])

    // A turn that changed nothing keeps the last patch.
    await $.turn.complete({ ...turn, turnId: 't2' })
    expect((await run('last-diff')).text).toBe("Opened the last turn's changes in cmux")
    expect(runs.at(-1)).toEqual(['cmux', 'diff', '/t/open-last-s1.patch', '--title', 'Last turn'])
  })

  test('files a shell command writes join the patch and the band, like a Write', async ($, on) => {
    const world = patchWorld(on, { '/p/src/x.ts': 'const a = 1\n', '/h/.zshrc': 'alias a=b\n', '/p/.env': 'K=1\n' })
    let cwd = '/p'
    on('session.cwd', () => ({ value: cwd }))
    on('tool.call', { tool: 'Bash' }, ($, e) => {
      if (e.command.startsWith('sed')) world.disk['/p/src/x.ts'] = 'const a = 2\n'
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    // A command that writes nothing reads nothing and asks for no cwd.
    cwd = '/nowhere'
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b0', command: 'ls -la && git status' })
    expect(world.reads).toEqual([])
    cwd = '/p'

    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: "sed -i '' 's/1/2/' src/x.ts" })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'echo "alias c=d" >> ~/.zshrc && npm test > /tmp/out.log 2>&1' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b3', command: 'echo K=2 > .env' })
    await $.turn.complete(TURN)

    // Old text read before each command ran; the temp log and the secret never read.
    expect(world.reads).toEqual(['/p/src/x.ts', '/h/.zshrc'])
    expect(world.runs.filter(argv => argv[0] === 'diff').map(argv => argv.at(-1))).toEqual(['/p/src/x.ts', '/h/.zshrc'])
    expect(world.writes['/t/open-last-s1.patch']).toBe('@@ b/p/src/x.ts @@\n@@ b/h/.zshrc @@\n')
    expect((await $.command.run({ command: 'last-diff', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text).toBe(
      "Opened the last turn's changes in cmux (skipped 1 secret file: .env)",
    )
    const band = await $.ui.mount({ plugin: 'open-last', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Text', text: /^\.env$/ })).toBeDefined()
    await band.unmount()
  })

  test('a refused shell command is not the band\'s file', async ($, on) => {
    patchWorld(on, { '/p/x.ts': 'a\n' })
    on('session.cwd', () => ({ value: '/p' }))
    on('tool.call', { tool: 'Bash' }, () => ({ deny: 'denied' }))
    // The engine's own band: empty.
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))

    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'echo b > x.ts' })
    const band = await $.ui.mount({ plugin: 'open-last', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Text', text: 'x.ts' })).toBeUndefined()
    await band.unmount()
  })

  test('open refuses a target that is not an absolute path or a localhost URL', async ($, on) => {
    const runs: string[][] = []
    on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create', filePath: '-a', content: '' } }))
    on('process.run', ($, e) => {
      runs.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })

    await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '-a', content: 'hi' })
    const text = (await $.command.run({ command: 'open', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text
    expect(text).toBe('Not opening -a: not an absolute path or a localhost URL')
    expect(runs).toEqual([])
  })

  test('a server with buffered output shows once its command\'s port listens', async ($, on) => {
    let isUp = false
    const waits: Array<() => void> = []
    const tickOnce = async () => {
      for (const go of waits.splice(0)) go()
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    on('clock.every', () => new Promise(resolve => waits.push(() => resolve({ value: undefined }))))
    on('fs.read', () => ({ value: '' }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: BG_TEXT }))
    on('process.run', ($, e) => ({
      value: { exitCode: 0, stdout: e.argv[0] === 'lsof' && isUp ? '77\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))

    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'python3 -m http.server 8765', run_in_background: true })
    await tickOnce()
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect((await run('stop-servers')).text).toBe('No servers running')

    isUp = true
    await tickOnce()
    const band = await $.ui.mount({ plugin: 'open-last', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect((await band.find({ type: 'Link' }))?.props.href).toBe('http://localhost:8765/')
    await band.unmount()
  })

  test('a background dev server shows once its log prints a URL, and stop kills the pid it started', async ($, on) => {
    const runs: string[][] = []
    let log = 'starting...'
    const waits: Array<() => void> = []
    const tickOnce = async () => {
      for (const go of waits.splice(0)) go()
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    on('clock.every', () => new Promise(resolve => waits.push(() => resolve({ value: undefined }))))
    on('fs.read', () => ({ value: log }))
    on('tool.call', { tool: 'Bash' }, () => ({
      result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bwlbmkhlu' },
      text: BG_TEXT,
    }))
    on('process.run', ($, e) => {
      runs.push([...e.argv])
      return { value: { exitCode: 0, stdout: e.argv.includes('tcp:4321') ? '4242\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('ui.toast', () => ({ value: undefined }))

    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npx astro dev', run_in_background: true })
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await tickOnce()
    expect((await run('stop-servers')).text).toBe('No servers running')

    log = 'starting...\n ┃ Local    http://localhost:4321/\n'
    await tickOnce()
    const band = await $.ui.mount({ plugin: 'open-last', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect((await band.find({ type: 'Link' }))?.props.href).toBe('http://localhost:4321/')
    await band.press({ key: 'stop-bwlbmkhlu' })
    await band.unmount()

    expect(runs).toEqual([
      ['lsof', '-nP', '-t', '-iTCP', '-sTCP:LISTEN'],
      ['lsof', '-ti', 'tcp:4321', '-sTCP:LISTEN'],
      ['lsof', '-ti', 'tcp:4321', '-sTCP:LISTEN'],
      ['kill', '4242'],
    ])
    expect(waits).toHaveLength(0)
    expect((await run('stop-servers')).text).toBe('No servers running')
  })

  test('a secret file stays out of the patch: never read, never copied, named by the diff', async ($, on) => {
    const world = patchWorld(on, { '/p/notes.md': 'line one\n', '/p/.env': 'API_KEY=hunter2\n', '/h/.ssh/id_rsa': 'PRIVATE KEY\n' })
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/p/notes.md', old_string: 'one', new_string: '1' })
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: '/p/.env', old_string: 'hunter2', new_string: 'hunter3' })
    await $.turn.complete(TURN)

    expect(world.reads).toEqual(['/p/notes.md'])
    expect(world.runs.flat().filter(arg => arg.includes('.env'))).toEqual([])
    expect(Object.values(world.writes).filter(text => text.includes('API_KEY'))).toEqual([])
    expect(world.writes['/t/open-last-s1.patch']).toBe('@@ b/p/notes.md @@\n')

    // The .env is still the band's FILE: its path, nothing more.
    const band = await $.ui.mount({ plugin: 'open-last', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Text', text: /^\.env$/ })).toBeDefined()
    await band.press({ key: 'diff' })
    await band.unmount()
    expect(world.toasts).toEqual(["Opened the last turn's changes in cmux (skipped 1 secret file: .env)"])
    world.hasCmux = false
    expect((await run('last-diff')).text).toBe('Opened /t/open-last-s1.patch (skipped 1 secret file: .env)')
    world.hasCmux = true

    // Two secrets in one turn.
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e3', file_path: '/p/notes.md', old_string: '1', new_string: 'one' })
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e4', file_path: '/p/.env', old_string: 'hunter3', new_string: 'hunter4' })
    await $.tool.call({ tool: 'Write', tool_use_id: 'w5', file_path: '/h/.ssh/id_rsa', content: 'NEW PRIVATE KEY' })
    await $.turn.complete({ ...TURN, turnId: 't2' })
    expect(world.reads).toEqual(['/p/notes.md', '/p/notes.md'])
    expect((await run('last-diff')).text).toBe("Opened the last turn's changes in cmux (skipped 2 secret files: .env, id_rsa)")

    // The next patch with no secret in it drops the note.
    await $.tool.call({ tool: 'Write', tool_use_id: 'w6', file_path: '/p/new.md', content: 'hi' })
    await $.turn.complete({ ...TURN, turnId: 't3' })
    expect((await run('last-diff')).text).toBe("Opened the last turn's changes in cmux")
  })

  test('a turn that changed only secret files leaves no patch, and diff says so', async ($, on) => {
    const world = patchWorld(on, { '/p/notes.md': 'line one\n', '/p/.env': 'API_KEY=hunter2\n' })
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    const ONLY_SECRET = 'The last turn changed only secret files (.env), so there is nothing to show'

    await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/p/notes.md', content: 'line 1' })
    await $.turn.complete(TURN)
    expect((await run('last-diff')).text).toBe("Opened the last turn's changes in cmux")
    const ranBefore = world.runs.length
    const wroteBefore = Object.keys(world.writes).length

    // A refused write changed nothing, so it is not named.
    world.denied.add('/p/.env.local')
    await $.tool.call({ tool: 'Write', tool_use_id: 'w2', file_path: '/p/.env.local', content: 'X=1' })
    await $.tool.call({ tool: 'Write', tool_use_id: 'w3', file_path: '/p/.env', content: 'API_KEY=hunter3' })
    // A subagent's turn end does not close the main turn.
    await $.turn.complete({ ...TURN, turnId: 't2', agentId: 'a1' })
    expect((await run('last-diff')).text).toBe("Opened the last turn's changes in cmux")
    await $.turn.complete({ ...TURN, turnId: 't2' })

    expect(world.reads).toEqual(['/p/notes.md'])
    expect(Object.keys(world.writes)).toHaveLength(wroteBefore)
    const runsNow = world.runs.slice(ranBefore)
    expect(runsNow.filter(argv => argv[0] !== 'cmux')).toEqual([])
    expect((await run('last-diff')).text).toBe(ONLY_SECRET)
    const band = await $.ui.mount({ plugin: 'open-last', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Text', text: /^\.env$/ })).toBeDefined()
    expect(await band.find({ type: 'Button', key: 'diff' })).toBeUndefined()
    await band.unmount()

    // A turn that changed nothing keeps that answer.
    await $.turn.complete({ ...TURN, turnId: 't3' })
    expect((await run('last-diff')).text).toBe(ONLY_SECRET)
  })

  test('a command that names a port something already listens on adopts nothing, and stop kills nothing', async ($, on) => {
    const runs: string[][] = []
    const waits: Array<() => void> = []
    const tickOnce = async () => {
      for (const go of waits.splice(0)) go()
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    on('clock.every', () => new Promise(resolve => waits.push(() => resolve({ value: undefined }))))
    on('fs.read', () => ({ value: 'listening...\n' }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: BG_TEXT }))
    // Postgres (pid 999) listens on 5432 before the command and after it.
    on('process.run', ($, e) => {
      runs.push([...e.argv])
      const isListener = e.argv[0] === 'lsof' && (e.argv.includes('-iTCP') || e.argv.includes('tcp:5432'))
      return { value: { exitCode: 0, stdout: isListener ? '999\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'PORT=5432 npm run dev', run_in_background: true })
    await tickOnce()
    await tickOnce()
    expect((await run('stop-servers')).text).toBe('No servers running')
    expect(runs.filter(argv => argv[0] === 'kill')).toEqual([])
  })

  test('with no way to tell what listened before the command, no server is tracked', async ($, on) => {
    const waits: Array<() => void> = []
    on('clock.every', () => new Promise(resolve => waits.push(() => resolve({ value: undefined }))))
    on('fs.read', () => ({ value: ' ┃ Local    http://localhost:4321/\n' }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: BG_TEXT }))
    on('process.run', ($, e) => {
      if (e.argv.includes('-iTCP')) throw new Error('lsof: not found')
      return { value: { exitCode: 0, stdout: e.argv[0] === 'lsof' ? '4242\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })

    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npx astro dev --port 4321', run_in_background: true })
    expect(waits).toHaveLength(0)
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect((await run('stop-servers')).text).toBe('No servers running')
  })

  test('stop kills only the pids a server started that still listen on its port', async ($, on) => {
    const runs: string[][] = []
    // pid 888 listened before either command ran (on 5173 too, say on another interface).
    const listening: Record<string, string> = { all: '888\n', 'tcp:4321': '', 'tcp:5173': '888\n' }
    const waits: Array<() => void> = []
    const tickOnce = async () => {
      for (const go of waits.splice(0)) go()
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    on('clock.every', () => new Promise(resolve => waits.push(() => resolve({ value: undefined }))))
    on('fs.read', () => ({ value: '' }))
    // Each server is up by the time its call returns.
    on('tool.call', { tool: 'Bash' }, ($, e) => {
      const isAstro = e.command.includes('astro')
      if (isAstro) listening['tcp:4321'] = '4242\n4243\n'
      else listening['tcp:5173'] = '888\n5555\n'
      listening.all += isAstro ? '4242\n4243\n' : '5555\n'
      return { result: { stdout: '', stderr: '', interrupted: false }, text: BG_TEXT.replaceAll('bwlbmkhlu', isAstro ? 'bastro' : 'bvite') }
    })
    on('process.run', ($, e) => {
      runs.push([...e.argv])
      const key = e.argv.includes('-iTCP') ? 'all' : (e.argv[2] ?? '')
      return { value: { exitCode: 0, stdout: e.argv[0] === 'lsof' ? (listening[key] ?? '') : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npx astro dev --port 4321', run_in_background: true })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'npx vite --port 5173', run_in_background: true })
    await tickOnce()

    // Since: one astro pid exited and pid 999 took its place; vite's pid
    // exited and pid 777 took its port.
    listening['tcp:4321'] = '4242\n999\n'
    listening['tcp:5173'] = '888\n777\n'
    expect((await run('stop-servers')).text).toBe('Stopped http://localhost:4321/\nhttp://localhost:5173/ was not running')
    expect(runs.filter(argv => argv[0] === 'kill')).toEqual([['kill', '4242']])
    expect((await run('stop-servers')).text).toBe('No servers running')
  })

  test('every spelling of a path lands on one normalized key: a .env is never read under any of them', async ($, on) => {
    const world = patchWorld(on, { '/p/notes.md': 'line one\n', '/p/.env': 'API_KEY=hunter2\n' })
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    // A Write the tool refuses, under a trailing slash, reads nothing and names nothing.
    world.denied.add('/p/.env/')
    await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/p/.env/', content: 'X=1' })
    await $.turn.complete(TURN)
    expect(world.reads).toEqual([])
    expect((await run('last-diff')).text).toBe('No changes recorded yet')

    // The tool folds /p/.env/x/.. onto /p/.env; two spellings of notes.md are one file.
    await $.tool.call({ tool: 'Write', tool_use_id: 'w2', file_path: '/p/.env/x/..', content: 'API_KEY=hunter3' })
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e3', file_path: '/p//notes.md', old_string: 'one', new_string: '1' })
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e4', file_path: '/p/x/../notes.md', old_string: '1', new_string: 'one' })
    await $.turn.complete({ ...TURN, turnId: 't2' })
    expect(world.reads).toEqual(['/p/notes.md'])
    expect(Object.values(world.writes).filter(text => text.includes('API_KEY'))).toEqual([])
    expect(world.runs.filter(argv => argv[0] === 'diff')).toEqual([['diff', '-u', '--label', 'a/p/notes.md', '--label', 'b/p/notes.md', '/t/open-last-s1.before', '/p/notes.md']])
    expect((await run('last-diff')).text).toBe("Opened the last turn's changes in cmux (skipped 1 secret file: .env)")
    const band = await $.ui.mount({ plugin: 'open-last', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Text', text: /^notes\.md$/ })).toBeDefined()
    await band.unmount()
  })

  test('a link to a secret is a secret', async ($, on) => {
    const world = patchWorld(on, { '/p/.env': 'API_KEY=hunter2\n' })
    world.links['/p/config.txt'] = '/p/.env'
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/p/config.txt', old_string: 'hunter2', new_string: 'hunter3' })
    await $.turn.complete(TURN)
    expect(world.reads).toEqual([])
    expect(world.runs).toEqual([])
    expect((await run('last-diff')).text).toBe('The last turn changed only secret files (config.txt), so there is nothing to show')
  })

  test('a file too large or unreadable stays out of the patch, named as too large', async ($, on) => {
    const world = patchWorld(on, { '/p/notes.md': 'line one\n' })
    world.sizes['/p/big.json'] = 5 * 1024 * 1024
    world.locked.add('/p/locked.txt')
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    // Never read: stat says it is over 1 MB. Read and refused: exists, so not new.
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/p/big.json', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: '/p/locked.txt', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e3', file_path: '/p/notes.md', old_string: 'one', new_string: '1' })
    await $.turn.complete(TURN)
    expect(world.reads).toEqual(['/p/locked.txt', '/p/notes.md'])
    expect(world.runs.filter(argv => argv[0] === 'diff').map(argv => argv[7])).toEqual(['/p/notes.md'])
    expect(world.writes['/t/open-last-s1.patch']).toBe('@@ b/p/notes.md @@\n')
    expect((await run('last-diff')).text).toBe("Opened the last turn's changes in cmux (skipped 2 files too large or unreadable: big.json, locked.txt)")

    // A new file whose diff runs past what one run returns is too large too.
    world.cut.add('/p/huge.log')
    await $.tool.call({ tool: 'Write', tool_use_id: 'w4', file_path: '/p/huge.log', content: 'x' })
    await $.turn.complete({ ...TURN, turnId: 't2' })
    expect((await run('last-diff')).text).toBe('The last turn changed only files too large or unreadable (huge.log), so there is nothing to show')

    // With a secret beside it.
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e5', file_path: '/p/big.json', old_string: 'b', new_string: 'c' })
    await $.tool.call({ tool: 'Write', tool_use_id: 'w6', file_path: '/p/.env', content: 'API_KEY=1' })
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e7', file_path: '/p/notes.md', old_string: '1', new_string: 'one' })
    await $.turn.complete({ ...TURN, turnId: 't3' })
    expect((await run('last-diff')).text).toBe("Opened the last turn's changes in cmux (skipped 1 secret file: .env; 1 file too large or unreadable: big.json)")
  })

  test('a patch that cannot be built keeps the last one, removes the scratch copy, and says so', async ($, on) => {
    const world = patchWorld(on, { '/p/notes.md': 'line one\n' })
    const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    const edit = (id: string) => $.tool.call({ tool: 'Edit', tool_use_id: id, file_path: '/p/notes.md', old_string: 'a', new_string: 'b' })

    // No patch yet: the failure is the answer.
    world.fault = 'throw'
    await edit('e1')
    await $.turn.complete(TURN)
    expect(world.runs.map(argv => argv[0])).toEqual(['diff', 'rm'])
    expect((await run('last-diff')).text?.startsWith("Could not build the last turn's patch: ")).toBe(true)

    world.fault = undefined
    await edit('e2')
    await $.turn.complete({ ...TURN, turnId: 't2' })
    expect((await run('last-diff')).text).toBe("Opened the last turn's changes in cmux")

    // A diff that throws: the scratch copy still goes, the last patch stays.
    world.fault = 'throw'
    world.runs.length = 0
    await edit('e3')
    await $.turn.complete({ ...TURN, turnId: 't3' })
    expect(world.runs).toEqual([
      ['diff', '-u', '--label', 'a/p/notes.md', '--label', 'b/p/notes.md', '/t/open-last-s1.before', '/p/notes.md'],
      ['rm', '-f', '/t/open-last-s1.before'],
    ])
    const thrown = (await run('last-diff')).text ?? ''
    expect(thrown.startsWith("Opened the previous changes in cmux (the last turn's patch could not be built: ")).toBe(true)
    expect(world.runs.at(-1)).toEqual(['cmux', 'diff', '/t/open-last-s1.patch', '--title', 'Last turn'])

    // A diff that reports trouble (exit 2) fails the same way, with its words.
    world.fault = 'exit 2'
    await edit('e4')
    await $.turn.complete({ ...TURN, turnId: 't4' })
    expect((await run('last-diff')).text).toBe("Opened the previous changes in cmux (the last turn's patch could not be built: diff failed on notes.md: diff: /p/notes.md: Permission denied)")

    // The next good patch clears it.
    world.fault = undefined
    await edit('e5')
    await $.turn.complete({ ...TURN, turnId: 't5' })
    expect((await run('last-diff')).text).toBe("Opened the last turn's changes in cmux")
  })

  test(
    'with another plugin on the band, both draw',
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
      on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create', filePath: '/p/notes.md', content: '' } }))
      // The engine's own band: empty.
      on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))

      await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/p/notes.md', content: 'hi' })
      for (const surface of ['terminal', 'desktop'] as const) {
        const band = await $.ui.mount({ plugin: 'open-last', surface, component: 'AbovePrompt', props: BAND_PROPS })
        expect(await band.find({ type: 'Text', text: 'notes.md' })).toBeDefined()
        expect(await band.find({ type: 'Text', text: 'NEIGHBOR ROW' })).toBeDefined()
        await band.unmount()
      }
    },
  )
})
