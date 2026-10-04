const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const archiver = require('archiver');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

const PORT = process.env.PANEL_PORT || 8080;
const JWT_SECRET = uuidv4();
const DATA_DIR = path.join(__dirname, 'data');
const SERVERS_DIR = path.join(__dirname, 'servers');
const BACKUPS_DIR = path.join(__dirname, 'backups');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

[DATA_DIR, SERVERS_DIR, BACKUPS_DIR, UPLOAD_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Database Helper ──────────────────────────────────────────
function loadDB(name) {
    const f = path.join(DATA_DIR, `${name}.json`);
    if (!fs.existsSync(f)) { fs.writeFileSync(f, '[]'); return []; }
    return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function saveDB(name, data) {
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}
function loadConfig(name, def = {}) {
    const f = path.join(DATA_DIR, `${name}.json`);
    if (!fs.existsSync(f)) { fs.writeFileSync(f, JSON.stringify(def, null, 2)); return def; }
    return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function saveConfig(name, data) {
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

// ── Init Default Admin ───────────────────────────────────────
if (loadDB('users').length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    saveDB('users', [{ id: uuidv4(), username: 'admin', password: hash, email: 'admin@panel.local', role: 'admin', createdAt: new Date().toISOString() }]);
    console.log('✅ Default admin: admin / admin123');
}

// ── Middleware ────────────────────────────────────────────────
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try { req.user = jwt.verify(token, JWT_SECRET); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
}
function adminMiddleware(req, res, next) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
}

// ── Minecraft Process Manager ────────────────────────────────
class MCServer {
    constructor(id) {
        this.id = id;
        this.process = null;
        this.consoleLog = [];
        this.players = new Set();
        this.status = 'offline';
        this.startTime = null;
        this.maxLogLines = 2000;
        this.dir = path.join(SERVERS_DIR, id);
        fs.mkdirSync(this.dir, { recursive: true });
    }

    get config() {
        const servers = loadDB('servers');
        return servers.find(s => s.id === this.id) || {};
    }

    start() {
        if (this.process) return false;
        const cfg = this.config;
        if (!cfg) return false;

        const javaPath = cfg.javaPath || 'java';
        const maxRam = cfg.maxRam || '2G';
        const minRam = cfg.minRam || '1G';
        const jarFile = cfg.jarFile || 'server.jar';
        const jarPath = path.join(this.dir, jarFile);

        if (!fs.existsSync(jarPath)) {
            this.addLog(`[PANEL] JAR file not found: ${jarFile}`);
            return false;
        }

        // Accept EULA
        const eulaPath = path.join(this.dir, 'eula.txt');
        if (!fs.existsSync(eulaPath) || !fs.readFileSync(eulaPath, 'utf8').includes('eula=true')) {
            fs.writeFileSync(eulaPath, 'eula=true\n');
        }

        const jvmArgs = cfg.jvmArgs || `-Xms${minRam} -Xmx${maxRam}`;
        const args = [...jvmArgs.split(' '), '-jar', jarFile, 'nogui'];

        try {
            this.process = spawn(javaPath, args, { cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'] });
            this.status = 'starting';
            this.startTime = Date.now();
            this.players.clear();

            this.process.stdout.on('data', d => {
                const lines = d.toString().split('\n').filter(l => l.trim());
                lines.forEach(l => {
                    this.addLog(l);
                    this.parseLogLine(l);
                });
                io.emit('console:' + this.id, this.consoleLog.slice(-100));
                io.emit('serverStatus:' + this.id, this.getStatus());
            });

            this.process.stderr.on('data', d => {
                const lines = d.toString().split('\n').filter(l => l.trim());
                lines.forEach(l => this.addLog('[STDERR] ' + l));
                io.emit('console:' + this.id, this.consoleLog.slice(-100));
            });

            this.process.on('close', code => {
                this.status = 'offline';
                this.process = null;
                this.players.clear();
                this.addLog(`[PANEL] Server stopped (code: ${code})`);
                io.emit('console:' + this.id, this.consoleLog.slice(-100));
                io.emit('serverStatus:' + this.id, this.getStatus());

                // Auto restart
                if (cfg.autoRestart && code !== 0) {
                    this.addLog('[PANEL] Auto-restarting in 5s...');
                    setTimeout(() => this.start(), 5000);
                }
            });

            this.process.on('error', err => {
                this.addLog(`[PANEL] Error: ${err.message}`);
                this.status = 'offline';
                this.process = null;
            });

            return true;
        } catch (err) {
            this.addLog(`[PANEL] Failed to start: ${err.message}`);
            return false;
        }
    }

    stop() {
        if (!this.process) return false;
        this.sendCommand('stop');
        setTimeout(() => {
            if (this.process) {
                this.process.kill('SIGTERM');
                setTimeout(() => { if (this.process) this.process.kill('SIGKILL'); }, 10000);
            }
        }, 15000);
        return true;
    }

    kill() {
        if (!this.process) return false;
        this.process.kill('SIGKILL');
        this.process = null;
        this.status = 'offline';
        return true;
    }

    restart() {
        this.stop();
        const checkStop = setInterval(() => {
            if (this.status === 'offline') {
                clearInterval(checkStop);
                setTimeout(() => this.start(), 2000);
            }
        }, 1000);
        setTimeout(() => clearInterval(checkStop), 30000);
        return true;
    }

    sendCommand(cmd) {
        if (!this.process) return false;
        this.process.stdin.write(cmd + '\n');
        this.addLog(`[CMD] > ${cmd}`);
        io.emit('console:' + this.id, this.consoleLog.slice(-100));
        return true;
    }

    addLog(line) {
        this.consoleLog.push({ time: new Date().toISOString(), text: line });
        if (this.consoleLog.length > this.maxLogLines) this.consoleLog.shift();
    }

    parseLogLine(line) {
        // Parse player join/leave
        const joinMatch = line.match(/(\w+) joined the game/);
        if (joinMatch) this.players.add(joinMatch[1]);

        const leaveMatch = line.match(/(\w+) left the game/);
        if (leaveMatch) this.players.delete(leaveMatch[1]);

        if (line.includes('Done') && line.includes('For help')) {
            this.status = 'online';
        }
    }

    getStatus() {
        const cfg = this.config;
        return {
            id: this.id,
            name: cfg.name || this.id,
            status: this.status,
            players: Array.from(this.players),
            playerCount: this.players.size,
            maxPlayers: cfg.maxPlayers || 20,
            uptime: this.startTime ? Date.now() - this.startTime : 0,
            port: cfg.port || 25565,
            version: cfg.version || 'Unknown',
            javaVersion: cfg.javaVersion || 'Default'
        };
    }
}

// Server instances
const mcServers = {};
function getMC(id) {
    if (!mcServers[id]) mcServers[id] = new MCServer(id);
    return mcServers[id];
}

// Restore servers on startup
loadDB('servers').forEach(s => getMC(s.id));

// ── System Stats ─────────────────────────────────────────────
function getSystemStats() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    return {
        cpu: { cores: cpus.length, model: cpus[0]?.model || 'Unknown', load: loadAvg },
        ram: { total: totalMem, free: freeMem, used: totalMem - freeMem, percent: ((totalMem - freeMem) / totalMem * 100).toFixed(1) },
        uptime: os.uptime(),
        platform: os.platform(),
        hostname: os.hostname(),
        network: Object.entries(os.networkInterfaces()).reduce((acc, [name, addrs]) => {
            addrs.filter(a => !a.internal && a.family === 'IPv4').forEach(a => { acc[name] = a.address; });
            return acc;
        }, {})
    };
}

// ── AUTH ROUTES ───────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const users = loadDB('users');
    const user = users.find(u => u.username === username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
    }
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    // Log activity
    const logs = loadDB('activity_logs');
    logs.push({ id: uuidv4(), userId: user.id, action: 'login', ip: req.ip, time: new Date().toISOString() });
    saveDB('activity_logs', logs.slice(-1000));
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, email: user.email } });
});

