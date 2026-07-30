const path = require('path');
const fs = require('fs');

// Bazı ağlarda (özellikle DPI atlatma araçlarıyla) IPv6 bağlantısı yarım çalışıp
// isteklerin uzun süre asılı kalmasına neden olabiliyor. IPv4'ü önceliklendiriyoruz.
require('dns').setDefaultResultOrder('ipv4first');

const CONFIG_ENV_PATH = path.join(__dirname, 'config.env');
require('dotenv').config({ path: CONFIG_ENV_PATH });

// Paketlenmiş .exe konsolsuz açıldığı için console.log çıktısı hiçbir yerde görünmüyordu.
// Artık aynı satırlar debug.log dosyasına da yazılıyor - sorun olursa o dosyaya bakılabilir.
const DEBUG_LOG_PATH = path.join(__dirname, 'debug.log');
const originalConsoleLog = console.log;
console.log = (...args) => {
    originalConsoleLog(...args);
    try {
        const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
    } catch (e) {}
};

// discord.js-selfbot-v13 içindeki bazı olay işleyicileri (örn. READY işlenirken)
// hata fırlatırsa bu sessizce yutuluyordu, hiçbir yere yazılmıyordu. Artık yakalayıp
// debug.log'a yazıyoruz - asıl kırılma noktasını görebilmek için.
process.on('unhandledRejection', (reason) => {
    console.log(`[YAKALANMAMIŞ HATA] ${reason?.stack || reason}`);
});
process.on('uncaughtException', (error) => {
    console.log(`[YAKALANMAMIŞ İSTİSNA] ${error?.stack || error}`);
});

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { Client } = require('discord.js-selfbot-v13');
const { exec } = require('child_process');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

// --- OTOMATİK GÜNCELLEME ---
// Her yeni sürüm çıkardığında bu numarayı artır ve nexora-panel-updates repo'sundaki
// version.json + dosyaları güncelle. Program açılışta bunu kontrol eder, farklıysa
// dosyaları indirip üzerine yazar ve kendini yeniden başlatır.
const CURRENT_VERSION = '1.3.0';
const UPDATE_REPO_OWNER = 'anilkee';
const UPDATE_REPO_NAME = 'nexora-panel-updates';
const UPDATE_REPO_TOKEN = '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';
const UPDATE_FILES = ['main.js', 'index.html', 'renderer.js', 'mobile.html', 'setup.html'];

