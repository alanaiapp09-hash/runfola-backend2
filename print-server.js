const express = require('express');
const cors    = require('cors');
const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const app  = express();
app.use(cors());
app.use(express.json());

const PRINTER_SHARE = '\\\\localhost\\POS80';

// ─── ESC/POS helpers ──────────────────────────────────────────────────────────
const ESC      = '\x1B';
const GS       = '\x1D';
const INIT     = ESC + '@';
const CENTER   = ESC + 'a\x01';
const LEFT     = ESC + 'a\x00';
const BOLD_ON  = ESC + 'E\x01';
const BOLD_OFF = ESC + 'E\x00';
const DOUBLE   = ESC + '!\x10';
const NORMAL   = ESC + '!\x00';
const CUT      = GS  + 'V\x42\x00';
const LF       = '\n';
const M        = '    '; // 4 espacios de margen izquierdo

const line = '------------------------------' + LF;
const pad  = (l, r, w = 26) => {
  const space = w - l.length - r.length;
  return M + l + ' '.repeat(Math.max(1, space)) + r;
};

// ─── Print ticket (factura) ───────────────────────────────────────────────────
function printTicket(d, callback) {
  const items    = d.items || [];
  const total    = d.total || 0;
  const fecha    = new Date().toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' });
  const hora     = new Date().toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const ticketId = d.ticketId || new Date().getFullYear() + '-' + String(Math.floor(Math.random() * 9999)).padStart(4, '0');
  const isCopy   = d.isCopy || false;

  let ticket = INIT;
  ticket += CENTER;
  ticket += BOLD_ON + DOUBLE;
  ticket += 'RUNFOLA' + LF;
  ticket += NORMAL + BOLD_OFF;
  ticket += 'coffee · pizzeria · bar' + LF;
  ticket += line;

  if (isCopy) {
    ticket += BOLD_ON;
    ticket += '** COPIA DE FACTURA **' + LF;
    ticket += '** SIMPLIFICADA **' + LF;
    ticket += BOLD_OFF;
    ticket += line;
  }

  ticket += BOLD_ON;
  ticket += 'FACTURA SIMPLIFICADA' + LF;
  ticket += BOLD_OFF;
  ticket += 'No ' + ticketId + LF;
  ticket += line;

  ticket += LEFT;
  ticket += pad('Fecha: ' + fecha, hora) + LF;
  ticket += BOLD_ON + M + (d.label || '') + LF + BOLD_OFF;
  ticket += line;

  ticket += BOLD_ON;
  ticket += pad('Producto', 'Ud  Importe') + LF;
  ticket += BOLD_OFF;
  ticket += line;

  items.forEach(x => {
    const nombre  = x.n.length > 18 ? x.n.substring(0, 18) : x.n;
    const importe = (x.p * x.q).toFixed(2);
    const qty     = String(x.q).padStart(2, ' ');
    ticket += pad(nombre, qty + ' ' + importe.padStart(7, ' ')) + LF;
  });

  ticket += line;
  ticket += BOLD_ON + DOUBLE;
  ticket += pad('TOTAL', Number(total).toFixed(2) + ' EUR') + LF;
  ticket += NORMAL + BOLD_OFF;
  ticket += line;

  ticket += CENTER;
  ticket += 'IVA incluido' + LF;
  ticket += line;
  ticket += LF + 'Gracias por su visita' + LF;
  ticket += 'runfolapizzas.com' + LF;
  ticket += LF + LF + LF;
  ticket += CUT;

  sendToPrinter(ticket, 'Ticket ' + (d.label || ''), callback);
}

// ─── Print comanda (cocina / barra) ──────────────────────────────────────────
function printComanda(msg) {
  const items   = msg.items || [];
  const fecha   = new Date().toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' });
  const hora    = new Date().toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const destino = (msg.dest || '').toUpperCase();

  let ticket = INIT;
  ticket += CENTER;
  ticket += BOLD_ON + DOUBLE;
  ticket += '*** COMANDA ***' + LF;
  ticket += NORMAL + BOLD_OFF;
  ticket += line;

  if (msg.orderNum) {
    ticket += CENTER + BOLD_ON + DOUBLE;
    ticket += msg.orderNum + LF;
    ticket += NORMAL + BOLD_OFF;
  }

  ticket += CENTER + BOLD_ON;
  ticket += (msg.label || '') + LF;
  ticket += BOLD_OFF;
  ticket += destino + LF;
  ticket += line;

  ticket += LEFT;
  ticket += pad('Fecha: ' + fecha, hora) + LF;
  ticket += line;

  ticket += BOLD_ON;
  ticket += pad('Producto', 'Ud') + LF;
  ticket += BOLD_OFF;
  ticket += line;

  items.forEach(x => {
    const nombre = x.n.length > 24 ? x.n.substring(0, 24) : x.n;
    const qty    = String(x.q || 1).padStart(2, ' ');
    ticket += BOLD_ON;
    ticket += pad(nombre, qty) + LF;
    ticket += BOLD_OFF;
  });

  if (msg.nota) {
    ticket += line;
    ticket += M + 'NOTA: ' + msg.nota + LF;
  }

  ticket += line;
  ticket += CENTER;
  ticket += hora + LF;
  ticket += LF + LF + LF;
  ticket += CUT;

  sendToPrinter(ticket, 'Comanda ' + (msg.label || '') + ' → ' + destino);
}

// ─── Send to printer ─────────────────────────────────────────────────────────
function sendToPrinter(data, label, callback) {
  const tmpFile = path.join(__dirname, 'ticket.tmp');
  fs.writeFileSync(tmpFile, data, 'binary');
  exec(`copy /b "${tmpFile}" "${PRINTER_SHARE}"`, { shell: 'cmd.exe' }, (err) => {
    if (err) { console.log('Error imprimiendo:', err.message); if (callback) callback(err); }
    else     { console.log('Impreso:', label); if (callback) callback(null); }
  });
}

// ─── Endpoints ────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({ ok: true, printer: 'POS-80', app: 'Runfola' }));

app.post('/print', (req, res) => {
  const d = req.body;
  if (!d || !d.items) return res.status(400).json({ error: 'Sin datos' });
  printTicket(d, (err) => {
    if (err) res.status(500).json({ error: 'No se pudo imprimir' });
    else     res.json({ ok: true });
  });
});

app.post('/print-comanda', (req, res) => {
  const d = req.body;
  if (!d || !d.items) return res.status(400).json({ error: 'Sin datos' });
  printComanda(d);
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = 3333;
app.listen(PORT, () => {
  console.log('');
  console.log('=================================');
  console.log('  Runfola Print Server');
  console.log('  Impresora: POS-80-Series');
  console.log('  Puerto: ' + PORT);
  console.log('=================================');
  console.log('');
});