app.post('/api/auth/register', authMiddleware, adminMiddleware, (req, res) => {
    const { username, password, email, role } = req.body;
    const users = loadDB('users');
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'نام کاربری تکراری' });
    const user = { id: uuidv4(), username, password: bcrypt.hashSync(password, 10), email, role: role || 'user', createdAt: new Date().toISOString() };
    users.push(user);
    saveDB('users', users);
    res.json({ success: true, user: { id: user.id, username, email, role } });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
    const users = loadDB('users');
    const user = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ id: user.id, username: user.username, email: user.email, role: user.role });
});

app.put('/api/auth/password', authMiddleware, (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const users = loadDB('users');
    const idx = users.findIndex(u => u.id === req.user.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    if (!bcrypt.compareSync(oldPassword, users[idx].password)) return res.status(400).json({ error: 'رمز فعلی اشتباه' });
    users[idx].password = bcrypt.hashSync(newPassword, 10);
    saveDB('users', users);
    res.json({ success: true });
});

// ── SERVERS CRUD ──────────────────────────────────────────────
app.get('/api/servers', authMiddleware, (req, res) => {
    let servers = loadDB('servers');
    if (req.user.role !== 'admin') {
        servers = servers.filter(s => s.ownerId === req.user.id || (s.users || []).includes(req.user.id));
    }
    const result = servers.map(s => {
        const mc = getMC(s.id);
        return { ...s, ...mc.getStatus() };
    });
    res.json(result);
});

app.post('/api/servers', authMiddleware, adminMiddleware, (req, res) => {
    const { name, port, maxRam, minRam, maxPlayers, version, type, javaPath, jvmArgs, javaVersion } = req.body;
    const servers = loadDB('servers');
    const id = uuidv4().substring(0, 8);
    const server = {
        id, name: name || `Server-${id}`,
        port: port || 25565,
        maxRam: maxRam || '2G', minRam: minRam || '1G',
        maxPlayers: maxPlayers || 20,
        version: version || '1.20.4', type: type || 'paper',
        javaPath: javaPath || 'java', jvmArgs: jvmArgs || '',
        javaVersion: javaVersion || '17',
        jarFile: 'server.jar',
        ownerId: req.user.id, users: [],
        autoRestart: false,
        createdAt: new Date().toISOString()
    };
    servers.push(server);
    saveDB('servers', servers);
    fs.mkdirSync(path.join(SERVERS_DIR, id), { recursive: true });
    res.json({ success: true, server });
});

app.put('/api/servers/:id', authMiddleware, (req, res) => {
    const servers = loadDB('servers');
    const idx = servers.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Server not found' });
    if (req.user.role !== 'admin' && servers[idx].ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    Object.assign(servers[idx], req.body);
    saveDB('servers', servers);
    res.json({ success: true, server: servers[idx] });
});

app.delete('/api/servers/:id', authMiddleware, adminMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    mc.kill();
    let servers = loadDB('servers');
    servers = servers.filter(s => s.id !== req.params.id);
    saveDB('servers', servers);
    // Don't delete files, just remove from DB
    res.json({ success: true });
});

// ── SERVER ACTIONS ────────────────────────────────────────────
app.post('/api/servers/:id/start', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    const ok = mc.start();
    res.json({ success: ok });
});
app.post('/api/servers/:id/stop', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    const ok = mc.stop();
    res.json({ success: ok });
});
app.post('/api/servers/:id/restart', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    const ok = mc.restart();
    res.json({ success: ok });
});
app.post('/api/servers/:id/kill', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    const ok = mc.kill();
    res.json({ success: ok });
});
app.post('/api/servers/:id/command', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    const ok = mc.sendCommand(req.body.command);
    res.json({ success: ok });
});
app.get('/api/servers/:id/console', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    res.json(mc.consoleLog.slice(-200));
});
app.get('/api/servers/:id/status', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    res.json(mc.getStatus());
});