async function fetchUpdateRepoFile(filePath) {
    const res = await fetch(
        `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/contents/${filePath}`,
        {
            headers: {
                'Authorization': `Bearer ${UPDATE_REPO_TOKEN}`,
                'Accept': 'application/vnd.github.v3.raw',
                'User-Agent': 'NexoraPanel-Updater'
            }
        }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

async function checkForUpdates() {
    try {
        console.log(`[Güncelleme] Kontrol ediliyor (mevcut: v${CURRENT_VERSION})...`);
        const remote = JSON.parse(await fetchUpdateRepoFile('version.json'));

        if (remote.version === CURRENT_VERSION) {
            console.log('[Güncelleme] Güncel.');
            return;
        }

        console.log(`[Güncelleme] Yeni sürüm bulundu: v${remote.version}. İndiriliyor...`);
        for (const file of UPDATE_FILES) {
            const content = await fetchUpdateRepoFile(file);
            fs.writeFileSync(path.join(__dirname, file), content);
            console.log(`[Güncelleme] ${file} güncellendi.`);
        }

        await dialog.showMessageBox({
            type: 'info',
            title: `✅ Nexora Panel v${remote.version} güncellendi`,
            message: `Yenilikler:\n\n${remote.changelog || '-'}\n\nUygulama şimdi yeniden başlatılacak.`,
            buttons: ['Tamam']
        });

        app.relaunch();
        app.exit();
    } catch (error) {
        console.log(`[Güncelleme] Kontrol edilemedi: ${error.message}`);
    }
}

function isConfigComplete() {
    return Boolean(
        process.env.USER_TOKEN &&
        process.env.LOG_CHANNEL_ID &&
        process.env.CATEGORY_ID &&
        process.env.NEXORA_API_KEY
    );
}

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const CATEGORY_ID = process.env.CATEGORY_ID;
const IGNORED_ROLE_ID = process.env.IGNORED_ROLE_ID;
const ANTICHEAT_ROLE_ID = process.env.ANTICHEAT_ROLE_ID;
const NEXORA_API_KEY = process.env.NEXORA_API_KEY;
const NEXORA_BASE_URL = 'https://nexorascanner.ac/api/v1';

const ignoredIdsString = process.env.IGNORED_IDS || '';
const IGNORED_IDS = ignoredIdsString.split(',').map(id => id.trim()).filter(id => id.length > 0);

const KONTROL_KEYWORD = 'kontrol';

async function findTargetUserId(channel, excludeMessageId) {
    const messagesCollection = await channel.messages.fetch({ limit: 20 });
    const messagesArray = Array.from(messagesCollection.values());
    for (const msg of messagesArray) {
        if (msg.id === excludeMessageId) continue;
        if (msg.author.id === client.user.id || IGNORED_IDS.includes(msg.author.id)) continue;
        if (ANTICHEAT_ROLE_ID && msg.member?.roles?.cache.has(ANTICHEAT_ROLE_ID)) continue;
        return msg.author.id;
    }
    return null;
}

let mainWindow;
const client = new Client({ checkUpdate: false });

let autoReplyEnabled = process.env.AUTO_REPLY_ENABLED === 'true';
let welcomeMessage = process.env.WELCOME_MESSAGE || '';

const DEFAULT_SCAN_MESSAGE = 'Programı çalıştırıp tam ekran ss atar mısınız?';
let scanMessage = process.env.SCAN_MESSAGE || DEFAULT_SCAN_MESSAGE;

// config.env satırı üretir - değer içinde satır sonu/tırnak olsa da güvenle saklanır.
function formatConfigLine(key, value) {
    const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return `${key}="${escaped}"`;
}

// config.env'i { KEY: value } objesi olarak okur (tırnaklı/kaçışlı ya da düz satırları da anlar).
function readConfigEnvAsObject() {
    const result = {};
    try {
        const content = fs.readFileSync(CONFIG_ENV_PATH, 'utf8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const idx = trimmed.indexOf('=');
            if (idx === -1) continue;
            const key = trimmed.slice(0, idx);
            let value = trimmed.slice(idx + 1);
            if (value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1)
                    .replace(/\\n/g, '\n')
                    .replace(/\\"/g, '"')
                    .replace(/\\\\/g, '\\');
            }
            result[key] = value;
        }
    } catch (error) {
        // config.env henüz yoksa (ilk kurulum) boş obje döneriz
    }
    return result;
}

// Panel ayarlarını config.env'e kalıcı olarak yazan genel yardımcı fonksiyon.
function saveConfigValue(key, value) {
    let lines = [];
    try {
        lines = fs.readFileSync(CONFIG_ENV_PATH, 'utf8')
            .split('\n')
            .filter((l) => l.trim() && !l.startsWith(`${key}=`));
    } catch (error) {
        console.log(`[Ayar] config.env okunamadı: ${error.message}`);
    }
    if (value) {
        lines.push(formatConfigLine(key, value));
    }
    try {
        fs.writeFileSync(CONFIG_ENV_PATH, lines.join('\n') + '\n');
    } catch (error) {
        console.log(`[Ayar] ${key} kaydedilemedi: ${error.message}`);
    }
}

function saveWelcomeMessageToConfig(text) {
    welcomeMessage = text;
    saveConfigValue('WELCOME_MESSAGE', text);
    console.log('[Karşılama] Mesaj kaydedildi.');
}

function saveAutoReplyToConfig(status) {
    autoReplyEnabled = status;
    saveConfigValue('AUTO_REPLY_ENABLED', status ? 'true' : '');
    console.log(`[Sistem] Otomatik karşılama durumu kaydedildi: ${status ? "AÇIK" : "KAPALI"}`);
}

function saveScanMessageToConfig(text) {
    scanMessage = text || DEFAULT_SCAN_MESSAGE;
    saveConfigValue('SCAN_MESSAGE', text);
    console.log('[Tarama Mesajı] Mesaj kaydedildi.');
}
const activeTickets = new Set();
const heldTickets = new Set();       // beklemeye alınmış ticket kanal ID'leri
const channelScans = new Map();      // kanal ID -> o kanalda süren "kontrol" tarama kodu
const channelLastLogMessage = new Map(); // kanal ID -> o kanalın en son sonuç log mesajı (ban notu için)
const myTickets = new Set();         // içinde en az bir mesaj yazdığım ticket kanal ID'leri
const warnedCategoryMismatch = new Set(); // kategori ID uyuşmazlığı için tekrar tekrar log basmayı önler
const cheatingFlagged = new Set();    // "cheating" sonucu çıkan ticket kanal ID'leri (panelde kırmızı vurgu için)
const channelLastResult = new Map();   // kanal ID -> { verdict, url } (panelde "Sonuç" butonu için, sadece bu oturumda tamamlanan taramalar)

function flagIfCheating(channelId, result) {
    if (String(result?.verdict).toLowerCase() === 'cheating') {
        cheatingFlagged.add(channelId);
        console.log(`[Tarama] Ticket kırmızı işaretlendi (cheating): ${channelId}`);
        broadcastTicketList();
    }
}

function getTicketChannels() {
    return client.channels.cache
        .filter((ch) => ch.parentId === CATEGORY_ID && myTickets.has(ch.id))
        .map((ch) => {
            const lastResult = channelLastResult.get(ch.id);
            return {
                id: ch.id,
                name: ch.name,
                held: heldTickets.has(ch.id),
                scanCode: channelScans.get(ch.id) || null,
                flagged: cheatingFlagged.has(ch.id),
                resultVerdict: lastResult ? lastResult.verdict : null,
                resultUrl: lastResult ? lastResult.url : null
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

function broadcastTicketList() {
    if (mainWindow) mainWindow.webContents.send('ticket-list', getTicketChannels());
}

async function refreshMyTickets() {
    const categoryChannels = client.channels.cache.filter((ch) => ch.parentId === CATEGORY_ID);
    console.log(`[Ticket] CATEGORY_ID altında ${categoryChannels.size} kanal bulundu.`);
    for (const channel of categoryChannels.values()) {
        try {
            const messages = await channel.messages.fetch({ limit: 50 });
            if (messages.some((m) => m.author.id === client.user.id)) {
                myTickets.add(channel.id);
            }
        } catch (error) {
            console.log(`[Ticket] ${channel.name} geçmişi okunamadı: ${error.message}`);
        }
    }
    console.log(`[Ticket] Başlangıçta panele eklenen ticket sayısı: ${myTickets.size}`);
    broadcastTicketList();
}

ipcMain.on('request-ticket-list', () => broadcastTicketList());
ipcMain.on('request-mobile-url', (event) => {
    if (mainWindow) mainWindow.webContents.send('mobile-url', getMobileUrl());
});
ipcMain.on('request-app-version', (event) => {
    if (mainWindow) mainWindow.webContents.send('app-version', CURRENT_VERSION);
});

ipcMain.on('request-account-settings', (event) => {
    if (mainWindow) {
        mainWindow.webContents.send('account-settings', {
            USER_TOKEN: process.env.USER_TOKEN || '',
            NEXORA_API_KEY: NEXORA_API_KEY || '',
            LOG_CHANNEL_ID: LOG_CHANNEL_ID || '',
            CATEGORY_ID: CATEGORY_ID || '',
            IGNORED_ROLE_ID: IGNORED_ROLE_ID || '',
            ANTICHEAT_ROLE_ID: ANTICHEAT_ROLE_ID || '',
            IGNORED_IDS: ignoredIdsString || ''
        });
    }
});

ipcMain.on('toggle-auto-reply', (event, status) => {
    saveAutoReplyToConfig(status);
});

ipcMain.on('request-auto-reply-status', (event) => {
    if (mainWindow) mainWindow.webContents.send('auto-reply-status', autoReplyEnabled);
});

ipcMain.on('set-welcome-message', (event, text) => {
    saveWelcomeMessageToConfig(text.trim());
});

ipcMain.on('request-welcome-message', (event) => {
    if (mainWindow) mainWindow.webContents.send('welcome-message', welcomeMessage);
});

ipcMain.on('set-scan-message', (event, text) => {
    saveScanMessageToConfig(text.trim());
});

ipcMain.on('request-scan-message', (event) => {
    if (mainWindow) mainWindow.webContents.send('scan-message', scanMessage);
});

// --- AKTİF TARAMA / İPTAL SİSTEMİ ---
const activeScans = new Map(); // kod -> { cancelled: boolean, messages: Message[] }

function registerScan(code) {
    activeScans.set(code, { cancelled: false, messages: [] });
    if (mainWindow) mainWindow.webContents.send('scan-started', { code });
}

function trackScanMessage(code, sentMessage) {
    const scan = activeScans.get(code);
    if (scan) scan.messages.push(sentMessage);
}

function isScanCancelled(code) {
    return activeScans.get(code)?.cancelled === true;
}

function finishScan(code) {
    activeScans.delete(code);
    if (mainWindow) mainWindow.webContents.send('scan-ended', { code });
}

async function cancelScan(code) {
    const scan = activeScans.get(code);
    if (!scan) return;
    scan.cancelled = true;
    for (const msg of scan.messages) {
        try { await msg.delete(); } catch (e) {}
    }
    console.log(`[İptal] Tarama iptal edildi, gönderilen loglar silindi: ${code}`);

    // Kuyrukta bekliyorsa sırasını beklemeden hemen sonuçlandır
    const pending = pollEntries.get(code);
    if (pending) {
        pollEntries.delete(code);
        const idx = pollQueue.indexOf(code);
        if (idx !== -1) pollQueue.splice(idx, 1);
        pending.resolve(null);
    }
}

ipcMain.on('cancel-scan', (event, code) => {
    cancelScan(code);
});

const BAN_MESSAGE = '3. parti yazılım sebebiyle banlandınız, itiraz için ac masterlara yazabilirsiniz.';

// --- TICKET AKSİYONLARI (Electron paneli ve mobil panel ortak kullanır) ---

async function performTicketKontrol(channelId) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;
    const targetUserId = await findTargetUserId(channel, null);
    if (!targetUserId) {
        console.log(`[Panel] ${channel.name}: hedef kullanıcı bulunamadı.`);
        dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'Hedef Bulunamadı',
            message: `${channel.name} kanalında geçerli bir hedef kullanıcı mesajı bulunamadı.`,
            buttons: ['Tamam']
        });
        return;
    }
    await startKontrolScan(channel, targetUserId);
}

function performTicketCancel(channelId) {
    const code = channelScans.get(channelId);
    if (code) cancelScan(code);
}

async function performTicketBan(channelId) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;
    await channel.send(BAN_MESSAGE);
    console.log(`[Panel] ${channel.name}: ban mesajı gönderildi.`);

    const logMsg = channelLastLogMessage.get(channelId);
    if (logMsg) {
        await logMsg.edit(`${logMsg.content}\n\n🚫 **BAN**`);
        channelLastLogMessage.delete(channelId);
        console.log(`[Panel] ${channel.name}: log mesajına BAN notu düşüldü.`);
    }
}

function performTicketHold(channelId) {
    if (heldTickets.has(channelId)) {
        heldTickets.delete(channelId);
    } else {
        heldTickets.add(channelId);
    }
    const held = heldTickets.has(channelId);
    console.log(`[Panel] Ticket ${held ? 'beklemeye alındı' : 'beklemeden çıkarıldı'}: ${channelId}`);
    if (mainWindow) mainWindow.webContents.send('ticket-hold-changed', { channelId, held });
    return held;
}

ipcMain.on('ticket-kontrol', async (event, channelId) => {
    try {
        await performTicketKontrol(channelId);
    } catch (error) {
        console.log(`[Hata] Panel kontrol hatası: ${error.message}`);
    }
});

ipcMain.on('ticket-cancel', (event, channelId) => {
    performTicketCancel(channelId);
});

ipcMain.on('ticket-ban', async (event, channelId) => {
    try {
        await performTicketBan(channelId);
    } catch (error) {
        console.log(`[Hata] Ban mesajı gönderilemedi: ${error.message}`);
    }
});

ipcMain.on('ticket-hold', (event, channelId) => {
    performTicketHold(channelId);
});

// --- MOBİL PANEL (telefondan erişim için basit HTTP sunucusu) ---
const MOBILE_PORT = 3939;

function getOrCreateMobileToken() {
    if (process.env.MOBILE_ACCESS_TOKEN) return process.env.MOBILE_ACCESS_TOKEN;
    const token = crypto.randomBytes(4).toString('hex');
    try {
        fs.appendFileSync(CONFIG_ENV_PATH, `\nMOBILE_ACCESS_TOKEN=${token}\n`);
    } catch (error) {
        console.log(`[Mobil] Token config.env'e yazılamadı: ${error.message}`);
    }
    return token;
}

const MOBILE_ACCESS_TOKEN = getOrCreateMobileToken();

function getLocalLanIp() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return 'localhost';
}

function getMobileUrl() {
    return `http://${getLocalLanIp()}:${MOBILE_PORT}/?token=${MOBILE_ACCESS_TOKEN}`;
}

function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

function hasValidToken(reqUrl) {
    return reqUrl.searchParams.get('token') === MOBILE_ACCESS_TOKEN;
}

const mobileServer = http.createServer(async (req, res) => {
    let reqUrl;
    try {
        reqUrl = new URL(req.url, `http://${req.headers.host}`);
    } catch (error) {
        res.writeHead(400);
        res.end('Geçersiz istek');
        return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/') {
        if (!hasValidToken(reqUrl)) {
            res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Erişim kodu geçersiz.');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(__dirname, 'mobile.html'), 'utf8'));
        return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/tickets') {
        if (!hasValidToken(reqUrl)) return sendJson(res, 401, { error: 'Geçersiz erişim kodu' });
        return sendJson(res, 200, getTicketChannels());
    }

    const actionMatch = reqUrl.pathname.match(/^\/api\/tickets\/(\d+)\/(kontrol|cancel|ban|hold)$/);
    if (req.method === 'POST' && actionMatch) {
        if (!hasValidToken(reqUrl)) return sendJson(res, 401, { error: 'Geçersiz erişim kodu' });
        const [, channelId, action] = actionMatch;
        try {
            if (action === 'kontrol') await performTicketKontrol(channelId);
            else if (action === 'cancel') performTicketCancel(channelId);
            else if (action === 'ban') await performTicketBan(channelId);
            else if (action === 'hold') performTicketHold(channelId);
            return sendJson(res, 200, { ok: true });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: error.message });
        }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bulunamadı' }));
});

function startApp() {
    console.log("[Sistem] Nexora Kontrol Merkezi başlatılıyor...");
    validateNexoraApiKey();
    mainWindow = new BrowserWindow({
        width: 460,
        height: 700,
        title: "Nexora Kontrol Merkezi",
        autoHideMenuBar: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('index.html');

    mobileServer.listen(MOBILE_PORT, '0.0.0.0', () => {
        const mobileUrl = getMobileUrl();
        console.log(`[Mobil] Aynı Wi-Fi'daki telefondan erişim: ${mobileUrl}`);
        if (mainWindow) mainWindow.webContents.send('mobile-url', mobileUrl);
    });

    console.log('[Bağlantı] Discord\'a giriş deneniyor...');
    const LOGIN_TIMEOUT_MS = 25000;
    const loginTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Giriş ${LOGIN_TIMEOUT_MS / 1000} saniye içinde tamamlanmadı. Muhtemelen güvenlik duvarı/antivirüs Discord bağlantısını (WebSocket) engelliyor - dosya dışlaması bunu kapsamaz, ayrıca Windows Güvenlik Duvarı izni de gerekiyor.`)), LOGIN_TIMEOUT_MS);
    });
    Promise.race([client.login(process.env.USER_TOKEN), loginTimeout]).catch((error) => {
        console.log(`[Hata] Discord girişi başarısız: ${error.message}`);
        dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Discord Girişi Başarısız',
            message: `Discord'a bağlanılamadı:\n${error.message}`,
            buttons: ['Tamam']
        });
    });
}

