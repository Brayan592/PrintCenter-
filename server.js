import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import * as webpush from 'web-push';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_VERSION = 'v.20.26.11.100 Uptade IA';

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

// Cabeceras PWA estrictas para Service Worker y Web App Manifest
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.use(express.static(__dirname));

// Endpoint de verificación de estado y conectividad
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: APP_VERSION,
    timestamp: Date.now(),
    server: 'PrintCenterPro Cloud Sync',
    capabilities: {
      aiGemini: Boolean(process.env.GEMINI_API_KEY),
      webPush: true,
      serviceWorker: true
    }
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

function createEmptySnapshot() {
  return {
    productos: [],
    ventas: [],
    pedidos: [],
    clientes: [],
    gastos: [],
    notasInternas: [],
    metaMensual: 15000,
    distribucionesDiarias: null,
    distribucionesJuguetes: null,
    ajustesSaldo: null
  };
}

function getOrCreateRoom(rawCode) {
  const normCode = String(rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!normCode) return null;
  if (!syncRooms[normCode]) {
    syncRooms[normCode] = {
      code: normCode,
      createdAt: Date.now(),
      creatorDeviceId: null,
      version: 1,
      devices: {},
      events: [],
      snapshot: createEmptySnapshot()
    };
  }
  if (!syncRooms[normCode].snapshot) {
    syncRooms[normCode].snapshot = createEmptySnapshot();
  }
  const snap = syncRooms[normCode].snapshot;
  if (!Array.isArray(snap.productos)) snap.productos = [];
  if (!Array.isArray(snap.ventas)) snap.ventas = [];
  if (!Array.isArray(snap.pedidos)) snap.pedidos = [];
  if (!Array.isArray(snap.clientes)) snap.clientes = [];
  if (!Array.isArray(snap.gastos)) snap.gastos = [];
  if (!Array.isArray(snap.notasInternas)) snap.notasInternas = [];
  return syncRooms[normCode];
}

function getActiveDevicesList(room, now = Date.now()) {
  return Object.entries(room.devices || {})
    .filter(([_, d]) => now - d.lastSeen < 60000)
    .map(([id, d]) => ({ id, name: d.name, lastSeen: d.lastSeen }));
}

