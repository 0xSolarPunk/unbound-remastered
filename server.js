// Unbound Remastered — a modern viewer for Pokémon Unbound Cloud.
// Node stdlib HTTP server + socket.io-client (Wonder Trade) + sharp (sprite resizing).
// Each visitor logs in with their own Unbound Cloud account; the password is only
// forwarded to unboundcloud.net, and we keep just the returned account token.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { io } from "socket.io-client";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8777);
const HOST = process.env.HOST || "0.0.0.0";
const UPSTREAM = process.env.UPSTREAM || "https://unboundcloud.net";
const TRADE_TIMEOUT_MS = Number(process.env.TRADE_TIMEOUT_MS || 600000);
const SESSION_DAYS = 30;
const DATA_DIR = join(__dirname, "data");
const SPRITE_DIR = join(DATA_DIR, "sprites");
const PUBLIC_DIR = join(__dirname, "public");
await mkdir(SPRITE_DIR, { recursive: true });

// ---------- sessions (token -> { username, accountCode, expires }) ----------
// Security fix: account tokens are held in memory only and are NEVER written to
// disk. A leaked or copied data directory therefore contains no usable tokens,
// and a server restart logs everyone out (they simply sign in again).
const sessions = {};
// Per-session working state (memory only): the Cloud/save snapshot the browser is editing,
// and any running Wonder Trades. token -> { cloud, save, trades }
const state = new Map();
const st = (token) => { if (!state.has(token)) state.set(token, { cloud: null, save: null, trades: new Map() }); return state.get(token); };

function getSession(req) {
  const m = /(?:^|;\s*)ubr_sid=([a-f0-9]{48})/.exec(req.headers.cookie || "");
  const s = m && sessions[m[1]];
  if (!s || s.expires < Date.now()) return null;
  return { token: m[1], ...s };
}
const cacheFile = (username) => join(DATA_DIR, `cache-${username.replace(/[^\w.-]/g, "_")}.json`);