client.on('error', (error) => {
    console.log(`[Hata] Discord bağlantı hatası: ${error.message}`);
});

client.on('debug', (info) => {
    console.log(`[Discord Debug] ${info}`);
});

client.on('warn', (info) => {
    console.log(`[Discord Uyarı] ${info}`);
});

// Node event loop'unun gerçekten donup donmadığını görmek için düzenli aralıklarla
// "nabız" atıyoruz. Bu satır kesilirse/gecikirse sistem CPU'dan aç kalmış demektir.
let lastHeartbeat = Date.now();
setInterval(() => {
    const delay = Date.now() - lastHeartbeat - 5000;
    if (delay > 3000) {
        console.log(`[Nabız] Event loop ${delay}ms gecikti - sistem CPU'dan aç kalmış olabilir (yayın/ağır yazılım vb.).`);
    }
    lastHeartbeat = Date.now();
}, 5000);

// --- İLK KURULUM EKRANI ---
// config.env eksikse (USER_TOKEN, LOG_CHANNEL_ID, CATEGORY_ID, NEXORA_API_KEY),
// Discord'a bağlanmadan önce basit bir form gösterip bilgileri buradan alıyoruz.
let setupWindow;
const SETUP_REQUIRED_FIELDS = ['USER_TOKEN', 'LOG_CHANNEL_ID', 'CATEGORY_ID', 'NEXORA_API_KEY'];