function applyInitialDataToSnapshot(room, data, overwriteAll = false) {
  if (!data || typeof data !== 'object') return;
  const snap = room.snapshot;

  if (Array.isArray(data.productos) && (overwriteAll || snap.productos.length === 0)) {
    snap.productos = data.productos;
  }
  if (Array.isArray(data.ventas) && (overwriteAll || snap.ventas.length === 0)) {
    snap.ventas = data.ventas;
  }
  if (Array.isArray(data.pedidos) && (overwriteAll || snap.pedidos.length === 0)) {
    snap.pedidos = data.pedidos;
  }
  if (Array.isArray(data.clientes) && (overwriteAll || snap.clientes.length === 0)) {
    snap.clientes = data.clientes;
  }
  if (Array.isArray(data.gastos) && (overwriteAll || snap.gastos.length === 0)) {
    snap.gastos = data.gastos;
  }
  if (Array.isArray(data.notasInternas) && (overwriteAll || snap.notasInternas.length === 0)) {
    snap.notasInternas = data.notasInternas;
  }
  if (typeof data.metaMensual === 'number' && data.metaMensual > 0 && (overwriteAll || !snap.metaMensual)) {
    snap.metaMensual = data.metaMensual;
  }
  if (Array.isArray(data.distribucionesDiarias) && (overwriteAll || !snap.distribucionesDiarias)) {
    snap.distribucionesDiarias = data.distribucionesDiarias;
  }
  if (Array.isArray(data.distribucionesJuguetes) && (overwriteAll || !snap.distribucionesJuguetes)) {
    snap.distribucionesJuguetes = data.distribucionesJuguetes;
  }
  if (data.ajustesSaldo && typeof data.ajustesSaldo === 'object' && (overwriteAll || !snap.ajustesSaldo)) {
    snap.ajustesSaldo = data.ajustesSaldo;
  }
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
  const { code, deviceId, deviceName, isCreator, initialData } = req.body;
  if (!code) return res.status(400).json({ error: 'Código de enlace requerido' });

  const normCode = String(code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!normCode) return res.status(400).json({ error: 'Código inválido' });

  const existingBefore = syncRooms[normCode];
  const roomAlreadyPopulated = Boolean(
    existingBefore && (
      existingBefore.creatorDeviceId ||
      (existingBefore.snapshot?.productos?.length > 0) ||
      (existingBefore.snapshot?.ventas?.length > 0) ||
      existingBefore.version > 1
    )
  );

  const room = getOrCreateRoom(normCode);
  const now = Date.now();
  const devId = deviceId || 'dev_' + Math.random().toString(36).slice(2, 9);
  const resolvedName = deviceName || 'Dispositivo ' + devId.slice(-4);

  room.devices[devId] = {
    name: resolvedName,
    lastSeen: now
  };

  const shouldSeedCreator = Boolean(isCreator) || !roomAlreadyPopulated;

  if (shouldSeedCreator) {
    if (!room.creatorDeviceId || isCreator) {
      room.creatorDeviceId = devId;
    }
    if (initialData && typeof initialData === 'object') {
      applyInitialDataToSnapshot(room, initialData, Boolean(isCreator));
      room.version += 1;
      persistRooms();
    }
  } else if (initialData && typeof initialData === 'object') {
    // El usuario que se une NO debe sobrescribir los productos/datos del creador
    // Solo rellenamos si algún arreglo del servidor estuviera completamente vacío
    applyInitialDataToSnapshot(room, initialData, false);
    persistRooms();
  }

  const activeList = getActiveDevicesList(room, now);

  // Notificar inmediatamente a otros dispositivos conectados en la sala
  broadcastToSseClients(room.code, {
    type: 'EVENT',
    version: room.version,
    event: {
      type: 'DEVICE_HEARTBEAT',
      eventId: 'join_' + devId + '_' + now,
      deviceId: devId,
      deviceName: resolvedName,
      name: resolvedName,
      timestamp: now
    },
    activeDevices: activeList.length,
    devices: activeList
  });

  res.json({
    success: true,
    code: room.code,
    version: room.version,
    isRoomCreator: room.creatorDeviceId === devId,
    isExistingRoom: roomAlreadyPopulated && !isCreator,
    creatorDeviceId: room.creatorDeviceId,
    activeDevices: activeList.length,
    devices: activeList,
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
  const activeList = getActiveDevicesList(room, now);

  if (room.version > clientVer) {
    const pendingEvents = room.events.filter(e => e.version > clientVer);
    return res.json({
      hasUpdates: true,
      type: 'EVENTS',
      version: room.version,
      activeDevices: activeList.length,
      devices: activeList,
      events: pendingEvents,
      snapshot: room.snapshot
    });
  }

  res.json({
    hasUpdates: false,
    version: room.version,
    activeDevices: activeList.length,
    devices: activeList
  });
});

// 3. Emitir evento (Venta nueva, producto, gasto, modificación, eliminación)
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

  if (!room.snapshot) room.snapshot = createEmptySnapshot();
  const snap = room.snapshot;
  if (!Array.isArray(snap.ventas)) snap.ventas = [];
  if (!Array.isArray(snap.pedidos)) snap.pedidos = [];
  if (!Array.isArray(snap.productos)) snap.productos = [];
  if (!Array.isArray(snap.clientes)) snap.clientes = [];
  if (!Array.isArray(snap.gastos)) snap.gastos = [];
  if (!Array.isArray(snap.notasInternas)) snap.notasInternas = [];

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
    if (room.events.length > 350) {
      room.events = room.events.slice(-350);
    }

    const evType = event.type;
    if (evType === 'POS_SALE_SAVED' && event.venta) {
      const v = event.venta;
      const idx = snap.ventas.findIndex(x => x.id === v.id);
      if (idx > -1) snap.ventas[idx] = v;
      else snap.ventas.unshift(v);
      snap.ventas.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    } else if (evType === 'DAILY_SALE_SAVED' && event.venta) {
      const v = event.venta;
      const idx = snap.ventas.findIndex(x => x.id === v.id || (x.fecha && v.fecha && x.fecha.slice(0, 10) === v.fecha.slice(0, 10) && x.tipoRegistro === 'diario'));
      if (idx > -1) snap.ventas[idx] = v;
      else snap.ventas.unshift(v);
      snap.ventas.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    } else if (evType === 'SALE_MODIFIED' && event.venta) {
      const idx = snap.ventas.findIndex(x => x.id === event.venta.id);
      if (idx > -1) snap.ventas[idx] = event.venta;
      snap.ventas.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    } else if (evType === 'SALE_DELETED' && event.saleId) {
      snap.ventas = snap.ventas.filter(x => x.id !== event.saleId);
    } else if (evType === 'MONTH_SALES_DELETED' && event.mes) {
      snap.ventas = snap.ventas.filter(x => !(x.fecha && x.fecha.startsWith(event.mes)));
    } else if (evType === 'ORDER_SAVED' && event.pedido) {
      const p = event.pedido;
      const idx = snap.pedidos.findIndex(x => x.id === p.id);
      if (idx > -1) snap.pedidos[idx] = p;
      else snap.pedidos.unshift(p);
    } else if (evType === 'ORDER_DELETED' && event.pedidoId) {
      snap.pedidos = snap.pedidos.filter(x => x.id !== event.pedidoId);
    } else if (evType === 'STOCK_UPDATED' && event.producto) {
      const pr = event.producto;
      const spIdx = snap.productos.findIndex(x => x.id === pr.id);
      if (spIdx > -1) snap.productos[spIdx] = { ...snap.productos[spIdx], ...pr };
      else snap.productos.push(pr);
    } else if (evType === 'PRODUCT_SAVED' && event.producto) {
      const pr = event.producto;
      const spIdx = snap.productos.findIndex(x => x.id === pr.id);
      if (spIdx > -1) snap.productos[spIdx] = pr;
      else snap.productos.push(pr);
    } else if (evType === 'PRODUCT_DELETED' && event.productId) {
      snap.productos = snap.productos.filter(x => x.id !== event.productId);
    } else if (evType === 'PRODUCTS_SYNC' && Array.isArray(event.productos)) {
      snap.productos = event.productos;
    } else if (evType === 'CLIENT_ADDED' && event.cliente) {
      const c = event.cliente;
      const idx = snap.clientes.findIndex(x => x.id === c.id || (x.nombre && c.nombre && x.nombre.toLowerCase() === c.nombre.toLowerCase()));
      if (idx > -1) snap.clientes[idx] = c;
      else snap.clientes.push(c);
    } else if (evType === 'CLIENT_DELETED' && event.clienteId) {
      snap.clientes = snap.clientes.filter(x => x.id !== event.clienteId);
    } else if (evType === 'EXPENSES_SYNC' && Array.isArray(event.gastos)) {
      snap.gastos = event.gastos;
    } else if (evType === 'NOTE_SAVED' && event.nota) {
      const n = event.nota;
      const idx = snap.notasInternas.findIndex(x => x.id === n.id || (n.alertKey && x.alertKey === n.alertKey));
      if (idx > -1) snap.notasInternas[idx] = n;
      else snap.notasInternas.push(n);
    } else if (evType === 'NOTE_DELETED' && event.noteId) {
      snap.notasInternas = snap.notasInternas.filter(x => x.id !== event.noteId);
    } else if (evType === 'NOTES_SYNC' && Array.isArray(event.notasInternas)) {
      snap.notasInternas = event.notasInternas;
    } else if (evType === 'META_MENSUAL_UPDATED' && typeof event.metaMensual === 'number') {
      snap.metaMensual = event.metaMensual;
    } else if (evType === 'FINANCE_SETTINGS_SYNC') {
      if (Array.isArray(event.distribucionesDiarias)) snap.distribucionesDiarias = event.distribucionesDiarias;
      if (Array.isArray(event.distribucionesJuguetes)) snap.distribucionesJuguetes = event.distribucionesJuguetes;
      if (event.ajustesSaldo) snap.ajustesSaldo = event.ajustesSaldo;
      if (Array.isArray(event.gastos)) snap.gastos = event.gastos;
    }
  }

  // Sincronizar snapshot completo adjunto por el emisor
  if (fullSnapshot && typeof fullSnapshot === 'object') {
    if (Array.isArray(fullSnapshot.ventas)) {
      snap.ventas = fullSnapshot.ventas;
    }
    if (Array.isArray(fullSnapshot.pedidos)) {
      snap.pedidos = fullSnapshot.pedidos;
    }
    if (Array.isArray(fullSnapshot.productos)) {
      snap.productos = fullSnapshot.productos;
    }
    if (Array.isArray(fullSnapshot.clientes)) {
      snap.clientes = fullSnapshot.clientes;
    }
    if (Array.isArray(fullSnapshot.gastos)) {
      snap.gastos = fullSnapshot.gastos;
    }
    if (Array.isArray(fullSnapshot.notasInternas)) {
      snap.notasInternas = fullSnapshot.notasInternas;
    }
    if (typeof fullSnapshot.metaMensual === 'number' && fullSnapshot.metaMensual > 0) {
      snap.metaMensual = fullSnapshot.metaMensual;
    }
    if (Array.isArray(fullSnapshot.distribucionesDiarias)) {
      snap.distribucionesDiarias = fullSnapshot.distribucionesDiarias;
    }
    if (Array.isArray(fullSnapshot.distribucionesJuguetes)) {
      snap.distribucionesJuguetes = fullSnapshot.distribucionesJuguetes;
    }
    if (fullSnapshot.ajustesSaldo && typeof fullSnapshot.ajustesSaldo === 'object') {
      snap.ajustesSaldo = fullSnapshot.ajustesSaldo;
    }
  }

  persistRooms();

  const activeList = getActiveDevicesList(room, now);

  // Transmitir inmediatamente vía Server-Sent Events (SSE) en tiempo real (< 15ms)
  broadcastToSseClients(room.code, {
    type: 'EVENT',
    version: room.version,
    event: recordedEvent,
    snapshot: room.snapshot,
    activeDevices: activeList.length,
    devices: activeList
  });

  res.json({
    success: true,
    version: room.version,
    activeDevices: activeList.length,
    devices: activeList,
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
  const resolvedName = deviceName || 'Dispositivo ' + devId.slice(-4);
  room.devices[devId] = {
    name: resolvedName,
    lastSeen: Date.now()
  };

  const activeList = getActiveDevicesList(room);

  // Enviar estado inicial y snapshot actual al conectarse
  const initialPayload = {
    type: 'INIT',
    code: room.code,
    version: room.version,
    creatorDeviceId: room.creatorDeviceId,
    activeDevices: activeList.length,
    devices: activeList,
    snapshot: room.snapshot
  };
  res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

  // Heartbeat ping cada 15 segundos para evitar timeouts de proxies y mantener presencia
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
      if (room.devices[devId]) room.devices[devId].lastSeen = Date.now();
    } catch (e) {
      clearInterval(heartbeat);
    }
  }, 15000);

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

  const activeList = getActiveDevicesList(room);

  res.json({
    success: true,
    code: room.code,
    version: room.version,
    creatorDeviceId: room.creatorDeviceId,
    activeDevices: activeList.length,
    devices: activeList,
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

  const activeList = getActiveDevicesList(room);

  res.json({
    exists: true,
    code: room.code,
    version: room.version,
    creatorDeviceId: room.creatorDeviceId,
    devices: activeList,
    activeCount: activeList.length,
    snapshotSummary: {
      ventasCount: room.snapshot?.ventas?.length || 0,
      pedidosCount: room.snapshot?.pedidos?.length || 0,
      productosCount: room.snapshot?.productos?.length || 0,
      gastosCount: room.snapshot?.gastos?.length || 0,
      notasCount: room.snapshot?.notasInternas?.length || 0
    }
  });
});

