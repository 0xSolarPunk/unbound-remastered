import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

for (const secure of [false, true]) {
  test(`login lifecycle with secure cookies ${secure ? "enabled" : "disabled"}`, { timeout: 30_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ubr-auth-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "public"));
    await mkdir(join(root, "data"));
    for (const file of ["server.js", "sessions.js", "package.json", "public/species-map.json", "public/index.html"]) {
      await copyFile(join(projectDir, file), join(root, file));
    }
    await symlink(await realpath(join(projectDir, "node_modules")), join(root, "node_modules"), "dir");
    const legacyPath = join(root, "data/sessions.json");
    const legacyCookie = `ubr_sid=${"a".repeat(48)}`;
    await writeFile(legacyPath, JSON.stringify({ ["a".repeat(48)]: {
      username: "legacy", accountCode: "old-fake-token", expires: Date.now() + 864e5,
    } }));

    let cloudReads = 0;
    const upstream = http.createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text || "{}");
      res.setHeader("content-type", "application/json");
      if (req.url === "/checkUser") {
        return res.end(JSON.stringify(body.password === "fake-password"
          ? { username: "review_user", accountCode: "fake-account-token", activated: true }
          : { errorMsg: "INVALID_PASSWORD" }));
      }
      if (req.url === "/getAccountCloudData" && body.accountCode === "fake-account-token") {
        cloudReads++;
        return res.end(JSON.stringify({ cloudBoxes: Array.from({ length: 30 }, () => ({})), cloudTitles: ["Review"] }));
      }
      res.writeHead(400); res.end('{}');
    });
    const upstreamPort = await listen(upstream);
    t.after(() => close(upstream));

    let child;
    async function stop() {
      if (!child || child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
      child = null;
    }
    t.after(stop);
    async function start() {
      const probe = http.createServer();
      const port = await listen(probe);
      await close(probe);
      child = spawn(process.execPath, ["server.js"], {
        cwd: root,
        env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", SECURE_COOKIES: secure ? "1" : "",
          UPSTREAM: `http://127.0.0.1:${upstreamPort}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise((resolve, reject) => {
        let errors = "";
        const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 10_000);
        child.stderr.on("data", (data) => { errors += data; });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${errors}`)); });
        child.stdout.on("data", (data) => {
          if (data.toString().includes("Unbound Remastered")) { clearTimeout(timer); resolve(); }
        });
      });
      return `http://127.0.0.1:${port}`;
    }
    let base = await start();
    const login = (password = "fake-password") => fetch(base + "/api/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "review_user", password }),
    });
    const me = async (cookie) => (await fetch(base + "/api/me", { headers: { cookie } })).json();
    assert.deepEqual(await me(legacyCookie), { username: null });
    await assert.rejects(access(legacyPath), { code: "ENOENT" });
    assert.equal((await login("wrong-password")).status, 401);
    const signedIn = await login();
    assert.equal(signedIn.status, 200);
    assert.deepEqual(await signedIn.json(), { username: "review_user" });
    const setCookie = signedIn.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.equal(setCookie.includes("; Secure"), secure);
    const cookie = setCookie.split(";")[0];
    assert.deepEqual(await me(cookie), { username: "review_user" });
    const otherCookie = (await login()).headers.get("set-cookie").split(";")[0];
    assert.notEqual(otherCookie, cookie);
    const data = await fetch(base + "/api/data?live=1", { headers: { cookie } });
    assert.equal(data.status, 200);
    assert.equal((await data.json()).cloudBoxes.length, 30);
    assert.equal(cloudReads, 1);
    const cached = await readFile(join(root, "data/cache-review_user.json"), "utf8");
    assert.doesNotMatch(cached, /fake-account-token|fake-password/);
    const logout = await fetch(base + "/api/logout", { method: "POST", headers: { cookie } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(logout.headers.get("set-cookie").includes("; Secure"), secure);
    assert.deepEqual(await me(cookie), { username: null });
    assert.equal((await fetch(base + "/api/data", { headers: { cookie } })).status, 401);
    assert.deepEqual(await me(otherCookie), { username: "review_user" });
    await assert.rejects(access(legacyPath), { code: "ENOENT" });
    await stop();
    base = await start();
    assert.deepEqual(await me(otherCookie), { username: null });
    assert.equal((await fetch(base + "/api/data", { headers: { cookie: otherCookie } })).status, 401);
    assert.equal((await login()).status, 200);
    await assert.rejects(access(legacyPath), { code: "ENOENT" });
  });
}
