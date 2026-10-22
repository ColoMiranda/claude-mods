import type { AccountGuardStatus } from '../types'

// `user` and `hasPassword` are what an https URL carries before the host: the
// user may be a token, so a caller keeps it only once it matches a signed-in
// gh login, and never shows it.
export type GithubRemote = { owner: string; repo: string; via: 'https' | 'ssh'; host: string; user?: string; hasPassword?: boolean }

// The GitHub repo a push URL names: https://[user[:password]@]github.com/o/r[.git],
// git@HOST:o/r[.git] or ssh://git@HOST[:port]/o/r[.git]. An ssh HOST other
// than github.com may be an alias in ~/.ssh/config; the caller resolves it.
export function githubRemote(url: string): GithubRemote | undefined {
  const https = /^https:\/\/(?:([^@/:]+)(:[^@/]*)?@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim())
  if (https) return { owner: https[3]!, repo: https[4]!, via: 'https', host: 'github.com', user: https[1], hasPassword: https[2] !== undefined }
  const ssh = /^(?:ssh:\/\/)?[\w.-]+@([\w.-]+)(?::\d+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  if (ssh) return { owner: ssh[2]!, repo: ssh[3]!, via: 'ssh', host: ssh[1]! }

  return undefined
}

// The remote `git push` uses on this branch, as git picks it: the branch's
// pushRemote, remote.pushDefault, the branch's remote, then origin, then the
// only one. `config` is `git config --get-regexp` output ("key value" lines).
export function pushRemoteName(branch: string | undefined, config: string, remotes: readonly string[]): string | undefined {
  const values = new Map(config.split('\n').map(line => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1).trim()]))
  const picks = [
    branch && values.get(`branch.${branch}.pushremote`),
    values.get('remote.pushdefault'),
    branch && values.get(`branch.${branch}.remote`),
    'origin',
    remotes.length === 1 ? remotes[0] : undefined,
  ]

  return picks.find((name): name is string => typeof name === 'string' && remotes.includes(name))
}

// What `ssh -G <host>` resolves (no network): the real hostname, and a key
// naming the identity it offers (files and agent), for a cache per identity.
export function sshConfig(text: string): { hostname?: string; key: string } {
  const hostname = /^hostname (\S+)$/im.exec(text)?.[1]
  const identities = [...text.matchAll(/^(?:identityfile|identityagent) (.+)$/gim)].map(([line]) => line.trim())

  return { hostname, key: [hostname ?? '', ...identities].join('|') }
}

// "Hi ColoMiranda! You've successfully authenticated..." from `ssh -T`.
export function sshUser(text: string): string | undefined {
  return /\bHi ([A-Za-z0-9-]+)!/.exec(text)?.[1]
}

// The github.com accounts `gh auth status --json hosts` reports signed in,
// and the active one.
export function ghAccounts(json: string): { active?: string; all: string[] } {
  try {
    const hosts: unknown = JSON.parse(json)?.hosts?.['github.com']
    const signedIn = (Array.isArray(hosts) ? hosts : []).filter(
      (one): one is { login: string; active?: boolean } => one?.state === 'success' && typeof one.login === 'string',
    )
    return { active: signedIn.find(one => one.active === true)?.login, all: signedIn.map(one => one.login) }
  } catch {
    return { all: [] }
  }
}

// `gh api repos/<o>/<r> --jq .permissions.push`: true or false, or a 404 (no
// access to a private repo, or none there); anything else (offline, a rate
// limit, a bad token) is undefined, never a false "no".
export function pushAccess(ran: { exitCode: number; stdout: string; stderr: string }): boolean | undefined {
  if (ran.exitCode === 0 && ran.stdout.trim() === 'true') return true
  if (ran.exitCode === 0 && ran.stdout.trim() === 'false') return false
  return /\(HTTP 404\)/.test(ran.stderr) ? false : undefined
}

// Each command of a line, its leading VAR=value assignments dropped.
function commands(line: string): string[] {
  return line.split(/&&|\|\||[;|\n]/).map(one => one.trim().replace(/^(?:\w+=\S*\s+)+/, ''))
}

export function isPushCommand(line: string): boolean {
  return commands(line).some(one => /^git\s+push\b/.test(one) || /^gh\s+pr\s+(?:create|merge)\b/.test(one))
}

// A command that can change which account a push uses, or the remote.
export function isAccountCommand(line: string): boolean {
  return commands(line).some(one => /^gh\s+auth\s+(?:switch|login|logout)\b/.test(one) || /^git\s+remote\b/.test(one))
}

// A GitHub login: letters, digits and hyphens, never a leading hyphen, so it
// can never reach a command as a flag.
export function isLogin(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(name)
}

// The account `gh auth switch` should move to, when switching gh changes
// what a push signs in as and another signed-in account can push.
export function switchTarget(status: AccountGuardStatus | null): string | undefined {
  return status?.state === 'no-access' && status.isGhActive ? status.canPush[0] : undefined
}

export function bandLine(status: AccountGuardStatus): { text: string; isWarning: boolean } {
  if (status.state === 'url-credential') return { text: `GH push uses a credential in the remote URL: ${status.repo}`, isWarning: false }
  if (status.state === 'ssh-unchecked') return { text: 'GH ssh remote: account not checked. /gh-check', isWarning: false }
  if (status.state === 'unknown') return { text: `GH status unknown for ${status.repo}: ${status.reason}`, isWarning: false }
  const from = status.envToken === undefined ? '' : ` (from ${status.envToken})`
  if (status.state === 'ok') return { text: `GH ${status.account}${from} -> ${status.repo}`, isWarning: false }
  const who = status.via === 'ssh' ? `${status.account} (SSH key)` : `${status.account}${from}`
  const [first, ...rest] = status.canPush
  const fix =
    status.envToken !== undefined
      ? `${status.envToken} wins over gh auth switch.`
      : first === undefined
      ? 'No signed-in gh account can.'
      : !status.isGhActive
        ? `Can push: ${status.canPush.join(', ')}.`
        : rest.length > 0
          ? `Also can push: ${rest.join(', ')}.`
          : '' // the switch button names the account

  return { text: `GH ${who} cannot push to ${status.repo}.${fix === '' ? '' : ` ${fix}`}`, isWarning: true }
}
