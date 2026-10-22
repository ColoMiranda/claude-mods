declare module 'claude-code' {
  interface PluginState {
    // `lastBlocks`: the fenced code blocks of the last main-loop answer, fences
    // removed, in order. `lastReplies`: for each table of that answer, in order,
    // the lines /reply-table puts in the prompt box, one per row.
    'copy-draft': { lastBlocks: string[]; lastReplies: string[] }
  }
}
