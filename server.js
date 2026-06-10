const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Config reporte ───────────────────────────────────────────────────────────
const RESEND_KEY   = process.env.RESEND_KEY   || 're_bhhvWhBa_9mh4kubvyFLwb5MU9GJTchrf';
const REPORT_EMAIL = process.env.REPORT_EMAIL || 'criptotjay@gmail.com';
const FROM_EMAIL   = process.env.FROM_EMAIL   || 'quickorder@resend.dev';

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
let bills  = [];     // cuentas pendientes para caja

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

  // Si es cocina, barra o caja — enviar comandas pendientes
  const destMap = { kitchen: 'cocina', bar: 'barra', cash: 'caja' };
  const destFiltro = destMap[ws._role];
  if (destFiltro) {
    const pendientes = orders.filter(o => o.status === 'pending' && o.dest === destFiltro);
    pendientes.forEach(o => sendTo(ws, o));
    if (pendientes.length) log(`Enviadas ${pendientes.length} comandas pendientes a ${ws._role}`);
  }
  // Caja: enviar cuentas pendientes
  if (ws._role === 'cash') {
    const billsPend = bills.filter(b => b.status === 'pending');
    billsPend.forEach(b => sendTo(ws, b));
    if (billsPend.length) log(`Enviadas ${billsPend.length} cuentas pendientes a caja`);
  }

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
        const rolesConectados = Array.from(wss.clients).map(c=>c._role).join(', ');
        log(`Roles conectados: [${rolesConectados}] | buscando: ${destRole}`);
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

        // Marcar en historial
        const o = orders.find(x => x.id === msg.orderId || (x.mesa === msg.mesa && x.status === 'pending'));
        if (o) o.status = 'ready';

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
        const bill = {
          id: Date.now(),
          type:  'bill',
          mesa:  msg.mesa,
          label,
          items: msg.items || [],
          total: msg.total || 0,
          nota:  msg.nota  || '',
          time:  new Date().toISOString(),
          status: 'pending'
        };
        bills.push(bill);
        broadcastToRole('cash', bill);
        log(`Cuenta: ${label} → caja`);
        break;
      }

      // ── Mesa/cliente cerrado ──────────────────────────────────────────────
      case 'close': {
        const m = mesas.find(x => x.id === msg.mesa);
        if (m) { m.items = []; m.total = 0; m.estado = 'libre'; }
        if (Array.isArray(msg.clientes)) clientes = msg.clientes;
        // Marcar bill como cobrada
        const b = bills.find(x => x.mesa === msg.mesa && x.status === 'pending');
        if (b) b.status = 'paid';
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

// CORS para que el frontend pueda llamar al backend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check para Railway
app.get('/', (_, res) => res.json({ ok: true, app: 'QuickOrder', uptime: process.uptime() }));

// ─── MENÚ ─────────────────────────────────────────────────────────────────────
let menuData = {
  restaurante: { nombre: 'Runfola', subtitulo: 'coffee · pizzería · bar' },
  categorias: [
    {id:'bebidas',label:'Bebidas',dest:'barra',items:[
      {id:'be1',n:'Agua',p:1.50},{id:'be2',n:'Refresco',p:2.50},
      {id:'be3',n:'Cerveza',p:2.80},{id:'be4',n:'Vino de la casa',p:6.00},{id:'be5',n:'Café',p:1.50}
    ]},
    {id:'entrantes',label:'Entrantes',dest:'cocina',items:[
      {id:'co1',n:'Pan de ajo',p:7.90},{id:'co2',n:'Tequeños',p:7.90},{id:'co3',n:'Patatas Bravioli',p:7.00},
      {id:'en1',n:'Provoleta',p:8.90},{id:'en2',n:'Albóndigas de Napoli',p:9.90},
      {id:'en3',n:'Fingers de pollo',p:8.00},{id:'en4',n:'Patatas Frankfurt',p:8.00},
      {id:'es1',n:'Ensalada Caprese',p:9.90},{id:'es2',n:'Ensalada Burrata',p:9.90},
      {id:'es3',n:'Ensalada César',p:9.90},{id:'es4',n:'Ensalada Atún',p:9.90}
    ]},
    {id:'pizzas',label:'Pizzas',dest:'cocina',items:[
      {id:'pz1',n:'Margarita',p:9.90},{id:'pz2',n:'Tentazione',p:12.90},
      {id:'pz3',n:'Carbonara',p:12.90},{id:'pz4',n:'Diavola',p:11.90},
      {id:'pz5',n:'Diavola Dolce',p:11.90},{id:'pz6',n:'Diavola Inferno',p:11.90},
      {id:'pz7',n:'Bella Italia',p:12.90},{id:'pz8',n:'Prosciutto e Funghi',p:12.90},
      {id:'pz9',n:'4 Formaggi',p:11.90},{id:'pz10',n:'Capricciosa',p:12.90},
      {id:'pz11',n:'Tonno',p:12.90},{id:'pz12',n:'Franfumina',p:12.90},
      {id:'pz13',n:'Pizza de queso',p:12.90},
      {id:'pt1',n:'Pizzeta Margarita',p:9.90},{id:'pt2',n:'Pizzeta Tentazione',p:12.90},
      {id:'pt3',n:'Pizzeta Carbonara',p:12.90},{id:'pt4',n:'Pizzeta Diavola',p:11.90},
      {id:'pt5',n:'Pizzeta Diavola Dolce',p:11.90},{id:'pt6',n:'Pizzeta Diavola Inferno',p:11.90},
      {id:'pt7',n:'Pizzeta Bella Italia',p:12.90},{id:'pt8',n:'Pizzeta Prosciutto e Funghi',p:12.90},
      {id:'pt9',n:'Pizzeta 4 Formaggi',p:11.90},{id:'pt10',n:'Pizzeta Capricciosa',p:12.90},
      {id:'pt11',n:'Pizzeta Tonno',p:12.90},{id:'pt12',n:'Pizzeta Franfumina',p:12.90},
      {id:'pd1',n:'Pizzeta Nutella',p:8.00},{id:'pd2',n:'Pizzeta Pistacho',p:8.00}
    ]},
    {id:'postres',label:'Postres',dest:'cocina',items:[
      {id:'po1',n:'Tarta de queso',p:5.00},{id:'po2',n:'Flan',p:3.90},
      {id:'po3',n:'Natillas',p:3.90},{id:'po4',n:'Helado',p:3.00},{id:'po5',n:'Granizado',p:3.50}
    ]}
  ]
};

// Obtener menú completo
app.get('/menu', (_, res) => res.json(menuData));

// Añadir plato a una categoría
app.post('/menu/:catId/items', (req, res) => {
  const cat = menuData.categorias.find(c => c.id === req.params.catId);
  if (!cat) return res.status(404).json({ error: 'Categoría no encontrada' });
  const { n, p } = req.body;
  if (!n || p === undefined) return res.status(400).json({ error: 'Nombre y precio requeridos' });
  const id = req.params.catId.slice(0, 2) + '_' + Date.now();
  const item = { id, n, p: Number(p) };
  cat.items.push(item);
  broadcast({ type: 'menu-update', menu: menuData });
  log(`Menú: añadido "${n}" a ${cat.label}`);
  res.json(item);
});

// Editar plato
app.put('/menu/items/:itemId', (req, res) => {
  for (const cat of menuData.categorias) {
    const item = cat.items.find(x => x.id === req.params.itemId);
    if (item) {
      if (req.body.n !== undefined) item.n = req.body.n;
      if (req.body.p !== undefined) item.p = Number(req.body.p);
      broadcast({ type: 'menu-update', menu: menuData });
      log(`Menú: editado "${item.n}" → ${item.p}€`);
      return res.json(item);
    }
  }
  res.status(404).json({ error: 'Plato no encontrado' });
});

// Eliminar plato
app.delete('/menu/items/:itemId', (req, res) => {
  for (const cat of menuData.categorias) {
    const idx = cat.items.findIndex(x => x.id === req.params.itemId);
    if (idx !== -1) {
      const removed = cat.items.splice(idx, 1)[0];
      broadcast({ type: 'menu-update', menu: menuData });
      log(`Menú: eliminado "${removed.n}" de ${cat.label}`);
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ error: 'Plato no encontrado' });
});

// Añadir categoría
app.post('/menu/categorias', (req, res) => {
  const { id, label, dest } = req.body;
  if (!id || !label) return res.status(400).json({ error: 'id y label requeridos' });
  menuData.categorias.push({ id, label, dest: dest || 'cocina', items: [] });
  broadcast({ type: 'menu-update', menu: menuData });
  log(`Menú: nueva categoría "${label}"`);
  res.json({ ok: true });
});

// Editar info restaurante
app.put('/menu/restaurante', (req, res) => {
  if (req.body.nombre) menuData.restaurante.nombre = req.body.nombre;
  if (req.body.subtitulo) menuData.restaurante.subtitulo = req.body.subtitulo;
  broadcast({ type: 'menu-update', menu: menuData });
  log(`Menú: info restaurante actualizada`);
  res.json(menuData.restaurante);
});

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
  bills    = [];
  broadcast({ type: 'sync', mesas, clientes });
  log('Reset del día');
  res.json({ ok: true });
});

