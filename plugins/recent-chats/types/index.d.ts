// A chat of this folder the band offers: its session id (what `/resume`
// takes), the title shown (`/rename`'s, else the auto title, else the last
// prompt), when its transcript was last written (ms since the epoch), and a
// one-line summary of where it stopped once the model wrote one.
export type RecentChat = { id: string; title: string; at: number; summary?: string }

declare module 'claude-code' {
  interface PluginState {
    // chats: the band's offer, newest first; empty once a prompt is sent, a
    // chat is picked, or the session did not start fresh.
    'recent-chats': { chats: RecentChat[] }
  }
}
