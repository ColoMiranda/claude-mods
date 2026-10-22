import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { AccountGuardStatus } from '../types'
import { bandLine, ghAccounts, githubRemote, isAccountCommand, isLogin, isPushCommand, pushAccess, pushRemoteName, sshConfig, sshUser, switchTarget } from '../hooks/parse'

describe('parse', () => {
  test('the GitHub repo a push URL names', () => {
    expect(githubRemote('https://github.com/ColoMiranda/claude-mods.git')).toEqual({ owner: 'ColoMiranda', repo: 'claude-mods', via: 'https', host: 'github.com', user: undefined, hasPassword: false })
    expect(githubRemote('https://ColoMiranda@github.com/ColoMiranda/claude-mods')).toMatchObject({ user: 'ColoMiranda', hasPassword: false })
    expect(githubRemote('https://x-access-token:ghp_FAKEtoken1234567890@github.com/o/r.git')).toMatchObject({ owner: 'o', repo: 'r', hasPassword: true })
    expect(githubRemote('git@github.com:golemfactory/yagna.git')).toEqual({ owner: 'golemfactory', repo: 'yagna', via: 'ssh', host: 'github.com' })
    expect(githubRemote('ssh://git@github.com:22/Arkiv-Network/arkiv.js.git')).toEqual({ owner: 'Arkiv-Network', repo: 'arkiv.js', via: 'ssh', host: 'github.com' })
    expect(githubRemote('git@github-personal:ColoMiranda/claude-mods.git')?.host).toBe('github-personal')
    expect(githubRemote('https://gitlab.com/a/b.git')).toBeUndefined()
    expect(githubRemote('/srv/git/b.git')).toBeUndefined()
  })

  test('the remote git push picks', () => {
    const remotes = ['origin', 'mine', 'up']
    expect(pushRemoteName('main', 'branch.main.pushremote mine\nremote.pushdefault up\nbranch.main.remote up', remotes)).toBe('mine')
    expect(pushRemoteName('main', 'remote.pushdefault up\nbranch.main.remote mine', remotes)).toBe('up')
    expect(pushRemoteName('main', 'branch.main.remote mine', remotes)).toBe('mine')
    expect(pushRemoteName(undefined, '', remotes)).toBe('origin')
    expect(pushRemoteName('main', 'branch.main.remote .', ['fork'])).toBe('fork')
    expect(pushRemoteName('main', '', ['a', 'b'])).toBeUndefined()
    expect(pushRemoteName('main', '', [])).toBeUndefined()
  })

  test('who an ssh key signs in as, and the signed-in gh accounts', () => {
    expect(sshUser("Hi work-acct! You've successfully authenticated, but GitHub does not provide shell access.")).toBe('work-acct')
    expect(sshUser('git@github.com: Permission denied (publickey).')).toBeUndefined()
    const json = JSON.stringify({ hosts: { 'github.com': [
      { state: 'success', active: true, login: 'work-acct' },
      { state: 'success', active: false, login: 'ColoMiranda' },
      { state: 'error', active: false, login: 'expired' },
    ] } })
    expect(ghAccounts(json)).toEqual({ active: 'work-acct', all: ['work-acct', 'ColoMiranda'] })
    expect(ghAccounts('not json')).toEqual({ all: [] })
  })

  test('what ssh -G resolves: the host, and a key per identity', () => {
    const conf = sshConfig('user git\nhostname github.com\nport 22\nidentityfile ~/.ssh/id_alt\nidentityagent ~/.ssh/agent.sock\n')
    expect(conf.hostname).toBe('github.com')
    expect(conf.key).toBe('github.com|identityfile ~/.ssh/id_alt|identityagent ~/.ssh/agent.sock')
    expect(sshConfig('hostname github.com\nidentityfile ~/.ssh/id_home\n').key).not.toBe(conf.key)
  })

  test('push access: true, false, a 404, or unknown', () => {
    const ran = (exitCode: number, stdout: string, stderr = '') => pushAccess({ exitCode, stdout, stderr })
    expect(ran(0, 'true\n')).toBe(true)
    expect(ran(0, 'false\n')).toBe(false)
    expect(ran(1, '{"message":"Not Found","status":"404"}', 'gh: Not Found (HTTP 404)\n')).toBe(false)
    expect(ran(1, '', 'error connecting to api.github.com\n')).toBeUndefined()
    expect(ran(1, '', 'gh: API rate limit exceeded (HTTP 403)\n')).toBeUndefined()
  })

  test('push and account commands', () => {
    expect(isPushCommand('git push origin main')).toBe(true)
    expect(isPushCommand('cd repo && GIT_TRACE=1 git push')).toBe(true)
    expect(isPushCommand('gh pr create --fill')).toBe(true)
    expect(isPushCommand('gh pr merge 12 --squash')).toBe(true)
    expect(isPushCommand('gh pr view 12')).toBe(false)
    expect(isPushCommand('echo "git push later"')).toBe(false)
    expect(isAccountCommand('gh auth switch --user ColoMiranda')).toBe(true)
    expect(isAccountCommand('gh auth login --web')).toBe(true)
    expect(isAccountCommand('git remote set-url origin git@github.com:a/b.git')).toBe(true)
    expect(isAccountCommand('gh auth status')).toBe(false)
  })

  test('the band line for each state', () => {
    const line = (status: AccountGuardStatus) => bandLine(status)
    expect(line({ state: 'ok', repo: 'ColoMiranda/claude-mods', account: 'ColoMiranda' })).toEqual({ text: 'GH ColoMiranda -> ColoMiranda/claude-mods', isWarning: false })
    expect(line({ state: 'no-access', repo: 'ColoMiranda/claude-mods', account: 'work-acct', via: 'https', isGhActive: true, canPush: ['ColoMiranda'] }).text).toBe(
      'GH work-acct cannot push to ColoMiranda/claude-mods.',
    )
    expect(line({ state: 'no-access', repo: 'a/b', account: 'x', via: 'https', isGhActive: true, canPush: ['y', 'z'] }).text).toBe('GH x cannot push to a/b. Also can push: z.')
    expect(line({ state: 'no-access', repo: 'a/b', account: 'x', via: 'ssh', isGhActive: false, canPush: ['y'] }).text).toBe('GH x (SSH key) cannot push to a/b. Can push: y.')
    expect(line({ state: 'no-access', repo: 'a/b', account: 'x', via: 'https', isGhActive: true, canPush: [] })).toEqual({ text: 'GH x cannot push to a/b. No signed-in gh account can.', isWarning: true })
    expect(line({ state: 'unknown', repo: 'a/b', reason: 'GitHub did not answer for x' }).isWarning).toBe(false)
    expect(line({ state: 'url-credential', repo: 'a/b' })).toEqual({ text: 'GH push uses a credential in the remote URL: a/b', isWarning: false })
    expect(line({ state: 'ssh-unchecked', repo: 'a/b' })).toEqual({ text: 'GH ssh remote: account not checked. /gh-check', isWarning: false })
    expect(line({ state: 'ok', repo: 'a/b', account: 'y', envToken: 'GH_TOKEN' }).text).toBe('GH y (from GH_TOKEN) -> a/b')
    expect(line({ state: 'no-access', repo: 'a/b', account: 'x', via: 'https', isGhActive: false, canPush: [], envToken: 'GITHUB_TOKEN' }).text).toBe(
      'GH x (from GITHUB_TOKEN) cannot push to a/b. GITHUB_TOKEN wins over gh auth switch.',
    )
    // A user in the https URL pins the account: switching gh would not help.
    expect(line({ state: 'no-access', repo: 'a/b', account: 'x', via: 'https', isGhActive: false, canPush: ['y'] }).text).toBe('GH x cannot push to a/b. Can push: y.')
  })

  test('a GitHub login, and the account a switch moves to', () => {
    for (const name of ['ColoMiranda', 'work-acct', 'a1']) expect(isLogin(name)).toBe(true)
    for (const name of ['--help', '-x', 'a b', 'a;rm', '', 'x'.repeat(40), 'a/b']) expect(isLogin(name)).toBe(false)
    const noAccess: AccountGuardStatus = { state: 'no-access', repo: 'a/b', account: 'x', via: 'https', isGhActive: true, canPush: ['y', 'z'] }
    expect(switchTarget(noAccess)).toBe('y')
    expect(switchTarget({ ...noAccess, via: 'ssh', isGhActive: false })).toBeUndefined()
    expect(switchTarget({ ...noAccess, canPush: [] })).toBeUndefined()
    expect(switchTarget({ state: 'ok', repo: 'a/b', account: 'y' })).toBeUndefined()
    expect(switchTarget(null)).toBeUndefined()
  })
})