// ─── Reporte diario ───────────────────────────────────────────────────────────
async function enviarReporte() {
  if (!orders.length) { log('Reporte: sin ventas hoy, no se envía'); return; }

  const fecha = new Date().toLocaleDateString('es-ES', {
    weekday:'long', year:'numeric', month:'long', day:'numeric', timeZone:'Europe/Madrid'
  });

  // Totales
  const totalVentas   = orders.reduce((s, o) => s + (o.total || 0), 0);
  const totalComandas = orders.length;

  // Desglose por categoría
  const porCat = {};
  orders.forEach(o => {
    (o.items || []).forEach(it => {
      const cat = it.cat || 'otros';
      if (!porCat[cat]) porCat[cat] = { qty: 0, total: 0 };
      porCat[cat].qty   += it.q || 1;
      porCat[cat].total += (it.p || 0) * (it.q || 1);
    });
  });

  // Platos más vendidos (top 5)
  const porPlato = {};
  orders.forEach(o => {
    (o.items || []).forEach(it => {
      if (!porPlato[it.n]) porPlato[it.n] = { qty: 0, total: 0 };
      porPlato[it.n].qty   += it.q || 1;
      porPlato[it.n].total += (it.p || 0) * (it.q || 1);
    });
  });
  const top5 = Object.entries(porPlato)
    .sort((a, b) => b[1].qty - a[1].qty)
    .slice(0, 5);

  // Construir HTML del email
  const catRows = Object.entries(porCat).map(([cat, d]) =>
    `<tr><td style="padding:8px 12px;text-transform:capitalize">${cat}</td>
     <td style="padding:8px 12px;text-align:center">${d.qty}</td>
     <td style="padding:8px 12px;text-align:right;font-weight:700">${d.total.toFixed(2)} €</td></tr>`
  ).join('');

  const top5Rows = top5.map(([n, d]) =>
    `<tr><td style="padding:8px 12px">${n}</td>
     <td style="padding:8px 12px;text-align:center">${d.qty}</td>
     <td style="padding:8px 12px;text-align:right">${d.total.toFixed(2)} €</td></tr>`
  ).join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#f5f5f5;margin:0;padding:20px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    
    <div style="background:#FF6B35;padding:28px 32px">
      <div style="font-size:22px;font-weight:800;color:#fff">Runfola · Reporte diario</div>
      <div style="font-size:14px;color:rgba(255,255,255,.8);margin-top:4px;text-transform:capitalize">${fecha}</div>
    </div>

    <div style="padding:28px 32px">
      <div style="display:flex;gap:16px;margin-bottom:28px">
        <div style="flex:1;background:#fff8f5;border:1.5px solid #FF6B35;border-radius:12px;padding:16px;text-align:center">
          <div style="font-size:32px;font-weight:800;color:#FF6B35">${totalVentas.toFixed(2)} €</div>
          <div style="font-size:13px;color:#888;margin-top:4px">Facturación total</div>
        </div>
        <div style="flex:1;background:#f5fff5;border:1.5px solid #41d36f;border-radius:12px;padding:16px;text-align:center">
          <div style="font-size:32px;font-weight:800;color:#41d36f">${totalComandas}</div>
          <div style="font-size:13px;color:#888;margin-top:4px">Comandas</div>
        </div>
      </div>

      <div style="margin-bottom:24px">
        <div style="font-size:13px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Ventas por categoría</div>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr style="background:#f5f5f5">
              <th style="padding:8px 12px;text-align:left;font-weight:700">Categoría</th>
              <th style="padding:8px 12px;text-align:center;font-weight:700">Uds.</th>
              <th style="padding:8px 12px;text-align:right;font-weight:700">Total</th>
            </tr>
          </thead>
          <tbody>${catRows}</tbody>
        </table>
      </div>

      <div>
        <div style="font-size:13px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Top 5 platos</div>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr style="background:#f5f5f5">
              <th style="padding:8px 12px;text-align:left;font-weight:700">Plato</th>
              <th style="padding:8px 12px;text-align:center;font-weight:700">Uds.</th>
              <th style="padding:8px 12px;text-align:right;font-weight:700">Total</th>
            </tr>
          </thead>
          <tbody>${top5Rows}</tbody>
        </table>
      </div>
    </div>

    <div style="background:#f5f5f5;padding:16px 32px;font-size:12px;color:#aaa;text-align:center">
      Reporte generado automáticamente por QuickOrder
    </div>
  </div>
</body>
</html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from:    FROM_EMAIL,
        to:      [REPORT_EMAIL],
        subject: `Runfola · Reporte ${fecha} · ${totalVentas.toFixed(2)} €`,
        html
      })
    });
    const data = await res.json();
    if (res.ok) {
      log(`Reporte enviado a ${REPORT_EMAIL} | ${totalVentas.toFixed(2)} € en ${totalComandas} comandas`);
    } else {
      log(`Error Resend: ${JSON.stringify(data)}`);
    }
  } catch (e) {
    log(`Error enviando reporte: ${e.message}`);
  }

  // Reset del día tras enviar
  orders = [];
  bills  = [];
  mesas  = mesas.map(m => ({ ...m, items: [], total: 0, estado: 'libre' }));
  clientes = [];
  broadcast({ type: 'sync', mesas, clientes });
  log('Reset automático del día completado');
}

// ─── Scheduler 1:00 AM (Madrid) ───────────────────────────────────────────────
function scheduleReport() {
  const now    = new Date();
  const target = new Date();
  target.setHours(1, 0, 0, 0);
  // Si ya pasó la 1 AM de hoy, programar para mañana
  if (now >= target) target.setDate(target.getDate() + 1);
  const ms = target - now;
  log(`Próximo reporte en ${Math.round(ms/1000/60)} minutos`);
  setTimeout(() => {
    enviarReporte();
    setInterval(enviarReporte, 24 * 60 * 60 * 1000); // cada 24h
  }, ms);
}
scheduleReport();

// ─── Arranque ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => log(`QuickOrder backend escuchando en :${PORT}`));