// ── FILE MANAGER ──────────────────────────────────────────────
app.get('/api/servers/:id/files', authMiddleware, (req, res) => {
    const dir = path.join(SERVERS_DIR, req.params.id, req.query.path || '');
    if (!dir.startsWith(SERVERS_DIR)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const items = fs.readdirSync(dir).map(name => {
            const stat = fs.statSync(path.join(dir, name));
            return { name, isDir: stat.isDirectory(), size: stat.size, modified: stat.mtime };
        }).sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name));
        res.json(items);
    } catch { res.json([]); }
});

app.get('/api/servers/:id/files/read', authMiddleware, (req, res) => {
    const filePath = path.join(SERVERS_DIR, req.params.id, req.query.path || '');
    if (!filePath.startsWith(SERVERS_DIR)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const stat = fs.statSync(filePath);
        if (stat.size > 5 * 1024 * 1024) return res.status(400).json({ error: 'File too large' });
        res.json({ content: fs.readFileSync(filePath, 'utf8'), size: stat.size });
    } catch { res.status(404).json({ error: 'File not found' }); }
});

app.post('/api/servers/:id/files/write', authMiddleware, (req, res) => {
    const filePath = path.join(SERVERS_DIR, req.params.id, req.body.path || '');
    if (!filePath.startsWith(SERVERS_DIR)) return res.status(403).json({ error: 'Forbidden' });
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, req.body.content);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/servers/:id/files/mkdir', authMiddleware, (req, res) => {
    const dirPath = path.join(SERVERS_DIR, req.params.id, req.body.path || '');
    if (!dirPath.startsWith(SERVERS_DIR)) return res.status(403).json({ error: 'Forbidden' });
    try { fs.mkdirSync(dirPath, { recursive: true }); res.json({ success: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/servers/:id/files/delete', authMiddleware, (req, res) => {
    const target = path.join(SERVERS_DIR, req.params.id, req.body.path || '');
    if (!target.startsWith(SERVERS_DIR)) return res.status(403).json({ error: 'Forbidden' });
    try { fs.rmSync(target, { recursive: true, force: true }); res.json({ success: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/servers/:id/files/rename', authMiddleware, (req, res) => {
    const oldPath = path.join(SERVERS_DIR, req.params.id, req.body.oldPath);
    const newPath = path.join(SERVERS_DIR, req.params.id, req.body.newPath);
    if (!oldPath.startsWith(SERVERS_DIR) || !newPath.startsWith(SERVERS_DIR)) return res.status(403).json({ error: 'Forbidden' });
    try { fs.renameSync(oldPath, newPath); res.json({ success: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/servers/:id/files/upload', authMiddleware, upload.array('files'), (req, res) => {
    const destDir = path.join(SERVERS_DIR, req.params.id, req.body.path || '');
    if (!destDir.startsWith(SERVERS_DIR)) return res.status(403).json({ error: 'Forbidden' });
    fs.mkdirSync(destDir, { recursive: true });
    try {
        (req.files || []).forEach(f => {
            fs.renameSync(f.path, path.join(destDir, f.originalname));
        });
        res.json({ success: true, count: (req.files || []).length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/servers/:id/files/download', authMiddleware, (req, res) => {
    const filePath = path.join(SERVERS_DIR, req.params.id, req.query.path || '');
    if (!filePath.startsWith(SERVERS_DIR) || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    res.download(filePath);
});

app.post('/api/servers/:id/files/zip', authMiddleware, (req, res) => {
    const sourcePath = path.join(SERVERS_DIR, req.params.id, req.body.path || '');
    const zipPath = sourcePath + '.zip';
    if (!sourcePath.startsWith(SERVERS_DIR)) return res.status(403).json({ error: 'Forbidden' });
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip');
    archive.pipe(output);
    if (fs.statSync(sourcePath).isDirectory()) {
        archive.directory(sourcePath, false);
    } else {
        archive.file(sourcePath, { name: path.basename(sourcePath) });
    }
    archive.finalize();
    output.on('close', () => res.json({ success: true, zipPath: req.body.path + '.zip' }));
});

app.post('/api/servers/:id/files/unzip', authMiddleware, (req, res) => {
    const zipPath = path.join(SERVERS_DIR, req.params.id, req.body.path || '');
    const destDir = path.dirname(zipPath);
    if (!zipPath.startsWith(SERVERS_DIR)) return res.status(403).json({ error: 'Forbidden' });
    fs.createReadStream(zipPath).pipe(require('unzipper').Extract({ path: destDir }))
        .on('close', () => res.json({ success: true }))
        .on('error', err => res.status(500).json({ error: err.message }));
});

// ── MINECRAFT INSTALLER ───────────────────────────────────────
app.post('/api/servers/:id/install', authMiddleware, adminMiddleware, async (req, res) => {
    const { type, version } = req.body;
    const serverDir = path.join(SERVERS_DIR, req.params.id);
    let downloadUrl = '';

    switch (type) {
        case 'paper':
            const paperRes = await fetch(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds`);
            const paperData = await paperRes.json();
            const latestBuild = paperData.builds[paperData.builds.length - 1];
            downloadUrl = `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${latestBuild.build}/downloads/${latestBuild.downloads.application.name}`;
            break;
        case 'purpur':
            const purpurRes = await fetch(`https://api.purpurmc.org/v2/purpur/${version}`);
            const purpurData = await purpurRes.json();
            downloadUrl = `https://api.purpurmc.org/v2/purpur/${version}/${purpurData.builds.latest}/download`;
            break;
        case 'vanilla':
            const manifestRes = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
            const manifest = await manifestRes.json();
            const verInfo = manifest.versions.find(v => v.id === version);
            const verDataRes = await fetch(verInfo.url);
            const verData = await verDataRes.json();
            downloadUrl = verData.downloads.server.url;
            break;
        case 'fabric':
            downloadUrl = `https://meta.fabricmc.net/v2/versions/loader/${version}/0.15.11/1.0.0/server/jar`;
            break;
        default:
            return res.status(400).json({ error: 'Unsupported type' });
    }

    if (!downloadUrl) return res.status(400).json({ error: 'Could not find download URL' });

    // Download
    exec(`curl -L -o "${path.join(serverDir, 'server.jar')}" "${downloadUrl}"`, (err) => {
        if (err) return res.status(500).json({ error: err.message });

        // Update server config
        const servers = loadDB('servers');
        const idx = servers.findIndex(s => s.id === req.params.id);
        if (idx !== -1) {
            servers[idx].type = type;
            servers[idx].version = version;
            servers[idx].jarFile = 'server.jar';
            saveDB('servers', servers);
        }

        // Set server.properties
        const props = `server-port=${servers[idx]?.port || 25565}\nmotd=§6Minecraft Server\nmax-players=${servers[idx]?.maxPlayers || 20}\nonline-mode=false\n`;
        fs.writeFileSync(path.join(serverDir, 'server.properties'), props);

        res.json({ success: true, type, version });
    });
});

// ── PLAYER MANAGEMENT (via commands) ──────────────────────────
app.post('/api/servers/:id/players/kick', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    const ok = mc.sendCommand(`kick ${req.body.player} ${req.body.reason || ''}`);
    res.json({ success: ok });
});
app.post('/api/servers/:id/players/ban', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    const ok = mc.sendCommand(`ban ${req.body.player} ${req.body.reason || ''}`);
    res.json({ success: ok });
});
app.post('/api/servers/:id/players/unban', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    const ok = mc.sendCommand(`pardon ${req.body.player}`);
    res.json({ success: ok });
});
app.post('/api/servers/:id/players/op', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    const ok = mc.sendCommand(`op ${req.body.player}`);
    res.json({ success: ok });
});
app.post('/api/servers/:id/players/deop', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    const ok = mc.sendCommand(`deop ${req.body.player}`);
    res.json({ success: ok });
});
app.post('/api/servers/:id/players/whitelist/add', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    mc.sendCommand('whitelist on');
    const ok = mc.sendCommand(`whitelist add ${req.body.player}`);
    res.json({ success: ok });
});
app.post('/api/servers/:id/players/whitelist/remove', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    const ok = mc.sendCommand(`whitelist remove ${req.body.player}`);
    res.json({ success: ok });
});
app.post('/api/servers/:id/players/ban-ip', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    const ok = mc.sendCommand(`ban-ip ${req.body.ip}`);
    res.json({ success: ok });
});
app.post('/api/servers/:id/players/unban-ip', authMiddleware, (req, res) => {
    const mc = getMC(req.params.id);
    const ok = mc.sendCommand(`pardon-ip ${req.body.ip}`);
    res.json({ success: ok });
});

// ── SERVER PROPERTIES ─────────────────────────────────────────
app.get('/api/servers/:id/properties', authMiddleware, (req, res) => {
    const propsPath = path.join(SERVERS_DIR, req.params.id, 'server.properties');
    if (!fs.existsSync(propsPath)) return res.json({});
    const content = fs.readFileSync(propsPath, 'utf8');
    const props = {};
    content.split('\n').forEach(line => {
        if (line.startsWith('#') || !line.includes('=')) return;
        const [key, ...val] = line.split('=');
        props[key.trim()] = val.join('=').trim();
    });
    res.json(props);
});

app.put('/api/servers/:id/properties', authMiddleware, (req, res) => {
    const propsPath = path.join(SERVERS_DIR, req.params.id, 'server.properties');
    const content = Object.entries(req.body).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    fs.writeFileSync(propsPath, content);
    res.json({ success: true });
});

// ── BACKUP ────────────────────────────────────────────────────
app.post('/api/servers/:id/backup', authMiddleware, (req, res) => {
    const serverDir = path.join(SERVERS_DIR, req.params.id);
    const backupName = `backup-${req.params.id}-${Date.now()}.zip`;
    const backupPath = path.join(BACKUPS_DIR, backupName);
    const output = fs.createWriteStream(backupPath);
    const archive = archiver('zip');
    archive.pipe(output);
    archive.directory(serverDir, false);
    archive.finalize();
    output.on('close', () => {
        const backups = loadDB('backups');
        backups.push({ id: uuidv4(), serverId: req.params.id, name: backupName, size: fs.statSync(backupPath).size, createdAt: new Date().toISOString() });
        saveDB('backups', backups);
        res.json({ success: true, name: backupName });
    });
});

app.get('/api/servers/:id/backups', authMiddleware, (req, res) => {
    const backups = loadDB('backups').filter(b => b.serverId === req.params.id);
    res.json(backups);
});

app.post('/api/backups/:id/restore', authMiddleware, adminMiddleware, (req, res) => {
    const backups = loadDB('backups');
    const backup = backups.find(b => b.id === req.params.id);
    if (!backup) return res.status(404).json({ error: 'Not found' });
    const backupPath = path.join(BACKUPS_DIR, backup.name);
    const serverDir = path.join(SERVERS_DIR, backup.serverId);
    fs.createReadStream(backupPath).pipe(require('unzipper').Extract({ path: serverDir }))
        .on('close', () => res.json({ success: true }))
        .on('error', err => res.status(500).json({ error: err.message }));
});

app.delete('/api/backups/:id', authMiddleware, adminMiddleware, (req, res) => {
    let backups = loadDB('backups');
    const backup = backups.find(b => b.id === req.params.id);
    if (backup) {
        const backupPath = path.join(BACKUPS_DIR, backup.name);
        fs.unlinkSync(backupPath);
        backups = backups.filter(b => b.id !== req.params.id);
        saveDB('backups', backups);
    }
    res.json({ success: true });
});

app.get('/api/backups/:id/download', authMiddleware, (req, res) => {
    const backups = loadDB('backups');
    const backup = backups.find(b => b.id === req.params.id);
    if (!backup) return res.status(404).json({ error: 'Not found' });
    res.download(path.join(BACKUPS_DIR, backup.name));
});

// ── SCHEDULE ──────────────────────────────────────────────────
app.get('/api/servers/:id/schedules', authMiddleware, (req, res) => {
    const schedules = loadDB('schedules').filter(s => s.serverId === req.params.id);
    res.json(schedules);
});

app.post('/api/servers/:id/schedules', authMiddleware, adminMiddleware, (req, res) => {
    const schedules = loadDB('schedules');
    const schedule = {
        id: uuidv4(), serverId: req.params.id,
        name: req.body.name, action: req.body.action,
        cron: req.body.cron, command: req.body.command,
        enabled: true, createdAt: new Date().toISOString()
    };
    schedules.push(schedule);
    saveDB('schedules', schedules);
    res.json({ success: true, schedule });
});

app.put('/api/schedules/:id', authMiddleware, adminMiddleware, (req, res) => {
    const schedules = loadDB('schedules');
    const idx = schedules.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    Object.assign(schedules[idx], req.body);
    saveDB('schedules', schedules);
    res.json({ success: true });
});

app.delete('/api/schedules/:id', authMiddleware, adminMiddleware, (req, res) => {
    let schedules = loadDB('schedules');
    schedules = schedules.filter(s => s.id !== req.params.id);
    saveDB('schedules', schedules);
    res.json({ success: true });
});

// ── USERS MANAGEMENT (Admin) ──────────────────────────────────
app.get('/api/users', authMiddleware, adminMiddleware, (req, res) => {
    const users = loadDB('users').map(u => ({ id: u.id, username: u.username, email: u.email, role: u.role, createdAt: u.createdAt }));
    res.json(users);
});

app.put('/api/users/:id', authMiddleware, adminMiddleware, (req, res) => {
    const users = loadDB('users');
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    if (req.body.password) req.body.password = bcrypt.hashSync(req.body.password, 10);
    Object.assign(users[idx], req.body);
    saveDB('users', users);
    res.json({ success: true });
});

app.delete('/api/users/:id', authMiddleware, adminMiddleware, (req, res) => {
    let users = loadDB('users');
    users = users.filter(u => u.id !== req.params.id);
    saveDB('users', users);
    res.json({ success: true });
});

// ── SYSTEM & STATS ────────────────────────────────────────────
app.get('/api/system/stats', authMiddleware, (req, res) => {
    res.json(getSystemStats());
});

app.get('/api/activity-logs', authMiddleware, adminMiddleware, (req, res) => {
    res.json(loadDB('activity_logs').slice(-200));
});

// ── JAVA MANAGEMENT ───────────────────────────────────────────
app.get('/api/java/versions', authMiddleware, (req, res) => {
    exec('java -version 2>&1; ls /usr/lib/jvm/ 2>/dev/null || echo "none"', (err, stdout) => {
        const lines = stdout.split('\n').filter(l => l.trim());
        const versions = [];
        lines.forEach(l => {
            const m = l.match(/java-(\d+)/);
            if (m) versions.push(m[0]);
            if (l.includes('version')) versions.unshift(l.trim());
        });
        res.json({ installed: versions, current: lines[0] || 'Unknown' });
    });
});

// ── DATABASE (MySQL) ──────────────────────────────────────────
app.get('/api/databases', authMiddleware, adminMiddleware, (req, res) => {
    exec('mysql -u root -e "SHOW DATABASES;" 2>/dev/null || echo "MySQL not available"', (err, stdout) => {
        const dbs = stdout.split('\n').filter(l => l.trim() && !l.startsWith('Database') && !l.startsWith('+') && !l.includes('MySQL'));
        res.json(dbs);
    });
});

// ── NOTIFICATIONS ─────────────────────────────────────────────
app.get('/api/notifications', authMiddleware, (req, res) => {
    const notifs = loadDB('notifications').filter(n => n.userId === req.user.id || !n.userId);
    res.json(notifs.slice(-50));
});

function notify(userId, type, message, serverId) {
    const notifs = loadDB('notifications');
    notifs.push({ id: uuidv4(), userId, type, message, serverId, read: false, createdAt: new Date().toISOString() });
    saveDB('notifications', notifs.slice(-500));
    io.emit('notification', { type, message, serverId });
}

// ── CRON SCHEDULER ────────────────────────────────────────────
setInterval(() => {
    const schedules = loadDB('schedules');
    const now = new Date();
    schedules.filter(s => s.enabled).forEach(s => {
        // Simple check - in production use proper cron parsing
        try {
            if (cron.validate(s.cron) && cron.schedule(s.cron, () => {
                const mc = getMC(s.serverId);
                switch (s.action) {
                    case 'start': mc.start(); break;
                    case 'stop': mc.stop(); break;
                    case 'restart': mc.restart(); break;
                    case 'command': mc.sendCommand(s.command || 'list'); break;
                    case 'backup':
                        // Trigger backup
                        break;
                }
                notify(null, 'schedule', `Scheduled task "${s.name}" executed`, s.serverId);
            })) {}
        } catch {}
    });
}, 60000);

// ── SOCKET.IO ─────────────────────────────────────────────────
io.on('connection', (socket) => {
    socket.on('subscribeConsole', (serverId) => {
        socket.join('console:' + serverId);
        const mc = getMC(serverId);
        socket.emit('console:' + serverId, mc.consoleLog.slice(-200));
        socket.emit('serverStatus:' + serverId, mc.getStatus());
    });

    socket.on('getStats', () => {
        socket.emit('stats', getSystemStats());
    });
});

// Broadcast stats every 3 seconds
setInterval(() => {
    io.emit('stats', getSystemStats());
    // Broadcast server statuses
    loadDB('servers').forEach(s => {
        const mc = getMC(s.id);
        io.emit('serverStatus:' + s.id, mc.getStatus());
    });
}, 3000);

// ── START ─────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎮 Minecraft Panel running on http://0.0.0.0:${PORT}\n`);
    console.log(`   Default login: admin / admin123\n`);
});