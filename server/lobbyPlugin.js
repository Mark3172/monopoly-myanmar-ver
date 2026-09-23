import { WebSocketServer } from "ws";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode(rooms) {
  for (let i = 0; i < 20; i += 1) {
    let code = "";
    for (let n = 0; n < 4; n += 1) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  return `G${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

function publicPlayers(room) {
  return [...room.clients.values()].map((p, slot) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    colorLabel: p.colorLabel,
    slot,
    host: p.id === room.hostId,
  }));
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function broadcast(room, payload, except = null) {
  for (const client of room.clients.keys()) {
    if (client !== except) send(client, payload);
  }
}

export function lobbyPlugin() {
  return {
    name: "gyin-lobby",
    configureServer(server) {
      attachLobby(server.httpServer);
    },
    configurePreviewServer(server) {
      attachLobby(server.httpServer);
    },
  };
}

function attachLobby(httpServer) {
  if (!httpServer || httpServer.__gyinLobby) return;
  httpServer.__gyinLobby = true;

  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map();

  httpServer.on("upgrade", (req, socket, head) => {
    const path = req.url?.split("?")[0];
    if (path !== "/ws") return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    const me = {
      id: crypto.randomUUID(),
      name: "",
      color: "",
      colorLabel: "",
      room: null,
    };

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.type === "create") {
        const code = makeCode(rooms);
        const room = {
          code,
          hostId: me.id,
          started: false,
          clients: new Map(),
        };
        me.name = String(msg.name || "Host").slice(0, 18);
        me.color = msg.color;
        me.colorLabel = msg.colorLabel;
        me.room = code;
        room.clients.set(ws, me);
        rooms.set(code, room);
        send(ws, { type: "created", code, you: me.id, players: publicPlayers(room) });
        return;
      }

      if (msg.type === "join") {
        const code = String(msg.code || "").trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: "error", message: "Room not found." });
          return;
        }
        if (room.started) {
          send(ws, { type: "error", message: "That table already started." });
          return;
        }
        if (room.clients.size >= 4) {
          send(ws, { type: "error", message: "Table is full (4)." });
          return;
        }
        me.name = String(msg.name || "Player").slice(0, 18);
        me.color = msg.color;
        me.colorLabel = msg.colorLabel;
        me.room = code;
        room.clients.set(ws, me);
        send(ws, { type: "joined", code, you: me.id, players: publicPlayers(room) });
        broadcast(room, { type: "lobby", players: publicPlayers(room) });
        return;
      }

      const room = me.room ? rooms.get(me.room) : null;
      if (!room) return;

      if (msg.type === "start") {
        if (me.id !== room.hostId) return;
        if (room.clients.size < 2) {
          send(ws, { type: "error", message: "Need at least 2 players." });
          return;
        }
        room.started = true;
        broadcast(room, { type: "started", players: publicPlayers(room) });
        return;
      }

      if (["sync", "walk", "dice", "pulse", "trade-offer", "trade-answer", "trade-cancel"].includes(msg.type)) {
        broadcast(room, msg, ws);
      }
    });

    ws.on("close", () => {
      const room = me.room ? rooms.get(me.room) : null;
      if (!room) return;
      room.clients.delete(ws);
      if (room.clients.size === 0) {
        rooms.delete(room.code);
        return;
      }
      if (me.id === room.hostId && !room.started) {
        broadcast(room, { type: "error", message: "Host left. Room closed." });
        for (const client of room.clients.keys()) client.close();
        rooms.delete(room.code);
        return;
      }
      broadcast(room, { type: "lobby", players: publicPlayers(room) });
      if (room.started) {
        broadcast(room, { type: "peer-left", id: me.id, name: me.name });
      }
    });
  });
}
