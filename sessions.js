import { unlink } from "node:fs/promises";
import { join } from "node:path";

// Upgrades must remove credentials written by older versions. Fail startup if the
// file exists but cannot be removed; never silently leave known tokens on disk.
export async function removeLegacySessions(dataDir) {
  try { await unlink(join(dataDir, "sessions.json")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

export class SessionStore {
  #sessions = new Map();

  constructor(onDelete) { this.onDelete = onDelete; }

  set(token, session) { this.#sessions.set(token, session); }

  get(token) {
    const session = this.#sessions.get(token);
    if (session && session.expires <= Date.now()) {
      this.delete(token);
      return undefined;
    }
    return session;
  }

  delete(token) {
    if (this.#sessions.delete(token)) this.onDelete(token);
  }

  sweep() {
    const now = Date.now();
    for (const [token, session] of this.#sessions) {
      if (session.expires <= now) this.delete(token);
    }
  }
}
