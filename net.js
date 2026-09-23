export const net = {
  ws: null,
  online: false,
  code: null,
  youId: null,
  isHost: false,
  handlers: {},
};

function socketUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export function connect() {
  if (net.ws && (net.ws.readyState === WebSocket.OPEN || net.ws.readyState === WebSocket.CONNECTING)) {
    return Promise.resolve(net.ws);
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl());
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Lobby server did not answer. Use This device, or run npm run dev."));
    }, 4000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      net.ws = ws;
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not open a live table."));
    });
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      net.handlers[msg.type]?.(msg);
      net.handlers.any?.(msg);
    });
    ws.addEventListener("close", () => {
      if (net.online && net.handlers.closed) net.handlers.closed();
    });
  });
}

export function send(payload) {
  if (net.ws?.readyState === WebSocket.OPEN) net.ws.send(JSON.stringify(payload));
}

export function on(type, fn) {
  net.handlers[type] = fn;
}

export function resetNet() {
  net.online = false;
  net.code = null;
  net.youId = null;
  net.isHost = false;
  try {
    net.ws?.close();
  } catch {
    /* ignore */
  }
  net.ws = null;
}

export function isMyTurn(player) {
  if (!net.online) return true;
  return Boolean(player?.netId && player.netId === net.youId);
}
