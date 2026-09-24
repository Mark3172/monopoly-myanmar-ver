import {
  CONFIG,
  DEFAULT_NAMES,
  GROUPS,
  GYIN_DECK,
  KYAW_DECK,
  PLAYER_PALETTE,
  TILES,
} from "./boardData.js";
import { connect, isMyTurn, net, on, resetNet, send } from "./net.js";

const canvas = document.getElementById("board");
const wrap = document.getElementById("board-wrap");
const ctx = canvas.getContext("2d");
const dieEls = [document.getElementById("die-1"), document.getElementById("die-2")];
const btnRoll = document.getElementById("btn-roll");
const btnEnd = document.getElementById("btn-end");
const btnTrade = document.getElementById("btn-trade");
const tradeRoot = document.getElementById("trade-root");
const turnLabel = document.getElementById("turn-label");
const playerList = document.getElementById("player-list");
const inspectBody = document.getElementById("inspect-body");
const logEl = document.getElementById("log");
const modalRoot = document.getElementById("modal-root");
const setupScreen = document.getElementById("setup-screen");
const app = document.getElementById("app");

const PROPERTY_TYPES = new Set(["property", "transit", "utility"]);

const PLACE_ART = {
  "street-food": "place-street-food.jpg",
  "tea-shops": "place-tea.jpg",
  mookata: "place-mookata.jpg",
  nightlife: "place-night.jpg",
  markets: "place-market.jpg",
  malls: "place-mall.jpg",
  condos: "place-condo.jpg",
  "golden-mile": "place-golden.jpg",
  transit: "place-transit.jpg",
  utility: "place-utility.jpg",
  go: "place-go.jpg",
  jail: "place-jail.jpg",
  gotojail: "place-jail.jpg",
  gyin: "place-gyin.jpg",
  kyaw: "place-kyaw.jpg",
  tax: "place-utility.jpg",
  safe: "place-go.jpg",
};

function bandInk(hex) {
  const raw = String(hex || "").replace("#", "");
  if (raw.length < 6) return "#fffaf0";
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 160 ? "#1c140c" : "#fffaf0";
}

function placeArt(tile) {
  const file = (tile.group && PLACE_ART[tile.group]) || PLACE_ART[tile.type] || "place-go.jpg";
  return `./art/${file}`;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

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
  landFlash: null,
  flashUntil: 0,
};

let modalResolver = null;
let setupCount = 2;
const lastMoney = new Map();
let netQueue = Promise.resolve();

function enqueueNet(fn) {
  netQueue = netQueue.then(fn).catch(() => {});
}

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

function canUpgradeTile(player, tile, { ignoreBusy = false } = {}) {
  if (!player || player.broke || tile.type !== "property") return false;
  if (state.phase !== "roll" && state.phase !== "end") return false;
  if (state.owners[tile.id] !== player.index) return false;
  if (!ownsGroup(player, tile.group)) return false;
  const level = state.upgrades[tile.id] ?? 0;
  if (level >= 5) return false;
  if (level > minUpgradeInGroup(tile.group)) return false;
  const cost = GROUPS[tile.group].upgradeCost;
  return player.money >= cost && (ignoreBusy || !state.busy);
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

const graphemeSplitter = (() => {
  try {
    return new Intl.Segmenter("my", { granularity: "grapheme" });
  } catch {
    return null;
  }
})();

function graphemes(text) {
  if (graphemeSplitter) {
    return [...graphemeSplitter.segment(text)].map((part) => part.segment);
  }
  return [...text];
}

function wrapLines(text, maxWidth, font, maxLines = 3) {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) return [text];

  const lines = [];
  const words = text.split(/\s+/).filter(Boolean);
  let line = "";

  const flush = () => {
    if (line) lines.push(line);
    line = "";
  };

  for (const word of words) {
    if (ctx.measureText(word).width <= maxWidth) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > maxWidth) {
        flush();
        line = word;
      } else {
        line = next;
      }
      continue;
    }
    if (line) flush();
    let chunk = "";
    for (const g of graphemes(word)) {
      const next = chunk + g;
      if (chunk && ctx.measureText(next).width > maxWidth) {
        lines.push(chunk);
        chunk = g;
      } else {
        chunk = next;
      }
    }
    line = chunk;
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
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
  const anim = state.anim?.[player.index];
  const base = anim ?? tileCenter(player.position);
  const offsets = [
    [-10, -10],
    [10, -10],
    [-10, 10],
    [10, 10],
  ];
  const [dx, dy] = offsets[indexOnTile % 4];
  return {
    x: base.x + dx,
    y: base.y + dy,
    scale: anim?.scale ?? 1,
    hop: anim?.hop ?? 0,
  };
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
  if (!state.busy && !dieDrag) parkDice();
}

let surfacePatterns = null;

function makeSurfacePatterns() {
  const wood = document.createElement("canvas");
  wood.width = 160;
  wood.height = 160;
  const wg = wood.getContext("2d");
  wg.fillStyle = "#6a3d1c";
  wg.fillRect(0, 0, 160, 160);
  for (let y = 0; y < 160; y += 3) {
    wg.strokeStyle = y % 2 === 0 ? "rgba(40,18,6,0.28)" : "rgba(255,196,120,0.08)";
    wg.beginPath();
    wg.moveTo(0, y);
    wg.bezierCurveTo(40, y + 2, 90, y - 2, 160, y + 1);
    wg.stroke();
  }
  wg.fillStyle = "rgba(255,220,160,0.05)";
  wg.fillRect(0, 0, 160, 18);

  const felt = document.createElement("canvas");
  felt.width = 96;
  felt.height = 96;
  const fg = felt.getContext("2d");
  fg.fillStyle = "#0f5a40";
  fg.fillRect(0, 0, 96, 96);
  for (let i = 0; i < 420; i += 1) {
    const shade = 40 + ((i * 17) % 50);
    fg.fillStyle = `rgba(${shade},${shade + 30},${shade},0.16)`;
    fg.fillRect((i * 13) % 96, (i * 29) % 96, 1, 1);
  }

  return {
    wood: ctx.createPattern(wood, "repeat"),
    felt: ctx.createPattern(felt, "repeat"),
  };
}

