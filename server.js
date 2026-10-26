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
    version: 'V20.26.11.010 Update',
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
      snapshot: null
    };
  }
  return syncRooms[normCode];
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

  // Si la sala aún no tiene snapshot y este dispositivo aporta datos
  if (!room.snapshot && initialData && Object.keys(initialData).length > 0) {
    room.snapshot = initialData;
    room.version = 1;
    persistRooms();
  }

  const activeDevices = Object.values(room.devices).filter(d => now - d.lastSeen < 60000).length;

  res.json({
    success: true,
    code: room.code,
    version: room.version,
    activeDevices,
    snapshot: room.snapshot || null,
    assignedDeviceId: devId
  });
});

// 2. Consulta de cambios en tiempo real (Polling eficiente)
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
    // Si los eventos son continuos, mandar eventos
    if (pendingEvents.length > 0 && pendingEvents[0].version <= clientVer + 1) {
      return res.json({
        hasUpdates: true,
        type: 'EVENTS',
        version: room.version,
        activeDevices,
        events: pendingEvents
      });
    } else {
      // Si el cliente está muy desfasado, mandar snapshot completo
      return res.json({
        hasUpdates: true,
        type: 'SNAPSHOT',
        version: room.version,
        activeDevices,
        snapshot: room.snapshot
      });
    }
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

  if (event) {
    const recordedEvent = {
      ...event,
      version: room.version,
      deviceId,
      deviceName: deviceName || room.devices[deviceId]?.name || 'Otro dispositivo',
      timestamp: now
    };
    room.events.push(recordedEvent);
    if (room.events.length > 250) {
      room.events = room.events.slice(-250);
    }
  }

  if (fullSnapshot) {
    room.snapshot = fullSnapshot;
  }

  persistRooms();

  const activeDevices = Object.values(room.devices).filter(d => now - d.lastSeen < 60000).length;

  res.json({
    success: true,
    version: room.version,
    activeDevices
  });
});

// 4. Estado de los dispositivos enlazados
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
    activeCount: activeList.length
  });
});

// Servir frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PrintCenterPro server running on http://0.0.0.0:${PORT}`);
});