// The machine a check runs on: one repo at /r, its push URL, git's credential
// helper, the signed-in gh accounts, what GitHub answers each account, and
// whom the SSH key signs in as. Every command run is logged.
type World = {
  isRepo: boolean
  url: string
  helper: string
  accounts: Array<{ login: string; active: boolean }>
  push: Record<string, 'true' | 'false' | '404' | 'offline'>
  sshAs?: string
  aliases: Record<string, string>
  runs: string[][]
  // Each run's timeout, in step with `runs` (30 s when none was given).
  timeouts: number[]
  toasts: string[]
  bashRan: string[]
  // The host's env (GH_TOKEN, GITHUB_TOKEN), and whose token it is.
  env: Record<string, string>
  envLogin?: string
  // When set, `gh auth switch` fails with this on stderr.
  switchFails?: string
  // When set, the next rev-parse answers as the world is at call time, but
  // only once this resolves: a slow check.
  hold?: Promise<void>
}

function machine(on: On, setup: Partial<World>) {
  const world: World = {
    isRepo: true,
    url: 'https://github.com/ColoMiranda/claude-mods.git',
    helper: '!/opt/homebrew/bin/gh auth git-credential',
    accounts: [{ login: 'work-acct', active: true }, { login: 'ColoMiranda', active: false }],
    push: { 'work-acct': '404', ColoMiranda: 'true' },
    aliases: {},
    runs: [],
    timeouts: [],
    toasts: [],
    bashRan: [],
    env: {},
    ...setup,
  }
  const clock = mock.clock(on)
  mock.env(on, world.env)
  mock.store(on)
  const answer = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', async ($, e) => {
    world.runs.push([...e.argv])
    world.timeouts.push(e.init?.timeoutMs ?? 30_000)
    const [cmd, ...args] = e.argv
    const line = args.join(' ')
    if (cmd === 'git' && line === 'rev-parse --is-inside-work-tree' && world.hold) {
      const [held, isRepo] = [world.hold, world.isRepo]
      world.hold = undefined
      await held
      return isRepo ? answer('true\n') : answer('', 128, 'fatal: not a git repository')
    }
    if (cmd === 'git') {
      if (!world.isRepo) return answer('', 128, 'fatal: not a git repository')
      if (line === 'rev-parse --is-inside-work-tree') return answer('true\n')
      if (line === 'symbolic-ref --quiet --short HEAD') return answer('main\n')
      if (args[0] === 'config' && args[1] === '--get-regexp') return answer('', 1)
      if (line === 'remote') return answer('origin\n')
      if (line === 'remote get-url --push origin') return answer(`${world.url}\n`)
      if (line === 'config --get-urlmatch credential.helper https://github.com') return answer(`${world.helper}\n`)
    }
    if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'switch') {
      if (world.switchFails) return answer('', 1, `${world.switchFails}\n`)
      world.accounts = world.accounts.map(one => ({ ...one, active: one.login === args[3] }))
      return answer('', 0, `✓ Switched active account for github.com to ${args[3]}\n`)
    }
    if (cmd === 'gh' && line === 'config get -h github.com user') return answer(`${world.accounts.find(one => one.active)?.login ?? ''}\n`)
    if (cmd === 'gh' && line === 'auth status --json hosts') {
      return answer(JSON.stringify({ hosts: { 'github.com': world.accounts.map(one => ({ state: 'success', ...one })) } }))
    }
    if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'token') {
      const user = args[3] ?? ''
      return world.accounts.some(one => one.login === user) ? answer(`token-${user}\n`) : answer('', 1, `no oauth token found for github.com account ${user}`)
    }
    if (cmd === 'gh' && line === 'api user --jq .login') return world.envLogin ? answer(`${world.envLogin}\n`) : answer('', 1, 'gh: Bad credentials (HTTP 401)\n')
    if (cmd === 'gh' && args[0] === 'api') {
      // An explicit GH_TOKEN names the account; else the host env's token does.
      const token = e.init?.env?.GH_TOKEN
      const as = token?.startsWith('token-') ? token.slice('token-'.length) : (world.envLogin ?? '')
      const said = world.push[as] ?? '404'
      if (said === '404') return answer('{"message":"Not Found","status":"404"}', 1, 'gh: Not Found (HTTP 404)\n')
      if (said === 'offline') return answer('', 1, 'error connecting to api.github.com\n')
      return answer(`${said}\n`)
    }
    if (cmd === 'ssh' && args[0] === '-G') return answer(`user git\nhostname ${world.aliases[args[1] ?? ''] ?? args[1]}\nport 22\nidentityfile ~/.ssh/key-${args[1]}\n`)
    if (cmd === 'ssh' && args[0] === '-T') {
      return world.sshAs ? answer('', 1, `Hi ${world.sshAs}! You've successfully authenticated, but GitHub does not provide shell access.\n`) : answer('', 255, 'Permission denied (publickey).')
    }
    return answer('', 127, `${cmd}: not found`)
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: '/r' }))
  on('classic.CwdChanged', () => ({}))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    world.bashRan.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  // The engine's own band: empty.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))

  return { world, clock }
}

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} } as const
const START = { cwd: '/r', surface: 'terminal', isInteractive: true } as const