function drawBoard() {
  const layout = state.layout;
  if (!layout) return;
  const { cssSize, rects } = layout;
  if (!surfacePatterns) surfacePatterns = makeSurfacePatterns();

  ctx.clearRect(0, 0, cssSize, cssSize);

  roundRect(ctx, 0, 0, cssSize, cssSize, cssSize * 0.028);
  ctx.fillStyle = surfacePatterns.wood;
  ctx.fill();
  ctx.save();
  roundRect(ctx, 1.5, 1.5, cssSize - 3, cssSize - 3, cssSize * 0.026);
  ctx.strokeStyle = "rgba(255,220,170,0.28)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  const inset = Math.max(7, cssSize * 0.012);
  roundRect(ctx, inset, inset, cssSize - inset * 2, cssSize - inset * 2, cssSize * 0.02);
  ctx.fillStyle = "#123f2e";
  ctx.fill();
  ctx.save();
  roundRect(ctx, inset, inset, cssSize - inset * 2, cssSize - inset * 2, cssSize * 0.02);
  ctx.clip();
  ctx.fillStyle = surfacePatterns.felt;
  ctx.globalAlpha = 0.55;
  ctx.fillRect(inset, inset, cssSize, cssSize);
  ctx.restore();

  const inner = layout.origin + layout.corner;
  const innerSize = layout.board - layout.corner * 2;
  roundRect(ctx, inner + 6, inner + 6, innerSize - 12, innerSize - 12, 18);
  const feltShade = ctx.createRadialGradient(
    inner + innerSize * 0.45,
    inner + innerSize * 0.4,
    innerSize * 0.1,
    inner + innerSize / 2,
    inner + innerSize / 2,
    innerSize * 0.72,
  );
  feltShade.addColorStop(0, "rgba(32,120,86,0.35)");
  feltShade.addColorStop(1, "rgba(0,0,0,0.28)");
  ctx.fillStyle = feltShade;
  ctx.fill();
  ctx.strokeStyle = "rgba(212,168,74,0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  TILES.forEach((tile) => drawTile(tile, rects[tile.id]));
  drawTokens();
}

function barRect(rect) {
  const depth = rect.side === "left" || rect.side === "right" ? rect.w : rect.h;
  const t = Math.max(11, Math.min(22, depth * 0.2));
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

  const pad = 1.6;
  ctx.save();
  roundRect(ctx, rect.x + pad, rect.y + pad, rect.w - pad * 2, rect.h - pad * 2, 3);
  ctx.clip();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;

  const paper = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.h);
  paper.addColorStop(0, "#fff8ea");
  paper.addColorStop(1, "#e7d7b8");
  ctx.fillStyle = paper;
  if (tile.type === "gyin") ctx.fillStyle = "#4a2a1c";
  if (tile.type === "kyaw") ctx.fillStyle = "#1c4636";
  if (tile.type === "go") ctx.fillStyle = "#f3dd9a";
  if (tile.type === "jail") ctx.fillStyle = "#e4d3b4";
  if (tile.type === "safe") ctx.fillStyle = "#d7efe4";
  if (tile.type === "gotojail") ctx.fillStyle = "#f0c8bb";
  if (tile.type === "tax") ctx.fillStyle = "#efe0c4";
  if (tile.type === "transit") ctx.fillStyle = "#efe8dc";
  if (tile.type === "utility") ctx.fillStyle = "#e3e7ea";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.shadowColor = "transparent";

  if (tile.type === "property" && tile.group && GROUPS[tile.group]) {
    const bar = barRect(rect);
    if (bar) {
      ctx.fillStyle = GROUPS[tile.group].color;
      ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      if (rect.side === "bottom" || rect.side === "top") ctx.fillRect(bar.x, bar.y, bar.w, 2);
      else ctx.fillRect(bar.x, bar.y, 2, bar.h);
    }
  }

  drawTileLabel(tile, rect);
  drawOwnership(tile, rect);
  ctx.restore();

  ctx.save();
  const flashing = state.landFlash === tile.id && performance.now() < state.flashUntil;
  ctx.strokeStyle = flashing ? "#fff3b0" : isSelected ? "#f4d06a" : isHere ? "#2ea572" : isHover ? "#d7a84a" : "rgba(40,24,10,0.45)";
  ctx.lineWidth = flashing || isSelected || isHere ? 3 : 1;
  roundRect(ctx, rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, 4);
  ctx.stroke();
  ctx.restore();
}

function boardMark(tile) {
  if (tile.type === "gyin") return "ဂျင်း";
  if (tile.type === "kyaw") return "၉";
  if (tile.type === "transit" || tile.type === "utility") return tile.short || tile.name;
  if (tile.type === "tax") return tile.short || "ခွန်";
  return "";
}

