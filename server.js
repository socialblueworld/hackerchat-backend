const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 20 * 1024 * 1024   // 20MB max file
});

// ── Static files ──
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── File upload (multer) ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename:    (req, file, cb) => {
    const unique = Date.now() + '_' + Math.random().toString(36).slice(2);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname, size: req.file.size, mimetype: req.file.mimetype });
});

// ── Room state ──
// rooms[roomKey] = { members: { socketId: {name, color} }, files: [] }
const rooms = {};

function roomKey(ip, code) {
  const raw = ip + '::' + (code || '');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function getRoomMembers(key) {
  if (!rooms[key]) return [];
  return Object.values(rooms[key].members);
}

// ── Socket.IO ──
io.on('connection', (socket) => {

  socket.on('join', ({ name, ip, code }) => {
    if (!name || !ip) return;

    const key = roomKey(ip, code);
    socket.join(key);
    socket.data = { name, key, color: colorFor(name) };

    if (!rooms[key]) rooms[key] = { members: {}, files: [] };
    rooms[key].members[socket.id] = { name, color: colorFor(name) };

    // Send existing files to new joiner
    socket.emit('files_sync', rooms[key].files);

    // Tell everyone in room
    io.to(key).emit('members_update', getRoomMembers(key));
    socket.to(key).emit('system', { text: `${name} joined the room`, type: 'join' });

    // Tell joiner their room info
    socket.emit('joined', { ip, hasCode: !!code });
  });

  socket.on('message', ({ text }) => {
    const { name, key, color } = socket.data || {};
    if (!name || !key || !text) return;
    const time = nowTime();
    io.to(key).emit('message', { name, text, time, color });
  });

  socket.on('file_share', ({ url, fileName, fileSize, mimeType }) => {
    const { name, key, color } = socket.data || {};
    if (!name || !key) return;
    const time = nowTime();
    const fileObj = { url, fileName, fileSize, mimeType, sender: name, time };
    rooms[key].files.push(fileObj);
    io.to(key).emit('file_message', { name, color, time, file: fileObj });
  });

  socket.on('disconnect', () => {
    const { name, key } = socket.data || {};
    if (!key || !rooms[key]) return;
    delete rooms[key].members[socket.id];
    if (Object.keys(rooms[key].members).length === 0) {
      delete rooms[key];  // cleanup empty room
    } else {
      io.to(key).emit('members_update', getRoomMembers(key));
      io.to(key).emit('system', { text: `${name} left the room`, type: 'leave' });
    }
  });
});

// ── Helpers ──
const COLORS = ['#ff2244','#1a6fff','#00ff88','#ff8800','#cc44ff','#ffdd00','#ff44aa','#00ddff'];
function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return COLORS[Math.abs(h) % COLORS.length];
}
function nowTime() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ── Start ──
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`HackerChat running on port ${PORT}`));