function showSetupWindow() {
    setupWindow = new BrowserWindow({
        width: 480,
        height: 680,
        title: "Nexora Panel - İlk Kurulum",
        autoHideMenuBar: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    setupWindow.loadFile('setup.html');
}

ipcMain.on('save-setup', (event, values) => {
    for (const key of SETUP_REQUIRED_FIELDS) {
        if (!values[key] || !String(values[key]).trim()) {
            event.reply('setup-error', `"${key}" alanı boş bırakılamaz.`);
            return;
        }
    }

    // Mevcut config.env'deki diğer ayarları (karşılama/tarama mesajı vb.) korumak için
    // önce onun üstüne, sonra yeni değerlerin üstüne yazıyoruz - panel içi Ayarlar'dan
    // sadece hesap/sunucu alanları değiştiğinde diğer ayarlar silinmesin diye.
    const merged = { ...readConfigEnvAsObject(), ...values, MOBILE_ACCESS_TOKEN };
    const lines = Object.entries(merged)
        .filter(([, v]) => v && String(v).trim())
        .map(([k, v]) => formatConfigLine(k, String(v).trim()))
        .join('\n');

    try {
        fs.writeFileSync(CONFIG_ENV_PATH, lines + '\n');
    } catch (error) {
        event.reply('setup-error', `config.env yazılamadı: ${error.message}`);
        return;
    }

    if (setupWindow) {
        setupWindow.close();
        setupWindow = null;
    }

    // Yeni config.env ile temiz bir başlangıç için uygulamayı yeniden başlat
    app.relaunch();
    app.exit();
});

app.on('ready', async () => {
    await checkForUpdates(); // güncelleme varsa burada indirip yeniden başlatır, devam etmez

    if (isConfigComplete()) {
        startApp();
    } else {
        console.log('[Kurulum] config.env eksik, kurulum ekranı gösteriliyor...');
        showSetupWindow();
    }
});

client.on('ready', () => {
    console.log(`[Bağlantı] Giriş yapıldı: ${client.user.tag}`);
    console.log(`[Ayar] CATEGORY_ID=${CATEGORY_ID}, LOG_CHANNEL_ID=${LOG_CHANNEL_ID}`);
    refreshMyTickets();
});

client.on('channelCreate', async (channel) => {
    if (channel.parentId === CATEGORY_ID) {
        console.log(`[Yeni Ticket] Kanal oluşturuldu: ${channel.name} (${channel.id})`);
        if (mainWindow) {
            mainWindow.webContents.send('ticket-geldi');
        }
        activeTickets.add(channel.id);
        broadcastTicketList();
    }
});

client.on('channelDelete', (channel) => {
    if (channel.parentId === CATEGORY_ID) {
        console.log(`[Ticket] Kanal kapatıldı: ${channel.name} (${channel.id})`);
        activeTickets.delete(channel.id);
        heldTickets.delete(channel.id);
        channelScans.delete(channel.id);
        channelLastLogMessage.delete(channel.id);
        myTickets.delete(channel.id);
        cheatingFlagged.delete(channel.id);
        channelLastResult.delete(channel.id);
        broadcastTicketList();
    }
});

client.on('messageCreate', async (message) => {

    // --- BEKLETİLEN TICKET BİLDİRİMİ ---
    if (heldTickets.has(message.channel.id) && !message.author.bot && message.author.id !== client.user.id) {
        console.log(`[Beklet] ${message.channel.name} kanalında yeni mesaj var.`);
        if (mainWindow) mainWindow.webContents.send('ticket-geldi');
    }

    // --- YENİ OTOMATİK KARŞILAMA SİSTEMİ ---
    if (activeTickets.has(message.channel.id) && autoReplyEnabled) {
        if (!message.author.bot) {
            if (message.author.id === client.user.id) {
                console.log(`[Karşılama] Kendi mesajın algılandı, kanalı izlemeyi bırakıyorum: ${message.channel.id}`);
                activeTickets.delete(message.channel.id);
            } else {
                const hasIgnoredRole = message.member?.roles?.cache.has(IGNORED_ROLE_ID);
                if (hasIgnoredRole) {
                    console.log(`[Karşılama] Yetkili mesaj attı, işlem yapılmadı: ${message.author.username}`);
                    activeTickets.delete(message.channel.id);
                } else {
                    try {
                        if (welcomeMessage) {
                            console.log(`[Karşılama] Müşteriye özel mesaj gönderiliyor...`);
                            await message.channel.send(welcomeMessage);
                            console.log(`[Karşılama] Mesaj başarıyla gönderildi.`);
                        } else {
                            console.log(`[Karşılama] Müşteriye sticker gönderiliyor...`);
                            await message.channel.send({ stickers: ['749054660769218631'] });
                            console.log(`[Karşılama] Sticker başarıyla gönderildi.`);
                        }
                        activeTickets.delete(message.channel.id);
                    } catch (error) {
                        console.log(`[Hata] Karşılama gönderilemedi: ${error.message}`);
                    }
                }
            }
        }
    }

    // --- ESKİ SİSTEMLER ---

    if (message.author.id !== client.user.id) return;

    if (message.channel.parentId === CATEGORY_ID) {
        if (!myTickets.has(message.channel.id)) {
            myTickets.add(message.channel.id);
            console.log(`[Ticket] "${message.channel.name}" panele eklendi.`);
            broadcastTicketList();
        }
    } else if (message.channel.parentId && !warnedCategoryMismatch.has(message.channel.id)) {
        warnedCategoryMismatch.add(message.channel.id);
        console.log(`[Ticket] UYARI: "${message.channel.name}" kanalının kategori ID'si (${message.channel.parentId}) ayarlanan CATEGORY_ID (${CATEGORY_ID}) ile eşleşmiyor, panele eklenmedi.`);
    }

    const content = message.content.trim();

    if (content === KONTROL_KEYWORD) {
        await handleKontrolCommand(message);
        return;
    }

    const isUppercaseCode = /^[A-Z0-9]{6}$/.test(content);

    if (isUppercaseCode) {
        console.log(`[Kod] 6 haneli kod algılandı: ${content}`);
        try {
            const targetUserId = await findTargetUserId(message.channel, message.id);

            if (targetUserId) {
                console.log(`[Kod] Hedef kullanıcı bulundu: ${targetUserId}`);
                await sendToLogChannel(content, targetUserId, message);
            } else {
                console.log("[Kod] Hedef kullanıcı bulunamadı.");
            }
        } catch (error) {
            console.log(`[Hata] Kod işlenirken hata: ${error.message}`);
        }
        return;
    }

    const lines = content.split('\n');
    if (lines.length === 2) {
        const code = lines[0].trim();
        const userId = lines[1].trim();
        if (/^[A-Z0-9]{6}$/.test(code) && /^\d+$/.test(userId)) {
            console.log(`[Manuel] Manuel log verisi algılandı: Kod: ${code}, ID: ${userId}`);
            await sendToLogChannel(code, userId, message);
        }
    }
});

function nexoraHeaders() {
    return {
        'Authorization': `Bearer ${NEXORA_API_KEY}`,
        'Content-Type': 'application/json'
    };
}

// --- API SAĞLIK KONTROLÜ ---
const HEALTH_FAILURE_THRESHOLD = 3; // art arda kaç ağ hatasından sonra uyarılacak
let consecutiveNetworkFailures = 0;
let healthAlertShown = false;

function showTimeoutPopup(code) {
    dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '⏱️ Süre Doldu',
        message: `Kod ${code} için 10 dakikalık süre doldu, tarama tamamlanmadı.`,
        buttons: ['Tamam']
    });
}