// ---------- helpers ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
};
function send(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  res.writeHead(status, { "content-type": type, ...headers });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
// POST to Unbound Cloud. Always resolves to { ok, status, json } where failures carry a
// human-readable json.errorMsg. Unbound sometimes answers with a bare string, and when it's
// down Cloudflare answers with an HTML error page.
async function upstream(path, payload, timeoutMs = 45000) {
  let r;
  try {
    r = await fetch(UPSTREAM + path, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const msg = e.name === "TimeoutError" ? "Unbound Cloud didn't respond in time — please try again in a minute."
      : "Couldn't reach Unbound Cloud — please try again.";
    return { ok: false, status: 504, json: { errorMsg: msg } };
  }
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (typeof json === "string") json = { errorMsg: json.replace(/^ERROR:\s*/i, "") };
  if (!json || typeof json !== "object") {
    json = { errorMsg: r.status >= 500 || /^\s*</.test(text)
      ? `Unbound Cloud is having trouble right now (error ${r.status}) — please try again in a few minutes.`
      : text.slice(0, 200) || "Unexpected response from Unbound Cloud." };
  }
  return { ok: r.ok && !json.errorMsg, status: r.ok && json.errorMsg ? 400 : r.status, json };
}
const isFilled = (m) => m && m.species && m.species !== "SPECIES_NONE" && Object.keys(m).length > 0;
const fetchCloud = (s) => upstream("/getAccountCloudData", { username: s.username, accountCode: s.accountCode, randomizer: false });

// ---------- sprites: Pokémon HOME renders, resized + cached; pokesprite fallback ----------
const speciesMap = JSON.parse(await readFile(join(PUBLIC_DIR, "species-map.json"), "utf8"));
const FORM_SUFFIX = { a: "alola", g: "galar", h: "hisui", p: "paldea" };
function pokeapiId(species) {
  const parts = species.replace(/^SPECIES_/, "").toLowerCase().split("_");
  const tries = [parts.join("-")];
  if (FORM_SUFFIX[parts.at(-1)]) tries.push([...parts.slice(0, -1), FORM_SUFFIX[parts.at(-1)]].join("-"));
  tries.push(parts[0]);
  for (const t of tries) if (speciesMap[t]) return speciesMap[t];
  const forms = Object.keys(speciesMap).filter((k) => k.startsWith(parts[0] + "-"));
  return forms.length ? Math.min(...forms.map((k) => speciesMap[k])) : null;
}
const inflight = new Map();
async function sprite(species, shiny) {
  const key = `${species}${shiny ? "_s" : ""}`.replace(/[^\w]/g, "");
  const file = join(SPRITE_DIR, key + ".webp");
  try { return await readFile(file); } catch {}
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const id = pokeapiId(species);
    const slug = species.replace(/^SPECIES_/, "").toLowerCase().replace(/_/g, "-");
    const urls = [
      id && `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/${shiny ? "shiny/" : ""}${id}.png`,
      id && `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/${id}.png`,
      `https://raw.githubusercontent.com/msikma/pokesprite/master/pokemon-gen8/${shiny ? "shiny" : "regular"}/${slug}.png`,
      `https://raw.githubusercontent.com/msikma/pokesprite/master/pokemon-gen8/regular/${slug.split("-")[0]}.png`,
    ].filter(Boolean);
    for (const u of urls) {
      const r = await fetch(u).catch(() => null);
      if (!r || !r.ok) continue;
      const out = await sharp(Buffer.from(await r.arrayBuffer())).trim().resize(192, 192, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: u.includes("pokesprite") ? "nearest" : "lanczos3" }).webp({ quality: 82 }).toBuffer();
      await writeFile(file, out);
      return out;
    }
    return null;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

// ---------- cries (PokeAPI/cries, transcoded to MP3 when ffmpeg exists) ----------
const HAS_FFMPEG = await new Promise((r) => execFile("ffmpeg", ["-version"], (e) => r(!e)));

// Cache a derived asset on disk; a ".none" marker remembers misses so we don't refetch.
async function cached(key, ext, produce) {
  const file = join(SPRITE_DIR, key + ext);
  try { return await readFile(file); } catch {}
  try { await readFile(file + ".none"); return null; } catch {}
  if (inflight.has(file)) return inflight.get(file);
  const job = (async () => {
    const out = await produce().catch(() => null);
    await writeFile(out ? file : file + ".none", out || "");
    return out;
  })().finally(() => inflight.delete(file));
  inflight.set(file, job);
  return job;
}
async function getBuf(u) {
  const r = await fetch(u, { headers: { "user-agent": "unbound-remastered" } }).catch(() => null);
  return r && r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}
function cry(species) {
  return cached(species.replace(/[^\w]/g, "") + "_cry", HAS_FFMPEG ? ".mp3" : ".ogg", async () => {
    const id = pokeapiId(species);
    if (!id) return null;
    const ogg = await getBuf(`https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest/${id}.ogg`)
      || await getBuf(`https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/legacy/${id}.ogg`);
    if (!ogg || !HAS_FFMPEG) return ogg;
    return new Promise((resolve) => {
      const p = execFile("ffmpeg", ["-v", "error", "-i", "pipe:0", "-ac", "1", "-b:a", "64k", "-f", "mp3", "pipe:1"],
        { encoding: "buffer", maxBuffer: 8 << 20 }, (e, out) => resolve(e ? ogg : out));
      p.stdin.end(ogg);
    });
  });
}
// ---------- Wonder Trade rules (mirrors unboundcloud.net) ----------
const WT_COOLDOWN_MS = 120000;
const WT_BANNED_ITEMS = new Set(["ITEM_BOTTLE_CAP", "ITEM_GOLD_BOTTLE_CAP", "ITEM_DREAM_MIST", "ITEM_ABILITY_CAPSULE",
  "ITEM_ABILITY_PATCH", "ITEM_MAX_POWDER", "ITEM_WISHING_PIECE", "ITEM_MASTER_BALL", "ITEM_PARK_BALL"]);
const WT_BANNED_CHARS = [..."Œßœºª&+=;¿¡%()…$*▶"];
function wonderTradeBlocker(m) {
  if (!isFilled(m)) return "That slot is empty.";
  if (m.isEgg || m.isBadEgg) return "Eggs can't be Wonder Traded.";
  if (WT_BANNED_ITEMS.has(m.item)) return "It's holding an item that can't be traded.";
  const moves = (m.moves || []).filter((x) => x && x !== "MOVE_NONE");
  if (new Set(moves).size !== moves.length) return "It knows the same move twice, so it can't be traded.";
  if (WT_BANNED_CHARS.some((c) => (m.nickname || "").includes(c) || (m.otName || "").includes(c))) return "Its nickname or OT name has characters that can't be traded.";
  const wait = m.wonderTradeTimestamp ? WT_COOLDOWN_MS - (Date.now() - m.wonderTradeTimestamp) : 0;
  if (wait > 0) return `It just arrived — it can be traded again in ${Math.ceil(wait / 1000)}s.`;
  return null;
}

// One Wonder Trade over socket.io. Disconnecting before "message" cancels it cleanly —
// your Pokémon is only given up once a partner is matched.
function startTradeSocket(username, mon, randomizer, cloudDataSyncKey, job) {
  return new Promise((resolve, reject) => {
    const socket = io(UPSTREAM, { forceNew: true, reconnection: false, timeout: 15000 });
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); socket.close(); fn(arg); };
    const timer = setTimeout(() => finish(reject, new Error("No partner turned up in time — the trade was cancelled and you kept your Pokémon.")), TRADE_TIMEOUT_MS);
    job.cancel = () => finish(reject, Object.assign(new Error("Cancelled — you kept your Pokémon."), { cancelled: true }));
    socket.on("connect", () => {
      socket.emit("tradeType", "WONDER_TRADE", username, cloudDataSyncKey);
      socket.send(mon, randomizer); // socket.io .send() -> "message" event
    });
    socket.on("message", (received, from) => { job.cancel = null; finish(resolve, { received, from }); });
    socket.on("invalidPokemon", () => finish(reject, new Error("Unbound rejected this Pokémon as invalid.")));
    socket.on("invalidCloudDataSyncKey", (msg) => finish(reject, new Error(typeof msg === "string" ? msg : "Your Cloud changed elsewhere — sync and try again.")));
    socket.on("connect_error", (e) => finish(reject, new Error("Couldn't reach the trade server: " + e.message)));
    socket.on("disconnect", () => finish(reject, new Error("Lost connection to the trade server — the trade was cancelled.")));
  });
}

