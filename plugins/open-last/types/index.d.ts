export type OpenLastServer = {
  // The background Bash task's id.
  taskId: string
  // Normalized for a Link: http://localhost:<port>/<path>.
  url: string
  port: number
  // The pids that began listening on the port after the command started:
  // the only ones `stop` kills.
  pids: string[]
}

declare module 'claude-code' {
  interface PluginState {
    // patch: the last turn's changes as a unified patch file, for `diff`.
    // skipped: the secret files (paths) that turn changed, left out of it.
    // tooLarge: the files (paths) left out of it for their size.
    // patchError: why the latest turn's patch could not be built (the last
    // good one stays), or null.
    'open-last': {
      file: string | null
      servers: OpenLastServer[]
      patch: string | null
      skipped: string[]
      tooLarge: string[]
      patchError: string | null
    }
  }
}