function reportNexoraSuccess() {
    consecutiveNetworkFailures = 0;
    healthAlertShown = false;
}

function reportNexoraFailure() {
    consecutiveNetworkFailures++;
    if (consecutiveNetworkFailures >= HEALTH_FAILURE_THRESHOLD && !healthAlertShown) {
        healthAlertShown = true;
        dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: '⚠️ Nexora API Sorunu',
            message: `Nexora API'ye art arda ${consecutiveNetworkFailures} kez ulaşılamadı.\nİnternet bağlantını veya nexorascanner.ac durumunu kontrol et.`,
            buttons: ['Tamam']
        });
    }
}

// --- API KEY DOĞRULAMA (açılışta bir kere) ---
async function validateNexoraApiKey() {
    if (!NEXORA_API_KEY) {
        console.log('[Nexora] UYARI: NEXORA_API_KEY tanımlı değil. config.env dosyasını kontrol et.');
        return;
    }
    try {
        const res = await fetch(`${NEXORA_BASE_URL}/user/me`, { headers: nexoraHeaders() });
        if (res.ok) {
            const data = await res.json();
            console.log(`[Nexora] API key doğrulandı - Kullanıcı: ${data.username}, Plan: ${String(data.plan).toUpperCase()}, Toplam tarama: ${data.totalScans}`);

            if (['free', 'starter'].includes(String(data.plan).toLowerCase())) {
                console.log('[Nexora] UYARI: Hesap planı Free/Starter görünüyor - tarama API çağrıları 403 ile reddedilecektir. Professional veya üstüne geçmen gerekiyor.');
            }
            if (data.subscription && data.subscription.active === false) {
                console.log('[Nexora] UYARI: Abonelik aktif görünmüyor.');
            }
        } else if (res.status === 401 || res.status === 403) {
            console.log(`[Nexora] UYARI: API key geçersiz veya plan yetersiz (HTTP ${res.status}). config.env içindeki NEXORA_API_KEY'i ve dashboard'daki planını kontrol et.`);
        } else {
            console.log(`[Nexora] API key doğrulanamadı: HTTP ${res.status}`);
        }
    } catch (error) {
        console.log(`[Nexora] API key doğrulanırken hata: ${error.message}`);
    }
}

