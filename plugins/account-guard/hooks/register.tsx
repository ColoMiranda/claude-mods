import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AccountGuardEnvToken, AccountGuardStatus } from '../types'
import {
  bandLine,
  ghAccounts,
  type GithubRemote,
  githubRemote,
  isAccountCommand,
  isLogin,
  isPushCommand,
  pushAccess,
  pushRemoteName,
  sshConfig,
  sshUser,
  switchTarget,
} from './parse'

const status = atom({ plugin: 'account-guard', key: 'status' } as const, null as AccountGuardStatus | null)
const access = atom({ plugin: 'account-guard', key: 'access' } as const, {} as Record<string, boolean>)
const NETWORK_MS = 15_000
// Local reads (git config, gh's own config, ssh's config) never wait longer.
const LOCAL_MS = 2_000
const SSH_DAY_MS = 24 * 60 * 60 * 1000

// Whether `account` can push to `repo` ("owner/repo"), asked once per pair as
// that account: with its gh token, or, for the env token's account, with the
// env as it is (the token never passes through here). Undefined when GitHub
// does not tell, or the account is not signed in to gh. Owning the repo is
// not the test: an org repo is pushed by its members.
async function canPush($: EngineInterface, repo: string, account: string, isEnvToken = false): Promise<boolean | undefined> {
  const key = `${repo}@${account}`.toLowerCase()
  const known = (await read($, access))[key]
  if (known !== undefined) return known
  let env: Record<string, string> | undefined
  if (!isEnvToken) {
    const token = await $.process.run(['gh', 'auth', 'token', '--user', account])
    if (token.exitCode !== 0 || token.stdout.trim() === '') return undefined
    env = { GH_TOKEN: token.stdout.trim() }
  }
  const ran = await $.process.run(['gh', 'api', `repos/${repo}`, '--jq', '.permissions.push'], { env, timeoutMs: NETWORK_MS })
  const answer = pushAccess(ran)
  if (answer !== undefined) await update($, access, all => ({ ...all, [key]: answer }))

  return answer
}

// The env variable gh takes its token from (GH_TOKEN first), and whose it is:
// asked once per process, since the host's env does not change under it.
const envLogins = new Map<AccountGuardEnvToken, string>()

async function envToken($: EngineInterface): Promise<AccountGuardEnvToken | undefined> {
  if (await $.env.get('GH_TOKEN').catch(() => undefined)) return 'GH_TOKEN'
  if (await $.env.get('GITHUB_TOKEN').catch(() => undefined)) return 'GITHUB_TOKEN'
  return undefined
}

async function envLogin($: EngineInterface, name: AccountGuardEnvToken): Promise<string | undefined> {
  if (!envLogins.has(name)) {
    const login = (await $.process.run(['gh', 'api', 'user', '--jq', '.login'], { timeoutMs: NETWORK_MS })).stdout.trim()
    if (isLogin(login)) envLogins.set(name, login)
  }
  return envLogins.get(name)
}

// The signed-in gh accounts: `gh auth status` checks each token online, so it
// runs once, and again only after an account command, a switch or /gh-check.
let signedIn: { active?: string; all: string[] } | undefined

async function accountsOf($: EngineInterface): Promise<{ active?: string; all: string[] }> {
  signedIn ??= ghAccounts((await $.process.run(['gh', 'auth', 'status', '--json', 'hosts'], { timeoutMs: NETWORK_MS })).stdout)
  return signedIn
}

// gh's active account from its own config file: local, no token check.
async function activeAccount($: EngineInterface): Promise<string | undefined> {
  const user = (await $.process.run(['gh', 'config', 'get', '-h', 'github.com', 'user'], { timeoutMs: LOCAL_MS })).stdout.trim()
  return isLogin(user) ? user : (await accountsOf($)).active
}

type Ask = { repo: string; account: string; via: 'https' | 'ssh'; isGhActive: boolean; envToken?: AccountGuardEnvToken; logins: string[] }
type Local = { status?: AccountGuardStatus | null; ask?: Ask; ssh?: { host: string; key: string } }