// The band's GH line on a surface: its text and color, or undefined.
async function ghLine($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const band = await $.ui.mount({ plugin: 'account-guard', surface, component: 'AbovePrompt', props: BAND_PROPS })
  const found = await band.find({ type: 'Text', text: /^GH / })
  await band.unmount()
  return found && { text: found.text, color: found.props.color, dim: found.props.dimColor }
}

const apiRuns = (world: World) => world.runs.filter(argv => argv[0] === 'gh' && argv[1] === 'api').length

describe('hooks', () => {
  test('https, gh active and able to push: one dim line', async ($, on) => {
    const { clock } = machine(on, { accounts: [{ login: 'ColoMiranda', active: true }] })
    await $.session.start(START)
    await clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await ghLine($, surface)).toBeUndefined() // ok: nothing drawn
    }
    // A survey holds the band: this plugin yields.
    const band = await $.ui.mount({ plugin: 'account-guard', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, hasSurvey: true } })
    expect(await band.find({ type: 'Text', text: /^GH / })).toBeUndefined()
    await band.unmount()
  })

  test('https, gh active cannot push: a red line naming the account that can', async ($, on) => {
    const { world, clock } = machine(on, {})
    await $.session.start(START)
    await clock.settle()
    expect(await ghLine($)).toEqual({
      text: 'GH work-acct cannot push to ColoMiranda/claude-mods.',
      color: 'red',
      dim: undefined,
    })
    // Asked as each account, with that account's own token.
    expect(world.runs.filter(argv => argv[1] === 'api')).toHaveLength(2)
  })

  test('an org repo is pushed by a member who does not own it', async ($, on) => {
    const { clock } = machine(on, { url: 'https://github.com/golemfactory/yagna.git', push: { 'work-acct': 'true', ColoMiranda: 'false' } })
    await $.session.start(START)
    await clock.settle()
    expect(await ghLine($)).toBeUndefined() // ok: nothing drawn
  })

  test('ssh: never asked unprompted; /gh-check or the check button asks, kept a day per identity', async ($, on) => {
    const { world, clock } = machine(on, { url: 'git@github.com:ColoMiranda/claude-mods.git', sshAs: 'work-acct' })
    const sshT = () => world.runs.filter(argv => argv[0] === 'ssh' && argv[1] === '-T')
    const check = async () => (await $.command.run({ command: 'gh-check', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text
    const recheck = async () => {
      await $.classic.CwdChanged({ old_cwd: '/elsewhere', new_cwd: '/r' })
      await clock.settle()
    }
    await $.session.start(START)
    await clock.settle()
    expect(await ghLine($)).toEqual({ text: 'GH ssh remote: account not checked. /gh-check', color: undefined, dim: true })
    expect(sshT()).toEqual([])

    const RED = 'GH work-acct (SSH key) cannot push to ColoMiranda/claude-mods. Can push: ColoMiranda.'
    expect(await check()).toBe(RED)
    expect(sshT()).toEqual([['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'git@github.com']])
    expect((await ghLine($))?.text).toBe(RED)

    // Kept: a new check of the same identity asks nobody.
    await recheck()
    expect((await ghLine($))?.text).toBe(RED)
    expect(sshT()).toHaveLength(1)

    // A day later it is unchecked again; the check button (k) asks.
    await clock.advance(24 * 60 * 60 * 1000 + 1)
    await recheck()
    expect((await ghLine($))?.text).toBe('GH ssh remote: account not checked. /gh-check')
    const band = await $.ui.mount({ plugin: 'account-guard', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect((await band.find({ type: 'Button', key: 'check' }))?.props).toMatchObject({ label: 'check', hotkey: 'k' })
    await band.press({ key: 'check' })
    await band.unmount()
    expect(world.toasts).toEqual([RED])
    expect(sshT()).toHaveLength(2)

    // An ~/.ssh/config alias of github.com is its own identity.
    world.url = 'git@github-personal:ColoMiranda/claude-mods.git'
    world.aliases['github-personal'] = 'github.com'
    world.sshAs = 'ColoMiranda'
    await recheck()
    expect((await ghLine($))?.text).toBe('GH ssh remote: account not checked. /gh-check')
    expect(await check()).toBe('GH ColoMiranda -> ColoMiranda/claude-mods')
    expect(sshT().at(-1)).toEqual(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'git@github-personal'])
  })

  test('https: a user in the URL is the account; a helper other than gh is unknown', async ($, on) => {
    const { world, clock } = machine(on, { url: 'https://ColoMiranda@github.com/ColoMiranda/claude-mods.git' })
    await $.session.start(START)
    await clock.settle()
    expect(await ghLine($)).toBeUndefined() // ok: nothing drawn

    world.url = 'https://github.com/ColoMiranda/claude-mods.git'
    world.helper = 'osxkeychain'
    await $.classic.CwdChanged({ old_cwd: '/elsewhere', new_cwd: '/r' })
    await clock.settle()
    expect(await ghLine($)).toEqual({ text: 'GH status unknown for ColoMiranda/claude-mods: git does not sign in through gh here', color: undefined, dim: true })
  })

  test('offline: a dim unknown line, never a false warning', async ($, on) => {
    const { clock } = machine(on, { push: { 'work-acct': 'offline', ColoMiranda: 'offline' } })
    await $.session.start(START)
    await clock.settle()
    expect(await ghLine($)).toEqual({ text: 'GH status unknown for ColoMiranda/claude-mods: GitHub did not answer for work-acct', color: undefined, dim: true })
  })

  test('no git repo, or no GitHub remote: nothing', async ($, on) => {
    const { world, clock } = machine(on, { isRepo: false })
    await $.session.start(START)
    await clock.settle()
    expect(await ghLine($)).toBeUndefined()
    expect(world.runs.filter(argv => argv[0] !== 'git')).toEqual([])

    world.isRepo = true
    world.url = 'https://gitlab.com/a/b.git'
    await $.classic.CwdChanged({ old_cwd: '/elsewhere', new_cwd: '/r' })
    await clock.settle()
    expect(await ghLine($)).toBeUndefined()

    // An ssh host that is not github.com, nor an alias of it.
    world.url = 'git@gitlab.com:a/b.git'
    await $.classic.CwdChanged({ old_cwd: '/elsewhere', new_cwd: '/r' })
    await clock.settle()
    expect(await ghLine($)).toBeUndefined()
    expect(world.runs.filter(argv => argv[0] === 'ssh')).toEqual([['ssh', '-G', 'gitlab.com']])
  })

  test('a slow check that ends after a newer one does not overwrite it', async ($, on) => {
    const { world, clock } = machine(on, { isRepo: false, accounts: [{ login: 'ColoMiranda', active: true }] })
    let release = () => {}
    world.hold = new Promise<void>(resolve => (release = resolve))
    await $.session.start(START)
    await clock.settle()

    world.isRepo = true
    await $.classic.CwdChanged({ old_cwd: '/elsewhere', new_cwd: '/r' })
    await clock.settle()
    expect(await ghLine($)).toBeUndefined() // ok: nothing drawn

    release()
    await clock.settle()
    expect(await ghLine($)).toBeUndefined() // ok: nothing drawn
  })

  test('each repo and account is checked once: drawing never checks, an account change checks fresh', async ($, on) => {
    const { world, clock } = machine(on, {})
    await $.session.start(START)
    await clock.settle()
    const ran = world.runs.length
    for (let i = 0; i < 3; i += 1) await ghLine($)
    expect(world.runs).toHaveLength(ran)

    await $.classic.CwdChanged({ old_cwd: '/elsewhere', new_cwd: '/r' })
    await clock.settle()
    expect(apiRuns(world)).toBe(2)

    // The user switches: the line turns ok, asked again from scratch.
    world.accounts = [{ login: 'work-acct', active: false }, { login: 'ColoMiranda', active: true }]
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'gh auth switch --user ColoMiranda' })
    await clock.settle()
    expect(await ghLine($)).toBeUndefined() // ok: nothing drawn
    expect(apiRuns(world)).toBe(3)
  })

  test('a push from an account that cannot push: a toast, and the push still runs', async ($, on) => {
    const { world, clock } = machine(on, {})
    await $.session.start(START)
    await clock.settle()
    const run = (command: string) => $.tool.call({ tool: 'Bash', tool_use_id: command, command })

    await run('git status')
    await run('git push origin main')
    await run('cd /r && gh pr create --fill')
    expect(world.toasts).toEqual([
      'GH work-acct cannot push to ColoMiranda/claude-mods.',
      'GH work-acct cannot push to ColoMiranda/claude-mods.',
    ])
    expect(world.bashRan).toEqual(['git status', 'git push origin main', 'cd /r && gh pr create --fill'])

    // Once able to push, no toast.
    world.accounts = [{ login: 'ColoMiranda', active: true }]
    await run('gh auth switch --user ColoMiranda')
    await clock.settle()
    await run('git push')
    expect(world.toasts).toHaveLength(2)
  })
})

describe('composition', () => {
  test(
    'with another plugin on the band, both lines draw',
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
      const { clock } = machine(on, { accounts: [{ login: 'ColoMiranda', active: true }] })
      await $.session.start(START)
      await clock.settle()
      for (const surface of ['terminal', 'desktop'] as const) {
        const band = await $.ui.mount({ plugin: 'account-guard', surface, component: 'AbovePrompt', props: BAND_PROPS })
        expect(await band.find({ type: 'Text', text: /^GH / })).toBeUndefined() // ok: nothing drawn
        expect(await band.find({ type: 'Text', text: 'NEIGHBOR ROW' })).toBeDefined()
        await band.unmount()
      }
    },
  )
})

describe('switch', () => {
  const SWITCH = ['gh', 'auth', 'switch', '--user', 'ColoMiranda']
  const switches = (world: World) => world.runs.filter(argv => argv[1] === 'auth' && argv[2] === 'switch')
  const buttonOn = async ($: Engine) => {
    const band = await $.ui.mount({ plugin: 'account-guard', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    const found = await band.find({ type: 'Button', key: 'switch' })
    return { band, found }
  }

  test('https through gh, another account can push: a switch button that switches, toasts and checks again', async ($, on) => {
    const { world, clock } = machine(on, {})
    await $.session.start(START)
    await clock.settle()
    const { band, found } = await buttonOn($)
    expect(found?.props).toMatchObject({ label: 'switch to ColoMiranda', hotkey: 'w' })
    const asked = apiRuns(world)
    await band.press({ key: 'switch' })
    await band.unmount()
    expect(switches(world)).toEqual([SWITCH])
    expect(world.toasts).toEqual(['Switched gh to ColoMiranda. This applies to all terminals.'])

    // Checked again, cache cleared: the band is ok, with no button.
    await clock.settle()
    expect(apiRuns(world)).toBeGreaterThan(asked)
    expect(await ghLine($)).toBeUndefined() // ok: nothing drawn
    expect((await buttonOn($)).found).toBeUndefined()
  })

  test('a failed switch toasts gh\'s words, and /gh-switch does the same', async ($, on) => {
    const { world, clock } = machine(on, { switchFails: 'no accounts matched that criteria' })
    await $.session.start(START)
    await clock.settle()
    const { band } = await buttonOn($)
    await band.press({ key: 'switch' })
    await band.unmount()
    expect(world.toasts).toEqual(['Could not switch gh to ColoMiranda: no accounts matched that criteria'])

    const run = () => $.command.run({ command: 'gh-switch', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect((await run()).text).toBe('Could not switch gh to ColoMiranda: no accounts matched that criteria')
    world.switchFails = undefined
    expect((await run()).text).toBe('Switched gh to ColoMiranda. This applies to all terminals.')
    expect(switches(world)).toEqual([SWITCH, SWITCH, SWITCH])
    await clock.settle()
    expect((await run()).text).toBe('Nothing to switch: no other signed-in gh account would make this push work')
  })

  test('no button over ssh, with a user in the URL, or when no other account can push', async ($, on) => {
    const { world, clock } = machine(on, { url: 'git@github.com:ColoMiranda/claude-mods.git', sshAs: 'work-acct' })
    const recheck = async () => {
      await $.classic.CwdChanged({ old_cwd: '/elsewhere', new_cwd: '/r' })
      await clock.settle()
    }
    await $.session.start(START)
    await clock.settle()
    await $.command.run({ command: 'gh-check', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect((await ghLine($))?.text).toBe('GH work-acct (SSH key) cannot push to ColoMiranda/claude-mods. Can push: ColoMiranda.')
    expect((await buttonOn($)).found).toBeUndefined()

    world.url = 'https://work-acct@github.com/ColoMiranda/claude-mods.git'
    await recheck()
    expect((await ghLine($))?.text).toBe('GH work-acct cannot push to ColoMiranda/claude-mods. Can push: ColoMiranda.')
    expect((await buttonOn($)).found).toBeUndefined()

    world.url = 'https://github.com/ColoMiranda/claude-mods.git'
    world.push = { 'work-acct': '404', ColoMiranda: '404' }
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'gh auth login' })
    await clock.settle()
    expect((await ghLine($))?.text).toBe('GH work-acct cannot push to ColoMiranda/claude-mods. No signed-in gh account can.')
    expect((await buttonOn($)).found).toBeUndefined()
    expect(switches(world)).toEqual([])
  })

  test('gh auth login adds an account: the signed-in list is read again, and it is offered', async ($, on) => {
    const { world, clock } = machine(on, { accounts: [{ login: 'work-acct', active: true }] })
    await $.session.start(START)
    await clock.settle()
    expect((await ghLine($))?.text).toBe('GH work-acct cannot push to ColoMiranda/claude-mods. No signed-in gh account can.')

    world.accounts = [{ login: 'work-acct', active: true }, { login: 'ColoMiranda', active: false }]
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'gh auth login --web' })
    await clock.settle()
    expect((await buttonOn($)).found?.props.label).toBe('switch to ColoMiranda')
  })

  test('a name that is not a GitHub login is never run', async ($, on) => {
    const { world, clock } = machine(on, { accounts: [{ login: 'work-acct', active: true }, { login: '--hostname=evil', active: false }], push: { 'work-acct': '404', '--hostname=evil': 'true' } })
    await $.session.start(START)
    await clock.settle()
    const { band } = await buttonOn($)
    await band.press({ key: 'switch' })
    await band.unmount()
    expect(world.toasts).toEqual(['Not switching: "--hostname=evil" is not a GitHub login'])
    expect(switches(world)).toEqual([])
  })
})

describe('review fixes', () => {
  const run = ($: Engine, command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

  test(
    'a credential in the remote URL is never shown, stored or passed on',
    {
      plugins: [
        {
          // Reads what account-guard keeps, as any plugin may.
          name: 'peek',
          register(on) {
            on('command.run', { command: 'peek' }, async $ => ({
              text: JSON.stringify([await $.state.get({ plugin: 'account-guard', key: 'status' }), await $.state.get({ plugin: 'account-guard', key: 'access' })]),
            }))
          },
        },
      ],
    },
    async ($, on) => {
      const PAT = 'ghp_FAKEtoken1234567890'
      const { world, clock } = machine(on, {})
      await $.session.start(START)
      await clock.settle()
      for (const url of [`https://${PAT}@github.com/ColoMiranda/claude-mods.git`, `https://x-access-token:${PAT}@github.com/ColoMiranda/claude-mods.git`, `https://ColoMiranda:${PAT}@github.com/ColoMiranda/claude-mods.git`]) {
        world.url = url
        await $.classic.CwdChanged({ old_cwd: '/elsewhere', new_cwd: '/r' })
        await clock.settle()
        expect(await ghLine($)).toEqual({ text: 'GH push uses a credential in the remote URL: ColoMiranda/claude-mods', color: undefined, dim: true })
        await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'git push' })
        expect((await run($, 'gh-check')).text).toBe('GH push uses a credential in the remote URL: ColoMiranda/claude-mods')
        const kept = (await run($, 'peek')).text ?? ''
        expect(kept).toContain('url-credential')
        for (const one of [kept, JSON.stringify(world.runs), JSON.stringify(world.toasts), (await ghLine($))?.text ?? '']) expect(one.includes(PAT)).toBe(false)
      }
    },
  )

  test('a gh switch made outside shows by the next prompt, read locally; a push then has no stale toast', async ($, on) => {
    const { world, clock } = machine(on, {})
    await $.session.start(START)
    await clock.settle()
    expect((await ghLine($))?.color).toBe('red')
    const asked = apiRuns(world)

    world.accounts = [{ login: 'work-acct', active: false }, { login: 'ColoMiranda', active: true }]
    const ran = world.runs.length
    await $.prompt.submit({ text: 'status?', wait: false, origin: { kind: 'composer' } })
    await clock.settle()
    expect(await ghLine($)).toBeUndefined() // ok: nothing drawn
    // What a prompt runs: local reads only, each with a short timeout.
    expect(world.runs.slice(ran)).toEqual([
      ['git', 'rev-parse', '--is-inside-work-tree'],
      ['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'],
      ['git', 'config', '--get-regexp', '^(remote\\.pushdefault|branch\\..*\\.(pushremote|remote))$'],
      ['git', 'remote'],
      ['git', 'remote', 'get-url', '--push', 'origin'],
      ['git', 'config', '--get-urlmatch', 'credential.helper', 'https://github.com'],
      ['gh', 'config', 'get', '-h', 'github.com', 'user'],
    ])
    expect(Math.max(...world.timeouts.slice(ran))).toBeLessThanOrEqual(2_000)
    // Both pairs were known: GitHub was not asked again.
    expect(apiRuns(world)).toBe(asked)

    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'git push' })
    await clock.settle()
    expect(world.toasts).toEqual([])
  })

  test('a push never waits for a check; a check that finds a new no toasts a moment later', async ($, on) => {
    const { world, clock } = machine(on, { accounts: [{ login: 'work-acct', active: false }, { login: 'ColoMiranda', active: true }] })
    await $.session.start(START)
    await clock.settle()
    expect(await ghLine($)).toBeUndefined() // ok: nothing drawn

    // Switched outside to an account never asked about; the check behind the
    // push hangs on its first read.
    world.accounts = [{ login: 'work-acct', active: true }, { login: 'ColoMiranda', active: false }]
    let release = () => {}
    world.hold = new Promise<void>(resolve => (release = resolve))
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'git push' })
    expect(world.bashRan).toEqual(['git push'])
    await clock.settle()
    expect(world.toasts).toEqual([])

    release()
    await clock.settle()
    expect(world.toasts).toEqual(['GH work-acct cannot push to ColoMiranda/claude-mods.'])
    // The next push toasts from what is known, at once.
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'git push' })
    await clock.settle()
    expect(world.toasts).toHaveLength(2)
  })

  test('GH_TOKEN or GITHUB_TOKEN in the env: the account of that token, named, and no switch button', async ($, on) => {
    const SECRET = 'ghp_ENVSECRET000'
    const { world, clock } = machine(on, { env: { GH_TOKEN: SECRET }, envLogin: 'ColoMiranda', accounts: [{ login: 'work-acct', active: true }, { login: 'ColoMiranda', active: false }] })
    await $.session.start(START)
    await clock.settle()
    expect(await ghLine($)).toBeUndefined() // ok: nothing drawn
    expect(world.runs).toContainEqual(['gh', 'api', 'user', '--jq', '.login'])
    expect(JSON.stringify(world.runs).includes(SECRET)).toBe(false)

    // The env token cannot push: gh auth switch would not help, so no button.
    world.push = { ColoMiranda: '404', 'work-acct': 'true' }
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'gh auth login' })
    await clock.settle()
    expect(await ghLine($)).toEqual({ text: 'GH ColoMiranda (from GH_TOKEN) cannot push to ColoMiranda/claude-mods. GH_TOKEN wins over gh auth switch.', color: 'red', dim: undefined })
    const band = await $.ui.mount({ plugin: 'account-guard', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Button', key: 'switch' })).toBeUndefined()
    await band.unmount()
    expect((await run($, 'gh-switch')).text).toBe('Nothing to switch: no other signed-in gh account would make this push work')
  })

  test('GITHUB_TOKEN alone is named too', async ($, on) => {
    const { clock } = machine(on, { env: { GITHUB_TOKEN: 'ghp_OTHER' }, envLogin: 'ColoMiranda' })
    await $.session.start(START)
    await clock.settle()
    expect(await ghLine($)).toBeUndefined() // ok: nothing drawn
  })
})