// --- MERKEZİ TARAMA KUYRUĞU ---
// Her aktif tarama kendi 10sn'lik döngüsünü bağımsız çalıştırmak yerine,
// tek bir kuyruktan sırayla geçiyor. Böylece kaç ticket aynı anda açık olursa
// olsun /scan/{kod}/status isteği rate limitin (5/10s) asla üzerine çıkmıyor.
const SCAN_QUEUE_TICK_MS = 2500;        // her tick'te en fazla 1 istek -> 10sn'de en fazla 4 istek
const SCAN_TIMEOUT_MS = 10 * 60 * 1000; // kod başına toplam bekleme süresi (10 dakika)

const pollQueue = [];        // sırayla kontrol edilecek kodlar
const pollEntries = new Map(); // kod -> { startedAt, resolve }

function waitForScanCompletion(code) {
    return new Promise((resolve) => {
        pollEntries.set(code, { startedAt: Date.now(), resolve });
        pollQueue.push(code);
    });
}

async function processNextInQueue() {
    if (pollQueue.length === 0) return;

    const code = pollQueue.shift();
    const entry = pollEntries.get(code);
    if (!entry) return; // iptal/tamamlanma sırasında zaten temizlenmiş

    if (isScanCancelled(code)) {
        pollEntries.delete(code);
        entry.resolve(null);
        return;
    }

    if (Date.now() - entry.startedAt > SCAN_TIMEOUT_MS) {
        console.log(`[Tarama] ${code}: zaman aşımı (10 dakika içinde tamamlanmadı).`);
        pollEntries.delete(code);
        entry.resolve(null);
        return;
    }

    try {
        const res = await fetch(`${NEXORA_BASE_URL}/scan/${code}/status`, {
            headers: nexoraHeaders()
        });
        reportNexoraSuccess(); // sunucudan cevap geldi, ağ sorunu yok

        if (isScanCancelled(code)) return; // istek havadayken iptal edilmiş, sonucu boşa işleme

        const contentType = res.headers.get('content-type') || '';
        const bodyText = await res.text();

        if (res.ok && contentType.includes('application/json')) {
            const data = JSON.parse(bodyText);
            console.log(`[Tarama] ${code}: durum = ${data.status}`);
            if (String(data.status).toLowerCase() === 'completed') {
                const fullResult = await fetchFullScanResult(code);
                pollEntries.delete(code);
                entry.resolve(fullResult);
                return;
            }
        } else if (res.ok) {
            console.log(`[Tarama] ${code}: HTTP ${res.status} ama JSON değil (content-type: ${contentType || 'yok'}) - gelen içerik: ${bodyText.slice(0, 150).replace(/\s+/g, ' ')}`);
        } else if (res.status === 401 || res.status === 403) {
            console.log(`[Tarama] ${code}: HTTP ${res.status} - API key geçersiz/reddedildi. config.env içindeki NEXORA_API_KEY'i kontrol et.`);
        } else if (res.status === 404) {
            console.log(`[Tarama] ${code}: HTTP 404 - kod bulunamadı veya süresi dolmuş olabilir.`);
        } else if (res.status === 429) {
            console.log(`[Tarama] ${code}: HTTP 429 - Rate limit aşıldı, sıradaki turda tekrar denenecek.`);
        } else {
            console.log(`[Tarama] ${code}: HTTP ${res.status}`);
        }
    } catch (error) {
        console.log(`[Tarama] ${code} sorgu hatası: ${error.message}`);
        reportNexoraFailure();
    }

    pollQueue.push(code); // hâlâ bitmedi, kuyruğun sonuna tekrar ekle
}

