import {
  CONFIG,
  DEFAULT_NAMES,
  GROUPS,
  GYIN_DECK,
  KYAW_DECK,
  PLAYER_PALETTE,
  TILES,
} from "./boardData.js";

const canvas = document.getElementById("board");
const wrap = document.getElementById("board-wrap");
const ctx = canvas.getContext("2d");
const dieEls = [document.getElementById("die-1"), document.getElementById("die-2")];
const btnRoll = document.getElementById("btn-roll");
const btnEnd = document.getElementById("btn-end");
const turnLabel = document.getElementById("turn-label");
const playerList = document.getElementById("player-list");
const inspectBody = document.getElementById("inspect-body");
const logEl = document.getElementById("log");
const modalRoot = document.getElementById("modal-root");
const setupScreen = document.getElementById("setup-screen");
const app = document.getElementById("app");

const PROPERTY_TYPES = new Set(["property", "transit", "utility"]);

const state = {
  players: [],
  current: 0,
  phase: "setup",
  owners: /** @type {Record<number, number|null>} */ ({}),
  upgrades: /** @type {Record<number, number>} */ ({}),
  pot: 0,
  gyin: [],
  kyaw: [],
  gyinDiscard: [],
  kyawDiscard: [],
  lastDice: { d1: 1, d2: 1 },
  doublesStreak: 0,
  selected: null,
  hover: null,
  busy: false,
  layout: null,
  anim: null,
  log: [],
};

let modalResolver = null;
let setupCount = 2;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function formatMMK(n) {
  const value = Math.max(0, Math.round(n));
  return `${value.toLocaleString("en-US")} Ks`;
}

function tileById(id) {
  return TILES[id];
}

function currentPlayer() {
  return state.players[state.current];
}

function alivePlayers() {
  return state.players.filter((p) => !p.broke);
}

function groupColor(groupId) {
  return GROUPS[groupId]?.color ?? "#888";
}

function tilesInGroup(groupId) {
  return TILES.filter((t) => t.group === groupId);
}

function ownsGroup(player, groupId) {
  const tiles = tilesInGroup(groupId);
  return tiles.length > 0 && tiles.every((t) => state.owners[t.id] === player.index);
}

function ownedOfType(player, type) {
  return TILES.filter((t) => t.type === type && state.owners[t.id] === player.index);
}

function ownedProperties(player) {
  return TILES.filter((t) => PROPERTY_TYPES.has(t.type) && state.owners[t.id] === player.index);
}

function minUpgradeInGroup(groupId) {
  return Math.min(...tilesInGroup(groupId).map((t) => state.upgrades[t.id] ?? 0));
}

function canUpgradeTile(player, tile) {
  if (!player || player.broke || tile.type !== "property") return false;
  if (state.phase !== "roll" && state.phase !== "end") return false;
  if (state.owners[tile.id] !== player.index) return false;
  if (!ownsGroup(player, tile.group)) return false;
  const level = state.upgrades[tile.id] ?? 0;
  if (level >= 5) return false;
  if (level > minUpgradeInGroup(tile.group)) return false;
  const cost = GROUPS[tile.group].upgradeCost;
  return player.money >= cost && !state.busy;
}

function rentFor(tile, visitor, diceTotal) {
  const ownerIndex = state.owners[tile.id];
  if (ownerIndex == null) return 0;
  const owner = state.players[ownerIndex];
  if (!owner || owner.broke) return 0;

  if (tile.type === "transit") {
    const n = ownedOfType(owner, "transit").length;
    return tile.rents[Math.max(0, n - 1)];
  }
  if (tile.type === "utility") {
    const n = ownedOfType(owner, "utility").length;
    const mult = n >= 2 ? 10_000 : 4_000;
    return (diceTotal || 7) * mult;
  }
  const level = state.upgrades[tile.id] ?? 0;
  if (level === 0 && ownsGroup(owner, tile.group)) return tile.rentSet;
  return tile.rents[level] ?? tile.rent;
}

function log(message) {
  state.log.unshift(message);
  state.log = state.log.slice(0, 40);
  logEl.innerHTML = state.log.map((line) => `<li>${line}</li>`).join("");
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

function roundRect(context, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + w, y, x + w, y + h, radius);
  context.arcTo(x + w, y + h, x, y + h, radius);
  context.arcTo(x, y + h, x, y, radius);
  context.arcTo(x, y, x + w, y, radius);
  context.closePath();
}