// =======================================================
// SISTEMA DE NOTIFICACIONES PUSH (WEB PUSH VAPID + SSE)
// =======================================================
const vapidFile = path.join(__dirname, '.vapid_keys.json');
const subsFile = path.join(__dirname, '.push_subscriptions.json');

let vapidKeys = null;
try {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapidKeys = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY
    };
  } else if (fs.existsSync(vapidFile)) {
    vapidKeys = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
  } else {
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(vapidFile, JSON.stringify(vapidKeys, null, 2));
  }
  webpush.setVapidDetails('mailto:admin@printcenterpro.local', vapidKeys.publicKey, vapidKeys.privateKey);
} catch (err) {
  console.warn('VAPID setup note:', err.message);
}

let pushSubscriptions = [];
try {
  if (fs.existsSync(subsFile)) {
    pushSubscriptions = JSON.parse(fs.readFileSync(subsFile, 'utf8'));
  }
} catch (e) {
  pushSubscriptions = [];
}

function persistPushSubscriptions() {
  try {
    fs.writeFileSync(subsFile, JSON.stringify(pushSubscriptions, null, 2));
  } catch (e) {}
}

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({
    available: Boolean(vapidKeys?.publicKey),
    publicKey: vapidKeys?.publicKey || null,
    activeSubscriptions: pushSubscriptions.length
  });
});