setInterval(processNextInQueue, SCAN_QUEUE_TICK_MS);

async function fetchFullScanResult(code) {
    try {
        const res = await fetch(`${NEXORA_BASE_URL}/scan/${code}`, {
            headers: nexoraHeaders()
        });
        if (res.ok) {
            const data = await res.json();
            console.log(`[Tarama] SONUÇ: verdict=${data.verdict}, tespit sayısı=${data.detectionCount}`);
            return data;
        }
        console.log(`[Tarama] Tam sonuç alınamadı: HTTP ${res.status}`);
    } catch (error) {
        console.log(`[Tarama] Tam sonuç alınırken hata: ${error.message}`);
    }
    return { status: 'completed' };
}

const VERDICT_ICONS = {
    clean: '✅',
    warn: '⚠️',
    cheating: '🚨'
};

// Not: Discord, kullanıcı hesaplarının (selfbot) özel embed göndermesine izin vermiyor
// (embeds sadece bot hesaplarında çalışır) - bu yüzden sonucu formatlı düz metin olarak gönderiyoruz.
function buildResultMessage(code, userId, result, url) {
    const verdictKey = String(result.verdict || '').toLowerCase();
    const icon = VERDICT_ICONS[verdictKey] || 'ℹ️';
    const verdictText = String(result.verdict || 'BİLİNMİYOR').toUpperCase();

    let message = `${icon} **Tarama Sonucu: ${verdictText}**\n`;
    message += `${url}\n`;
    message += `👤 Hedef ID: ${userId}\n`;
    message += `🔎 Kod: \`${code}\`\n`;
    message += `🎯 Tespit Sayısı: **${result.detectionCount ?? 0}**`;

    if (Array.isArray(result.detections) && result.detections.length > 0) {
        const detectionText = result.detections
            .map((d) => `• **${d.name}** (${d.severity}) - ${d.category}`)
            .join('\n');
        message += `\n\n**Tespitler:**\n${detectionText}`;
    }

    return message.slice(0, 2000); // Discord mesaj karakter limiti
}

