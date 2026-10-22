# claude-mods

Personal Claude Code mods.

## Install

```
/plugin marketplace add ColoMiranda/claude-mods
/plugin install team-board@claude-mods
/plugin install open-last@claude-mods
/plugin install copy-draft@claude-mods
/plugin install account-guard@claude-mods
/plugin install recent-chats@claude-mods
/reload-plugins
```

## Mods

- **team-board**: a Team pane for agent teams. One row per agent: working, done, or blocked (red, with the reason). Teammate messages fold to one line in the chat. `/team` shows or hides the pane.
- **open-last**: a band above the prompt with the last file Claude wrote and any local dev server it started. `open` opens it in cmux (else the default app), `diff` shows what Claude changed in the last turn (in any folder, git or not; shell edits too: `sed -i`, `perl -i`, `tee`, `>` and `>>`), and `stop` kills the server. `/open`, `/last-diff` and `/stop-servers` do the same from the prompt (`/diff` is Claude Code's own).
- **account-guard**: silent while the GitHub account a push from this repo would use can push. Otherwise a line above the prompt names that account (gh's active account or GH_TOKEN for https; for ssh, the key's account once you run `/gh-check`). Red when that account cannot push to the repo, with a `switch` button and `/gh-switch` when another signed-in gh account can; a toast when Claude pushes or opens a PR anyway.
- **copy-draft**: a `copy` button under each code block of Claude's answers (`copy 1`, `copy 2` when there are several; terminal), and `/copy-block [n]` to copy a block of the last answer from the prompt. The built-in `/copy` copies the whole answer. A `reply` button under each table puts one line per row in the prompt box (`R22 - `, `R23 - `...: the row's first cell, or its number), under anything you typed, so you write what to do with each row; `/reply-table [n]` does the same from the prompt.
- **recent-chats**: when Claude opens fresh, a band above the prompt lists this folder's last 5 chats: the `/rename` name (else Claude's title, else the last prompt), how long ago, and under it a one-line summary of where that chat stopped. Haiku writes each summary from the end of the chat (a few hundred tokens) and it is kept until that chat changes; only sessions with a person at the prompt call the model, never `-p` runs. Press `1` to `5` in the empty prompt box, or click a row, to resume that chat. When the www mod shows tasks, the chats take the next numbers. Type anything else to start a new chat; the band goes away at the first prompt. Not shown on `claude -c` or `claude -r`. Not listed: chats open in another terminal (two sessions would write one chat), and headless runs (`claude -p`, SDK).

## Develop

```
claude --plugin-dir ./plugins/team-board
claude plugin validate ./plugins/team-board
claude plugin test ./plugins/team-board
```
