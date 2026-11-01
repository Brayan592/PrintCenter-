import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '25mb' }));

// Configurar CORS completo para permitir sincronización desde cualquier dispositivo,
// aplicaciones exportadas, vistas móviles, WebView, y orígenes externos
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(__dirname));

// Endpoint de verificación de estado y conectividad
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: 'V20.26.11.015',
    timestamp: Date.now(),
    server: 'PrintCenterPro Cloud Sync'
  });
});

// Memoria y persistencia de tiendas/dispositivos enlazados por código
const roomsFile = path.join(__dirname, '.sync_rooms.json');
let syncRooms = {};
try {
  if (fs.existsSync(roomsFile)) {
    syncRooms = JSON.parse(fs.readFileSync(roomsFile, 'utf8'));
  }
} catch (e) {
  console.warn('Iniciando syncRooms en memoria:', e.message);
}

function persistRooms() {
  try {
    fs.writeFileSync(roomsFile, JSON.stringify(syncRooms, null, 2));
  } catch (e) {
    console.warn('Error persistiendo sync rooms:', e.message);
  }
}

// Mapa de conexiones SSE activas por código de sala: normCode -> Set<Response>
const sseConnections = new Map();

function getOrCreateRoom(rawCode) {
  const normCode = String(rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!normCode) return null;
  if (!syncRooms[normCode]) {
    syncRooms[normCode] = {
      code: normCode,
      createdAt: Date.now(),
      version: 1,
      devices: {},
      events: [],
      snapshot: {
        ventas: [],
        pedidos: [],
        productos: [],
        clientes: []
      }
    };
  }
  if (!syncRooms[normCode].snapshot) {
    syncRooms[normCode].snapshot = {
      ventas: [],
      pedidos: [],
      productos: [],
      clientes: []
    };
  }
  return syncRooms[normCode];
}

// Transmitir evento a clientes SSE conectados
function broadcastToSseClients(normCode, data) {
  const clients = sseConnections.get(normCode);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch (err) {
      clients.delete(client);
    }
  }
}

// 1. Unirse o inicializar un código de tienda
app.post('/api/sync/join', (req, res) => {
  const { code, deviceId, deviceName, initialData } = req.body;
  if (!code) return res.status(400).json({ error: 'Código de enlace requerido' });

  const room = getOrCreateRoom(code);
  if (!room) return res.status(400).json({ error: 'Código inválido' });

  const now = Date.now();
  const devId = deviceId || 'dev_' + Math.random().toString(36).slice(2, 9);

  room.devices[devId] = {
    name: deviceName || 'Dispositivo ' + devId.slice(-4),
    lastSeen: now
  };

  // Si la sala no tiene ventas pero el dispositivo que se une sí tiene datos
  if (initialData && typeof initialData === 'object') {
    if (!room.snapshot.ventas || room.snapshot.ventas.length === 0) {
      if (Array.isArray(initialData.ventas) && initialData.ventas.length > 0) {
        room.snapshot.ventas = initialData.ventas;
      }
    }
    if ((!room.snapshot.productos || room.snapshot.productos.length === 0) && Array.isArray(initialData.productos)) {
      room.snapshot.productos = initialData.productos;
    }
    if ((!room.snapshot.pedidos || room.snapshot.pedidos.length === 0) && Array.isArray(initialData.pedidos)) {
      room.snapshot.pedidos = initialData.pedidos;
    }
    if ((!room.snapshot.clientes || room.snapshot.clientes.length === 0) && Array.isArray(initialData.clientes)) {
      room.snapshot.clientes = initialData.clientes;
    }
    persistRooms();
  }

  const activeDevices = Object.values(room.devices).filter(d => now - d.lastSeen < 60000).length;

  res.json({
    success: true,
    code: room.code,
    version: room.version,
    activeDevices,
    snapshot: room.snapshot,
    assignedDeviceId: devId
  });
});