function drawFittedLines(text, maxWidth, maxHeight, color, family = '"Noto Sans Myanmar", "Noto Sans"') {
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  let size = Math.min(13, maxHeight * 0.55);
  while (size >= 7) {
    ctx.font = `700 ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth && size <= maxHeight) {
      ctx.fillText(text, 0, 0);
      return size;
    }
    size -= 0.5;
  }

  size = Math.min(10, maxHeight * 0.38);
  let lines = wrapLines(text, maxWidth, `700 ${size}px ${family}`, 2);
  while (size >= 7) {
    const font = `700 ${size}px ${family}`;
    lines = wrapLines(text, maxWidth, font, 2);
    const lineH = size * 1.15;
    const fits = lines.length * lineH <= maxHeight + 1;
    if (fits) {
      ctx.font = font;
      lines.forEach((line, i) => {
        ctx.fillText(line, 0, (i - (lines.length - 1) / 2) * lineH);
      });
      return size;
    }
    size -= 0.5;
  }
  ctx.font = `700 7px ${family}`;
  ctx.fillText(text, 0, 0);
  return 7;
}

function drawTileLabel(tile, rect) {
  const isCorner = ["br", "bl", "tl", "tr"].includes(rect.side);
  const color = ["gyin", "kyaw"].includes(tile.type) ? "#f6edd8" : "#1c140c";

  if (isCorner) {
    ctx.save();
    ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
    drawFittedLines(tile.short || tile.name, rect.w - 16, rect.h * 0.42, color);
    ctx.restore();
    return;
  }

  const mark = boardMark(tile);
  const along = rect.side === "bottom" || rect.side === "top" ? rect.w : rect.h;
  const depth = rect.side === "bottom" || rect.side === "top" ? rect.h : rect.w;
  const price = tile.price || tile.amount;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (rect.side === "left") {
    ctx.translate(rect.x + depth / 2, rect.y + rect.h / 2);
    ctx.rotate(-Math.PI / 2);
  } else if (rect.side === "right") {
    ctx.translate(rect.x + depth / 2, rect.y + rect.h / 2);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
  }
  if (mark) drawFittedLines(mark, along - 8, Math.min(18, depth * 0.28), color);
  ctx.restore();

  if (!price) return;
  const label = formatMMK(price).replace(" Ks", "");
  ctx.save();
  ctx.fillStyle = "#5c4630";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.max(7, Math.min(9, along * 0.15))}px "Noto Sans"`;
  if (rect.side === "bottom") ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h - 8);
  if (rect.side === "top") ctx.fillText(label, rect.x + rect.w / 2, rect.y + 8);
  if (rect.side === "left") {
    ctx.translate(rect.x + 8, rect.y + rect.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(label, 0, 0);
  }
  if (rect.side === "right") {
    ctx.translate(rect.x + rect.w - 8, rect.y + rect.h / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(label, 0, 0);
  }
  ctx.restore();
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
  const hotel = level >= 5;
  const count = hotel ? 1 : level;
  for (let i = 0; i < count; i += 1) {
    const bw = hotel ? 11 : 6;
    const bh = Math.max(6, bar.h - 5);
    const bx = bar.x + 3 + i * (bw + 1);
    const by = bar.y + (bar.h - bh) / 2;
    ctx.fillStyle = hotel ? "#9d1c1c" : "#1f7a3a";
    ctx.fillRect(bx, by + 2, bw, bh - 2);
    ctx.beginPath();
    ctx.moveTo(bx - 1, by + 2);
    ctx.lineTo(bx + bw / 2, by - 1);
    ctx.lineTo(bx + bw + 1, by + 2);
    ctx.closePath();
    ctx.fillStyle = hotel ? "#c44536" : "#2f9a4e";
    ctx.fill();
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
    const r = 12 * pos.scale;
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = `rgba(0,0,0,${0.28 + pos.hop * 0.01})`;
    ctx.ellipse(pos.x + 1, pos.y + 6 + pos.hop * 0.4, r * 0.85, r * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    const gloss = ctx.createRadialGradient(pos.x - r * 0.35, pos.y - r * 0.4, r * 0.1, pos.x, pos.y, r);
    gloss.addColorStop(0, "#fff6df");
    gloss.addColorStop(0.45, player.color);
    gloss.addColorStop(1, "#1a1008");
    ctx.fillStyle = gloss;
    ctx.strokeStyle = "rgba(20,10,4,0.85)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (player.color === "#d4a017") {
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r * 0.55, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(90,50,8,0.7)";
      ctx.stroke();
    } else if (player.color === "#c44536") {
      ctx.moveTo(pos.x, pos.y - r);
      ctx.lineTo(pos.x + r * 0.86, pos.y);
      ctx.lineTo(pos.x, pos.y + r);
      ctx.lineTo(pos.x - r * 0.86, pos.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (player.color === "#2b6cb0") {
      roundRect(ctx, pos.x - r * 0.82, pos.y - r * 0.7, r * 1.64, r * 1.4, 3);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = "#fff8ea";
    ctx.font = `700 ${Math.round(9 * pos.scale)}px "Noto Sans Myanmar"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const initial = graphemes(player.name)[0] ?? "?";
    ctx.fillText(initial, pos.x, pos.y + 0.5);
    ctx.restore();
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

const diceStage = document.getElementById("dice-stage");
let pendingToss = null;
let dieDrag = null;

function dieSize() {
  return dieEls[0]?.offsetWidth || 52;
}

function restSpot(index) {
  const w = diceStage?.clientWidth || 0;
  const h = diceStage?.clientHeight || 0;
  const s = dieSize();
  const gap = 12;
  return {
    x: w / 2 + (index === 0 ? -(s + gap) : gap),
    y: Math.max(8, h * 0.62),
  };
}

function setDiePose(el, x, y, rx = 0, ry = 0, lift = 0) {
  el.style.transform = `translate3d(${x}px, ${y}px, ${lift}px) rotateX(${rx}deg) rotateY(${ry}deg)`;
  el._pose = { x, y, rx, ry };
}

function parkDice() {
  if (!diceStage || diceStage.clientWidth < 40 || state.busy || dieDrag) return;
  dieEls.forEach((el, index) => {
    const spot = restSpot(index);
    setDiePose(el, spot.x, spot.y, 0, 0, 0);
  });
}

function clampDie(value, max) {
  return Math.max(0, Math.min(max, value));
}

async function glideDiceHome() {
  const from = dieEls.map((el, index) => ({ ...(el._pose || restSpot(index)), spot: restSpot(index) }));
  const start = performance.now();
  await new Promise((resolve) => {
    const tick = (now) => {
      const t = Math.min(1, (now - start) / 320);
      const e = easeInOut(t);
      dieEls.forEach((el, index) => {
        const pose = from[index];
        setDiePose(
          el,
          pose.x + (pose.spot.x - pose.x) * e,
          pose.y + (pose.spot.y - pose.y) * e,
          pose.rx * (1 - e),
          pose.ry * (1 - e),
          8 * (1 - e),
        );
      });
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

async function animateDice(forced) {
  const toss = pendingToss;
  pendingToss = null;
  const d1 = forced?.d1 ?? 1 + randInt(6);
  const d2 = forced?.d2 ?? 1 + randInt(6);
  const w = diceStage?.clientWidth || 0;
  const h = diceStage?.clientHeight || 0;
  const s = dieSize();
  if (w < 40 || h < 40) {
    paintDice(d1, d2);
    return { d1, d2 };
  }
  const bodies = dieEls.map((el, index) => {
    const pose = el._pose || restSpot(index);
    let vx;
    let vy;
    if (toss && toss.index === index) {
      vx = toss.vx;
      vy = toss.vy;
    } else if (toss) {
      vx = toss.vx * 0.55 + (index === 0 ? -90 : 90);
      vy = toss.vy * 0.55 - 60;
    } else {
      vx = (index === 0 ? -1 : 1) * (240 + Math.random() * 160);
      vy = -320 - Math.random() * 140;
    }
    if (Math.hypot(vx, vy) < 320) {
      const ang = Math.atan2(vy || -1, vx || (index ? 1 : -1));
      vx = Math.cos(ang) * 420;
      vy = Math.sin(ang) * 420;
    }
    return {
      el,
      x: pose.x,
      y: pose.y,
      vx,
      vy,
      rx: pose.rx || 0,
      ry: pose.ry || 0,
      sx: vx * 1.6,
      sy: -vy * 1.2,
    };
  });
  let last = performance.now();
  const start = last;
  await new Promise((resolve) => {
    const frame = (now) => {
      const dt = Math.min(0.034, (now - last) / 1000);
      last = now;
      const flick = now - start < 980;
      bodies.forEach((body) => {
        const drag = Math.exp(-1.35 * dt);
        body.vx *= drag;
        body.vy *= drag;
        body.x += body.vx * dt;
        body.y += body.vy * dt;
        const maxX = w - s;
        const maxY = h - s;
        if (body.x < 0) {
          body.x = 0;
          body.vx = Math.abs(body.vx) * 0.62;
          body.sy += 240;
        } else if (body.x > maxX) {
          body.x = maxX;
          body.vx = -Math.abs(body.vx) * 0.62;
          body.sy -= 240;
        }
        if (body.y < 0) {
          body.y = 0;
          body.vy = Math.abs(body.vy) * 0.62;
        } else if (body.y > maxY) {
          body.y = maxY;
          body.vy = -Math.abs(body.vy) * 0.62;
        }
        body.rx += body.sx * dt;
        body.ry += body.sy * dt;
        body.sx *= Math.exp(-0.9 * dt);
        body.sy *= Math.exp(-0.9 * dt);
        const lift = Math.min(26, Math.hypot(body.vx, body.vy) * 0.05);
        if (flick && Math.random() < 0.45) body.el.dataset.value = String(1 + randInt(6));
        setDiePose(body.el, body.x, body.y, body.rx, body.ry, lift);
      });
      if (now - start < 1080) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
  paintDice(d1, d2);
  await glideDiceHome();
  return { d1, d2 };
}

async function animateTo(player, fromId, toId, duration) {
  const from = tileCenter(fromId);
  const to = tileCenter(toId);
  const ms = duration ?? CONFIG.tokenStepMs;
  const start = performance.now();
  return new Promise((resolve) => {
    const tick = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const e = easeInOut(t);
      const hop = Math.sin(Math.PI * t) * Math.min(22, 14 + ms * 0.04);
      state.anim = {
        ...(state.anim ?? {}),
        [player.index]: {
          x: from.x + (to.x - from.x) * e,
          y: from.y + (to.y - from.y) * e - hop,
          hop,
          scale: 1 + Math.sin(Math.PI * t) * 0.2,
        },
      };
      drawBoard();
      if (t < 1) requestAnimationFrame(tick);
      else {
        state.anim = {
          ...(state.anim ?? {}),
          [player.index]: { x: to.x, y: to.y, hop: 0, scale: 0.88 },
        };
        drawBoard();
        requestAnimationFrame(() => {
          if (state.anim) delete state.anim[player.index];
          drawBoard();
          resolve();
        });
      }
    };
    requestAnimationFrame(tick);
  });
}

async function walk(player, steps, { collectGo = true } = {}) {
  const dir = steps >= 0 ? 1 : -1;
  const n = Math.abs(steps);
  const duration = n > 16 ? 80 : n > 8 ? 140 : CONFIG.tokenStepMs;
  if (net.online && isMyTurn(player) && n) {
    send({ type: "walk", index: player.index, from: player.position, steps, duration });
  }
  for (let i = 0; i < n; i += 1) {
    const from = player.position;
    const to = (from + dir + CONFIG.boardTiles) % CONFIG.boardTiles;
    await animateTo(player, from, to, duration);
    player.position = to;
    pulseTile(to);
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

function pulseTile(id) {
  state.landFlash = id;
  state.flashUntil = performance.now() + 520;
  drawBoard();
}

function credit(player, amount, { silent = false } = {}) {
  player.money += amount;
  if (!silent) updateHUD();
}

function cardsById(list) {
  const all = [...GYIN_DECK, ...KYAW_DECK];
  return list.map((id) => all.find((c) => c.id === id)).filter(Boolean);
}

function getSnapshot() {
  return {
    players: state.players,
    owners: state.owners,
    upgrades: state.upgrades,
    pot: state.pot,
    gyin: state.gyin.map((c) => c.id),
    kyaw: state.kyaw.map((c) => c.id),
    gyinDiscard: state.gyinDiscard.map((c) => c.id),
    kyawDiscard: state.kyawDiscard.map((c) => c.id),
    current: state.current,
    phase: state.phase,
    lastDice: state.lastDice,
    doublesStreak: state.doublesStreak,
    log: state.log,
    selected: state.selected,
  };
}

function applySnapshot(snap) {
  if (!snap) return;
  state.players = snap.players;
  state.owners = snap.owners;
  state.upgrades = snap.upgrades;
  state.pot = snap.pot;
  state.gyin = cardsById(snap.gyin);
  state.kyaw = cardsById(snap.kyaw);
  state.gyinDiscard = cardsById(snap.gyinDiscard);
  state.kyawDiscard = cardsById(snap.kyawDiscard);
  state.current = snap.current;
  state.phase = snap.phase;
  state.lastDice = snap.lastDice;
  state.doublesStreak = snap.doublesStreak;
  state.log = snap.log ?? [];
  state.selected = snap.selected ?? state.selected;
  logEl.innerHTML = state.log.map((line) => `<li>${line}</li>`).join("");
  paintDice(state.lastDice.d1, state.lastDice.d2);
}

function publish(extra = {}, { force = false } = {}) {
  if (!net.online) return;
  if (!force && !isMyTurn(currentPlayer())) return;
  send({ type: "sync", snapshot: getSnapshot(), extra });
}

async function replayWalk({ index, from, steps, duration }) {
  const player = state.players[index];
  if (!player) return;
  player.position = from;
  const dir = steps >= 0 ? 1 : -1;
  const n = Math.abs(steps);
  const ms = duration ?? 160;
  for (let i = 0; i < n; i += 1) {
    const a = player.position;
    const b = (a + dir + CONFIG.boardTiles) % CONFIG.boardTiles;
    await animateTo(player, a, b, ms);
    player.position = b;
    pulseTile(b);
  }
}

function sellUpgrades(player, need = Infinity) {
  let guard = 0;
  while (player.money < need && guard < 80) {
    guard += 1;
    const tile = ownedProperties(player)
      .filter((t) => (state.upgrades[t.id] ?? 0) > 0)
      .sort((a, b) => (state.upgrades[b.id] ?? 0) - (state.upgrades[a.id] ?? 0))[0];
    if (!tile) break;
    const cost = GROUPS[tile.group]?.upgradeCost ?? 0;
    state.upgrades[tile.id] -= 1;
    player.money += Math.floor(cost / 2);
    log(`${player.name} ${tile.name} က Wi-Fi/Generator ပြန်ရောင်းတယ်။`);
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
  if (player.money < amount) sellUpgrades(player, amount);
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
  btnTrade.hidden = true;
  dieEls.forEach((die) => {
    die.disabled = true;
  });
  closeTrade();
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
  const mine = !net.online || isMyTurn(player);
  const canAct = !state.busy && !player?.broke && state.phase !== "over" && mine;
  btnRoll.disabled = !(canAct && phase === "roll");
  btnRoll.hidden = phase !== "roll";
  dieEls.forEach((die) => {
    die.disabled = !(canAct && phase === "roll");
  });
  const showEnd = canAct && phase === "end";
  const wasHidden = btnEnd.hidden;
  btnEnd.hidden = !showEnd;
  if (wasHidden && showEnd) {
    btnEnd.classList.remove("arriving");
    void btnEnd.offsetWidth;
    btnEnd.classList.add("arriving");
  }
  btnTrade.hidden = !(canAct && (phase === "roll" || phase === "end") && tradePartners().length > 0);
  if (!player) return;
  if (phase === "roll") {
    turnLabel.textContent = !mine
      ? `${player.name} အလှည့်`
      : player.inJail
        ? "ရွာပြင် — ထွက်မလား?"
        : "သင့်အလှည့်";
    btnRoll.textContent = player.inJail ? "ထွက်မည်" : "လှည့်";
  } else if (phase === "end") {
    turnLabel.textContent = mine ? "ပြီးအောင်" : `${player.name}`;
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
          return `<button type="button" data-tile="${t.id}" title="${t.name}" style="background:${color};color:${t.group === "golden-mile" || t.group === "transit" ? "#fff" : "#1c140c"}">${t.short || t.nameEn}${mark}</button>`;
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
      return `<article class="player-card ${p.index === state.current ? "active" : ""} ${p.broke ? "broke" : ""}" data-player="${p.index}">
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
  state.players.forEach((p) => {
    const moneyEl = playerList.querySelector(`[data-player="${p.index}"] .money`);
    const prev = lastMoney.get(p.index);
    if (moneyEl && prev != null && prev !== p.money) {
      moneyEl.classList.remove("flash");
      void moneyEl.offsetWidth;
      moneyEl.classList.add("flash");
    }
    lastMoney.set(p.index, p.money);
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
  inspectBody.innerHTML = `<div class="inspect-card deed-card">
    <figure class="place-card">
      <img src="${placeArt(tile)}" alt="" />
      <figcaption>
        <strong>${esc(tile.name)}</strong>
        <span>${esc(tile.nameEn)}</span>
      </figcaption>
    </figure>
    <div class="deed-band" style="background:${group?.color ?? "#c9a15b"};color:${bandInk(group?.color ?? "#c9a15b")}">${esc(group ? group.label : tile.name)}</div>
    <div class="deed-body">
    <p>${tile.price ? `ဈေး ${formatMMK(tile.price)}` : tile.amount ? `ပေးရန် ${formatMMK(tile.amount)}` : ""}</p>
    <p>${owner ? `ပိုင်ရှင်: ${owner.name} · ${upgradeLabels[level]}` : PROPERTY_TYPES.has(tile.type) ? "ပိုင်ရှင်မရှိ" : ""}</p>
    ${state.pot && tile.type === "safe" ? `<p>လက်ရှိအိုး: ${formatMMK(state.pot)}</p>` : ""}
    ${extra}
    ${canUp ? `<button type="button" class="btn gold" id="btn-upgrade" style="margin-top:0.6rem">တိုးတက်အောင်လုပ် (${formatMMK(group.upgradeCost)})</button>` : ""}
    </div>
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
  publish();
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
    log(`${player.name} ရွာပြင်ကို ဖြတ်ကြည့်တယ်။`);
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
      const up = canUpgradeTile(player, tile, { ignoreBusy: true });
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

    if (owner.broke) {
      await openModal({
        kicker: "ငှားရမ်းခ မယူ",
        title: tile.name,
        body: `<p>${owner.name} ဒေဝါလီဖြစ်နေလို့ ငှားရမ်းခ မပေးရ။</p>`,
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
    const pass = KYAW_DECK.find((c) => c.id === "village-pass");
    if (pass) state.kyawDiscard.unshift(pass);
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
  for (let n = 0; n < state.players.length; n += 1) {
    state.current = nextAlive(state.current);
    const player = currentPlayer();
    if (!player.skipNext) break;
    player.skipNext = false;
    log(`${player.name} ဒီအလှည့် ကျော်ရတယ်။`);
  }
  updateHUD();
  drawBoard();
  setPhase("roll");
  publish();
}

async function playRoll() {
  const player = currentPlayer();
  if (!player || state.busy || state.phase !== "roll" || player.broke) return;
  if (net.online && !isMyTurn(player)) return;
  state.busy = true;
  btnRoll.disabled = true;
  btnTrade.hidden = true;
  dieEls.forEach((die) => {
    die.disabled = true;
    die.classList.remove("cocked");
  });
  try {
    if (player.inJail) {
      const handled = await handleJail(player);
      if (handled) return;
    }
    const dice = await animateDice();
    state.lastDice = dice;
    if (net.online) send({ type: "dice", d1: dice.d1, d2: dice.d2 });
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
    publish();
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
    netId: entry.netId ?? null,
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
  const chip = document.getElementById("room-chip");
  if (chip && net.online && net.code) {
    chip.hidden = false;
    chip.textContent = net.code;
  }
}

function showSetup() {
  state.phase = "setup";
  app.hidden = true;
  setupScreen.hidden = false;
  modalRoot.hidden = true;
  resetNet();
  closeTrade();
  const chip = document.getElementById("room-chip");
  if (chip) chip.hidden = true;
  renderSetupRows();
  renderSelfSetup();
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

let playMode = "local";
let lobbyPlayers = [];

function renderSelfSetup() {
  const box = document.getElementById("self-setup");
  if (!box) return;
  const name = playMode === "join" ? DEFAULT_NAMES[1] : DEFAULT_NAMES[0];
  const colorIndex = playMode === "join" ? 1 : 0;
  box.innerHTML = `<div class="player-row">
    <div class="swatches" data-index="self"></div>
    <div>
      <label>သင့်နာမည်
        <input type="text" maxlength="18" value="${name}" id="self-name" />
      </label>
    </div>
  </div>`;
  const swatches = box.querySelector(".swatches");
  PLAYER_PALETTE.forEach((color, ci) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swatch-btn";
    btn.style.background = color.hex;
    btn.dataset.color = color.id;
    btn.setAttribute("aria-pressed", String(ci === colorIndex));
    swatches.appendChild(btn);
  });
}

function readSelf() {
  const name = document.getElementById("self-name")?.value.trim() || DEFAULT_NAMES[0];
  const id = document.querySelector("#self-setup .swatch-btn[aria-pressed='true']")?.dataset.color;
  const color = PLAYER_PALETTE.find((c) => c.id === id) ?? PLAYER_PALETTE[0];
  return { name, color: color.hex, colorLabel: color.label };
}

function renderLobby(players) {
  lobbyPlayers = players;
  const list = document.getElementById("lobby-list");
  const status = document.getElementById("lobby-status");
  list.hidden = false;
  status.hidden = false;
  status.textContent = net.code ? `အခန်း ${net.code}` : "";
  list.innerHTML = players
    .map(
      (p) => `<div class="lobby-row">
      <span class="token-dot" style="--token:${p.color};background:${p.color}"></span>
      <span>${p.name}${p.host ? " · host" : ""}</span>
    </div>`,
    )
    .join("");
  const chip = document.getElementById("room-chip");
  if (chip && net.code) {
    chip.hidden = false;
    chip.textContent = net.code;
  }
}

function setPlayMode(mode) {
  playMode = mode;
  document.querySelectorAll("#mode-pills .pill").forEach((el) => {
    el.setAttribute("aria-pressed", String(el.dataset.mode === mode));
  });
  document.getElementById("local-setup").hidden = mode !== "local";
  document.getElementById("online-setup").hidden = mode === "local";
  document.getElementById("join-code-wrap").hidden = mode !== "join";
  document.getElementById("btn-online").hidden = false;
  document.getElementById("btn-online").textContent = mode === "join" ? "အခန်းဝင်" : "အခန်းဖွင့်";
  document.getElementById("btn-host-start").hidden = true;
  document.getElementById("lobby-list").hidden = true;
  document.getElementById("lobby-status").hidden = true;
  renderSelfSetup();
}

function uniquifyLobby(players) {
  const used = new Set();
  return players.map((p, i) => {
    let swatch = PLAYER_PALETTE.find((c) => c.hex === p.color && !used.has(c.hex));
    if (!swatch) swatch = PLAYER_PALETTE.find((c) => !used.has(c.hex)) ?? PLAYER_PALETTE[i % PLAYER_PALETTE.length];
    used.add(swatch.hex);
    return { ...p, color: swatch.hex, colorLabel: swatch.label };
  });
}

function beginOnlineGame(players) {
  startGame(
    uniquifyLobby(players).map((p) => ({
      name: p.name,
      color: p.color,
      colorLabel: p.colorLabel,
      netId: p.id,
    })),
  );
  if (net.isHost) {
    queueMicrotask(() => publish({}, { force: true }));
  }
}

function tradePartners() {
  const me = currentPlayer();
  if (!me) return [];
  return state.players.filter((p) => p.index !== me.index && !p.broke);
}

function closeTrade() {
  if (!tradeRoot) return;
  tradeRoot.hidden = true;
  document.getElementById("trade-error").hidden = true;
}

function setTradeActions(buttons) {
  const actions = document.getElementById("trade-actions");
  actions.innerHTML = "";
  buttons.forEach((btn) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `btn ${btn.className ?? ""}`.trim();
    el.textContent = btn.label;
    el.addEventListener("click", btn.onClick);
    actions.appendChild(el);
  });
}

function deedChecks(player, attr) {
  const deeds = ownedProperties(player);
  if (!deeds.length) return `<p class="meta">ကွက်မရှိ</p>`;
  return deeds
    .map((tile) => {
      const locked = (state.upgrades[tile.id] ?? 0) > 0;
      return `<label class="deed ${locked ? "locked" : ""}">
        <input type="checkbox" ${attr} value="${tile.id}" ${locked ? "disabled" : ""} />
        <span>${esc(tile.short || tile.name)}${locked ? " · Wi-Fi" : ""}</span>
      </label>`;
    })
    .join("");
}

function showTradeError(message) {
  const el = document.getElementById("trade-error");
  el.hidden = !message;
  el.textContent = message || "";
}

function openTrade() {
  const me = currentPlayer();
  const partners = tradePartners();
  if (!me || !partners.length || state.busy) return;
  const partner = partners[0];
  document.getElementById("trade-kicker").textContent = "လဲလှယ်";
  document.getElementById("trade-title").textContent = "အရောင်းအဝယ်";
  document.getElementById("trade-accent").style.background = me.color;
  document.getElementById("trade-body").innerHTML = `
    <label class="trade-field">မိတ်ဖက်
      <select id="trade-partner">
        ${partners.map((p) => `<option value="${p.index}">${esc(p.name)}</option>`).join("")}
      </select>
    </label>
    <div class="trade-grid">
      <section class="trade-col">
        <h3>${esc(me.name)} ပေးမည်</h3>
        <div id="trade-give">${deedChecks(me, 'data-side="give"')}</div>
        <label class="deed"><input type="checkbox" id="give-pass" ${me.jailPasses ? "" : "disabled"} /> လွတ်ကတ်${me.jailPasses ? ` ×${me.jailPasses}` : ""}</label>
        <label class="trade-field">ငွေ (Ks)
          <input id="give-cash" type="number" min="0" step="10000" value="0" />
        </label>
      </section>
      <section class="trade-col">
        <h3 id="trade-take-title">${esc(partner.name)} ပေးမည်</h3>
        <div id="trade-take">${deedChecks(partner, 'data-side="take"')}</div>
        <label class="deed"><input type="checkbox" id="take-pass" ${partner.jailPasses ? "" : "disabled"} /> <span id="take-pass-label">လွတ်ကတ်${partner.jailPasses ? ` ×${partner.jailPasses}` : ""}</span></label>
        <label class="trade-field">ငွေ (Ks)
          <input id="take-cash" type="number" min="0" step="10000" value="0" />
        </label>
      </section>
    </div>`;
  document.getElementById("trade-partner").addEventListener("change", (event) => {
    const next = state.players[Number(event.target.value)];
    document.getElementById("trade-take-title").textContent = `${next.name} ပေးမည်`;
    document.getElementById("trade-take").innerHTML = deedChecks(next, 'data-side="take"');
    const pass = document.getElementById("take-pass");
    pass.checked = false;
    pass.disabled = !next.jailPasses;
    document.getElementById("take-pass-label").textContent = `လွတ်ကတ်${next.jailPasses ? ` ×${next.jailPasses}` : ""}`;
  });
  showTradeError("");
  setTradeActions([
    { label: "ကမ်းလှမ်းမည်", className: "primary", onClick: submitTrade },
    { label: "မလုပ်တော့", onClick: () => { cancelTrade(); closeTrade(); } },
  ]);
  tradeRoot.hidden = false;
}

function cashInput(id, max) {
  const raw = Number(document.getElementById(id)?.value);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(max, Math.floor(raw));
}

function collectOffer() {
  const me = currentPlayer();
  const to = Number(document.getElementById("trade-partner").value);
  const partner = state.players[to];
  const offer = {
    from: me.index,
    to,
    giveIds: [...document.querySelectorAll('[data-side="give"]:checked')].map((el) => Number(el.value)),
    takeIds: [...document.querySelectorAll('[data-side="take"]:checked')].map((el) => Number(el.value)),
    giveCash: cashInput("give-cash", me.money),
    takeCash: cashInput("take-cash", partner?.money ?? 0),
    givePass: Boolean(document.getElementById("give-pass")?.checked),
    takePass: Boolean(document.getElementById("take-pass")?.checked),
  };
  const problem = tradeProblem(offer);
  return { offer, problem };
}

function tradeProblem(offer) {
  const from = state.players[offer.from];
  const to = state.players[offer.to];
  if (!from || !to || from.broke || to.broke || from.index === to.index) return "မိတ်ဖက်မမှန်ပါ။";
  const owns = (id, player) => state.owners[id] === player.index && (state.upgrades[id] ?? 0) === 0;
  if (offer.giveIds.some((id) => !owns(id, from))) return "ပေးမည့်ကွက်မှာ Wi-Fi ရှိနေတယ်။";
  if (offer.takeIds.some((id) => !owns(id, to))) return "ယူမည့်ကွက်မှာ Wi-Fi ရှိနေတယ်။";
  if (offer.giveCash < 0 || offer.giveCash > from.money) return "ပေးမည့်ငွေ မလုံလောက်ပါ။";
  if (offer.takeCash < 0 || offer.takeCash > to.money) return "ယူမည့်ငွေ မလုံလောက်ပါ။";
  if (offer.givePass && from.jailPasses < 1) return "လွတ်ကတ် မရှိပါ။";
  if (offer.takePass && to.jailPasses < 1) return "တစ်ဖက်မှာ လွတ်ကတ် မရှိပါ။";
  const moving = offer.giveIds.length + offer.takeIds.length + offer.giveCash + offer.takeCash + (offer.givePass ? 1 : 0) + (offer.takePass ? 1 : 0);
  if (!moving) return "ပေးရန် တစ်ခုခု ရွေးပါ။";
  return "";
}

function offerLines(ids, cash, pass) {
  const names = ids.map((id) => tileById(id)?.name).filter(Boolean);
  if (cash) names.push(formatMMK(cash));
  if (pass) names.push("လွတ်ကတ်");
  return names.length ? names.map((name) => esc(name)).join("၊ ") : "ဘာမှမရှိ";
}

function showTradeReview(offer, { remote = false } = {}) {
  const from = state.players[offer.from];
  const to = state.players[offer.to];
  document.getElementById("trade-kicker").textContent = remote ? "ကမ်းလှမ်းချက်" : `${to.name} အတွက်`;
  document.getElementById("trade-title").textContent = "လက်ခံမလား?";
  document.getElementById("trade-accent").style.background = to.color;
  document.getElementById("trade-body").innerHTML = `
    <div class="trade-grid">
      <section class="trade-col"><h3>${esc(from.name)} ပေးမည်</h3><p>${offerLines(offer.giveIds, offer.giveCash, offer.givePass)}</p></section>
      <section class="trade-col"><h3>${esc(to.name)} ပေးမည်</h3><p>${offerLines(offer.takeIds, offer.takeCash, offer.takePass)}</p></section>
    </div>`;
  showTradeError("");
  setTradeActions([
    {
      label: "လက်ခံမည်",
      className: "primary",
      onClick: () => {
        if (remote) {
          send({ type: "trade-answer", offer, accept: true });
          closeTrade();
          return;
        }
        acceptTrade(offer);
      },
    },
    {
      label: "ငြင်းမည်",
      onClick: () => {
        if (remote) send({ type: "trade-answer", offer, accept: false });
        else log(`${to.name} လဲလှယ်ခြင်းကို ငြင်းတယ်။`);
        closeTrade();
      },
    },
  ]);
  tradeRoot.hidden = false;
}

function showTradeWait(offer) {
  const to = state.players[offer.to];
  document.getElementById("trade-title").textContent = "စောင့်နေသည်";
  document.getElementById("trade-body").innerHTML = `<p>${esc(to.name)} လက်ခံမလား စောင့်နေတယ်။</p>`;
  showTradeError("");
  setTradeActions([{ label: "ပယ်ဖျက်မည်", onClick: cancelTrade }]);
  tradeRoot.hidden = false;
}

function submitTrade() {
  const { offer, problem } = collectOffer();
  if (problem) {
    showTradeError(problem);
    return;
  }
  if (net.online) {
    send({ type: "trade-offer", offer });
    showTradeWait(offer);
    return;
  }
  showTradeReview(offer);
}

function acceptTrade(offer) {
  if (tradeProblem(offer)) {
    log("လဲလှယ်ခြင်း မပြီးပါ။");
    closeTrade();
    return;
  }
  const from = state.players[offer.from];
  const to = state.players[offer.to];
  offer.giveIds.forEach((id) => {
    state.owners[id] = to.index;
  });
  offer.takeIds.forEach((id) => {
    state.owners[id] = from.index;
  });
  from.money -= offer.giveCash;
  to.money += offer.giveCash;
  to.money -= offer.takeCash;
  from.money += offer.takeCash;
  if (offer.givePass) {
    from.jailPasses -= 1;
    to.jailPasses += 1;
  }
  if (offer.takePass) {
    to.jailPasses -= 1;
    from.jailPasses += 1;
  }
  log(`${from.name} နှင့် ${to.name} လဲလှယ်ကြတယ်။`);
  closeTrade();
  updateHUD();
  drawBoard();
  publish();
}

function cancelTrade() {
  if (net.online && isMyTurn(currentPlayer())) send({ type: "trade-cancel" });
  closeTrade();
}

function mySeat() {
  return state.players.find((p) => p.netId && p.netId === net.youId) ?? null;
}

function bindNet() {
  on("created", (msg) => {
    net.online = true;
    net.isHost = true;
    net.code = msg.code;
    net.youId = msg.you;
    renderLobby(msg.players);
    document.getElementById("btn-online").hidden = true;
    document.getElementById("join-code-wrap").hidden = true;
    document.getElementById("btn-host-start").hidden = false;
  });
  on("joined", (msg) => {
    net.online = true;
    net.isHost = false;
    net.code = msg.code;
    net.youId = msg.you;
    renderLobby(msg.players);
    document.getElementById("btn-online").hidden = true;
    document.getElementById("lobby-status").textContent = `အခန်း ${msg.code} · host will start`;
  });
  on("lobby", (msg) => renderLobby(msg.players));
  on("started", (msg) => beginOnlineGame(msg.players));
  on("error", (msg) => {
    document.getElementById("lobby-status").hidden = false;
    document.getElementById("lobby-status").textContent = msg.message;
  });
  on("dice", (msg) => {
    enqueueNet(async () => {
      if (isMyTurn(currentPlayer())) return;
      await animateDice({ d1: msg.d1, d2: msg.d2 });
    });
  });
  on("walk", (msg) => {
    enqueueNet(async () => {
      if (isMyTurn(currentPlayer())) return;
      state.busy = true;
      await replayWalk(msg);
      state.busy = false;
      drawBoard();
      updateHUD();
    });
  });
  on("sync", (msg) => {
    enqueueNet(async () => {
      if (isMyTurn(currentPlayer()) && state.phase !== "setup") return;
      applySnapshot(msg.snapshot);
      updateHUD();
      setPhase(state.phase);
      drawBoard();
      if (app.hidden) {
        setupScreen.hidden = true;
        app.hidden = false;
        requestAnimationFrame(() => resizeCanvas());
      }
    });
  });
  on("trade-offer", (msg) => {
    const me = mySeat();
    if (!me || me.index !== msg.offer?.to) return;
    if (tradeProblem(msg.offer)) return;
    showTradeReview(msg.offer, { remote: true });
  });
  on("trade-answer", (msg) => {
    if (!isMyTurn(currentPlayer())) return;
    closeTrade();
    if (msg.accept) acceptTrade(msg.offer);
    else log(`${state.players[msg.offer?.to]?.name ?? "တစ်ဖက်"} လဲလှယ်ခြင်းကို ငြင်းတယ်။`);
  });
  on("trade-cancel", () => {
    if (isMyTurn(currentPlayer())) return;
    closeTrade();
  });
  on("peer-left", (msg) => log(`${msg.name} ထွက်သွားတယ်။`));
  on("closed", () => {
    if (state.phase !== "setup") log("ချိတ်ဆက်မှု ပြတ်သွားတယ်။");
  });
}

function bindSetup() {
  document.getElementById("mode-pills").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-mode]");
    if (!btn) return;
    setPlayMode(btn.dataset.mode);
  });

  document.getElementById("self-setup").addEventListener("click", (event) => {
    const btn = event.target.closest(".swatch-btn");
    if (!btn) return;
    btn.parentElement.querySelectorAll(".swatch-btn").forEach((el) => {
      el.setAttribute("aria-pressed", String(el === btn));
    });
  });

  document.getElementById("btn-online").addEventListener("click", async () => {
    const self = readSelf();
    const status = document.getElementById("lobby-status");
    status.hidden = false;
    status.textContent = "ချိတ်ဆက်နေသည်…";
    try {
      await connect();
    } catch (err) {
      status.textContent = err.message;
      return;
    }
    if (playMode === "join") {
      send({ type: "join", code: document.getElementById("join-code").value, ...self });
    } else {
      send({ type: "create", ...self });
    }
  });

  document.getElementById("btn-host-start").addEventListener("click", () => {
    send({ type: "start" });
  });

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
    const colorId = btn.dataset.color;
    document.querySelectorAll("#player-setup .swatches").forEach((other) => {
      if (other === group) return;
      const pressed = other.querySelector('.swatch-btn[aria-pressed="true"]');
      if (pressed?.dataset.color !== colorId) return;
      const taken = new Set(
        [...document.querySelectorAll("#player-setup .swatch-btn[aria-pressed='true']")]
          .filter((el) => el !== pressed)
          .map((el) => el.dataset.color),
      );
      taken.add(colorId);
      const fallback = [...other.querySelectorAll(".swatch-btn")].find((el) => !taken.has(el.dataset.color));
      other.querySelectorAll(".swatch-btn").forEach((el) => {
        el.setAttribute("aria-pressed", String(el === fallback));
      });
    });
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
  btnTrade.addEventListener("click", () => {
    if (btnTrade.hidden || state.busy) return;
    openTrade();
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
        <p>ဒီစက်မှာ ၂–၄ ယောက်၊ သို့မဟုတ် <strong>အခန်းဖွင့်</strong>ပြီး ကုဒ်ဝေ။ လစာကွက်ကျရင် ${formatMMK(CONFIG.goSalary)}။</p>
        <h3>မြေနှင့် ငှားရမ်းခ</h3>
        <p>ပိုင်ရှင်မရှိသော ကွက်ကို ဝယ်။ သူများကွက်ပေါ်ကျရင် ငှားရမ်းခပေး။ အရောင်အစုံပိုင်ရင် Wi-Fi Router (၄ လုံး) နဲ့ Generator တပ်ပြီး ငှားရမ်းခတက်တယ်။</p>
        <h3>ယာဉ်နှင့် ဘေလ်</h3>
        <p>YBS, Grab, Bolt, ရထားဝိုင်း — ပိုင်သည့်စင်းရေအလိုက် ငှားရမ်းခ။ EPC မီတာဘေလ်နဲ့ ရေဘေလ်က အန်စာတုံးပေါ် မူတည်။</p>
        <h3>ဂျင်း နှင့် ၉ ကျော်တယ်</h3>
        <p>ဂျင်းက ဒဏ်တွေ (ဆေထိုးခံရ၊ ပလပ်ကျွတ်)။ ၉ ကျော်တယ်က ဆုတွေ (ဒိုင်ရှိုး၊ SKB Status)။</p>
        <h3>လဲလှယ်</h3>
        <p>သင့်အလှည့်မှာ ကွက်၊ ငွေ၊ လွတ်ကတ် လဲနိုင်တယ်။ Wi-Fi သို့မဟုတ် Generator တပ်ထားသော ကွက်ကို အရင်ဖြုတ်မှ လဲရမယ်။ တစ်ဖက်က လက်ခံမှ ပြီးတယ်။</p>
        <h3>ရွာပြင်</h3>
        <p>ရွာပြင်ပို့ခံရရင် ဒဏ်ကြေး ${formatMMK(CONFIG.jailFine)}၊ လွတ်ကတ်၊ သို့မဟုတ် ဒိုင်ဗယ်။ သုံးအလှည့်ဆိုရင် မဖြစ်မနေ ပေးထွက်ရမယ်။ အန်စာတုံးကို နှိပ်ပြီး လှည့်နိုင်တယ်။</p>
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
  dieEls.forEach((die, index) => {
    if (!die.childElementCount) {
      for (let i = 0; i < 9; i += 1) {
        const pip = document.createElement("span");
        pip.className = "pip";
        die.appendChild(pip);
      }
    }
    die.addEventListener("pointerdown", (event) => {
      if (die.disabled || state.busy || state.phase !== "roll") return;
      event.preventDefault();
      const box = diceStage.getBoundingClientRect();
      const pose = die._pose || restSpot(index);
      die.setPointerCapture(event.pointerId);
      die.classList.add("grabbed");
      diceStage.classList.add("live");
      dieDrag = {
        index,
        pointerId: event.pointerId,
        dx: event.clientX - box.left - pose.x,
        dy: event.clientY - box.top - pose.y,
        samples: [{ x: event.clientX, y: event.clientY, t: performance.now() }],
      };
    });
  });
  window.addEventListener("pointermove", (event) => {
    if (!dieDrag || event.pointerId !== dieDrag.pointerId) return;
    const box = diceStage.getBoundingClientRect();
    const size = dieSize();
    const x = clampDie(event.clientX - box.left - dieDrag.dx, box.width - size);
    const y = clampDie(event.clientY - box.top - dieDrag.dy, box.height - size);
    const die = dieEls[dieDrag.index];
    setDiePose(die, x, y, -18, 14, 22);
    const now = performance.now();
    dieDrag.samples.push({ x: event.clientX, y: event.clientY, t: now });
    dieDrag.samples = dieDrag.samples.filter((sample) => now - sample.t < 90);
  });
  window.addEventListener("pointerup", (event) => {
    if (!dieDrag || event.pointerId !== dieDrag.pointerId) return;
    const drag = dieDrag;
    dieDrag = null;
    const die = dieEls[drag.index];
    die.classList.remove("grabbed");
    diceStage.classList.remove("live");
    const samples = drag.samples;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = Math.max(16, last.t - first.t);
    pendingToss = {
      index: drag.index,
      vx: ((last.x - first.x) / dt) * 1000,
      vy: ((last.y - first.y) / dt) * 1000,
    };
    if (!die.disabled && state.phase === "roll" && !state.busy) playRoll();
    else {
      pendingToss = null;
      parkDice();
    }
  });
  requestAnimationFrame(() => parkDice());
  bindNet();
  bindSetup();
  bindGame();
  renderSetupRows();
  renderSelfSetup();
  setPlayMode("local");
  try {
    await document.fonts.ready;
  } catch {
    /* canvas will fall back to system Myanmar fonts */
  }
}

boot();
