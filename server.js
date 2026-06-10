const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Estado en memoria ───────────────────────────────────────────────────────
let mesas = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  tipo: 'mesa',
  estado: 'libre',
  items: [],
  total: 0
}));
let clientes = [];   // clientes de barra, creados en runtime
let orders = [];     // historial de comandas del día

// ─── Roles válidos ────────────────────────────────────────────────────────────
// waiter  → camarero (recibe avisos de plato listo)
// kitchen → cocina   (recibe pedidos con dest:'cocina')
// bar     → barra    (recibe pedidos con dest:'barra')
// cash    → caja     (recibe pedidos con dest:'caja' y solicitudes de cuenta)

// ─── Helpers ─────────────────────────────────────────────────────────────────
function broadcast(data, skipSocket) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === 1 && c !== skipSocket) c.send(msg);
  });
}

function broadcastToRole(role, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === 1 && c._role === role) c.send(msg);
  });
}

function broadcastToRoles(roles, data) {
  roles.forEach(r => broadcastToRole(r, data));
}

function sendTo(socket, data) {
  if (socket.readyState === 1) socket.send(JSON.stringify(data));
}

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  ws._role = params.get('role') || 'waiter';
  log(`Conectado: ${ws._role} (total: ${wss.clients.size})`);

  // Al conectar, enviar estado actual para sincronizar la pantalla
  sendTo(ws, { type: 'sync', mesas, clientes });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Camarero sincroniza estado de mesas/clientes ──────────────────────
      case 'sync': {
        if (Array.isArray(msg.mesas))   mesas    = msg.mesas;
        if (Array.isArray(msg.clientes)) clientes = msg.clientes;
        // Reenviar a todas las demás pantallas
        broadcast({ type: 'sync', mesas, clientes }, ws);
        log(`Sync: ${mesas.filter(m => m.estado === 'ocupada').length} mesas ocupadas, ${clientes.length} clientes barra`);
        break;
      }

      // ── Nuevo pedido → repartir al destino correcto ───────────────────────
      case 'order': {
        const order = {
          id: Date.now(),
          type: 'order',
          mesa: msg.mesa,
          label: msg.label || `Mesa ${msg.mesa}`,
          dest: msg.dest,
          items: msg.items || [],
          nota: msg.nota || '',
          total: msg.total || 0,
          time: msg.time || new Date().toISOString(),
          status: 'pending'
        };
        orders.push(order);

        // Enviar al destino correcto — reenviar el objeto plano directamente
        const destRole = { barra: 'bar', cocina: 'kitchen', caja: 'cash' }[msg.dest] || msg.dest;
        broadcastToRole(destRole, order);

        // Confirmar al camarero
        sendTo(ws, { type: 'ack', orderId: order.id, dest: msg.dest });

        log(`Pedido #${order.id} | ${order.label} → ${msg.dest} (${order.items.length} ítems)`);
        break;
      }

      // ── Cocina/barra marca un plato como listo → avisar al camarero ───────
      case 'ready': {
        const orderId = msg.orderId;
        const item    = msg.item;
        const label   = msg.label || `Mesa ${msg.mesa}`;

        // Marcar en historial si viene con orderId
        if (orderId) {
          const o = orders.find(x => x.id === orderId);
          if (o) o.status = 'ready';
        }

        // Notificar a todos los camareros
        broadcastToRole('waiter', {
          type:   'notify',
          action: 'ready',
          mesa:   msg.mesa,
          label,
          item,
          orderId
        });

        log(`Listo: ${label} → "${item}"`);
        break;
      }

      // ── Camarero pide la cuenta ───────────────────────────────────────────
      case 'bill': {
        const label = msg.label || `Mesa ${msg.mesa}`;
        broadcastToRole('cash', {
          type:  'bill',
          mesa:  msg.mesa,
          label,
          items: msg.items || [],
          total: msg.total || 0,
          nota:  msg.nota  || '',
          time:  new Date().toISOString()
        });
        log(`Cuenta: ${label} → caja`);
        break;
      }

      // ── Mesa/cliente cerrado ──────────────────────────────────────────────
      case 'close': {
        const m = mesas.find(x => x.id === msg.mesa);
        if (m) { m.items = []; m.total = 0; m.estado = 'libre'; }
        if (Array.isArray(msg.clientes)) clientes = msg.clientes;
        broadcast({ type: 'sync', mesas, clientes }, ws);
        log(`Cerrado: ${msg.mesa}`);
        break;
      }

      default:
        log(`Tipo desconocido: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    log(`Desconectado: ${ws._role} (total: ${wss.clients.size})`);
  });
});

// ─── REST ─────────────────────────────────────────────────────────────────────
app.use(express.json());

// Health check para Railway
app.get('/', (_, res) => res.json({ ok: true, app: 'QuickOrder', uptime: process.uptime() }));

// Estado actual (útil para depuración)
app.get('/status', (_, res) => res.json({
  mesas: mesas.length,
  ocupadas: mesas.filter(m => m.estado === 'ocupada').length,
  clientes: clientes.length,
  ordersToday: orders.length,
  connected: wss.clients.size
}));

// Historial de pedidos del día
app.get('/orders', (_, res) => res.json(orders));

// Reset del día (llamar al abrir el local)
app.post('/reset', (_, res) => {
  mesas    = mesas.map(m => ({ ...m, items: [], total: 0, estado: 'libre' }));
  clientes = [];
  orders   = [];
  broadcast({ type: 'sync', mesas, clientes });
  log('Reset del día');
  res.json({ ok: true });
});

// ─── Arranque ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => log(`QuickOrder backend escuchando en :${PORT}`));
