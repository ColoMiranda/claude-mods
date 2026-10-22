// The variable gh takes its token from, over every signed-in account.
export type AccountGuardEnvToken = 'GH_TOKEN' | 'GITHUB_TOKEN'

// What the band shows for the session's working directory.
// ok: `account` can push to `repo`. no-access: it cannot; `canPush` lists the
// other signed-in gh accounts that can; `isGhActive` when the push signs in as
// gh's active account (https through gh's credential helper, no user in the
// URL, no token in the env), so `gh auth switch` changes it. `envToken`: the
// account is that variable's token. unknown: the check could not tell.
// url-credential: the remote URL carries its own credential (never kept).
// ssh-unchecked: an ssh remote whose key was not asked yet (/gh-check).
export type AccountGuardStatus =
  | { state: 'ok'; repo: string; account: string; envToken?: AccountGuardEnvToken }
  | { state: 'no-access'; repo: string; account: string; via: 'https' | 'ssh'; isGhActive: boolean; canPush: string[]; envToken?: AccountGuardEnvToken }
  | { state: 'unknown'; repo: string; reason: string }
  | { state: 'url-credential'; repo: string }
  | { state: 'ssh-unchecked'; repo: string }

declare module 'claude-code' {
  interface PluginState {
    // status: null outside a git repo with a GitHub remote.
    // access: whether an account can push to a repo, by "owner/repo@account"
    // (lower case), so a check runs once per pair.
    'account-guard': { status: AccountGuardStatus | null; access: Record<string, boolean> }
  }
}