// 2. Consulta de cambios en tiempo real (Polling eficiente + snapshot garantizado)
app.get('/api/sync/poll', (req, res) => {
  const { code, deviceId, version } = req.query;
  if (!code) return res.status(400).json({ error: 'Código requerido' });

  const normCode = String(code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const room = syncRooms[normCode];
  if (!room) {
    return res.status(404).json({ error: 'Código de tienda no encontrado' });
  }

  const now = Date.now();
  if (deviceId && room.devices[deviceId]) {
    room.devices[deviceId].lastSeen = now;
  }

  const clientVer = parseInt(version, 10) || 0;
  const activeDevices = Object.values(room.devices).filter(d => now - d.lastSeen < 60000).length;

  if (room.version > clientVer) {
    const pendingEvents = room.events.filter(e => e.version > clientVer);
    return res.json({
      hasUpdates: true,
      type: 'EVENTS',
      version: room.version,
      activeDevices,
      events: pendingEvents,
      snapshot: room.snapshot
    });
  }

  res.json({
    hasUpdates: false,
    version: room.version,
    activeDevices
  });
});

// 3. Emitir evento (Venta nueva, modificación, eliminación)
app.post('/api/sync/push', (req, res) => {
  const { code, deviceId, deviceName, event, fullSnapshot } = req.body;
  if (!code) return res.status(400).json({ error: 'Código requerido' });

  const room = getOrCreateRoom(code);
  if (!room) return res.status(400).json({ error: 'Código inválido' });

  const now = Date.now();
  if (deviceId) {
    room.devices[deviceId] = {
      name: deviceName || (room.devices[deviceId]?.name || 'Dispositivo'),
      lastSeen: now
    };
  }

  room.version += 1;

  let recordedEvent = null;
  if (event) {
    recordedEvent = {
      ...event,
      version: room.version,
      deviceId,
      deviceName: deviceName || room.devices[deviceId]?.name || 'Otro dispositivo',
      timestamp: now
    };
    room.events.push(recordedEvent);
    if (room.events.length > 300) {
      room.events = room.events.slice(-300);
    }

    // Mantener sincronizado el snapshot central del servidor
    if (!room.snapshot) {
      room.snapshot = { ventas: [], pedidos: [], productos: [], clientes: [] };
    }
    if (!Array.isArray(room.snapshot.ventas)) room.snapshot.ventas = [];
    if (!Array.isArray(room.snapshot.pedidos)) room.snapshot.pedidos = [];
    if (!Array.isArray(room.snapshot.productos)) room.snapshot.productos = [];
    if (!Array.isArray(room.snapshot.clientes)) room.snapshot.clientes = [];

    const evType = event.type;
    if (evType === 'POS_SALE_SAVED' && event.venta) {
      const v = event.venta;
      const idx = room.snapshot.ventas.findIndex(x => x.id === v.id);
      if (idx > -1) room.snapshot.ventas[idx] = v;
      else room.snapshot.ventas.unshift(v);
      room.snapshot.ventas.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      
      // Ajustar stock en el servidor
      if (Array.isArray(v.productos)) {
        v.productos.forEach(pItem => {
          const sp = room.snapshot.productos.find(x => x.id === pItem.id);
          if (sp && pItem.id !== 999999) sp.stock -= (pItem.qty || 1);
        });
      }
    } else if (evType === 'DAILY_SALE_SAVED' && event.venta) {
      const v = event.venta;
      const idx = room.snapshot.ventas.findIndex(x => x.id === v.id || (x.fecha && v.fecha && x.fecha.slice(0, 10) === v.fecha.slice(0, 10) && x.tipoRegistro === 'diario'));
      if (idx > -1) room.snapshot.ventas[idx] = v;
      else room.snapshot.ventas.unshift(v);
      room.snapshot.ventas.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    } else if (evType === 'SALE_MODIFIED' && event.venta) {
      const idx = room.snapshot.ventas.findIndex(x => x.id === event.venta.id);
      if (idx > -1) room.snapshot.ventas[idx] = event.venta;
      room.snapshot.ventas.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    } else if (evType === 'SALE_DELETED' && event.saleId) {
      room.snapshot.ventas = room.snapshot.ventas.filter(x => x.id !== event.saleId);
    } else if (evType === 'MONTH_SALES_DELETED' && event.mes) {
      room.snapshot.ventas = room.snapshot.ventas.filter(x => !(x.fecha && x.fecha.startsWith(event.mes)));
    } else if (evType === 'ORDER_SAVED' && event.pedido) {
      const p = event.pedido;
      const idx = room.snapshot.pedidos.findIndex(x => x.id === p.id);
      if (idx > -1) room.snapshot.pedidos[idx] = p;
      else room.snapshot.pedidos.unshift(p);
    } else if (evType === 'ORDER_DELETED' && event.pedidoId) {
      room.snapshot.pedidos = room.snapshot.pedidos.filter(x => x.id !== event.pedidoId);
    } else if (evType === 'STOCK_UPDATED' && event.producto) {
      const pr = event.producto;
      const sp = room.snapshot.productos.find(x => x.id === pr.id);
      if (sp) sp.stock = pr.stock;
    } else if (evType === 'CLIENT_ADDED' && event.cliente) {
      const c = event.cliente;
      if (!room.snapshot.clientes.some(x => x.id === c.id || (x.nombre && c.nombre && x.nombre.toLowerCase() === c.nombre.toLowerCase()))) {
        room.snapshot.clientes.push(c);
      }
    }
  }

  // Si el cliente adjunta un snapshot completo actualizado
  if (fullSnapshot && typeof fullSnapshot === 'object') {
    if (Array.isArray(fullSnapshot.ventas) && fullSnapshot.ventas.length > 0) {
      room.snapshot.ventas = fullSnapshot.ventas;
    }
    if (Array.isArray(fullSnapshot.pedidos)) {
      room.snapshot.pedidos = fullSnapshot.pedidos;
    }
    if (Array.isArray(fullSnapshot.productos)) {
      room.snapshot.productos = fullSnapshot.productos;
    }
    if (Array.isArray(fullSnapshot.clientes)) {
      room.snapshot.clientes = fullSnapshot.clientes;
    }
  }

  persistRooms();

  const activeDevices = Object.values(room.devices).filter(d => now - d.lastSeen < 60000).length;

  // Transmitir inmediatamente vía Server-Sent Events (SSE) en tiempo real (< 15ms)
  broadcastToSseClients(room.code, {
    type: 'EVENT',
    version: room.version,
    event: recordedEvent,
    snapshot: room.snapshot,
    activeDevices
  });

  res.json({
    success: true,
    version: room.version,
    activeDevices,
    snapshot: room.snapshot
  });
});

// 4. Canal de transmisión Server-Sent Events (SSE) para sincronización instantánea
app.get('/api/sync/stream', (req, res) => {
  const { code, deviceId, deviceName } = req.query;
  if (!code) return res.status(400).send('Código requerido');

  const normCode = String(code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const room = getOrCreateRoom(normCode);
  if (!room) return res.status(400).send('Código inválido');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': stream-connected\n\n');

  if (!sseConnections.has(normCode)) {
    sseConnections.set(normCode, new Set());
  }
  const clientSet = sseConnections.get(normCode);
  clientSet.add(res);

  const devId = deviceId || 'dev_' + Math.random().toString(36).slice(2, 9);
  room.devices[devId] = {
    name: deviceName || 'Dispositivo ' + devId.slice(-4),
    lastSeen: Date.now()
  };

  // Enviar estado inicial y snapshot actual al conectarse
  const initialPayload = {
    type: 'INIT',
    code: room.code,
    version: room.version,
    activeDevices: Object.values(room.devices).filter(d => Date.now() - d.lastSeen < 60000).length,
    snapshot: room.snapshot
  };
  res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

  // Heartbeat ping cada 20 segundos para evitar timeouts de proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
      if (room.devices[devId]) room.devices[devId].lastSeen = Date.now();
    } catch (e) {
      clearInterval(heartbeat);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clientSet.delete(res);
    if (clientSet.size === 0) sseConnections.delete(normCode);
  });
});