// ponytail: what a push from `cwd` would sign in as, read locally (git config,
// gh's config file, ssh's config; the network only for the signed-in list and
// the env token's login, each once). https:
// a user in the URL only when it is a signed-in gh login (anything else, or a
// password, is a credential of its own: never kept); else the env token's
// account; else gh's active account when gh is git's credential helper. ssh:
// whom the key signed in as when /gh-check last asked (24 h, in $.store), never
// asked unprompted: the agent may pop up an approval. The remote is the one
// `git push` picks on this branch; a push that names another is not seen.
// Upgrade path: read the push's own arguments at push time.
async function localTarget($: EngineInterface, cwd: string): Promise<Local> {
  const git = (...args: string[]) => $.process.run(['git', ...args], { cwd, timeoutMs: LOCAL_MS })
  if ((await git('rev-parse', '--is-inside-work-tree')).stdout.trim() !== 'true') return { status: null }
  const branch = (await git('symbolic-ref', '--quiet', '--short', 'HEAD')).stdout.trim() || undefined
  const config = (await git('config', '--get-regexp', '^(remote\\.pushdefault|branch\\..*\\.(pushremote|remote))$')).stdout
  const remotes = (await git('remote')).stdout.split('\n').map(one => one.trim()).filter(Boolean)
  const name = pushRemoteName(branch, config, remotes)
  if (name === undefined) return { status: null }
  const remote = githubRemote((await git('remote', 'get-url', '--push', name)).stdout)
  if (remote === undefined) return { status: null }
  const repo = `${remote.owner}/${remote.repo}`
  let ssh: Local['ssh']
  if (remote.via === 'ssh') {
    const resolved = sshConfig((await $.process.run(['ssh', '-G', remote.host], { timeoutMs: LOCAL_MS })).stdout)
    if (resolved.hostname?.toLowerCase() !== 'github.com') return { status: null }
    ssh = { host: remote.host, key: resolved.key }
  }
  try {
    return await signIn($, cwd, repo, remote, ssh)
  } catch {
    return { status: { state: 'unknown', repo, reason: 'gh failed' }, ssh }
  }
}

// Whom the remote signs in as, from gh, the env, git's helper and $.store.
async function signIn($: EngineInterface, cwd: string, repo: string, remote: GithubRemote, ssh: Local['ssh']): Promise<Local> {
  if (ssh !== undefined) {
    const seen = (await $.store.get(`ssh:${ssh.key}`)) as { account?: unknown; at?: unknown } | undefined
    const isFresh = typeof seen?.account === 'string' && isLogin(seen.account) && typeof seen.at === 'number' && (await $.clock.now()) - seen.at < SSH_DAY_MS
    if (!isFresh) return { status: { state: 'ssh-unchecked', repo }, ssh }
    const { all } = await accountsOf($)
    return { ask: { repo, account: seen.account as string, via: 'ssh', isGhActive: false, logins: all }, ssh }
  }
  const accounts = await accountsOf($)
  const named = remote.user === undefined ? undefined : accounts.all.find(login => login.toLowerCase() === remote.user?.toLowerCase())
  if (remote.hasPassword || (remote.user !== undefined && named === undefined)) return { status: { state: 'url-credential', repo } }
  const helper = (await $.process.run(['git', 'config', '--get-urlmatch', 'credential.helper', 'https://github.com'], { cwd, timeoutMs: LOCAL_MS })).stdout
  const usesGh = /\bgh(?:\.exe)? auth git-credential\b/.test(helper)
  const fromEnv = usesGh ? await envToken($) : undefined
  if (fromEnv !== undefined) {
    const account = await envLogin($, fromEnv)
    if (account === undefined) return { status: { state: 'unknown', repo, reason: `GitHub did not say whose ${fromEnv} this is` } }
    return { ask: { repo, account, via: 'https', isGhActive: false, envToken: fromEnv, logins: accounts.all } }
  }
  if (named !== undefined) return { ask: { repo, account: named, via: 'https', isGhActive: false, logins: accounts.all } }
  const active = usesGh ? await activeAccount($) : undefined
  if (active !== undefined) return { ask: { repo, account: active, via: 'https', isGhActive: true, logins: accounts.all } }

  return { status: { state: 'unknown', repo, reason: 'git does not sign in through gh here' } }
}

// The band's status: the local target, then GitHub's answer for it (cached
// per repo and account, so only a new pair goes to the network).
async function resolve($: EngineInterface, cwd: string): Promise<AccountGuardStatus | null> {
  const local = await localTarget($, cwd)
  if (local.ask === undefined) return local.status ?? null
  const { repo, account, via, isGhActive, envToken: fromEnv, logins } = local.ask
  const env = fromEnv === undefined ? {} : { envToken: fromEnv }
  try {
    const can = await canPush($, repo, account, fromEnv !== undefined)
    if (can === undefined) return { state: 'unknown', repo, reason: `GitHub did not answer for ${account}` }
    if (can) return { state: 'ok', repo, account, ...env }
    // The env token wins over every signed-in account: no other one helps.
    const others: string[] = []
    for (const other of fromEnv === undefined ? logins : []) {
      if (other.toLowerCase() !== account.toLowerCase() && (await canPush($, repo, other))) others.push(other)
    }

    return { state: 'no-access', repo, account, via, isGhActive, canPush: others, ...env }
  } catch {
    return { state: 'unknown', repo, reason: 'gh failed' }
  }
}

// The newest check wins: one that ends after a later one started is dropped.
// An unchanged answer is not written again, so the band does not redraw.
let latest = 0

async function refresh($: EngineInterface, cwd: string) {
  const mine = ++latest
  const found = await resolve($, cwd).catch(() => null)
  if (mine !== latest) return
  if (JSON.stringify(await read($, status)) !== JSON.stringify(found)) await update($, status, () => found)
}