app.post('/api/push/subscribe', (req, res) => {
  const { subscription, deviceId, deviceName, role, roomCode } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }

  const normCode = roomCode ? String(roomCode).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '') : '';
  const idx = pushSubscriptions.findIndex(s => s.endpoint === subscription.endpoint);
  const entry = {
    endpoint: subscription.endpoint,
    subscription,
    deviceId: deviceId || null,
    deviceName: deviceName || 'Dispositivo',
    role: role || 'admin',
    roomCode: normCode,
    updatedAt: Date.now()
  };

  if (idx > -1) pushSubscriptions[idx] = entry;
  else pushSubscriptions.push(entry);

  persistPushSubscriptions();
  res.json({ success: true, totalSubscriptions: pushSubscriptions.length });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint, deviceId } = req.body || {};
  const before = pushSubscriptions.length;
  pushSubscriptions = pushSubscriptions.filter(s => {
    if (endpoint && s.endpoint === endpoint) return false;
    if (deviceId && s.deviceId === deviceId) return false;
    return true;
  });
  if (pushSubscriptions.length !== before) persistPushSubscriptions();
  res.json({ success: true, totalSubscriptions: pushSubscriptions.length });
});

app.post('/api/push/send-alert', async (req, res) => {
  const { title, body, tag, roomCode, targetRole = 'admin', data = {}, excludeDeviceId } = req.body || {};
  if (!title || !body) {
    return res.status(400).json({ error: 'title y body son requeridos' });
  }

  const normCode = roomCode ? String(roomCode).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '') : '';
  const payloadObj = {
    title,
    body,
    tag: tag || 'pcp-admin-alert',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    timestamp: Date.now(),
    data: {
      tab: data.tab || 'dashboard',
      alertType: data.alertType || 'general',
      noteId: data.noteId || null,
      targetId: data.targetId || null,
      urgency: data.urgency || 'warning',
      actionLabel: data.actionLabel || 'Ver ahora'
    }
  };

  // 1. Broadcast SSE instantáneo en la sala si hay dispositivos conectados
  if (normCode) {
    broadcastToSseClients(normCode, {
      type: 'EVENT',
      event: {
        type: 'ADMIN_PUSH_ALERT',
        eventId: 'push_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        deviceId: excludeDeviceId || 'server',
        targetRole,
        payload: payloadObj,
        timestamp: Date.now()
      }
    });
  }

  // 2. Dispatch real W3C Web Push to registered admin subscriptions
  const candidates = pushSubscriptions.filter(s => {
    if (targetRole && s.role && s.role !== targetRole) return false;
    if (normCode && s.roomCode && s.roomCode !== normCode) return false;
    return true;
  });

  let sentCount = 0;
  let removed = false;
  await Promise.all(candidates.map(async (subEntry) => {
    try {
      await webpush.sendNotification(subEntry.subscription, JSON.stringify(payloadObj));
      sentCount++;
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== subEntry.endpoint);
        removed = true;
      }
    }
  }));

  if (removed) persistPushSubscriptions();

  res.json({
    success: true,
    sseBroadcasted: Boolean(normCode),
    pushSent: sentCount,
    registeredTargets: candidates.length
  });
});

