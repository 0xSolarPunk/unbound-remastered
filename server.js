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
const TRADE_TIMEOUT_MS = Number(process.env.TRADE_TIMEOUT_MS || 120000);
const SESSION_DAYS = 30;
const DATA_DIR = join(__dirname, "data");
const SPRITE_DIR = join(DATA_DIR, "sprites");
const PUBLIC_DIR = join(__dirname, "public");
await mkdir(SPRITE_DIR, { recursive: true });

// ---------- sessions (token -> { username, accountCode, expires }) ----------
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
let sessions = {};
try { sessions = JSON.parse(await readFile(SESSIONS_FILE, "utf8")); } catch {}
const saveSessions = () => writeFile(SESSIONS_FILE, JSON.stringify(sessions));
const saveFiles = new Map(); // token -> uploaded save session (memory only)

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
async function upstream(path, payload) {
  const r = await fetch(UPSTREAM + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { errorMsg: text }; }
  return { ok: r.ok, status: r.status, json };
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
// ---------- Wonder Trade over socket.io ----------
// Resolves with the received Pokémon. Disconnecting before "message" cancels the
// trade cleanly — your Pokémon is only given up once a partner is matched.
function wonderTrade(username, mon, randomizer, cloudDataSyncKey) {
  return new Promise((resolve, reject) => {
    const socket = io(UPSTREAM, { forceNew: true, reconnection: false, timeout: 15000 });
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); socket.close(); fn(arg); };
    const timer = setTimeout(() => finish(reject, new Error("No trade partner found in time — nothing was traded.")), TRADE_TIMEOUT_MS);
    socket.on("connect", () => {
      socket.emit("tradeType", "WONDER_TRADE", username, cloudDataSyncKey);
      socket.send(mon, randomizer); // socket.io .send() -> "message" event
    });
    socket.on("message", (received) => finish(resolve, received));
    socket.on("invalidPokemon", () => finish(reject, new Error("Unbound rejected this Pokémon for trading.")));
    socket.on("invalidCloudDataSyncKey", () => finish(reject, new Error("Your Cloud changed elsewhere — reload and try again.")));
    socket.on("connect_error", (e) => finish(reject, new Error("Couldn't reach the trade server: " + e.message)));
  });
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (p === "/api/login" && req.method === "POST") {
      const { username, password } = JSON.parse((await readBody(req)).toString() || "{}");
      if (!username || !password) return send(res, 400, { error: "Enter your username and password." });
      const up = await upstream("/checkUser", { username: String(username).trim(), password: String(password) });
      if (!up.ok || !up.json.accountCode) {
        const code = up.json.errorMsg || "LOGIN_FAILED";
        const msg = { INVALID_PASSWORD: "Wrong password.", USER_NOT_FOUND: "No Unbound Cloud account with that name.", INVALID_USERNAME: "No Unbound Cloud account with that name." }[code] || code;
        return send(res, 401, { error: msg });
      }
      if (up.json.activated === false) return send(res, 403, { error: "This account isn't activated yet — activate it on unboundcloud.net first." });
      const token = randomBytes(24).toString("hex");
      sessions[token] = { username: up.json.username, accountCode: up.json.accountCode, expires: Date.now() + SESSION_DAYS * 864e5 };
      await saveSessions();
      return send(res, 200, { username: up.json.username }, undefined, {
        "set-cookie": `ubr_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
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

    if (p.startsWith("/api/")) {
      const s = getSession(req);
      if (p === "/api/me") return s ? send(res, 200, { username: s.username }) : send(res, 401, { error: "LOGGED_OUT" });
      if (!s) return send(res, 401, { error: "LOGGED_OUT" });

      if (p === "/api/logout" && req.method === "POST") {
        delete sessions[s.token]; saveFiles.delete(s.token); await saveSessions();
        return send(res, 200, { ok: true }, undefined, { "set-cookie": "ubr_sid=; Path=/; Max-Age=0" });
      }

      // Cloud data — cached per user; ?live=1 re-pulls from Unbound.
      if (p === "/api/data" && req.method === "GET") {
        if (url.searchParams.get("live") !== "1") {
          try { return send(res, 200, await readFile(cacheFile(s.username), "utf8")); } catch {}
        }
        const up = await fetchCloud(s);
        if (up.ok) await writeFile(cacheFile(s.username), JSON.stringify(up.json));
        return send(res, up.ok ? 200 : 502, up.ok ? up.json : { error: up.json.errorMsg || "Couldn't load your Cloud." });
      }

      // Upload a .sav — parsed by Unbound's own save reader.
      if (p === "/api/savefile" && req.method === "POST") {
        const buf = await readBody(req);
        const file = {}; for (let i = 0; i < buf.length; i++) file[i] = buf[i];
        const up = await upstream("/uploadSaveFile", { file, isSaveFile: true, username: s.username, accountCode: s.accountCode });
        if (!up.ok || !up.json.boxes) return send(res, 400, { error: up.json.errorMsg || "Unsupported save file." });
        const d = up.json;
        saveFiles.set(s.token, { boxes: d.boxes, titles: d.titles, randomizer: !!d.randomizer, fileIdNumber: d.fileIdNumber,
          saveFileData: d.saveFileData, newSaveFileData: null, name: url.searchParams.get("name") || "savefile.sav" });
        return send(res, 200, { boxes: d.boxes, titles: d.titles, gameId: d.gameId, randomizer: !!d.randomizer });
      }

      // Wonder Trade one Pokémon from the Cloud or the uploaded save.
      if (p === "/api/wondertrade" && req.method === "POST") {
        const { source, boxIndex, slotIndex } = JSON.parse((await readBody(req)).toString() || "{}");
        const idx = boxIndex * 30 + slotIndex;
        try {
          const live = await fetchCloud(s); // fresh sync key (+ authoritative boxes for Cloud)
          if (!live.ok) return send(res, 502, { error: "Couldn't reach Unbound Cloud." });
          const { cloudBoxes, cloudTitles, cloudDataSyncKey } = live.json;
          if (source === "cloud") {
            if (!isFilled(cloudBoxes[idx])) return send(res, 400, { error: "That slot is empty." });
            const received = await wonderTrade(s.username, cloudBoxes[idx], false, cloudDataSyncKey);
            cloudBoxes[idx] = received;
            const saved = await upstream("/saveAccountCloudData", { username: s.username, accountCode: s.accountCode, cloudDataSyncKey,
              homeData: { titles: cloudTitles, boxes: cloudBoxes, randomizer: false, version: 2 } });
            if (!saved.ok) return send(res, 502, { error: "Traded, but saving to your Cloud failed.", received });
            await writeFile(cacheFile(s.username), JSON.stringify({ cloudBoxes, cloudTitles, cloudDataSyncKey }));
            return send(res, 200, { received });
          }
          if (source === "save") {
            const sv = saveFiles.get(s.token);
            if (!sv) return send(res, 400, { error: "Upload a save file first." });
            if (!isFilled(sv.boxes[idx])) return send(res, 400, { error: "That slot is empty." });
            const received = await wonderTrade(s.username, sv.boxes[idx], sv.randomizer, cloudDataSyncKey);
            sv.boxes[idx] = received;
            const upd = await upstream("/getUpdatedSaveFile", { newBoxes: sv.boxes, saveFileData: sv.saveFileData?.data, fileIdNumber: sv.fileIdNumber });
            if (!upd.ok || !upd.json.newSaveFileData) return send(res, 502, { error: "Traded, but re-encoding the save failed.", received });
            sv.newSaveFileData = upd.json.newSaveFileData;
            return send(res, 200, { received, downloadReady: true });
          }
          return send(res, 400, { error: "Unknown source." });
        } catch (e) {
          return send(res, 504, { error: e.message });
        }
      }

      if (p === "/api/savedownload" && req.method === "GET") {
        const sv = saveFiles.get(s.token);
        if (!sv?.newSaveFileData) return send(res, 404, "No updated save yet.", "text/plain");
        return send(res, 200, Buffer.from(sv.newSaveFileData.data || sv.newSaveFileData), "application/octet-stream",
          { "content-disposition": `attachment; filename="${sv.name.replace(/"/g, "")}"` });
      }
      return send(res, 404, { error: "Not found" });
    }

    // static files
    const full = join(PUBLIC_DIR, p === "/" ? "index.html" : p);
    if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, "forbidden", "text/plain");
    try { return send(res, 200, await readFile(full), MIME[extname(full)] || "application/octet-stream"); }
    catch { return send(res, 404, "not found", "text/plain"); }
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => console.log(`Unbound Remastered → http://${HOST}:${PORT}`));
