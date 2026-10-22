const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

// 建立 5 公尺格狀陣列標記物系統 (9x9 陣列，涵蓋 -20m ~ +20m，編號 A-1 ~ I-9)
const GRID_STEP = 5.0;
const GRID_HALF = 4; // -4..4 共 9 行列

function createInitialGridMarkers() {
  const markers = {};
  for (let r = -GRID_HALF; r <= GRID_HALF; r++) {
    const rowChar = String.fromCharCode(65 + (r + GRID_HALF)); // A ~ I
    for (let c = -GRID_HALF; c <= GRID_HALF; c++) {
      const colNum = c + GRID_HALF + 1; // 1 ~ 9
      const id = `${rowChar}-${colNum}`;
      const gx = c * GRID_STEP;
      const gz = r * GRID_STEP;
      markers[id] = {
        id,
        row: r + GRID_HALF,
        col: c + GRID_HALF,
        gx,
        gz,
        x: gx,
        y: 1.2,
        z: gz,
        nx: 0,
        nz: 1,
        snapped: false,
        active: false,
        activatedBy: null,
        timestamp: 0,
      };
    }
  }
  return markers;
}

const state = {
  players: {},   // id -> { id, role, x, z, yaw, speed, lastSeen }
  markers: createInitialGridMarkers(),
  walls: [],
};

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on('connection', (ws) => {
  let clientId = 'P_' + Math.random().toString(36).substring(2, 6).toUpperCase();
  let isDashboard = false;

  ws.send(JSON.stringify({
    type: 'init',
    id: clientId,
    players: state.players,
    markers: state.markers,
    walls: state.walls,
  }));

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === 'registerRole') {
        if (data.role === 'dashboard') {
          isDashboard = true;
          delete state.players[clientId];
          broadcast({ type: 'playerLeft', id: clientId });
          ws.send(JSON.stringify({
            type: 'stateSnapshot',
            players: state.players,
            markers: state.markers,
            walls: state.walls,
          }));
          return;
        } else {
          if (data.id) clientId = data.id;
          state.players[clientId] = {
            id: clientId,
            x: data.x || 0,
            z: data.z || 0,
            yaw: data.yaw || 0,
            speed: data.speed || 0,
            lastSeen: Date.now(),
          };
          broadcast({ type: 'playerJoined', player: state.players[clientId] }, ws);
        }
      }

      if (isDashboard) return;

      if (!state.players[clientId]) {
        state.players[clientId] = {
          id: clientId,
          x: 0,
          z: 0,
          yaw: 0,
          speed: 0,
          lastSeen: Date.now(),
        };
      }
      const p = state.players[clientId];
      p.lastSeen = Date.now();

      if (data.type === 'move') {
        p.x = Number(data.x) || 0;
        p.z = Number(data.z) || 0;
        p.yaw = Number(data.yaw) || 0;
        p.speed = Number(data.speed) || 0;
        broadcast({ type: 'playerMove', player: p }, ws);
      }
      else if (data.type === 'snapMarker') {
        const m = state.markers[data.id];
        if (m) {
          // 允許在 5m 格點周圍微調貼合真實牆面/邊緣，但不偏離 5m 網格超過 1.4m
          const dx = Math.max(-1.4, Math.min(1.4, (data.x || m.gx) - m.gx));
          const dz = Math.max(-1.4, Math.min(1.4, (data.z || m.gz) - m.gz));
          m.x = +(m.gx + dx).toFixed(2);
          m.z = +(m.gz + dz).toFixed(2);
          m.y = +(data.y || 1.2).toFixed(2);
          m.nx = data.nx || 0;
          m.nz = data.nz || 1;
          m.snapped = true;
          broadcast({ type: 'markerUpdated', marker: m });
        }
      }
      else if (data.type === 'activateMarker') {
        const m = state.markers[data.id];
        if (m) {
          m.active = true;
          m.activatedBy = clientId;
          m.timestamp = Date.now();
          if (Array.isArray(data.walls)) {
            data.walls.forEach((w) => {
              if (state.walls.length < 400) state.walls.push(w);
            });
          }
          broadcast({
            type: 'markerActivated',
            marker: m,
            playerId: clientId,
            walls: state.walls,
          });
        }
      }
    } catch (e) {
      console.error('WS parse error:', e);
    }
  });

  ws.on('close', () => {
    if (state.players[clientId]) {
      delete state.players[clientId];
      broadcast({ type: 'playerLeft', id: clientId });
    }
  });
});

// 每 500ms 主動推播一次完整快照，確保 Dashboard 與所有客戶端絕不漏接位置與方向變化
setInterval(() => {
  const now = Date.now();
  for (const id in state.players) {
    if (now - state.players[id].lastSeen > 30000) {
      delete state.players[id];
    }
  }
  broadcast({
    type: 'stateSnapshot',
    players: state.players,
    markers: state.markers,
    walls: state.walls,
  });
}, 500);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`AR 5m網格定位與多人連機伺服器已啟動：http://localhost:${PORT}`);
  console.log(`伺服器即時地圖監控端：http://localhost:${PORT}/dashboard.html`);
  console.log(`====================================================`);
});