// After a push started: the target read again, and a toast if it turns out
// not to have access where the toast at push time did not say so.
async function recheckPush($: EngineInterface, known: AccountGuardStatus | null) {
  await refresh($, await $.session.cwd())
  const now = await read($, status)
  if (now?.state === 'no-access' && JSON.stringify(now) !== JSON.stringify(known)) $.ui.toast(bandLine(now).text, { timeoutMs: 10_000 })
}

// Checks run on a timer, outside the hook that asked: a slow network never
// holds the session's start or a prompt.
function later($: EngineInterface, cwd: string) {
  $.clock.after(0, () => void refresh($, cwd))
}

// Moves gh's active account (for every terminal, not this session alone),
// then checks again from scratch so the band follows.
async function switchTo($: EngineInterface, account: string): Promise<string> {
  if (!isLogin(account)) return `Not switching: ${JSON.stringify(account)} is not a GitHub login`
  const ran = await $.process.run(['gh', 'auth', 'switch', '--user', account]).catch((error: unknown) => ({
    exitCode: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
  }))
  if (ran.exitCode !== 0) return `Could not switch gh to ${account}: ${(ran.stderr.trim() || ran.stdout.trim()).split('\n')[0]}`
  signedIn = undefined
  await update($, access, () => ({}))
  later($, await $.session.cwd())

  return `Switched gh to ${account}. This applies to all terminals.`
}

// The person's own check: for an ssh remote, asks GitHub whom the key signs
// in as (the agent may ask them to approve) and keeps it a day; for https,
// asks GitHub again from scratch.
async function checkNow($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const local = await localTarget($, cwd).catch(() => ({}) as Local)
  if (local.ssh !== undefined) {
    const greeted = await $.process.run(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', `git@${local.ssh.host}`], { timeoutMs: NETWORK_MS })
    const account = sshUser(`${greeted.stdout}\n${greeted.stderr}`)
    if (account === undefined) return 'ssh did not say which account the key signs in as'
    await $.store.set(`ssh:${local.ssh.key}`, { account, at: await $.clock.now() })
  } else {
    await update($, access, () => ({}))
  }
  signedIn = undefined
  await refresh($, cwd)
  const now = await read($, status)

  return now === null ? 'No GitHub remote here' : bandLine(now).text
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    later($, e.cwd)
    await $.command.register({ name: 'gh-switch', description: 'Switch gh to the signed-in account that can push here', immediate: true })
    await $.command.register({ name: 'gh-check', description: 'Check which GitHub account a push from here uses (asks the SSH key too)', immediate: true })

    return next(e)
  })

  on('classic.CwdChanged', async ($, e, next) => {
    later($, e.new_cwd)

    return next(e)
  })

  // A switch made in another terminal shows by the next prompt: the re-read is
  // local (git config, gh's config file, 2 s at most each), and GitHub is
  // asked only for a repo and account pair not seen yet.
  on('prompt.submit', async ($, e, next) => {
    later($, await $.session.cwd())

    return next(e)
  })

  // A push from an account that cannot push: a toast, and the command runs at
  // once, never held by a check. The toast comes from what is known; a check
  // starts beside the push and toasts a moment later when it finds a new "no"
  // (a switch made in another terminal). An account switch, a login or a
  // remote change: check again, fresh.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (isPushCommand(e.command)) {
      const known = await read($, status)
      if (known?.state === 'no-access') $.ui.toast(bandLine(known).text, { timeoutMs: 10_000 })
      $.clock.after(0, () => void recheckPush($, known))
    }
    const ran = await next(e)
    if (ran.deny === undefined && isAccountCommand(e.command)) {
      signedIn = undefined
      await update($, access, () => ({}))
      later($, await $.session.cwd())
    }

    return ran
  })

  on('command.run', { command: 'gh-switch' }, async $ => {
    const target = switchTarget(await read($, status))

    return { text: target === undefined ? 'Nothing to switch: no other signed-in gh account would make this push work' : await switchTo($, target) }
  })

  on('command.run', { command: 'gh-check' }, async $ => ({ text: await checkNow($) }))

  // One line over the rest of the band (other plugins' rows), never instead of it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, status)
    // All good: nothing to show, the band is the other mods' alone.
    if (e.props.hasSurvey || now === null || now.state === 'ok') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const line = bandLine(now)
    const target = switchTarget(now)
    // Nothing beneath (a test's bare engine): this line alone.
    const rest = await next(e).catch(() => undefined)

    return (
      <Box flexDirection="column">
        {line.isWarning ? (
          <Box gap={1}>
            <Text color="red" wrap="wrap">
              {line.text}
            </Text>
            {target !== undefined && (
              <Button key="switch" label={`switch to ${target}`} hotkey="w" onPress={async () => $.ui.toast(await switchTo($, target))} />
            )}
          </Box>
        ) : (
          <Box gap={1}>
            <Text dimColor wrap="truncate-end">
              {line.text}
            </Text>
            {now.state === 'ssh-unchecked' && <Button key="check" label="check" hotkey="k" onPress={async () => $.ui.toast(await checkNow($))} />}
          </Box>
        )}
        {rest}
      </Box>
    )
  })
}
