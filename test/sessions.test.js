import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeLegacySessions, SessionStore } from "../sessions.js";

test("expired sessions are rejected at the expiry boundary and cleaned up once", (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const deleted = [];
  const sessions = new SessionStore((token) => deleted.push(token));
  sessions.set("expired", { accountCode: "fake-token", expires: 1001 });
  assert.equal(sessions.get("expired").accountCode, "fake-token");
  now = 1001;
  assert.equal(sessions.get("expired"), undefined);
  assert.equal(sessions.get("expired"), undefined);
  sessions.delete("expired");
  assert.deepEqual(deleted, ["expired"]);
});

test("sweeping removes idle expired sessions and preserves active ones", (t) => {
  t.mock.method(Date, "now", () => 2000);
  const deleted = [];
  const sessions = new SessionStore((token) => deleted.push(token));
  sessions.set("expired", { expires: 1999 });
  sessions.set("boundary", { expires: 2000 });
  sessions.set("active", { expires: 2001 });
  sessions.sweep();
  sessions.sweep();
  assert.deepEqual(deleted, ["expired", "boundary"]);
  assert.equal(sessions.get("expired"), undefined);
  assert.equal(sessions.get("active").expires, 2001);
  sessions.delete("active");
  assert.equal(sessions.get("active"), undefined);
  assert.deepEqual(deleted, ["expired", "boundary", "active"]);
});

test("migration deletes old credentials, tolerates absence and reports removal failures", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ubr-session-migration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy = join(dir, "sessions.json");
  await writeFile(legacy, '{"old":"fake-secret"}');
  await removeLegacySessions(dir);
  await assert.rejects(access(legacy), { code: "ENOENT" });
  await removeLegacySessions(dir);
  // A directory cannot be unlinked, including when tests run as root.
  await mkdir(legacy);
  await assert.rejects(removeLegacySessions(dir));
});
