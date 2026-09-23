# ဂျင်း-O-Poly (Gyin-O-Poly)

A fully playable, Yangon-themed 2D board game in the browser. Forty tiles wrap a Monopoly-style perimeter: street-food stalls, tea shops, mookata halls, night markets, luxury condos, YBS / Grab / Bolt, and the dreaded village exile.

Burmese UI is first-class. The app loads **Noto Sans Myanmar** (with **Pyidaungsu** as a local fallback) so Myanmar script renders on the board, HUD, and cards.

## Stack

- HTML5 Canvas board renderer
- Vanilla JavaScript (ES modules)
- Modern CSS
- Vite dev server

No accounts, no backend, no build step required beyond Vite.

## Files

| File | Role |
| --- | --- |
| `index.html` | Shell, setup screen, HUD, modals |
| `styles.css` | Teak / jade / gold theme and responsive layout |
| `game.js` | Turns, dice, animation, rent, cards, UI |
| `net.js` | Room client |
| `server/lobbyPlugin.js` | WebSocket lobby on the Vite server |
| `boardData.js` | All tile names, prices, rents, and both card decks |

Rebalance the game by editing `boardData.js` only: `CONFIG`, `TILES`, `GROUPS`, `GYIN_DECK`, and `KYAW_DECK`.

## Run locally

Requires Node.js 18+.

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:43180](http://127.0.0.1:43180).

### Play with others

`npm run dev` starts the board **and** a live lobby (`/ws`).

1. One person opens **အခန်းဖွင့်**, picks a name/colour, and shares the **4-letter room code**.
2. Friends open the **same server URL** (this machine, or `http://<lan-ip>:43180` on the same Wi-Fi).
3. They choose **ဝင်မည်**, enter the code, and wait. Host clicks **စတင်မည်** at 2–4 players.

GitHub Pages is display-only (no lobby server). Use This device for hot-seat, or `npm run dev` / `npm run preview` for joinable rooms.

To publish on GitHub Pages: repo **Settings → Pages → Source: GitHub Actions**, then push `main`. The workflow builds with a relative `base` so the game works at `https://<user>.github.io/<repo>/`.

Production build:

```bash
npm run build
npm run preview
```

## How to play

1. Pick 2–4 players, names, and token colours.
2. On your turn, roll. Tokens walk tile-by-tile. Crossing **လစာဝင်ပြီ** pays **200,000 Ks**.
3. Unowned property can be bought. Landing on an opponent’s tile pays rent.
4. Own a whole colour group to install **Wi-Fi Routers** (up to four) and then a **Generator**.
5. **ဂျင်း** cards are setbacks. **၉ ကျော်တယ်** cards are flexes and cash.
6. **ရွာပြင်ပို့ခံရ** sends you to jail. Pay 50,000 Ks, use a village pass, or wait for doubles (three turns max).
7. Last player who is not bankrupt wins.

Keyboard: `Space` rolls when it is your turn. `Enter` confirms the open modal.

## Transit & utilities

- Transit: YBS, Grab, Bolt, Circular Railway (`ရထားဝိုင်း`)
- Utilities: EPC Meter Bill, YCDC Water Bill

Rent on transit scales with how many of the four you own. Utility rent is dice × 4,000 Ks (or × 10,000 Ks if you own both).

## Licence

Built for local play. Tile names are flavour, not official affiliations.
