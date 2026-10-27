# Unbound Remastered

A modern, mobile-friendly way to browse your **[Pokémon Unbound](https://www.pokecommunity.com/threads/pok%C3%A9mon-unbound-completed.382178/) Cloud** — inspired by Pokémon HOME.

Sign in with your existing [Unbound Cloud](https://unboundcloud.net/) account and you get the **same Cloud boxes**, just nicer: full-screen PC boxes, HOME-style 3D sprites, instant search across every box, IV/EV breakdowns, save-file support, Wonder Trade, dark mode and a built-in lofi radio.

![PC box](screenshots/box.png)

![Moving Pokémon between a save file and the Cloud](screenshots/transfer.png)

<p align="center">
  <img src="screenshots/mobile-box.png" width="260" alt="Mobile box">
  <img src="screenshots/mobile-summary.png" width="260" alt="Mobile summary">
  <img src="screenshots/mobile-login.png" width="260" alt="Mobile login">
</p>

## Features

- **Your real Cloud** — log in with your Unbound Cloud username/email + password. Everything is read from (and Wonder Trades are written back to) the official Unbound Cloud, so it stays in sync with the original site and the game.
- **PC boxes that fit one screen** — 6×5 on desktop, 5×6 on phones, 10×3 in landscape. No scrolling. Swipe or ←/→ to change boxes, or jump with the box picker. Every box gets its own wallpaper.
- **HOME-style sprites** — 3D renders (shiny variants included), regional forms (Galarian, Alolan, Hisuian…), resized and cached server-side so boxes load fast.
- **Search everything** — name, species, move, nature, item; multi-word (`shiny jolly`). Filter ✨ shiny or 💯 6IV, sort by best IVs / level / species. Results page 30 at a time.
- **Cries & animations** — tap a Pokémon and it hops (shinies burst into sparkles) while its real cry plays; the music ducks underneath. Tap the portrait in the summary to hear it again. Cries can be switched off in the radio menu.
- **Summary card** — IV bars with EVs shaded underneath, nature ▲▼, moves, ball, held item, OT, met data.
- **Save files** — upload a `.sav` and browse it with the same UI (parsed by Unbound Cloud's own save reader).
- **Move Pokémon anywhere** — between your save and your Cloud, or between boxes. On desktop, Save and Cloud sit side by side and you can drag & drop; on phones, use ✋ Arrange (tap to pick up, tap to drop — drop onto a Pokémon to swap). Release Pokémon you don't want. Everything stays local until you press **Save** (with Undo / Discard).
- **Safe saving** — the server verifies nothing was duplicated, altered or lost (other than what you released), refuses to overwrite a Cloud that changed elsewhere, and backs up your Cloud and save before writing. Save-file changes give you an updated `.sav` to put back in your game.
- **Wonder Trade** — from your Cloud *or* a save file. Runs in the background while you browse (cancel anytime and keep your Pokémon), tells you which trainer you traded with, plays a little fanfare and can send a browser notification. A banner tells you when another trainer is already waiting for an instant match. Same eligibility rules as Unbound Cloud (no eggs, untradeable held items, duplicate moves, special characters, or 2-minute post-trade cooldown).
- **Route Radio** 📻 — an original, procedurally generated lofi soundtrack (Web Audio, no audio files): jazzy chords, a soft Game Boy–style lead, boom-bap drums, vinyl crackle, rain and waves. Four stations.
- **Light & dark mode**, installable-feeling mobile layout with a bottom-sheet summary.

| | |
|---|---|
| ![Summary](screenshots/summary.png) | ![Dark mode](screenshots/dark-mode.png) |
| ![Shiny filter](screenshots/shiny-filter.png) | ![Route Radio](screenshots/route-radio.png) |
| ![Save file](screenshots/save-file.png) | ![Login](screenshots/login.png) |

## Run it

Requires Node.js 20+. Optional: `ffmpeg` on the PATH converts cries to MP3 so they play on iPhone/Safari (without it, cries are served as OGG).

```bash
git clone https://github.com/0xSolarPunk/unbound-remastered
cd unbound-remastered
npm install
npm start            # → http://localhost:8777
```

Options (environment variables): `PORT` (default `8777`), `HOST` (default `0.0.0.0`), `TRADE_TIMEOUT_MS` (default `120000`).

### Keep it running with tmux + Tailscale

```bash
./scripts/tmux.sh          # tailscaled (userspace) + the server in a tmux session 'ubr', auto-restarting
tmux respawn-window -k -t ubr:web   # restart the server after pulling changes
```

### Access it from your phone with Tailscale

```bash
tailscale serve --bg 8777
# → https://<machine>.<tailnet>.ts.net, private to your tailnet
```

## How it works

Unbound Cloud's web app is a React SPA backed by a small JSON + Socket.IO API. This project talks to the same endpoints:

| Endpoint | Used for |
|---|---|
| `POST /checkUser` | sign in → account token |
| `POST /getAccountCloudData` | your Cloud boxes, titles and sync key |
| `POST /uploadSaveFile` | parse a `.sav` |
| `POST /getUpdatedSaveFile` | re-encode a `.sav` after a trade |
| `POST /saveAccountCloudData` | write Cloud boxes back after moves / releases / trades |
| `POST /checkWonderTrade` | is a trainer already waiting? |
| Socket.IO `tradeType` / `message` | Wonder Trade |

`server.js` is a single dependency-light Node server (stdlib HTTP + `socket.io-client` + `sharp`). It proxies those calls so the browser never needs CORS, and keeps a per-browser session.

## Privacy & security

- Your password is sent only to `unboundcloud.net` to sign in. It is **never stored**. The server keeps the account token Unbound returns, in `data/sessions.json` (30-day, HttpOnly cookie).
- Cached Cloud data and sessions live in `data/`, which is git-ignored.
- Host it for yourself (or friends you trust): whoever runs the server can see the account tokens of people who sign in.

## Disclaimer

Fan project, not affiliated with Nintendo, Game Freak, The Pokémon Company, or the Pokémon Unbound / Unbound Cloud developers. Pokémon and Pokémon character names are trademarks of Nintendo. Sprites and cries are loaded at runtime from [PokeAPI/sprites](https://github.com/PokeAPI/sprites), [PokeAPI/cries](https://github.com/PokeAPI/cries) and [msikma/pokesprite](https://github.com/msikma/pokesprite); none are bundled. The music is original and generated in code.

License: MIT