// 5. Obtener Snapshot completo en cualquier momento
app.get('/api/sync/snapshot', (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Código requerido' });
  const normCode = String(code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const room = syncRooms[normCode];
  if (!room) return res.status(404).json({ error: 'Sala no encontrada' });

  const now = Date.now();
  const activeDevices = Object.values(room.devices).filter(d => now - d.lastSeen < 60000).length;

  res.json({
    success: true,
    code: room.code,
    version: room.version,
    activeDevices,
    snapshot: room.snapshot
  });
});

// 6. Estado de los dispositivos enlazados
app.get('/api/sync/status', (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Código requerido' });
  const normCode = String(code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const room = syncRooms[normCode];
  if (!room) return res.json({ exists: false });

  const now = Date.now();
  const activeList = Object.entries(room.devices)
    .filter(([_, d]) => now - d.lastSeen < 60000)
    .map(([id, d]) => ({ id, name: d.name, lastSeen: d.lastSeen }));

  res.json({
    exists: true,
    code: room.code,
    version: room.version,
    devices: activeList,
    activeCount: activeList.length,
    snapshotSummary: {
      ventasCount: room.snapshot?.ventas?.length || 0,
      pedidosCount: room.snapshot?.pedidos?.length || 0,
      productosCount: room.snapshot?.productos?.length || 0
    }
  });
});

// Servir frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PrintCenterPro server running on http://0.0.0.0:${PORT}`);
});