// =======================================================
// INTELIGENCIA ARTIFICIAL GEMINI SERVER-SIDE (PRINTCENTER IA)
// =======================================================
let geminiClient = null;
if (process.env.GEMINI_API_KEY) {
  try {
    geminiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
    });
  } catch (e) {
    console.warn('Gemini init note:', e.message);
  }
}

app.post('/api/ai/chat', async (req, res) => {
  const { query, mode = 'admin', history = [], context = {}, tabHint = '' } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Consulta requerida' });
  }

  if (!geminiClient) {
    return res.json({
      ok: true,
      mode: 'local-fallback',
      fallback: true
    });
  }

  try {
    const isAdmin = mode === 'admin';
    const systemInstruction = isAdmin
      ? `Eres PrintCenter IA, el analista financiero, de inventario y operaciones de PrintCenterPro POS (centro de impresión, copiado y papelería).
Hablas siempre en español de México, claro, directo, ejecutivo y accionable. Usa formato limpio con negritas (**texto**) y viñetas breves cuando ayuden.
Tienes acceso a los datos EN VIVO de la tienda proporcionados en el contexto JSON. Basa todas tus cifras estrictamente en ese contexto (nunca inventes números).
Si detectas pedidos pendientes urgentes, niveles críticos de stock o recados/mensajes internos del equipo sin atender, menciónalos proactivamente y sugiere ir a la pestaña correcta ("pedidos", "inventario", "reportes", "recursos", "clientes" o "dashboard").
Mantén "answer" conciso (máximo 140 palabras), llena "cards" con 2 a 4 KPIs numéricos clave cuando aplique, y define "action" si conviene un botón de navegación directa.`
      : `Eres PrintCenter Assistant, el asistente amable de mostrador de PrintCenterPro POS para empleados.
Hablas en español de México, práctico y rápido. Ayudas a consultar existencias, precios de venta, estado de pedidos e instrucciones operativas o mensajes del tablero interno.
NUNCA reveles márgenes de costo unitario privado ni utilidad neta al rol mostrador si no es necesario; enfócate en precio al público, stock disponible, entregas pendientes y recados.
Mantén "answer" conciso (máximo 110 palabras), usa "cards" para mostrar existencias o precios clave, y "action" para dirigir al módulo adecuado ("ventas", "pedidos", "inventario", "dashboard").`;

    const trimmedHistory = Array.isArray(history) ? history.slice(-6).map(m => ({
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(m.text || '').slice(0, 500) }]
    })) : [];

    const tabLine = tabHint ? `MÓDULO/PESTAÑA ACTIVA DEL USUARIO: ${tabHint}\n` : '';
    const contextPrompt = `${tabLine}CONTEXTO EN VIVO DEL NEGOCIO (${new Date().toLocaleString('es-MX')}):\n${JSON.stringify(context)}\n\nCONSULTA DEL USUARIO:\n${query}`;
    const contents = [
      ...trimmedHistory,
      { role: 'user', parts: [{ text: contextPrompt }] }
    ];

    const response = await geminiClient.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            answer: { type: Type.STRING },
            urgency: { type: Type.STRING, enum: ['info', 'warning', 'critical'] },
            cards: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  label: { type: Type.STRING },
                  value: { type: Type.STRING },
                  tone: { type: Type.STRING, enum: ['accent', 'success', 'warning', 'danger', 'neutral'] }
                },
                required: ['label', 'value']
              }
            },
            action: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                tab: { type: Type.STRING }
              },
              required: ['label', 'tab']
            }
          },
          required: ['answer']
        }
      }
    });

    const rawText = (response.text || '{}').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(rawText);
    return res.json({
      ok: true,
      mode: 'gemini-4-hydrogen',
      fallback: false,
      data: parsed
    });
  } catch (err) {
    console.warn('Gemini chat fallback:', err.message);
    return res.json({
      ok: true,
      mode: 'local-fallback',
      fallback: true,
      reason: 'gemini_unavailable'
    });
  }
});

// Servir frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PrintCenterPro server (${APP_VERSION}) running on http://0.0.0.0:${PORT}`);
});