function wrapGlyphs(text, maxWidth, font) {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) return [text];
  const chars = [...text];
  const lines = [];
  let line = "";
  for (const ch of chars) {
    const next = line + ch;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function computeLayout(cssSize) {
  const frame = cssSize * 0.016;
  const board = cssSize - frame * 2;
  const origin = frame;
  const corner = board * 0.136;
  const slot = (board - corner * 2) / 9;
  const rects = [];

  rects[0] = { x: origin + board - corner, y: origin + board - corner, w: corner, h: corner, side: "br" };
  for (let i = 1; i <= 9; i += 1) {
    rects[i] = {
      x: origin + corner + (9 - i) * slot,
      y: origin + board - corner,
      w: slot,
      h: corner,
      side: "bottom",
    };
  }
  rects[10] = { x: origin, y: origin + board - corner, w: corner, h: corner, side: "bl" };
  for (let i = 1; i <= 9; i += 1) {
    rects[10 + i] = {
      x: origin,
      y: origin + corner + (9 - i) * slot,
      w: corner,
      h: slot,
      side: "left",
    };
  }
  rects[20] = { x: origin, y: origin, w: corner, h: corner, side: "tl" };
  for (let i = 1; i <= 9; i += 1) {
    rects[20 + i] = {
      x: origin + corner + (i - 1) * slot,
      y: origin,
      w: slot,
      h: corner,
      side: "top",
    };
  }
  rects[30] = { x: origin + board - corner, y: origin, w: corner, h: corner, side: "tr" };
  for (let i = 1; i <= 9; i += 1) {
    rects[30 + i] = {
      x: origin + board - corner,
      y: origin + corner + (i - 1) * slot,
      w: corner,
      h: slot,
      side: "right",
    };
  }

  return { cssSize, frame, board, origin, corner, slot, rects };
}

function tileCenter(id) {
  const rect = state.layout.rects[id];
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function tokenDrawPos(player, indexOnTile) {
  const base = state.anim?.[player.index] ?? tileCenter(player.position);
  const offsets = [
    [-10, -10],
    [10, -10],
    [-10, 10],
    [10, 10],
  ];
  const [dx, dy] = offsets[indexOnTile % 4];
  return { x: base.x + dx, y: base.y + dy };
}

function resizeCanvas() {
  const cssSize = Math.floor(wrap.clientWidth);
  if (cssSize < 80) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.floor(cssSize * dpr);
  canvas.height = Math.floor(cssSize * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.layout = computeLayout(cssSize);
  drawBoard();
}

function drawBoard() {
  const layout = state.layout;
  if (!layout) return;
  const { cssSize, rects } = layout;

  ctx.clearRect(0, 0, cssSize, cssSize);

  roundRect(ctx, 0, 0, cssSize, cssSize, cssSize * 0.035);
  ctx.fillStyle = "#4a2c12";
  ctx.fill();

  roundRect(ctx, layout.frame * 0.35, layout.frame * 0.35, cssSize - layout.frame * 0.7, cssSize - layout.frame * 0.7, cssSize * 0.03);
  ctx.fillStyle = "#146048";
  ctx.fill();

  const inner = layout.origin + layout.corner;
  const innerSize = layout.board - layout.corner * 2;
  roundRect(ctx, inner + 3, inner + 3, innerSize - 6, innerSize - 6, 12);
  ctx.fillStyle = "#0e4a38";
  ctx.fill();
  ctx.strokeStyle = "rgba(224,177,74,0.28)";
  ctx.lineWidth = 2;
  ctx.stroke();

  TILES.forEach((tile) => drawTile(tile, rects[tile.id]));
  drawTokens();
}

function barRect(rect) {
  const t = Math.min(rect.w, rect.h) * 0.22;
  if (rect.side === "bottom") return { x: rect.x, y: rect.y, w: rect.w, h: t };
  if (rect.side === "top") return { x: rect.x, y: rect.y + rect.h - t, w: rect.w, h: t };
  if (rect.side === "left") return { x: rect.x + rect.w - t, y: rect.y, w: t, h: rect.h };
  if (rect.side === "right") return { x: rect.x, y: rect.y, w: t, h: rect.h };
  return null;
}

function drawTile(tile, rect) {
  const isHover = state.hover === tile.id;
  const isSelected = state.selected === tile.id;
  const current = currentPlayer();
  const isHere = current && !current.broke && current.position === tile.id;

  ctx.save();
  roundRect(ctx, rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, 4);
  ctx.fillStyle = tile.type === "gyin" ? "#3b2218" : tile.type === "kyaw" ? "#1d3d32" : "#f3ead6";
  if (tile.type === "go") ctx.fillStyle = "#e8c96a";
  if (tile.type === "jail") ctx.fillStyle = "#d9c4a3";
  if (tile.type === "safe") ctx.fillStyle = "#cfe7d8";
  if (tile.type === "gotojail") ctx.fillStyle = "#e4b4aa";
  if (tile.type === "tax") ctx.fillStyle = "#efe2c8";
  if (tile.type === "transit") ctx.fillStyle = "#ece6dc";
  if (tile.type === "utility") ctx.fillStyle = "#e4e8ea";
  ctx.fill();

  if (tile.group && GROUPS[tile.group] && (tile.type === "property")) {
    const bar = barRect(rect);
    if (bar) {
      ctx.fillStyle = GROUPS[tile.group].color;
      ctx.fillRect(bar.x + 1, bar.y + 1, bar.w - 2, bar.h - 2);
    }
  }

  ctx.strokeStyle = isSelected ? "#f4d06a" : isHere ? "#2ea572" : isHover ? "#d7a84a" : "rgba(40,24,10,0.45)";
  ctx.lineWidth = isSelected || isHere ? 2.4 : 1;
  roundRect(ctx, rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, 4);
  ctx.stroke();

  drawTileLabel(tile, rect);
  drawOwnership(tile, rect);
  ctx.restore();
}

function drawTileLabel(tile, rect) {
  const isCorner = ["br", "bl", "tl", "tr"].includes(rect.side);
  const color = ["gyin", "kyaw"].includes(tile.type) ? "#f6edd8" : "#1c140c";
  const pad = 4;
  const bar = tile.type === "property" ? barRect(rect) : null;

  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (isCorner) {
    const font = `700 ${Math.max(11, rect.w * 0.12)}px "Noto Sans Myanmar"`;
    const lines = wrapGlyphs(tile.name, rect.w - 12, font);
    ctx.font = font;
    lines.forEach((line, i) => {
      ctx.fillText(line, rect.x + rect.w / 2, rect.y + rect.h * 0.38 + i * 16);
    });
    ctx.font = `600 ${Math.max(9, rect.w * 0.08)}px "Noto Sans"`;
    ctx.fillStyle = "rgba(28,20,12,0.75)";
    ctx.fillText(tile.nameEn, rect.x + rect.w / 2, rect.y + rect.h * 0.78);
    return;
  }

  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const maxW = (rect.side === "bottom" || rect.side === "top" ? rect.w : rect.h) - 8;
  const font = `700 ${Math.max(8, Math.min(rect.w, rect.h) * 0.13)}px "Noto Sans Myanmar"`;
  const lines = wrapGlyphs(tile.name, maxW, font);

  ctx.save();
  if (rect.side === "left") {
    ctx.translate(cx - 4, cy);
    ctx.rotate(-Math.PI / 2);
  } else if (rect.side === "right") {
    ctx.translate(cx + 4, cy);
    ctx.rotate(Math.PI / 2);
  } else if (rect.side === "bottom") {
    ctx.translate(cx, cy + (bar ? 6 : 0));
  } else {
    ctx.translate(cx, cy - (bar ? 6 : 0));
  }

  ctx.font = font;
  ctx.fillStyle = color;
  lines.forEach((line, i) => {
    ctx.fillText(line, 0, (i - (lines.length - 1) / 2) * 12);
  });
  ctx.restore();

  if (tile.price) {
    ctx.save();
    ctx.fillStyle = "#5a4630";
    ctx.font = `700 ${Math.max(8, Math.min(rect.w, rect.h) * 0.1)}px "Noto Sans"`;
    const label = formatMMK(tile.price).replace(" Ks", "");
    if (rect.side === "bottom") ctx.fillText(label, cx, rect.y + rect.h - pad - 6);
    if (rect.side === "top") ctx.fillText(label, cx, rect.y + pad + 8);
    if (rect.side === "left") {
      ctx.translate(rect.x + 10, cy);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(label, 0, 0);
    }
    if (rect.side === "right") {
      ctx.translate(rect.x + rect.w - 10, cy);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(label, 0, 0);
    }
    ctx.restore();
  }
}

function drawOwnership(tile, rect) {
  const ownerIndex = state.owners[tile.id];
  if (ownerIndex == null) return;
  const owner = state.players[ownerIndex];
  if (!owner) return;
  const s = 8;
  let x = rect.x + 4;
  let y = rect.y + 4;
  if (rect.side === "top") y = rect.y + 4;
  if (rect.side === "bottom") y = rect.y + rect.h - s - 4;
  if (rect.side === "left") x = rect.x + 4;
  if (rect.side === "right") x = rect.x + rect.w - s - 4;
  ctx.fillStyle = owner.color;
  ctx.strokeStyle = "#fff8ea";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x + s / 2, y + s / 2, s / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  const level = state.upgrades[tile.id] ?? 0;
  if (!level) return;
  const bar = barRect(rect) ?? rect;
  ctx.fillStyle = level >= 5 ? "#f0c45a" : "#fffaf0";
  if (level >= 5) {
    ctx.beginPath();
    ctx.moveTo(bar.x + bar.w / 2, bar.y + 3);
    ctx.lineTo(bar.x + bar.w / 2 + 5, bar.y + bar.h - 3);
    ctx.lineTo(bar.x + bar.w / 2 - 5, bar.y + bar.h - 3);
    ctx.closePath();
    ctx.fill();
  } else {
    for (let i = 0; i < level; i += 1) {
      const bx = bar.x + 3 + i * 7;
      const by = bar.y + Math.max(2, (bar.h - 6) / 2);
      ctx.fillRect(bx, by, 5, 5);
    }
  }
}

function drawTokens() {
  const groups = new Map();
  state.players.forEach((p) => {
    if (p.broke) return;
    const key = state.anim ? p.index : p.position;
    const list = groups.get(p.position) ?? [];
    list.push(p);
    groups.set(p.position, list);
    void key;
  });

  state.players.forEach((player) => {
    if (player.broke) return;
    const mates = state.players.filter((p) => !p.broke && p.position === player.position);
    const idx = mates.indexOf(player);
    const pos = tokenDrawPos(player, idx);
    ctx.beginPath();
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.arc(pos.x + 1, pos.y + 3, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = player.color;
    ctx.strokeStyle = "#fff8ea";
    ctx.lineWidth = 2;
    ctx.arc(pos.x, pos.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#1c140c";
    ctx.font = '700 10px "Noto Sans Myanmar"';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText([...player.name][0] ?? "?", pos.x, pos.y + 1);
  });
}

function hitTile(x, y) {
  if (!state.layout) return null;
  return TILES.find((t) => {
    const r = state.layout.rects[t.id];
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  })?.id ?? null;
}

function canvasCoords(event) {
  const box = canvas.getBoundingClientRect();
  const size = state.layout.cssSize;
  return {
    x: ((event.clientX - box.left) / box.width) * size,
    y: ((event.clientY - box.top) / box.height) * size,
  };
}

function paintDice(d1, d2) {
  dieEls[0].dataset.value = String(d1);
  dieEls[1].dataset.value = String(d2);
}

async function animateDice() {
  dieEls.forEach((el) => el.classList.add("rolling"));
  const end = performance.now() + 620;
  while (performance.now() < end) {
    paintDice(1 + randInt(6), 1 + randInt(6));
    await wait(70);
  }
  const d1 = 1 + randInt(6);
  const d2 = 1 + randInt(6);
  paintDice(d1, d2);
  dieEls.forEach((el) => el.classList.remove("rolling"));
  return { d1, d2 };
}

async function animateTo(player, fromId, toId) {
  const from = tileCenter(fromId);
  const to = tileCenter(toId);
  const duration = CONFIG.tokenStepMs;
  const start = performance.now();
  return new Promise((resolve) => {
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const e = easeInOut(t);
      state.anim = {
        ...(state.anim ?? {}),
        [player.index]: { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e },
      };
      drawBoard();
      if (t < 1) requestAnimationFrame(tick);
      else {
        if (state.anim) delete state.anim[player.index];
        resolve();
      }
    };
    requestAnimationFrame(tick);
  });
}

async function walk(player, steps, { collectGo = true } = {}) {
  const dir = steps >= 0 ? 1 : -1;
  const n = Math.abs(steps);
  for (let i = 0; i < n; i += 1) {
    const from = player.position;
    const to = (from + dir + CONFIG.boardTiles) % CONFIG.boardTiles;
    await animateTo(player, from, to);
    player.position = to;
    if (collectGo && dir > 0 && to === 0) {
      credit(player, CONFIG.goSalary, { silent: true });
      log(`${player.name} လစာရပြီ — ${formatMMK(CONFIG.goSalary)}`);
    }
    drawBoard();
    updateHUD();
  }
}

async function advanceTo(player, tileId, { collectGo = true } = {}) {
  if (player.position === tileId) return;
  let steps = (tileId - player.position + CONFIG.boardTiles) % CONFIG.boardTiles;
  if (steps === 0) steps = CONFIG.boardTiles;
  await walk(player, steps, { collectGo });
}

function credit(player, amount, { silent = false } = {}) {
  player.money += amount;
  if (!silent) updateHUD();
}

function sellUpgrades(player) {
  const props = ownedProperties(player)
    .filter((t) => (state.upgrades[t.id] ?? 0) > 0)
    .sort((a, b) => (state.upgrades[b.id] ?? 0) - (state.upgrades[a.id] ?? 0));
  for (const tile of props) {
    const level = state.upgrades[tile.id] ?? 0;
    if (!level) continue;
    const cost = GROUPS[tile.group]?.upgradeCost ?? 0;
    state.upgrades[tile.id] = level - 1;
    player.money += Math.floor(cost / 2);
  }
}

async function bankrupt(player, creditor) {
  player.broke = true;
  player.inJail = false;
  log(`${player.name} ဒေဝါလီခံပြီ။`);
  const props = ownedProperties(player);
  for (const tile of props) {
    if (creditor && !creditor.broke) {
      state.owners[tile.id] = creditor.index;
    } else {
      state.owners[tile.id] = null;
      state.upgrades[tile.id] = 0;
    }
  }
  if (creditor && !creditor.broke) {
    creditor.money += player.money;
    creditor.jailPasses += player.jailPasses;
  }
  player.money = 0;
  player.jailPasses = 0;
  updateHUD();
  drawBoard();
  const alive = alivePlayers();
  if (alive.length === 1) {
    await endGame(alive[0]);
  }
}

async function charge(player, amount, { toPlayer = null, toPot = false, reason = "" } = {}) {
  if (amount <= 0) return true;
  if (player.money < amount) sellUpgrades(player);
  if (player.money >= amount) {
    player.money -= amount;
    if (toPlayer) toPlayer.money += amount;
    else if (toPot) state.pot += amount;
    if (reason) log(reason);
    updateHUD();
    return true;
  }
  const paid = player.money;
  if (toPlayer) toPlayer.money += paid;
  else if (toPot) state.pot += paid;
  player.money = 0;
  await bankrupt(player, toPlayer);
  return false;
}

function openModal({ kicker = "", title, body, accent = "#e0b14a", buttons }) {
  return new Promise((resolve) => {
    modalResolver = resolve;
    document.getElementById("modal-kicker").textContent = kicker;
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-body").innerHTML = body;
    document.getElementById("modal-accent").style.background = accent;
    const actions = document.getElementById("modal-actions");
    actions.innerHTML = "";
    buttons.forEach((btn, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `btn ${btn.className ?? ""}`.trim();
      el.textContent = btn.label;
      el.disabled = Boolean(btn.disabled);
      el.addEventListener("click", () => closeModal(btn.value));
      actions.appendChild(el);
      if (i === 0) queueMicrotask(() => el.focus());
    });
    modalRoot.hidden = false;
  });
}

function closeModal(value) {
  modalRoot.hidden = true;
  const resolve = modalResolver;
  modalResolver = null;
  resolve?.(value);
}

async function endGame(winner) {
  state.phase = "over";
  state.busy = false;
  btnRoll.disabled = true;
  btnEnd.hidden = true;
  turnLabel.textContent = `${winner.name} နိုင်ပြီ`;
  await openModal({
    kicker: "Game Over",
    title: `${winner.name} ၉ ကျော်တယ်`,
    accent: winner.color,
    body: `<p>${winner.name} သည် ရန်ကုန်မြေရှင် ဖြစ်သွားပြီ။ လက်ကျန်ငွေ ${formatMMK(winner.money)}။</p>`,
    buttons: [
      { label: "နောက်ဂိမ်း", className: "primary", value: "again" },
      { label: "ပိတ်မည်", value: "close" },
    ],
  });
  showSetup();
}

function setPhase(phase) {
  state.phase = phase;
  const player = currentPlayer();
  const canAct = !state.busy && !player?.broke && state.phase !== "over";
  btnRoll.disabled = !(canAct && phase === "roll");
  btnEnd.hidden = !(canAct && phase === "end");
  if (!player) return;
  if (phase === "roll") {
    turnLabel.textContent = player.inJail
      ? `${player.name} ရွာပြင်မှာ — ထွက်မလား?`
      : `${player.name} အန်စာတုံးလှည့်ပါ`;
    btnRoll.textContent = player.inJail ? "ရွာပြင်က ထွက်မည်" : "အန်စာတုံးလှည့်";
  } else if (phase === "end") {
    turnLabel.textContent = `${player.name} — မြေတိုးတက်အောင်လုပ် သို့မဟုတ် အလှည့်ပိတ်ပါ`;
  }
}

function updateHUD() {
  const player = currentPlayer();
  playerList.innerHTML = state.players
    .map((p) => {
      const props = ownedProperties(p);
      const chips = props
        .map((t) => {
          const color = t.group ? groupColor(t.group) : "#888";
          const up = state.upgrades[t.id] ?? 0;
          const mark = up >= 5 ? " ⚡" : up ? ` ${"▂".repeat(up)}` : "";
          return `<button type="button" data-tile="${t.id}" style="background:${color};color:${t.group === "golden-mile" || t.group === "transit" ? "#fff" : "#1c140c"}">${t.nameEn}${mark}</button>`;
        })
        .join("");
      const flags = [
        p.broke ? "ဒေဝါလီ" : "",
        p.inJail ? "ရွာပြင်" : "",
        p.skipNext ? "ကျော်ရမည်" : "",
        p.jailPasses ? `လွတ်ကတ် ×${p.jailPasses}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `<article class="player-card ${p.index === state.current ? "active" : ""} ${p.broke ? "broke" : ""}">
        <span class="token-dot" style="--token:${p.color};background:${p.color}"></span>
        <div>
          <h4>${p.name}</h4>
          <p class="meta">${p.colorLabel} · ကွက် ${p.position}${flags ? ` · ${flags}` : ""}</p>
          <div class="owned">${chips || "<span class='meta'>ပိုင်ဆိုင်မှု မရှိသေး</span>"}</div>
        </div>
        <div class="money">${formatMMK(p.money)}</div>
      </article>`;
    })
    .join("");

  playerList.querySelectorAll("button[data-tile]").forEach((btn) => {
    btn.addEventListener("click", () => selectTile(Number(btn.dataset.tile)));
  });

  if (state.selected != null) renderInspect(state.selected);
  if (player) {
    turnLabel.style.color = player.color;
  }
}

function renderInspect(id) {
  const tile = tileById(id);
  const ownerIndex = state.owners[id];
  const owner = ownerIndex != null ? state.players[ownerIndex] : null;
  const group = tile.group ? GROUPS[tile.group] : null;
  const player = currentPlayer();
  const level = state.upgrades[id] ?? 0;
  const upgradeLabels = ["မရှိ", "Wi-Fi ×1", "Wi-Fi ×2", "Wi-Fi ×3", "Wi-Fi ×4", "Generator"];

  let extra = "";
  if (tile.type === "property" && tile.rents) {
    extra = `<table class="rent-table">
      <tr><td>အခြေခံငှားရမ်းခ</td><td>${formatMMK(tile.rent)}</td></tr>
      <tr><td>အရောင်အစုံ</td><td>${formatMMK(tile.rentSet)}</td></tr>
      ${tile.rents
        .slice(1)
        .map((r, i) => `<tr><td>${upgradeLabels[i + 1]}</td><td>${formatMMK(r)}</td></tr>`)
        .join("")}
      <tr><td>Wi-Fi / Generator ကုန်ကျ</td><td>${formatMMK(group?.upgradeCost ?? 0)}</td></tr>
    </table>`;
  } else if (tile.type === "transit") {
    extra = `<table class="rent-table">${tile.rents
      .map((r, i) => `<tr><td>ယာဉ် ${i + 1} စင်း</td><td>${formatMMK(r)}</td></tr>`)
      .join("")}</table>`;
  } else if (tile.type === "utility") {
    extra = `<p>၁ ခုပိုင်ရင် အန်စာတုံး × ၄,၀၀၀။ ၂ ခုပိုင်ရင် × ၁၀,၀၀၀။</p>`;
  } else if (tile.subtitle) {
    extra = `<p>${tile.subtitle}</p>`;
  }

  const canUp = player && canUpgradeTile(player, tile);
  inspectBody.innerHTML = `<div class="inspect-card">
    <div class="swatch" style="background:${group?.color ?? "#e0b14a"}"></div>
    <h4>${tile.name}</h4>
    <p class="en">${tile.nameEn}${group ? ` · ${group.labelEn}` : ""}</p>
    <p>${tile.price ? `ဈေး ${formatMMK(tile.price)}` : tile.amount ? `ပေးရန် ${formatMMK(tile.amount)}` : ""}</p>
    <p>${owner ? `ပိုင်ရှင်: ${owner.name} · ${upgradeLabels[level]}` : PROPERTY_TYPES.has(tile.type) ? "ပိုင်ရှင်မရှိ" : ""}</p>
    ${state.pot && tile.type === "safe" ? `<p>လက်ရှိအိုး: ${formatMMK(state.pot)}</p>` : ""}
    ${extra}
    ${canUp ? `<button type="button" class="btn gold" id="btn-upgrade" style="margin-top:0.6rem">တိုးတက်အောင်လုပ် (${formatMMK(group.upgradeCost)})</button>` : ""}
  </div>`;

  const upBtn = document.getElementById("btn-upgrade");
  if (upBtn) upBtn.addEventListener("click", () => upgradeTile(tile));
}

function selectTile(id) {
  state.selected = id;
  renderInspect(id);
  drawBoard();
}

function upgradeTile(tile) {
  const player = currentPlayer();
  if (!canUpgradeTile(player, tile)) return;
  const cost = GROUPS[tile.group].upgradeCost;
  player.money -= cost;
  state.upgrades[tile.id] = (state.upgrades[tile.id] ?? 0) + 1;
  const level = state.upgrades[tile.id];
  log(
    `${player.name} က ${tile.name} ကို ${level >= 5 ? "Generator" : "Wi-Fi Router"} တပ်လိုက်တယ်။`,
  );
  updateHUD();
  drawBoard();
}

function refill(kind) {
  if (kind === "gyin" && state.gyin.length === 0) {
    state.gyin = shuffle(state.gyinDiscard);
    state.gyinDiscard = [];
  }
  if (kind === "kyaw" && state.kyaw.length === 0) {
    state.kyaw = shuffle(state.kyawDiscard);
    state.kyawDiscard = [];
  }
}

function drawCard(kind) {
  refill(kind);
  const pile = kind === "gyin" ? state.gyin : state.kyaw;
  const discard = kind === "gyin" ? state.gyinDiscard : state.kyawDiscard;
  const card = pile.pop();
  if (card.effect.type !== "jailPass") discard.unshift(card);
  return card;
}

async function applyEffect(player, card) {
  const effect = card.effect;
  switch (effect.type) {
    case "pay":
      await charge(player, effect.amount, {
        toPot: true,
        reason: `${player.name} ${formatMMK(effect.amount)} ပေးလိုက်တယ်။`,
      });
      break;
    case "collect":
      credit(player, effect.amount);
      log(`${player.name} ${formatMMK(effect.amount)} ရတယ်။`);
      break;
    case "collectFromEach": {
      let total = 0;
      for (const other of alivePlayers()) {
        if (other.index === player.index) continue;
        const ok = await charge(other, effect.amount, { toPlayer: player });
        if (ok) total += effect.amount;
        if (state.phase === "over") return;
      }
      log(`${player.name} အားလုံးဆီက ${formatMMK(total)} ကောက်တယ်။`);
      break;
    }
    case "payEach": {
      for (const other of alivePlayers()) {
        if (other.index === player.index) continue;
        await charge(player, effect.amount, { toPlayer: other });
        if (player.broke || state.phase === "over") return;
      }
      break;
    }
    case "skip":
      player.skipNext = true;
      log(`${player.name} နောက်အလှည့် ကျော်ရမယ်။`);
      break;
    case "gotoJail":
      await sendToJail(player);
      break;
    case "moveRelative":
      await walk(player, effect.steps, { collectGo: effect.steps > 0 });
      if (!player.inJail) await resolveTile(player, state.lastDice);
      break;
    case "moveTo":
      await advanceTo(player, effect.tileId, { collectGo: Boolean(effect.collectGo) });
      if (effect.tileId === 10 && card.id === "village-bus") return;
      if (!player.inJail) await resolveTile(player, state.lastDice);
      break;
    case "nearest": {
      let i = (player.position + 1) % CONFIG.boardTiles;
      while (TILES[i].type !== effect.kind) i = (i + 1) % CONFIG.boardTiles;
      await advanceTo(player, i, { collectGo: true });
      await resolveTile(player, state.lastDice);
      break;
    }
    case "jailPass":
      player.jailPasses += 1;
      log(`${player.name} ရွာပြင်လွတ်ကတ် ရပြီ။`);
      break;
    case "repairs": {
      let bill = 0;
      ownedProperties(player).forEach((t) => {
        const level = state.upgrades[t.id] ?? 0;
        if (level >= 5) bill += effect.generator;
        else bill += level * effect.router;
      });
      await charge(player, bill, {
        toPot: true,
        reason: `${player.name} ပြုပြင်ခ ${formatMMK(bill)} ပေးတယ်။`,
      });
      break;
    }
    case "freeRouter": {
      const candidate = ownedProperties(player).find((t) => {
        const level = state.upgrades[t.id] ?? 0;
        return (
          t.type === "property" &&
          ownsGroup(player, t.group) &&
          level < 4 &&
          level <= minUpgradeInGroup(t.group)
        );
      });
      if (candidate) {
        state.upgrades[candidate.id] = (state.upgrades[candidate.id] ?? 0) + 1;
        log(`${player.name} ${candidate.name} မှာ Wi-Fi အလကား တပ်တယ်။`);
      } else {
        credit(player, 40_000);
        log(`${player.name} Wi-Fi တပ်စရာမရှိလို့ ၄၀,၀၀၀ ကျပ် ယူတယ်။`);
      }
      break;
    }
    default:
      break;
  }
}

async function sendToJail(player) {
  player.position = 10;
  player.inJail = true;
  player.jailTurns = 0;
  state.doublesStreak = 0;
  state.anim = null;
  log(`${player.name} ရွာပြင်ပို့ခံရတယ်။`);
  drawBoard();
  await openModal({
    kicker: "ရွာပြင်",
    title: "ရွာပြင်ပို့ခံရ",
    accent: "#c44536",
    body: `<p>${player.name} ကို ရွာပြင်ပို့လိုက်ပြီ။ လစာမရ။ ဒဏ်ကြေးပေး၊ လွတ်ကတ်သုံး၊ သို့မဟုတ် ဒိုင်ဗယ်စောင့်။</p>`,
    buttons: [{ label: "နားလည်ပြီ", className: "primary", value: "ok" }],
  });
}

async function resolveTile(player, dice) {
  if (player.broke || state.phase === "over") return;
  const tile = tileById(player.position);
  selectTile(tile.id);

  if (tile.type === "go") {
    await openModal({
      kicker: tile.nameEn,
      title: tile.name,
      accent: "#e0b14a",
      body: `<p>လစာကွက်။ ဖြတ်သွားရင် ${formatMMK(CONFIG.goSalary)} ရတယ်။</p>`,
      buttons: [{ label: "ကောင်းပြီ", className: "primary", value: "ok" }],
    });
    return;
  }

  if (tile.type === "safe") {
    const pot = state.pot;
    state.pot = 0;
    if (pot > 0) {
      credit(player, pot);
      log(`${player.name} မီးပြန်လာလို့ အိုးထဲက ${formatMMK(pot)} ယူတယ်။`);
    }
    await openModal({
      kicker: "Safe Zone",
      title: tile.name,
      accent: "#2ea572",
      body: `<p>မီးလာပြီဟေ့ — ခဏနား။ ${pot ? `အိုးထဲက ${formatMMK(pot)} ရတယ်။` : "အိုးထဲမှာ ဘာမှမရှိ။"}</p>`,
      buttons: [{ label: "နားလိုက်မယ်", className: "primary", value: "ok" }],
    });
    return;
  }

  if (tile.type === "jail") {
    await openModal({
      kicker: "Just visiting",
      title: tile.name,
      body: `<p>ရွာပြင်ကို ဖြတ်ကြည့်တာပါ။ အထဲရောက်တာ မဟုတ်သေးဘူး။</p>`,
      buttons: [{ label: "ရှေ့ဆက်", className: "primary", value: "ok" }],
    });
    return;
  }

  if (tile.type === "gotojail") {
    await sendToJail(player);
    return;
  }

  if (tile.type === "tax") {
    await charge(player, tile.amount, {
      toPot: true,
      reason: `${player.name} ${tile.name} ${formatMMK(tile.amount)} ပေးတယ်။`,
    });
    if (!player.broke) {
      await openModal({
        kicker: tile.nameEn,
        title: tile.name,
        accent: "#c44536",
        body: `<p class="price-line">− ${formatMMK(tile.amount)}</p><p>အခွန်က အိုးထဲကို ဝင်တယ်။ မီးလာပြီဟေ့ ကွက်မှာ ပြန်ယူလို့ရ။</p>`,
        buttons: [{ label: "ပေးလိုက်ပြီ", className: "primary", value: "ok" }],
      });
    }
    return;
  }

  if (tile.type === "gyin" || tile.type === "kyaw") {
    const kind = tile.type === "gyin" ? "gyin" : "kyaw";
    const card = drawCard(kind);
    const accent = kind === "gyin" ? "#c44536" : "#2ea572";
    await openModal({
      kicker: kind === "gyin" ? "ဂျင်း ကတ်" : "၉ ကျော်တယ် ကတ်",
      title: card.title,
      accent,
      body: `<p class="en" style="color:var(--gold);font-family:var(--latin)">${card.titleEn}</p><p>${card.body}</p>`,
      buttons: [{ label: "ကတ်ဖွင့်", className: "primary", value: "ok" }],
    });
    await applyEffect(player, card);
    return;
  }

  if (PROPERTY_TYPES.has(tile.type)) {
    const ownerIndex = state.owners[tile.id];
    if (ownerIndex == null) {
      const canBuy = player.money >= tile.price;
      const choice = await openModal({
        kicker: tile.nameEn,
        title: tile.name,
        accent: groupColor(tile.group),
        body: `<p>${GROUPS[tile.group]?.label ?? ""} · ${GROUPS[tile.group]?.labelEn ?? ""}</p>
          <p class="price-line">${formatMMK(tile.price)}</p>
          <p>${canBuy ? "ဒီကွက်ကို ဝယ်မလား။" : "ပိုက်ဆံမလောက်သေးလို့ ဝယ်လို့မရ။"}</p>`,
        buttons: [
          { label: "ဝယ်မည်", className: "primary", value: "buy", disabled: !canBuy },
          { label: "ကျော်မည်", value: "pass" },
        ],
      });
      if (choice === "buy" && player.money >= tile.price) {
        player.money -= tile.price;
        state.owners[tile.id] = player.index;
        log(`${player.name} ${tile.name} ကို ${formatMMK(tile.price)} နဲ့ ဝယ်တယ်။`);
        updateHUD();
        drawBoard();
      } else {
        log(`${player.name} ${tile.name} ကို ကျော်လိုက်တယ်။`);
      }
      return;
    }

    const owner = state.players[ownerIndex];
    if (owner.index === player.index) {
      const up = canUpgradeTile(player, tile);
      const choice = await openModal({
        kicker: "ကိုယ်ပိုင်ကွက်",
        title: tile.name,
        accent: groupColor(tile.group),
        body: `<p>ကိုယ်ပိုင်မြေပေါ် ရောက်နေတယ်။ ${up ? "Wi-Fi Router သို့မဟုတ် Generator တပ်နိုင်တယ်။" : ownsGroup(player, tile.group) ? "ဒီအရောင်မှာ အဆင့်တူအောင် အရင်တပ်ပါ။" : "အရောင်အစုံပိုင်မှ တိုးတက်အောင်လုပ်လို့ရတယ်။"}</p>`,
        buttons: up
          ? [
              { label: `တပ်မည် (${formatMMK(GROUPS[tile.group].upgradeCost)})`, className: "gold", value: "up" },
              { label: "ထားမည်", value: "skip" },
            ]
          : [{ label: "ကောင်းပြီ", className: "primary", value: "ok" }],
      });
      if (choice === "up") upgradeTile(tile);
      return;
    }

    if (owner.broke || owner.inJail) {
      await openModal({
        kicker: "ငှားရမ်းခ မယူ",
        title: tile.name,
        body: `<p>${owner.name} ရွာပြင်မှာ/ဒေဝါလီဖြစ်နေလို့ ငှားရမ်းခ မပေးရ။</p>`,
        buttons: [{ label: "ကံကောင်းတယ်", className: "primary", value: "ok" }],
      });
      return;
    }

    const rent = rentFor(tile, player, dice.d1 + dice.d2);
    await openModal({
      kicker: "Rent",
      title: `${tile.name} ငှားရမ်းခ`,
      accent: groupColor(tile.group),
      body: `<p>${owner.name} ပိုင်တယ်။</p><p class="price-line">${formatMMK(rent)}</p>`,
      buttons: [{ label: "ပေးမည်", className: "danger", value: "pay" }],
    });
    await charge(player, rent, {
      toPlayer: owner,
      reason: `${player.name} က ${owner.name} ကို ငှားရမ်းခ ${formatMMK(rent)} ပေးတယ်။`,
    });
  }
}

async function handleJail(player) {
  const mustPay = player.jailTurns >= CONFIG.jailMaxTurns;
  const buttons = [];
  if (player.jailPasses > 0 && !mustPay) {
    buttons.push({ label: "လွတ်ကတ်သုံး", className: "gold", value: "pass" });
  }
  if (player.money >= CONFIG.jailFine || mustPay) {
    buttons.push({
      label: `ဒဏ်ကြေး ${formatMMK(CONFIG.jailFine)}`,
      className: "primary",
      value: "pay",
      disabled: player.money < CONFIG.jailFine && !mustPay,
    });
  }
  if (!mustPay) buttons.push({ label: "ဒိုင်ဗယ်စမ်း", value: "roll" });
  if (!buttons.length) {
    buttons.push({ label: "ဒိုင်ဗယ်စမ်း", value: "roll" });
  }

  const choice = await openModal({
    kicker: `Jail turn ${player.jailTurns + 1}/${CONFIG.jailMaxTurns}`,
    title: "ရွာပြင်ရောက်မယ်",
    accent: "#c44536",
    body: `<p>${mustPay ? "သုံးကြိမ်ပြည့်ပြီ။ ဒဏ်ကြေးပေးပြီး ထွက်ရမယ်။" : "ဒဏ်ကြေးပေး၊ လွတ်ကတ်သုံး၊ သို့မဟုတ် ဒိုင်ဗယ်ကျမှ ထွက်။"}</p>`,
    buttons,
  });

  if (choice === "pass") {
    player.jailPasses -= 1;
    state.kyawDiscard.unshift(KYAW_DECK.find((c) => c.id === "village-pass"));
    player.inJail = false;
    log(`${player.name} လွတ်ကတ်သုံးပြီး ရွာပြင်က ထွက်တယ်။`);
    setPhase("roll");
    btnRoll.textContent = "အန်စာတုံးလှည့်";
    return false;
  }

  if (choice === "pay") {
    const ok = await charge(player, CONFIG.jailFine, {
      toPot: true,
      reason: `${player.name} ရွာပြင်ဒဏ်ကြေး ပေးတယ်။`,
    });
    if (!ok) return true;
    player.inJail = false;
    setPhase("roll");
    btnRoll.textContent = "အန်စာတုံးလှည့်";
    return false;
  }

  const dice = await animateDice();
  state.lastDice = dice;
  if (dice.d1 === dice.d2) {
    player.inJail = false;
    log(`${player.name} ဒိုင်ဗယ်ကျလို့ ရွာပြင်က ထွက်တယ်။`);
    await walk(player, dice.d1 + dice.d2);
    await resolveTile(player, dice);
    afterResolve(player, dice, { fromJail: true });
    return true;
  }

  player.jailTurns += 1;
  log(`${player.name} ဒိုင်ဗယ်မကျ — ရွာပြင်မှာ ဆက်နေရသေးတယ်။`);
  if (player.jailTurns >= CONFIG.jailMaxTurns) {
    const ok = await charge(player, CONFIG.jailFine, { toPot: true });
    if (!ok) return true;
    player.inJail = false;
    await walk(player, dice.d1 + dice.d2);
    await resolveTile(player, dice);
    afterResolve(player, dice);
    return true;
  }
  finishTurn();
  return true;
}

function afterResolve(player, dice, { fromJail = false } = {}) {
  if (player.broke || state.phase === "over") return;
  if (player.inJail) {
    finishTurn();
    return;
  }
  if (!fromJail && dice.d1 === dice.d2) {
    state.doublesStreak += 1;
    log(`${player.name} ဒိုင်ဗယ်ကျ — နောက်ထပ်တစ်ခါ လှည့်။`);
    setPhase("roll");
    btnRoll.textContent = "ထပ်လှည့် (ဒိုင်ဗယ်)";
    return;
  }
  state.doublesStreak = 0;
  setPhase("end");
}

function nextAlive(from) {
  let i = from;
  for (let n = 0; n < state.players.length; n += 1) {
    i = (i + 1) % state.players.length;
    if (!state.players[i].broke) return i;
  }
  return from;
}

function finishTurn() {
  if (state.phase === "over") return;
  state.doublesStreak = 0;
  state.current = nextAlive(state.current);
  const player = currentPlayer();
  updateHUD();
  drawBoard();
  if (player.skipNext) {
    player.skipNext = false;
    log(`${player.name} ဒီအလှည့် ကျော်ရတယ်။`);
    turnLabel.textContent = `${player.name} ပလပ်ကျွတ် — အလှည့်ကျော်`;
    setTimeout(() => finishTurn(), 650);
    return;
  }
  setPhase("roll");
}

async function playRoll() {
  const player = currentPlayer();
  if (!player || state.busy || state.phase !== "roll" || player.broke) return;
  state.busy = true;
  btnRoll.disabled = true;
  try {
    if (player.inJail) {
      const handled = await handleJail(player);
      if (handled) return;
    }
    const dice = await animateDice();
    state.lastDice = dice;
    if (dice.d1 === dice.d2 && state.doublesStreak + 1 >= 3) {
      log(`${player.name} ဒိုင်ဗယ် သုံးကြိမ်ဆက် — ရွာပြင်ပို့ခံရ။`);
      await sendToJail(player);
      finishTurn();
      return;
    }
    await walk(player, dice.d1 + dice.d2);
    await resolveTile(player, dice);
    afterResolve(player, dice);
  } finally {
    state.busy = false;
    if (state.phase === "roll") setPhase("roll");
    if (state.phase === "end") setPhase("end");
    updateHUD();
    drawBoard();
  }
}

function createPlayers(entries) {
  return entries.map((entry, index) => ({
    index,
    name: entry.name.trim(),
    color: entry.color,
    colorLabel: entry.colorLabel,
    money: CONFIG.startMoney,
    position: 0,
    inJail: false,
    jailTurns: 0,
    jailPasses: 0,
    skipNext: false,
    broke: false,
  }));
}

function resetBoard() {
  state.owners = Object.fromEntries(TILES.map((t) => [t.id, null]));
  state.upgrades = Object.fromEntries(TILES.map((t) => [t.id, 0]));
  state.pot = 0;
  state.gyin = shuffle(GYIN_DECK);
  state.kyaw = shuffle(KYAW_DECK);
  state.gyinDiscard = [];
  state.kyawDiscard = [];
  state.lastDice = { d1: 1, d2: 1 };
  state.doublesStreak = 0;
  state.selected = 0;
  state.hover = null;
  state.anim = null;
  state.log = [];
  logEl.innerHTML = "";
  paintDice(1, 1);
}

function startGame(entries) {
  resetBoard();
  state.players = createPlayers(entries);
  state.current = 0;
  state.busy = false;
  setupScreen.hidden = true;
  app.hidden = false;
  log("ဂိမ်းစတင်ပြီ။ လစာကွက်ကနေ ထွက်ကြမယ်။");
  updateHUD();
  requestAnimationFrame(() => {
    resizeCanvas();
    selectTile(0);
  });
  setPhase("roll");
}

function showSetup() {
  state.phase = "setup";
  app.hidden = true;
  setupScreen.hidden = false;
  modalRoot.hidden = true;
  renderSetupRows();
}

function renderSetupRows() {
  const box = document.getElementById("player-setup");
  const used = new Set();
  box.innerHTML = "";
  for (let i = 0; i < setupCount; i += 1) {
    const palette = PLAYER_PALETTE.find((c) => !used.has(c.id)) ?? PLAYER_PALETTE[i];
    used.add(palette.id);
    const row = document.createElement("div");
    row.className = "player-row";
    row.innerHTML = `
      <div class="swatches" data-index="${i}"></div>
      <div>
        <label>ကစားသမား ${i + 1}
          <input type="text" maxlength="18" value="${DEFAULT_NAMES[i]}" data-name="${i}" />
        </label>
      </div>`;
    const swatches = row.querySelector(".swatches");
    PLAYER_PALETTE.forEach((color, ci) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "swatch-btn";
      btn.style.background = color.hex;
      btn.dataset.color = color.id;
      btn.setAttribute("aria-pressed", String(ci === i));
      btn.title = color.labelEn;
      swatches.appendChild(btn);
    });
    box.appendChild(row);
  }
}

function collectSetup() {
  const names = [...document.querySelectorAll("#player-setup input")].map((el) => el.value.trim());
  const colors = [...document.querySelectorAll("#player-setup .swatches")].map((group) => {
    const id = group.querySelector('.swatch-btn[aria-pressed="true"]')?.dataset.color;
    return PLAYER_PALETTE.find((c) => c.id === id) ?? PLAYER_PALETTE[0];
  });
  const unique = new Set(colors.map((c) => c.id));
  if (unique.size !== colors.length) {
    const fallback = PLAYER_PALETTE.filter((c, i) => i < setupCount);
    return names.map((name, i) => ({
      name: name || DEFAULT_NAMES[i],
      color: fallback[i].hex,
      colorLabel: fallback[i].label,
    }));
  }
  return names.map((name, i) => ({
    name: name || DEFAULT_NAMES[i],
    color: colors[i].hex,
    colorLabel: colors[i].label,
  }));
}

function bindSetup() {
  document.getElementById("count-pills").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-count]");
    if (!btn) return;
    setupCount = Number(btn.dataset.count);
    document.querySelectorAll("#count-pills .pill").forEach((el) => {
      el.setAttribute("aria-pressed", String(el === btn));
    });
    renderSetupRows();
  });

  document.getElementById("player-setup").addEventListener("click", (event) => {
    const btn = event.target.closest(".swatch-btn");
    if (!btn) return;
    const group = btn.parentElement;
    group.querySelectorAll(".swatch-btn").forEach((el) => el.setAttribute("aria-pressed", String(el === btn)));
  });

  document.getElementById("btn-start").addEventListener("click", () => {
    startGame(collectSetup());
  });
}

function bindGame() {
  btnRoll.addEventListener("click", () => {
    playRoll();
  });
  btnEnd.addEventListener("click", () => {
    if (state.phase !== "end" || state.busy) return;
    finishTurn();
  });

  document.getElementById("btn-new").addEventListener("click", async () => {
    const ok = await openModal({
      kicker: "New game",
      title: "ဂိမ်းအသစ် စမလဲ?",
      body: "<p>လက်ရှိဂိမ်းကို ပယ်ဖျက်ပြီး ကစားသမားပြန်ရွေးပါမယ်။</p>",
      buttons: [
        { label: "စမည်", className: "primary", value: "yes" },
        { label: "မလုပ်တော့", value: "no" },
      ],
    });
    if (ok === "yes") showSetup();
  });

  document.getElementById("btn-rules").addEventListener("click", () => {
    openModal({
      kicker: "How to play",
      title: "ကစားနည်း",
      body: `<div class="rules">
        <p>၂–၄ ယောက် အန်စာတုံးလှည့်ပြီး ရန်ကုန်ဘုတ်ပေါ် လှည့်ကစားကြတယ်။ လစာကွက် <strong>လစာဝင်ပြီ</strong> ကို ဖြတ်ရင် ${formatMMK(CONFIG.goSalary)} ရတယ်။</p>
        <h3>မြေနှင့် ငှားရမ်းခ</h3>
        <p>ပိုင်ရှင်မရှိသော ကွက်ကို ဝယ်။ သူများကွက်ပေါ်ကျရင် ငှားရမ်းခပေး။ အရောင်အစုံပိုင်ရင် Wi-Fi Router (၄ လုံး) နဲ့ Generator တပ်ပြီး ငှားရမ်းခတက်တယ်။</p>
        <h3>ယာဉ်နှင့် ဘေလ်</h3>
        <p>YBS, Grab, Bolt, ရထားဝိုင်း — ပိုင်သည့်စင်းရေအလိုက် ငှားရမ်းခ။ EPC မီတာဘေလ်နဲ့ ရေဘေလ်က အန်စာတုံးပေါ် မူတည်။</p>
        <h3>ဂျင်း နှင့် ၉ ကျော်တယ်</h3>
        <p>ဂျင်းက ဒဏ်တွေ (ဆေထိုးခံရ၊ ပလပ်ကျွတ်)။ ၉ ကျော်တယ်က ဆုတွေ (ဒိုင်ရှိုး၊ SKB Status)။</p>
        <h3>ရွာပြင်</h3>
        <p>ရွာပြင်ပို့ခံရရင် ဒဏ်ကြေး ${formatMMK(CONFIG.jailFine)}၊ လွတ်ကတ်၊ သို့မဟုတ် ဒိုင်ဗယ်။ သုံးအလှည့်ဆိုရင် မဖြစ်မနေ ပေးထွက်ရမယ်။</p>
      </div>`,
      buttons: [{ label: "ပိတ်မည်", className: "primary", value: "ok" }],
    });
  });

  canvas.addEventListener("pointermove", (event) => {
    const { x, y } = canvasCoords(event);
    const id = hitTile(x, y);
    if (id !== state.hover) {
      state.hover = id;
      drawBoard();
    }
  });
  canvas.addEventListener("pointerleave", () => {
    state.hover = null;
    drawBoard();
  });
  canvas.addEventListener("click", (event) => {
    const { x, y } = canvasCoords(event);
    const id = hitTile(x, y);
    if (id != null) selectTile(id);
  });

  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && modalRoot.hidden && state.phase === "roll") {
      event.preventDefault();
      playRoll();
    }
    if (event.key === "Enter" && !modalRoot.hidden) {
      const primary = modalRoot.querySelector(".btn.primary, .btn.gold, .btn");
      primary?.click();
    }
  });

  new ResizeObserver(() => resizeCanvas()).observe(wrap);
}

async function boot() {
  dieEls.forEach((die) => {
    if (!die.childElementCount) {
      for (let i = 0; i < 9; i += 1) {
        const pip = document.createElement("span");
        pip.className = "pip";
        die.appendChild(pip);
      }
    }
  });
  bindSetup();
  bindGame();
  renderSetupRows();
  try {
    await document.fonts.ready;
  } catch {
    /* canvas will fall back to system Myanmar fonts */
  }
}

boot();