// ---------- storage helpers ----------
const monKey = (m) => JSON.stringify(m);
const sameBoxes = (a, b) => a.length === b.length && a.every((m, i) => monKey(isFilled(m) ? m : {}) === monKey(isFilled(b[i]) ? b[i] : {}));
async function backup(username, label, data) {
  const dir = join(DATA_DIR, "backups", username.replace(/[^\w.-]/g, "_"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`), data);
}
async function saveCloud(s, boxes, titles) {
  const live = await fetchCloud(s); // also yields the fresh sync key Unbound expects
  if (!live.ok) throw new Error("Couldn't reach Unbound Cloud.");
  const saved = await upstream("/saveAccountCloudData", { username: s.username, accountCode: s.accountCode,
    cloudDataSyncKey: live.json.cloudDataSyncKey, homeData: { titles, boxes, randomizer: false, version: 2 } });
  if (!saved.ok) throw new Error(saved.json.errorMsg || "Unbound Cloud refused the save.");
  const fresh = { cloudBoxes: boxes, cloudTitles: titles };
  await writeFile(cacheFile(s.username), JSON.stringify(fresh));
  return live.json;
}
async function encodeSave(sv, boxes) {
  const upd = await upstream("/getUpdatedSaveFile", { newBoxes: boxes, saveFileData: sv.saveFileData.data, fileIdNumber: sv.fileIdNumber });
  if (!upd.ok || !upd.json.newSaveFileData) throw new Error(upd.json.errorMsg || "Unbound couldn't re-encode the save file.");
  return upd.json.newSaveFileData;
}
const firstEmpty = (boxes) => boxes.findIndex((m) => !isFilled(m));

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const body = async () => JSON.parse((await readBody(req)).toString() || "{}");

    if (p === "/api/login" && req.method === "POST") {
      const { username, password } = await body();
      if (!username || !password) return send(res, 400, { error: "Enter your username and password." });
      const up = await upstream("/checkUser", { username: String(username).trim(), password: String(password) });
      if (!up.ok || !up.json.accountCode) {
        const code = up.json.errorMsg || "LOGIN_FAILED";
        const noAcct = "No Unbound Cloud account with that username or email.";
        const msg = { INVALID_PASSWORD: "Wrong password.", USER_NOT_FOUND: noAcct, INVALID_USERNAME: noAcct, NO_ACCOUNT_FOUND: noAcct }[code] || code;
        return send(res, 401, { error: msg });
      }
      if (up.json.activated === false) return send(res, 403, { error: "This account isn't activated yet — activate it on unboundcloud.net first." });
      const token = randomBytes(24).toString("hex");
      sessions[token] = { username: up.json.username, accountCode: up.json.accountCode, expires: Date.now() + SESSION_DAYS * 864e5 };
      // Secure is set only for the public https deployment (SECURE_COOKIES=1);
      // a Secure cookie would never be sent back over plain local http.
      const secureFlag = process.env.SECURE_COOKIES === "1" ? "; Secure" : "";
      return send(res, 200, { username: up.json.username }, undefined, {
        "set-cookie": `ubr_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secureFlag}`,
      });
    }

    if (p.startsWith("/sprite/") && req.method === "GET") {
      const species = decodeURIComponent(p.slice(8)).replace(/\.webp$/, "");
      if (!/^SPECIES_[A-Z0-9_]+$/.test(species)) return send(res, 400, "bad species", "text/plain");
      const img = await sprite(species, url.searchParams.get("shiny") === "1");
      if (!img) return send(res, 404, "no sprite", "text/plain");
      return send(res, 200, img, "image/webp", { "cache-control": "public, max-age=2592000, immutable" });
    }

    if (p.startsWith("/cry/") && req.method === "GET") {
      const species = decodeURIComponent(p.slice(5)).replace(/\.\w+$/, "");
      if (!/^SPECIES_[A-Z0-9_]+$/.test(species)) return send(res, 400, "bad species", "text/plain");
      const buf = await cry(species);
      if (!buf) return send(res, 404, "none", "text/plain");
      const type = buf.subarray(0, 4).toString() === "OggS" ? "audio/ogg" : "audio/mpeg";
      return send(res, 200, buf, type, { "cache-control": "public, max-age=2592000, immutable" });
    }

    if (!p.startsWith("/api/")) {
      const full = join(PUBLIC_DIR, p === "/" ? "index.html" : p);
      if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, "forbidden", "text/plain");
      try { return send(res, 200, await readFile(full), MIME[extname(full)] || "application/octet-stream"); }
      catch { return send(res, 404, "not found", "text/plain"); }
    }

    const s = getSession(req);
    if (p === "/api/me") return send(res, 200, { username: s ? s.username : null });
    if (!s) return send(res, 401, { error: "LOGGED_OUT" });
    const S = st(s.token);

    if (p === "/api/logout" && req.method === "POST") {
      for (const j of S.trades.values()) j.cancel?.();
      delete sessions[s.token]; state.delete(s.token);
      return send(res, 200, { ok: true }, undefined, { "set-cookie": "ubr_sid=; Path=/; Max-Age=0" });
    }

    // Cloud data. Default = instant cached copy; ?live=1 = authoritative pull from Unbound.
    // Whatever we hand out becomes the snapshot that edits/trades are validated against.
    if (p === "/api/data" && req.method === "GET") {
      let d;
      if (url.searchParams.get("live") !== "1") { try { d = JSON.parse(await readFile(cacheFile(s.username), "utf8")); } catch {} }
      if (!d) {
        const up = await fetchCloud(s);
        if (!up.ok) return send(res, 502, { error: up.json.errorMsg || "Couldn't load your Cloud." });
        d = { cloudBoxes: up.json.cloudBoxes, cloudTitles: up.json.cloudTitles };
        await writeFile(cacheFile(s.username), JSON.stringify(d));
      }
      S.cloud = { boxes: d.cloudBoxes, titles: d.cloudTitles, live: url.searchParams.get("live") === "1" };
      return send(res, 200, { cloudBoxes: d.cloudBoxes, cloudTitles: d.cloudTitles });
    }

    // Upload a .sav — parsed by Unbound's own save reader. Also returns the live Cloud.
    if (p === "/api/savefile" && req.method === "POST") {
      const buf = await readBody(req);
      const file = {}; for (let i = 0; i < buf.length; i++) file[i] = buf[i];
      const up = await upstream("/uploadSaveFile", { file, isSaveFile: true, username: s.username, accountCode: s.accountCode });
      if (!up.ok || !up.json.boxes) return send(res, up.status >= 500 ? 502 : 400, { error: up.json.errorMsg || "That doesn't look like a Pokémon Unbound save file." });
      const d = up.json;
      S.save = { boxes: d.boxes, titles: d.titles, gameId: d.gameId, randomizer: !!d.randomizer, fileIdNumber: d.fileIdNumber,
        saveFileData: d.saveFileData, original: buf, newSaveFileData: null, name: url.searchParams.get("name") || "savefile.sav" };
      if (d.cloudBoxes?.length) {
        S.cloud = { boxes: d.cloudBoxes, titles: d.cloudTitles, live: true };
        await writeFile(cacheFile(s.username), JSON.stringify({ cloudBoxes: d.cloudBoxes, cloudTitles: d.cloudTitles }));
      }
      return send(res, 200, { boxes: d.boxes, titles: d.titles, gameId: d.gameId, randomizer: !!d.randomizer,
        cloudBoxes: S.cloud?.boxes, cloudTitles: S.cloud?.titles });
    }

    // Commit moves / swaps / releases / transfers across Cloud and save in one go.
    // The server checks that every Pokémon after the edit existed before it (no duplicates,
    // no tampering) and that the only ones missing are the ones you chose to release.
    if (p === "/api/commit" && req.method === "POST") {
      const { cloudBoxes, saveBoxes, released = 0 } = await body();
      if (!S.cloud || (saveBoxes && !S.save)) return send(res, 409, { expired: true, error: "The server lost track of what you were editing (it may have restarted)." });
      if ([...S.trades.values()].some((j) => j.status === "waiting")) return send(res, 409, { error: "Finish or cancel your Wonder Trade first." });
      const nextCloud = cloudBoxes || S.cloud.boxes, nextSave = saveBoxes || S.save?.boxes || [];
      if (nextCloud.length !== S.cloud.boxes.length || (S.save && nextSave.length !== S.save.boxes.length)) return send(res, 400, { error: "Box layout mismatch — reload and try again." });
      if (S.save?.randomizer && cloudBoxes && saveBoxes) return send(res, 400, { error: "Randomizer saves can't exchange Pokémon with the regular Cloud." });

      const pool = new Map();
      for (const m of [...S.cloud.boxes, ...(S.save?.boxes || [])]) if (isFilled(m)) pool.set(monKey(m), (pool.get(monKey(m)) || 0) + 1);
      for (const m of [...nextCloud, ...nextSave]) {
        if (!isFilled(m)) continue;
        const n = pool.get(monKey(m));
        if (!n) return send(res, 400, { error: "That edit contains a Pokémon that wasn't in your Cloud or save. Nothing was saved." });
        pool.set(monKey(m), n - 1);
      }
      const missing = [...pool.values()].reduce((a, b) => a + b, 0);
      if (missing !== released) return send(res, 400, { error: `Safety check failed (${missing} missing vs ${released} released). Nothing was saved.` });

      // live Cloud must still match what we were editing, or we'd overwrite someone else's changes
      const live = await fetchCloud(s);
      if (!live.ok) return send(res, 502, { error: "Couldn't reach Unbound Cloud." });
      if (!sameBoxes(live.json.cloudBoxes, S.cloud.boxes)) {
        S.cloud = { boxes: live.json.cloudBoxes, titles: live.json.cloudTitles, live: true };
        return send(res, 409, { error: "Your Cloud changed since you loaded it, so nothing was saved. It's been reloaded — please redo your changes.", conflict: true });
      }
      const cloudChanged = !sameBoxes(nextCloud, S.cloud.boxes), saveChanged = S.save && !sameBoxes(nextSave, S.save.boxes);
      let newSave = null;
      if (saveChanged) newSave = await encodeSave(S.save, nextSave); // no side effects yet
      await backup(s.username, "cloud.json", JSON.stringify({ cloudBoxes: S.cloud.boxes, cloudTitles: S.cloud.titles }));
      if (S.save) await backup(s.username, S.save.name.replace(/[^\w.-]/g, "_"), Buffer.from(S.save.saveFileData.data));
      if (cloudChanged) await saveCloud(s, nextCloud, S.cloud.titles);
      S.cloud = { ...S.cloud, boxes: nextCloud };
      if (saveChanged) {
        S.save.boxes = nextSave;
        S.save.saveFileData = newSave;          // further edits build on the new save
        S.save.newSaveFileData = newSave;
      }
      return send(res, 200, { ok: true, cloudChanged, saveChanged: !!saveChanged, downloadReady: !!S.save?.newSaveFileData });
    }

    if (p === "/api/savedownload" && req.method === "GET") {
      const sv = S.save;
      if (!sv?.newSaveFileData) return send(res, 404, "No updated save yet.", "text/plain");
      return send(res, 200, Buffer.from(sv.newSaveFileData.data || sv.newSaveFileData), "application/octet-stream",
        { "content-disposition": `attachment; filename="${sv.name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(sv.name)}` });
    }

    // Is another trainer already waiting in the Wonder Trade pool? (instant match)
    if (p === "/api/wondertrade/check" && req.method === "GET") {
      const up = await upstream("/checkWonderTrade", { username: s.username, randomizer: !!S.save?.randomizer && url.searchParams.get("source") === "save" });
      return send(res, 200, { waiting: !!up.json.waiting });
    }

    // Start a Wonder Trade in the background; poll GET /api/wondertrade/:id, cancel with DELETE.
    if (p === "/api/wondertrade" && req.method === "POST") {
      const { source, index } = await body();
      const store = source === "save" ? S.save : S.cloud;
      if (!store) return send(res, 400, { error: source === "save" ? "Upload a save file first." : "Reload your Cloud first." });
      if ([...S.trades.values()].some((j) => j.status === "waiting")) return send(res, 409, { error: "You already have a Wonder Trade running." });
      const mon = store.boxes[index];
      const blocker = wonderTradeBlocker(mon);
      if (blocker) return send(res, 400, { error: blocker });

      const live = await fetchCloud(s);
      if (!live.ok) return send(res, 502, { error: "Couldn't reach Unbound Cloud." });
      if (source === "cloud" && !sameBoxes(live.json.cloudBoxes, S.cloud.boxes)) {
        S.cloud = { boxes: live.json.cloudBoxes, titles: live.json.cloudTitles, live: true };
        return send(res, 409, { error: "Your Cloud changed elsewhere — it's been reloaded, try again.", conflict: true });
      }
      const id = randomBytes(6).toString("hex");
      const job = { id, source, index, sent: mon, status: "waiting", started: Date.now() };
      S.trades.set(id, job);
      startTradeSocket(s.username, mon, source === "save" ? S.save.randomizer : false, live.json.cloudDataSyncKey, job)
        .then(async ({ received, from }) => {
          received.wonderTradeTimestamp = Date.now();
          job.received = received; job.from = typeof from === "string" ? from : null;
          // Never lose a received Pokémon: keep a copy on disk before anything else.
          await backup(s.username, `wondertrade-${id}.json`, JSON.stringify({ sent: mon, received, from: job.from }));
          try {
            if (source === "cloud") {
              const now = await fetchCloud(s);
              const boxes = now.ok ? now.json.cloudBoxes : S.cloud.boxes, titles = now.ok ? now.json.cloudTitles : S.cloud.titles;
              let at = boxes.findIndex((m) => isFilled(m) && monKey(m) === monKey(mon));
              if (at < 0) at = firstEmpty(boxes);
              if (at < 0) throw new Error("Your Cloud is full, so the new Pokémon couldn't be placed. It's backed up on the server.");
              boxes[at] = received;
              await saveCloud(s, boxes, titles);
              S.cloud = { boxes, titles, live: true };
              job.index = at;
            } else {
              const boxes = S.save.boxes.slice();
              boxes[index] = received;
              const enc = await encodeSave(S.save, boxes);
              S.save.boxes = boxes; S.save.saveFileData = enc; S.save.newSaveFileData = enc;
              job.downloadReady = true;
            }
            job.status = "done";
          } catch (e) { job.status = "error"; job.error = e.message; }
        })
        .catch((e) => { job.status = e.cancelled ? "cancelled" : "error"; job.error = e.message; });
      return send(res, 200, { id, status: job.status });
    }

    const tm = /^\/api\/wondertrade\/([a-f0-9]{12})$/.exec(p);
    if (tm) {
      const job = S.trades.get(tm[1]);
      if (!job) return send(res, 404, { error: "No such trade." });
      if (req.method === "DELETE") { job.cancel?.(); return send(res, 200, { status: job.status }); }
      const { cancel, ...pub } = job;
      return send(res, 200, pub);
    }

    return send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => console.log(`Unbound Remastered → http://${HOST}:${PORT}`));