async function sendToLogChannel(code, userId, originalMessage) {
    console.log(`[Log] İşlem penceresi açılıyor...`);
    try {
        await originalMessage.delete();

        const response = dialog.showMessageBoxSync(mainWindow, {
            type: 'warning',
            buttons: ['✅ Onayla ve Aç', '❌ İptal Et'],
            defaultId: 0,
            cancelId: 1,
            title: 'Nexora Kod Algılandı!',
            message: `Hedef ID: ${userId}\nKod: ${code}\n\nBu logu gönderip tarayıcıda açmak istiyor musunuz?`
        });

        if (response === 0) {
            console.log("[Log] Kullanıcı onayı alındı, işlem yapılıyor.");
            const targetChannel = client.channels.cache.get(LOG_CHANNEL_ID);
            if (targetChannel) {
                const url = `https://nexorascanner.ac/dashboard/scan/${code}`;
                const formattedMessage = `${url}\n${userId}`;

                const sentMsg = await targetChannel.send(formattedMessage);
                registerScan(code);
                trackScanMessage(code, sentMsg);
                console.log(`[Log] Log gönderildi. Tarama tamamlanana kadar merkezi kuyruk üzerinden bekleniyor...`);

                const result = await waitForScanCompletion(code);
                if (isScanCancelled(code)) {
                    console.log(`[Log] Tarama iptal edildiği için tarayıcı açılmadı: ${code}`);
                    finishScan(code);
                } else if (result) {
                    exec(`start "" "${url}"`);
                    console.log(`[Log] Tarama tamamlandı, ${url} açıldı.`);
                    await sentMsg.edit(buildResultMessage(code, userId, result, url));
                    channelLastLogMessage.set(originalMessage.channel.id, sentMsg);
                    channelLastResult.set(originalMessage.channel.id, { verdict: result.verdict, url });
                    flagIfCheating(originalMessage.channel.id, result);
                    broadcastTicketList();
                    finishScan(code);
                } else {
                    console.log('[Log] Tarama zaman aşımına uğradı, tarayıcı açılmadı. Gerekirse linki elle aç:', url);
                    showTimeoutPopup(code);
                    finishScan(code);
                }
            }
        } else {
            console.log("[Log] İşlem iptal edildi.");
        }
    } catch (error) {
        console.log(`[Hata] Log gönderim hatası: ${error.message}`);
    }
}

// --- "kontrol" KOMUTU: YENİ PIN OLUŞTURUP LİNKİ OTOMATİK PAYLAŞ ---
const KONTROL_RESULT_DELAY_MS = 60000; // link atıldıktan 1 dakika sonra sonuç beklemeye başla

async function generateScanPin() {
    const res = await fetch(`${NEXORA_BASE_URL}/user/pin`, {
        headers: nexoraHeaders()
    });
    if (!res.ok) {
        throw new Error(`PIN oluşturulamadı: HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.pin;
}

function cleanupChannelScan(channelId) {
    channelScans.delete(channelId);
    if (mainWindow) mainWindow.webContents.send('ticket-scan-ended', { channelId });
}

async function startKontrolScan(channel, targetUserId) {
    const code = await generateScanPin();
    const downloadUrl = `https://nexorascanner.ac/download?pin=${code}`;
    const resultUrl = `https://nexorascanner.ac/dashboard/scan/${code}`;

    await channel.send(downloadUrl);
    await channel.send(`${scanMessage} <@${targetUserId}>`);

    registerScan(code);
    channelScans.set(channel.id, code);
    if (mainWindow) mainWindow.webContents.send('ticket-scan-started', { channelId: channel.id, code });

    console.log(`[Kontrol] Link gönderildi: ${downloadUrl} - 1 dakika sonra sonuç beklemeye başlanacak.`);
    await new Promise(resolve => setTimeout(resolve, KONTROL_RESULT_DELAY_MS));

    if (isScanCancelled(code)) {
        console.log(`[Kontrol] Bekleme süresinde iptal edildi: ${code}`);
        finishScan(code);
        cleanupChannelScan(channel.id);
        return;
    }

    const result = await waitForScanCompletion(code);
    if (isScanCancelled(code)) {
        console.log(`[Kontrol] Tarama iptal edildiği için tarayıcı açılmadı: ${code}`);
        finishScan(code);
    } else if (result) {
        exec(`start "" "${resultUrl}"`);
        console.log(`[Kontrol] Tarama tamamlandı, ${resultUrl} açıldı.`);
        const logChannel = client.channels.cache.get(LOG_CHANNEL_ID);
        if (logChannel) {
            const logMsg = await logChannel.send(buildResultMessage(code, targetUserId, result, resultUrl));
            channelLastLogMessage.set(channel.id, logMsg);
        }
        channelLastResult.set(channel.id, { verdict: result.verdict, url: resultUrl });
        flagIfCheating(channel.id, result);
        broadcastTicketList();
        finishScan(code);
    } else {
        console.log('[Kontrol] Tarama zaman aşımına uğradı, tarayıcı açılmadı. Gerekirse linki elle aç:', resultUrl);
        showTimeoutPopup(code);
        finishScan(code);
    }
    cleanupChannelScan(channel.id);
}

async function handleKontrolCommand(message) {
    console.log(`[Kontrol] "${KONTROL_KEYWORD}" komutu algılandı, yeni tarama başlatılıyor...`);
    try {
        const targetUserId = await findTargetUserId(message.channel, message.id);
        if (!targetUserId) {
            console.log("[Kontrol] Hedef kullanıcı bulunamadı.");
            return;
        }

        await message.delete();
        await startKontrolScan(message.channel, targetUserId);
    } catch (error) {
        console.log(`[Hata] Kontrol komutu işlenirken hata: ${error.message}`);
    }
}