const path = require('path');
const fs = require('fs');

// Bazı ağlarda (özellikle DPI atlatma araçlarıyla) IPv6 bağlantısı yarım çalışıp
// isteklerin uzun süre asılı kalmasına neden olabiliyor. IPv4'ü önceliklendiriyoruz.
require('dns').setDefaultResultOrder('ipv4first');

const CONFIG_ENV_PATH = path.join(__dirname, 'config.env');
require('dotenv').config({ path: CONFIG_ENV_PATH });

// Bazı kullanıcılarda ayarlar (token/API key) her açılışta sıfırlanıyordu.
// En olası sebep: uygulama ZIP dosyasının içinden, hiç çıkarılmadan çalıştırılıyor -
// Windows böyle bir durumda .exe'yi her seferinde geçici bir klasöre (AppData\Local\Temp
// altında) yeniden açıyor, o klasördeki her şey (config.env dahil) bir sonraki
// açılışta kayboluyor. __dirname bu türden geçici bir yolun altındaysa true döner.
function isRunningFromTemporaryLocation() {
    const dirLower = __dirname.toLowerCase();
    return dirLower.includes('\\appdata\\local\\temp\\') || dirLower.includes('/appdata/local/temp/');
}

// Paketlenmiş .exe konsolsuz açıldığı için console.log çıktısı hiçbir yerde görünmüyordu.
// Artık aynı satırlar debug.log dosyasına da yazılıyor - sorun olursa o dosyaya bakılabilir.
// Dosya sınırsız büyümesin diye belli bir boyutu geçince eski içerik debug.log.old'a
// taşınıyor - yine de bir sorun anında geriye dönük yeterli kayıt kalsın diye limit
// küçük tutulmadı (5 MB, üstelik bir önceki dönem debug.log.old'da hâlâ duruyor).
const DEBUG_LOG_PATH = path.join(__dirname, 'debug.log');
const DEBUG_LOG_OLD_PATH = path.join(__dirname, 'debug.log.old');
const DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;
let debugLogSize = 0;
try {
    debugLogSize = fs.statSync(DEBUG_LOG_PATH).size;
} catch (error) {
    debugLogSize = 0;
}
const originalConsoleLog = console.log;
console.log = (...args) => {
    originalConsoleLog(...args);
    try {
        const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
        if (debugLogSize > DEBUG_LOG_MAX_BYTES) {
            fs.renameSync(DEBUG_LOG_PATH, DEBUG_LOG_OLD_PATH);
            debugLogSize = 0;
        }
        fs.appendFileSync(DEBUG_LOG_PATH, line);
        debugLogSize += Buffer.byteLength(line, 'utf8');
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

const { app, BrowserWindow, dialog, ipcMain, shell, Notification } = require('electron');

// Aynı anda birden fazla kopya açılınca ikincisi mobil sunucunun portunu (3939)
// alamayıp çöküyordu (EADDRINUSE). Tek örnek kilidiyle ikinci açılışı tamamen
// engelleyip, zaten açık olan pencereyi öne getiriyoruz.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
    process.exit(0);
}

// Windows'ta native Notification'ların (şüpheli aktivite bildirimi) düzgün
// görünmesi için uygulamanın bir AppUserModelID'si olması gerekiyor - electron-packager
// çıktısı bir kurulum/kısayol oluşturmadığından bu olmadan bildirim sessizce kaybolabilir.
app.setAppUserModelId('com.nexora.panel');
app.on('second-instance', () => {
    const existingWindow = mainWindow || setupWindow;
    if (existingWindow) {
        if (existingWindow.isMinimized()) existingWindow.restore();
        existingWindow.focus();
    }
});

const { Client, MessageSelectMenu } = require('discord.js-selfbot-v13');
// channel.sendSlash()'ın kendi içinde yaptığı client.users.fetch(botId) çağrısı bazı
// oturum/ortamlarda "Unauthorized" ile başarısız olabiliyor (canlı test edildi - bkz.
// queryPlayerInfoCommandImpl yorumu) - bu iki sınıf, o adımı ATLAYIP komut şemasından
// (application-command-index API, bu ASLA başarısız olmadı) ApplicationCommand'i elle inşa
// edip slash komutunu doğrudan göndermek için kullanılıyor.
const DiscordApplicationCommand = require('discord.js-selfbot-v13/src/structures/ApplicationCommand');
const { Message: DiscordMessage } = require('discord.js-selfbot-v13/src/structures/Message');
const { exec } = require('child_process');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

// --- OTOMATİK GÜNCELLEME ---
// Her yeni sürüm çıkardığında bu numarayı artır ve nexora-panel-updates repo'sundaki
// version.json + dosyaları güncelle. Program açılışta bunu kontrol eder, farklıysa
// dosyaları indirip üzerine yazar ve kendini yeniden başlatır.
const CURRENT_VERSION = '1.15.0';
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
    const required = { USER_TOKEN: process.env.USER_TOKEN, LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID, CATEGORY_ID: process.env.CATEGORY_ID, NEXORA_API_KEY: process.env.NEXORA_API_KEY };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
        console.log(`[Kurulum] config.env yolu: ${CONFIG_ENV_PATH} (dosya var mı: ${fs.existsSync(CONFIG_ENV_PATH)}). Eksik alanlar: ${missing.join(', ')}.`);
    }
    return missing.length === 0;
}

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const CATEGORY_ID = process.env.CATEGORY_ID;
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

// --- SİSTEM DURUMU (panelde "Durum" kartı için) ---
let discordStatus = 'bağlanıyor'; // 'bağlanıyor' | 'bağlı' | 'hata'
let nexoraStatus = 'bilinmiyor';  // 'bilinmiyor' | 'sağlıklı' | 'sorunlu'
let mobileServerReady = false;

function broadcastSystemStatus() {
    if (mainWindow) {
        mainWindow.webContents.send('system-status', {
            discord: discordStatus,
            nexora: nexoraStatus,
            mobile: mobileServerReady
        });
    }
}

ipcMain.on('request-system-status', () => broadcastSystemStatus());

// Pencereler frame:false olduğu için (özel .titlebar kullanılıyor, hem index.html hem
// setup.html'de) küçült/kapat artık native başlık çubuğu butonlarından değil, kendi
// butonlarımızdan bu IPC mesajlarıyla tetikleniyor. İsteği HANGİ pencere gönderdiyse
// (mainWindow ya da setupWindow) o kapanıp/küçülüyor - sabit mainWindow varsayılmıyor.
ipcMain.on('window-minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.on('window-close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
});

// Panel yerleşimi (klasik/yan panel/liste+detay) - renderer açılışta mevcut tercihi
// soruyor, kullanıcı ayarlardan değiştirdiğinde ise pencere anında yeni boyuta getirilip
// config.env'e kalıcı olarak yazılıyor (bkz. PANEL_LAYOUT_SIZES, savePanelLayoutToConfig).
ipcMain.on('request-panel-layout', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.send('panel-layout', panelLayout);
});
ipcMain.on('set-panel-layout', (event, layout) => {
    if (!PANEL_LAYOUT_SIZES[layout]) return;
    savePanelLayoutToConfig(layout);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        const { width, height } = PANEL_LAYOUT_SIZES[layout];
        // Pencere resizable:false olduğu için Windows'ta setSize bazen (özellikle
        // küçültme yönünde) sessizce yok sayılıyor - resizable'ı anlık true yapıp
        // boyutu değiştirip tekrar false'a döndürmek bu sorunu güvenilir şekilde atlatıyor.
        win.setResizable(true);
        win.setSize(width, height);
        win.center();
        win.setResizable(false);
    }
});


const DEFAULT_SCAN_MESSAGE = 'Programı çalıştırıp tam ekran ss atar mısınız?';
let scanMessage = process.env.SCAN_MESSAGE || DEFAULT_SCAN_MESSAGE;

const DEFAULT_BAN_MESSAGE = '3. parti yazılım sebebiyle banlandınız, itiraz için ac masterlara yazabilirsiniz.';
let banMessage = process.env.BAN_MESSAGE || DEFAULT_BAN_MESSAGE;

// Kimlik Sorgula sonucundaki "AC Çağır" butonu için: /dm-player komutuyla oyuncuya
// giden mesaj.
const DEFAULT_AC_MESSAGE = 'AC ekibi sizi kontrol için sunucuya çağırıyor, lütfen Discord\'a bağlanın.';
let acMessage = process.env.AC_MESSAGE || DEFAULT_AC_MESSAGE;

// Aynı buton, kişiyi AC duyuru kanalında etiketlerken atacağı mesaj.
const DEFAULT_AC_TICKET_MESSAGE = 'ac ticket';
let acTicketMessage = process.env.AC_TICKET_MESSAGE || DEFAULT_AC_TICKET_MESSAGE;

// "Şüpheli" (silent aim vb.) bildirimlerinin düştüğü webhook kanalı. Varsayılan
// AÇIK - kapatılırsa config.env'e "false" olarak yazılır (bkz. saveSuspiciousNotifyToConfig).
let suspiciousNotifyEnabled = process.env.SUSPICIOUS_NOTIFY_ENABLED !== 'false';

// Fiveguard (fiveguard.net) log kanalı bildirimi - webhook-system'daki (FeloxAC)
// sistemden AYRI, ikinci bir hile tespit kaynağı. Varsayılan AÇIK.
let fiveguardNotifyEnabled = process.env.FIVEGUARD_NOTIFY_ENABLED !== 'false';

// Windows açılışında otomatik başlatma. Varsayılan AÇIK - bu güncellemeyi alan
// herkeste otomatik devreye girsin diye (kapatılırsa config.env'e "false" yazılır).
let openAtLoginEnabled = process.env.OPEN_AT_LOGIN !== 'false';

// --- PANEL YERLEŞİMİ (klasik / yan panel / liste+detay) ---
// Renderer'daki data-layout ile birebir aynı 3 seçenek. Pencere BOYUTU da yerleşime göre
// değişiyor, bu yüzden (tema gibi sadece localStorage'a değil) config.env'e de yazılıp ana
// pencere ilk açılırken doğru boyutta oluşturuluyor (renderer henüz yüklenmeden önce main
// process'in bilmesi gerekiyor - localStorage'a bu aşamada erişilemez).
const PANEL_LAYOUT_SIZES = {
    classic: { width: 460, height: 700 },
    sidebar: { width: 620, height: 640 },
    'list-detail': { width: 700, height: 620 }
};
let panelLayout = PANEL_LAYOUT_SIZES[process.env.PANEL_LAYOUT] ? process.env.PANEL_LAYOUT : 'classic';

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

function saveScanMessageToConfig(text) {
    scanMessage = text || DEFAULT_SCAN_MESSAGE;
    saveConfigValue('SCAN_MESSAGE', text);
    console.log('[Tarama Mesajı] Mesaj kaydedildi.');
}

function saveBanMessageToConfig(text) {
    banMessage = text || DEFAULT_BAN_MESSAGE;
    saveConfigValue('BAN_MESSAGE', text);
    console.log('[Ban Mesajı] Mesaj kaydedildi.');
}

function saveSuspiciousNotifyToConfig(status) {
    suspiciousNotifyEnabled = status;
    saveConfigValue('SUSPICIOUS_NOTIFY_ENABLED', status ? 'true' : 'false');
    console.log(`[Şüpheli Bildirim] Durum kaydedildi: ${status ? "AÇIK" : "KAPALI"}`);
}

function saveFiveguardNotifyToConfig(status) {
    fiveguardNotifyEnabled = status;
    saveConfigValue('FIVEGUARD_NOTIFY_ENABLED', status ? 'true' : 'false');
    console.log(`[Fiveguard Bildirim] Durum kaydedildi: ${status ? "AÇIK" : "KAPALI"}`);
}

function saveAcMessageToConfig(text) {
    acMessage = text || DEFAULT_AC_MESSAGE;
    saveConfigValue('AC_MESSAGE', text);
    console.log('[AC Mesajı] Mesaj kaydedildi.');
}

function saveAcTicketMessageToConfig(text) {
    acTicketMessage = text || DEFAULT_AC_TICKET_MESSAGE;
    saveConfigValue('AC_TICKET_MESSAGE', text);
    console.log('[AC Ticket Mesajı] Mesaj kaydedildi.');
}

function savePanelLayoutToConfig(layout) {
    if (!PANEL_LAYOUT_SIZES[layout]) return;
    panelLayout = layout;
    saveConfigValue('PANEL_LAYOUT', layout);
    console.log(`[Panel Yerleşimi] Kaydedildi: ${layout}`);
}

// Windows'un kendi "başlangıçta çalıştır" mekanizmasını (kayıt defterine kısayol
// ekleme) kullanıyor - elle registry/shortcut uğraşmaya gerek yok.
function saveOpenAtLoginToConfig(status) {
    openAtLoginEnabled = status;
    saveConfigValue('OPEN_AT_LOGIN', status ? 'true' : 'false');
    app.setLoginItemSettings({ openAtLogin: status });
    console.log(`[Ayar] Windows açılışında otomatik başlatma: ${status ? 'AÇIK' : 'KAPALI'}`);
}
const heldTickets = new Set();       // beklemeye alınmış ticket kanal ID'leri
const channelScans = new Map();      // kanal ID -> o kanalda süren "kontrol" tarama kodu
const channelLastLogMessage = new Map(); // kanal ID -> o kanalın en son sonuç log mesajı (ban notu için)
const myTickets = new Set();         // içinde en az bir mesaj yazdığım ticket kanal ID'leri
const warnedCategoryMismatch = new Set(); // kategori ID uyuşmazlığı için tekrar tekrar log basmayı önler
const cheatingFlagged = new Set();    // "cheating" sonucu çıkan ticket kanal ID'leri (panelde kırmızı vurgu için)
const channelLastResult = new Map();   // kanal ID -> { verdict, url } (panelde "Sonuç" butonu için, sadece bu oturumda tamamlanan taramalar)
const channelLicense = new Map();      // kanal ID -> ticket açılışında botun mesajından yakalanan "license:..." değeri
const channelGameId = new Map();       // kanal ID -> "Oyun İçi ID" alanındaki sayı (kullanıcı oyundaysa), yoksa yok
const banClickedOnce = new Set();      // ban butonuna en az bir kez basılmış ticket kanal ID'leri (2. basış /fg komutlarını sorar)

function flagIfCheating(channelId, result) {
    if (String(result?.verdict).toLowerCase() === 'cheating') {
        cheatingFlagged.add(channelId);
        console.log(`[Tarama] Ticket kırmızı işaretlendi (cheating): ${channelId}`);
        broadcastTicketList();
    }
}

function getTicketChannels() {
    return client.channels.cache
        .filter((ch) => ch.parentId === CATEGORY_ID)
        .map((ch) => {
            const lastResult = channelLastResult.get(ch.id);
            return {
                id: ch.id,
                name: ch.name,
                claimed: myTickets.has(ch.id),
                held: heldTickets.has(ch.id),
                scanCode: channelScans.get(ch.id) || null,
                flagged: cheatingFlagged.has(ch.id),
                resultVerdict: lastResult ? lastResult.verdict : null,
                resultUrl: lastResult ? lastResult.url : null,
                banStage: banClickedOnce.has(ch.id) ? 'second' : 'first',
                channelUrl: ch.guild ? `discord://-/channels/${ch.guild.id}/${ch.id}` : null
            };
        })
        // Bizim yazdığımız (claim edilmiş) ticketlar üstte, her grup kendi içinde alfabetik.
        .sort((a, b) => {
            if (a.claimed !== b.claimed) return a.claimed ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
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
            ANTICHEAT_ROLE_ID: ANTICHEAT_ROLE_ID || '',
            IGNORED_IDS: ignoredIdsString || ''
        });
    }
});

const DEBUG_LOG_TAIL_LINES = 300;

ipcMain.on('request-debug-log', (event) => {
    try {
        const content = fs.readFileSync(DEBUG_LOG_PATH, 'utf8');
        const lines = content.split('\n');
        const tail = lines.slice(-DEBUG_LOG_TAIL_LINES).join('\n');
        if (mainWindow) mainWindow.webContents.send('debug-log', tail);
    } catch (error) {
        if (mainWindow) mainWindow.webContents.send('debug-log', `Log okunamadı: ${error.message}`);
    }
});

ipcMain.on('open-debug-log-folder', () => {
    shell.showItemInFolder(DEBUG_LOG_PATH);
});

ipcMain.on('set-scan-message', (event, text) => {
    saveScanMessageToConfig(text.trim());
});

ipcMain.on('request-scan-message', (event) => {
    if (mainWindow) mainWindow.webContents.send('scan-message', scanMessage);
});

ipcMain.on('set-ban-message', (event, text) => {
    saveBanMessageToConfig(text.trim());
});

ipcMain.on('request-ban-message', (event) => {
    if (mainWindow) mainWindow.webContents.send('ban-message', banMessage);
});

ipcMain.on('set-ac-message', (event, text) => {
    saveAcMessageToConfig(text.trim());
});

ipcMain.on('request-ac-message', (event) => {
    if (mainWindow) mainWindow.webContents.send('ac-message', acMessage);
});

ipcMain.on('set-ac-ticket-message', (event, text) => {
    saveAcTicketMessageToConfig(text.trim());
});

ipcMain.on('request-ac-ticket-message', (event) => {
    if (mainWindow) mainWindow.webContents.send('ac-ticket-message', acTicketMessage);
});

ipcMain.on('toggle-suspicious-notify', (event, status) => {
    saveSuspiciousNotifyToConfig(status);
});

ipcMain.on('request-suspicious-notify-status', (event) => {
    if (mainWindow) mainWindow.webContents.send('suspicious-notify-status', suspiciousNotifyEnabled);
});

ipcMain.on('toggle-fiveguard-notify', (event, status) => {
    saveFiveguardNotifyToConfig(status);
});

ipcMain.on('request-fiveguard-notify-status', (event) => {
    if (mainWindow) mainWindow.webContents.send('fiveguard-notify-status', fiveguardNotifyEnabled);
});

ipcMain.on('toggle-open-at-login', (event, status) => {
    saveOpenAtLoginToConfig(status);
});

ipcMain.on('request-open-at-login-status', (event) => {
    if (mainWindow) mainWindow.webContents.send('open-at-login-status', openAtLoginEnabled);
});

ipcMain.on('lookup-player', async (event, query) => {
    const result = await resolvePlayerIdentity(query);
    if (mainWindow) mainWindow.webContents.send('lookup-player-result', { query, result });
});

ipcMain.on('ac-call', async (event, target) => {
    const result = await performAcCall(target || {});
    if (mainWindow) mainWindow.webContents.send('ac-call-result', result);
});

ipcMain.on('ac-call-spam', async (event, target) => {
    const result = await performAcCallSpam(target || {});
    if (mainWindow) mainWindow.webContents.send('ac-call-spam-result', result);
});

ipcMain.on('lookup-fg-ban', async (event, payload) => {
    const result = await performLookupFgBan(payload || {});
    if (mainWindow) mainWindow.webContents.send('lookup-fg-ban-result', result);
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


// --- TICKET AKSİYONLARI (Electron paneli ve mobil panel ortak kullanır) ---

// Ticket'ı claim eder: sabit bir sticker göndererek claim edildiğini belli eder.
// Mesaj gönderilince "ESKİ SİSTEMLER" bloğu zaten kanalı myTickets'a ekleyip
// claimed hale getiriyor.
async function performTicketClaim(channelId) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;
    try {
        await channel.send({ stickers: ['749054660769218631'] });
        console.log(`[Panel] ${channel.name}: claim edildi, sticker gönderildi.`);
    } catch (error) {
        console.log(`[Hata] ${channel.name} claim edilemedi: ${error.message}`);
    }
}

// Ticket sistemi botunun "Lütfen yapacağınız işlemi seçin" menüsünden "Ticket Sil"i
// programatik olarak seçer - bu, ticket kanalını (çoğunlukla) siler. Onay adımı
// (geri alınamaz olduğu için) arayüz tarafında (panel/mobil kart üzerinde) isteniyor -
// mobil panelden çağrılınca masaüstünde açılacak bir native pencerede kilitli kalmasın diye.
// Ticket sistemi botunun (işlem menüsünü gönderen) kullanıcı ID'si.
const TICKET_SYSTEM_BOT_ID = '1472695273418522657';

// Bu bot, menüsünü Discord'un yeni "Components V2" konteynerinin (tip 17) içine
// gömüyor. discord.js-selfbot-v13 2.15.1 bu tipi tanımıyor ve message.components
// üzerinde onu sessizce undefined bırakıyor (bkz. BaseMessageComponent.create).
// Bu yüzden select menu'yü kütüphanenin ayrıştırdığı message.components yerine
// ham API JSON'ından (client.api ile) recursive arayıp elle çekiyoruz.
const SELECT_COMPONENT_TYPES = [3, 5, 6, 7, 8]; // STRING/USER/ROLE/MENTIONABLE/CHANNEL select

function findSelectComponent(components) {
    if (!Array.isArray(components)) return null;
    for (const c of components) {
        if (!c || typeof c !== 'object') continue;
        if (SELECT_COMPONENT_TYPES.includes(c.type)) return c;
        const nested = findSelectComponent(c.components);
        if (nested) return nested;
    }
    return null;
}

async function performTicketClose(channelId) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;

    try {
        // İşlem menüsü mesajı ticket sistemi botu tarafından kanal açılır açılmaz
        // gönderiliyor, yani hemen hemen her zaman kanalın en eski mesajları arasında.
        // Panelin o an açık olup olmadığından bağımsız çalışsın diye kanalın en eski
        // mesajlarını ham JSON olarak tarayıp o botun select menu'lü mesajını buluyoruz.
        const rawMessages = await client.api.channels(channelId).messages.get({ query: { after: '0', limit: 20 } });
        const rawMenuMessage = rawMessages.find(
            (m) => m.author?.id === TICKET_SYSTEM_BOT_ID && findSelectComponent(m.components)
        );
        if (!rawMenuMessage) throw new Error('Ticket işlem menüsü bu kanalda bulunamadı.');

        const rawMenu = findSelectComponent(rawMenuMessage.components);
        if (!rawMenu) throw new Error('Select menu bulunamadı.');
        const option = (rawMenu.options || []).find((o) => /ticket sil/i.test(o.label));
        if (!option) throw new Error('"Ticket Sil" seçeneği bulunamadı.');

        const menuMessage = await channel.messages.fetch(rawMenuMessage.id);
        const menu = new MessageSelectMenu(rawMenu);
        await menu.select(menuMessage, [option.value]);
        console.log(`[Panel] ${channel.name}: "Ticket Sil" seçildi.`);
    } catch (error) {
        console.log(`[Hata] ${channel.name} kapatılamadı: ${error.message}`);
        if (mainWindow) {
            dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Ticket Kapatılamadı',
                message: `Ticket kapatılırken hata oluştu:\n${error.message}`,
                buttons: ['Tamam']
            });
        }
    }
}

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

async function performTicketBan(channelId, reason) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;

    // İkinci ve sonraki basışlar artık burada işlenmiyor - panel arayüzü bu durumda
    // doğrudan performTicketBanConfirm'i (sebep girildikten sonra) çağırıyor. Bu kontrol
    // sadece eski/gecikmiş bir isteğin yanlışlıkla ban mesajını tekrar atmasını engelliyor.
    if (banClickedOnce.has(channelId)) return;

    const safeReason = String(reason || '').trim();
    if (!safeReason) {
        console.log(`[Panel] ${channel.name}: sebep boş, ban mesajı gönderilmedi.`);
        return;
    }

    // Müşteri sadece sabit ban mesajını görüyor - yazılan sebep ona gitmiyor,
    // sadece aşağıdaki log güncellemesine düşüyor.
    await channel.send(banMessage);
    console.log(`[Panel] ${channel.name}: ban mesajı gönderildi (sebep sadece log'a düştü: ${safeReason}).`);

    const logMsg = channelLastLogMessage.get(channelId);
    if (logMsg) {
        await logMsg.edit(`${logMsg.content}\n\n🚫 **BAN**\n📝 Sebep: ${safeReason}`);
        channelLastLogMessage.delete(channelId);
        console.log(`[Panel] ${channel.name}: log mesajına BAN notu düşüldü.`);
    }

    banClickedOnce.add(channelId);
    broadcastTicketList();
}

// "/fg" komutunu barındıran botun (kullanıcı/uygulama) ID'si.
const FG_BOT_ID = '1470758770790498377';

async function performTicketBanConfirm(channelId, reason) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;

    let license = channelLicense.get(channelId);
    let gameId = channelGameId.get(channelId);
    if (!license || !gameId) {
        // Canlı yakalanmamış olabilir (ticket açılışı panel dinlemeye başlamadan önce
        // olmuş) - vazgeçmeden önce kanalın geçmişinden taze bulmayı dene (bkz.
        // findPlayerInfoFromHistory yorumu, buildTicketDetail'de de aynı desen kullanılıyor).
        const historyInfo = await findPlayerInfoFromHistory(channel);
        if (!license && historyInfo?.license) {
            license = historyInfo.license;
            channelLicense.set(channelId, license);
            console.log(`[Panel] ${channel.name}: lisans geçmişten bulundu: ${license}`);
        }
        if (!gameId && historyInfo?.gameId) {
            gameId = historyInfo.gameId;
            channelGameId.set(channelId, gameId);
        }
    }
    if (!license) {
        console.log(`[Panel] ${channel.name}: lisans yakalanmamış, /fg komutları gönderilmedi.`);
        if (mainWindow) {
            dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: 'Lisans Bulunamadı',
                message: `${channel.name} kanalında bir lisans yakalanmadı, /fg komutları gönderilemedi.`,
                buttons: ['Tamam']
            });
        }
        return;
    }

    const safeReason = String(reason || '').trim();
    if (!safeReason) {
        console.log(`[Panel] ${channel.name}: sebep boş, /fg komutları gönderilmedi.`);
        return;
    }

    try {
        if (gameId) {
            // Kullanıcı şu an oyunda: önce oyun içi ID ile canlı ban, sonra tekrar
            // bağlanmasını önlemek için license ile offline-ban.
            await channel.sendSlash(FG_BOT_ID, 'fg ban', gameId, safeReason);
            await channel.sendSlash(FG_BOT_ID, 'fg offline-ban', license, safeReason);
            console.log(`[Panel] ${channel.name}: /fg ban (oyun içi ID: ${gameId}) + /fg offline-ban (${license}) gönderildi.`);
        } else {
            // Kullanıcı oyunda değil: tek başına license ile offline-ban yeterli.
            await channel.sendSlash(FG_BOT_ID, 'fg offline-ban', license, safeReason);
            console.log(`[Panel] ${channel.name}: /fg offline-ban gönderildi (${license}).`);
        }

        // Ban gerekçesini kayıt altına almak için log kanalına da düşürüyoruz.
        const logChannel = client.channels.cache.get(LOG_CHANNEL_ID);
        if (logChannel) {
            const gameIdLine = gameId ? `\n🎮 Oyun İçi ID: ${gameId}` : '';
            await logChannel.send(`🚫 **BAN** — ${channel.name}\n📝 Sebep: ${safeReason}\n🔑 Lisans: ${license}${gameIdLine}`);
            console.log(`[Panel] ${channel.name}: ban sebebi log kanalına düşürüldü.`);
        }
    } catch (error) {
        console.log(`[Hata] "/fg" slash komutu gönderilemedi: ${error.message}`);
        if (mainWindow) {
            dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Ban Komutu Gönderilemedi',
                message: `"/fg" komutu gönderilirken hata oluştu:\n${error.message}`,
                buttons: ['Tamam']
            });
        }
    }
}

// --- KİMLİK SORGULA: "AC Çağır" butonu ---
// "/dm-player" komutu FG_BOT_ID'nin ac-komut kanalındaki bir komutu.
const AC_KOMUT_CHANNEL_ID = '1475520758095544490';
// Kişinin etiketlenip AC ticket mesajının atıldığı duyuru kanalı.
const AC_ANNOUNCE_CHANNEL_ID = '1470230489456578759';

// Aynı kişi için (çift tıklama, çift IPC olayı, her ne sebeple olursa olsun)
// kısa süre içinde ikinci bir AC Çağır isteği gelirse engeller - "1 kere bastım
// ama 6 kere gitti" tarzı çift gönderimlere karşı sunucu tarafında son kale.
const acCallCooldown = new Map(); // discordId -> son gönderim zamanı (ms)
const AC_CALL_COOLDOWN_MS = 10000;

// Bu, arkadaşların botları da dahil TÜM AC Çağır isteklerini kapsıyor: ayrı bir
// sunucu/veritabanı kurmadan, AC duyuru kanalının kendisini ortak "kayıt defteri"
// gibi kullanıyoruz - herkesin botu zaten aynı Discord sunucusuna bağlı.
const AC_RECENT_CALL_WINDOW_MS = 5 * 60 * 1000;

// AC duyuru kanalının son mesajlarını tarayıp bu Discord ID'nin son 5 dakika
// içinde (kim tarafından olursa olsun) etiketlenip etiketlenmediğine bakar.
async function findRecentAcCall(discordId, windowMs = AC_RECENT_CALL_WINDOW_MS) {
    const channel = client.channels.cache.get(AC_ANNOUNCE_CHANNEL_ID);
    if (!channel) return null;
    try {
        const messages = await channel.messages.fetch({ limit: 50 });
        const cutoff = Date.now() - windowMs;
        for (const message of messages.values()) {
            if (message.createdTimestamp < cutoff) break; // mesajlar yeniden eskiye sıralı, bundan sonrası zaten pencerenin dışında
            const mentionMatch = message.content.match(/<@!?(\d+)>/);
            if (mentionMatch && mentionMatch[1] === discordId) {
                return { at: message.createdTimestamp, author: message.author?.username || null };
            }
        }
    } catch (error) {
        console.log(`[AC Çağır] Son çağrı kontrolü yapılamadı: ${error.message}`);
    }
    return null;
}

// Kimlik Sorgula sonucundaki kişiyi AC'ye çağırır: hem ac-komut kanalına
// "/dm-player id:<oyun içi ID> message:<AC mesajı>" gönderir hem de duyuru
// kanalında kişiyi (Discord ID ile) etiketleyip AC ticket mesajını atar.
// "count" (1/2/3) kaçıncı çağrı olduğunu duyuru mesajının sonuna "Nx" olarak
// ekler - panel arayüzünde AC Çağır butonuna basınca 1x/2x/3x seçimi çıkıyor.
// Discord ID ve license'ın İKİSİ de yoksa (kimlik tam doğrulanmamış demektir)
// hiçbir şey göndermeden "yetersiz bilgi" hatası döner. "force" true değilse
// önce AC duyuru kanalında bu kişi son 5 dakikada geçmiş mi diye bakılır - geçmişse
// hiçbir şey göndermeden onay isteyen bir sonuç döner (renderer bunu "yine de
// gönder" butonuyla gösterip force:true ile tekrar çağırıyor).
async function performAcCall({ discord, license, playerId, name, count, force }) {
    if (!discord || !license) {
        console.log(`[AC Çağır] Yetersiz bilgi (discord: ${discord || 'yok'}, license: ${license || 'yok'}), hiçbir şey gönderilmedi.`);
        return { success: false, reason: 'insufficient', message: 'Discord ID veya License eksik - yetersiz bilgi, AC çağrılmadı.' };
    }

    if (!force) {
        const recent = await findRecentAcCall(discord);
        if (recent) {
            const minutesAgo = Math.max(1, Math.round((Date.now() - recent.at) / 60000));
            console.log(`[AC Çağır] ${discord} için ${minutesAgo} dakika önce AC duyuru kanalında etiketleme bulundu, onay bekleniyor.`);
            return {
                success: false,
                reason: 'recent-call',
                message: `Bu oyuncu ${minutesAgo} dakika önce zaten AC çağrıldı${recent.author ? ` (${recent.author} tarafından)` : ''} - yine de devam etmek istiyor musun?`,
            };
        }
    }

    const lastCallAt = acCallCooldown.get(discord);
    if (lastCallAt && Date.now() - lastCallAt < AC_CALL_COOLDOWN_MS) {
        console.log(`[AC Çağır] ${discord} için ${AC_CALL_COOLDOWN_MS}ms içinde tekrar istek geldi, çift gönderim koruması devrede - engellendi.`);
        return {
            success: false,
            reason: 'cooldown',
            message: `Bu kişi için ${Math.ceil(AC_CALL_COOLDOWN_MS / 1000)} saniye önce zaten AC çağrıldı - çift gönderimi önlemek için kısa bir süre bekleyip tekrar dene.`,
        };
    }
    acCallCooldown.set(discord, Date.now());

    const callCount = [1, 2, 3].includes(Number(count)) ? Number(count) : 1;
    const results = [];

    try {
        if (playerId) {
            const komutChannel = client.channels.cache.get(AC_KOMUT_CHANNEL_ID);
            if (!komutChannel) throw new Error(`ac-komut kanalı bulunamadı (${AC_KOMUT_CHANNEL_ID})`);
            await komutChannel.sendSlash(FG_BOT_ID, 'dm-player', playerId, acMessage);
            console.log(`[AC Çağır] /dm-player id:${playerId} gönderildi (${name || discord}).`);
            results.push('dm-player komutu gönderildi');
        } else {
            console.log(`[AC Çağır] Oyun içi ID yok, /dm-player atlandı (${name || discord}).`);
            results.push('/dm-player atlandı (oyun içi ID bilinmiyor)');
        }

        const announceChannel = client.channels.cache.get(AC_ANNOUNCE_CHANNEL_ID);
        if (!announceChannel) throw new Error(`AC duyuru kanalı bulunamadı (${AC_ANNOUNCE_CHANNEL_ID})`);
        await announceChannel.send(`<@${discord}> ${acTicketMessage} ${callCount}x`);
        console.log(`[AC Çağır] Duyuru kanalına etiketlendi (${name || discord}, ${callCount}x).`);
        results.push(`duyuru kanalına ${callCount}x olarak etiketlendi`);

        watchForDisconnectionAfterAcCall({ discord, license, name });

        return { success: true, message: results.join(', ') + '.' };
    } catch (error) {
        console.log(`[Hata] AC Çağır: ${error.message}`);
        return { success: false, reason: 'error', message: `Gönderilirken hata oluştu: ${error.message}` };
    }
}

// "Spam" - AC Çağır'ın agresif versiyonu: AC duyuru kanalına HİÇ yazmadan (kullanıcı
// isteği - orası kirlenmesin diye), sadece ac-komut kanalına SPAM_DM_COUNT kadar
// "/dm-player" komutunu HEPSİNİ AYNI ANDA (paralel, Promise.all) gönderip oyuncuya
// doğrudan o kadar AC mesajı ulaştırır - kullanıcı "yavaş atıyo, anında atsın"
// dediği için sıralı+beklemeli döngü (eskiden aralarda 700ms vardı) kaldırıldı.
// "/dm-player" oyunda olmayı gerektirdiği için Player ID şart - yoksa gönderilemez.
const SPAM_DM_COUNT = 10;

async function performAcCallSpam({ discord, license, playerId, name }) {
    if (!playerId) {
        console.log(`[AC Spam] Oyun içi ID yok (${name || discord || license || 'bilinmiyor'}), spam gönderilemedi.`);
        return { success: false, reason: 'insufficient', message: 'Oyun içi ID yok - kişi şu an oyunda değil, spam gönderilemedi.' };
    }

    const cooldownKey = discord || license || playerId;
    const lastCallAt = acCallCooldown.get(cooldownKey);
    if (lastCallAt && Date.now() - lastCallAt < AC_CALL_COOLDOWN_MS) {
        console.log(`[AC Spam] ${cooldownKey} için ${AC_CALL_COOLDOWN_MS}ms içinde tekrar istek geldi, çift gönderim koruması devrede - engellendi.`);
        return {
            success: false,
            reason: 'cooldown',
            message: `Bu kişi için ${Math.ceil(AC_CALL_COOLDOWN_MS / 1000)} saniye önce zaten bir çağrı/spam gönderildi - kısa bir süre bekleyip tekrar dene.`,
        };
    }
    acCallCooldown.set(cooldownKey, Date.now());

    const komutChannel = client.channels.cache.get(AC_KOMUT_CHANNEL_ID);
    if (!komutChannel) {
        return { success: false, reason: 'error', message: `ac-komut kanalı bulunamadı (${AC_KOMUT_CHANNEL_ID})` };
    }

    try {
        const outcomes = await Promise.allSettled(
            Array.from({ length: SPAM_DM_COUNT }, () => komutChannel.sendSlash(FG_BOT_ID, 'dm-player', playerId, acMessage))
        );
        const sent = outcomes.filter((o) => o.status === 'fulfilled').length;
        console.log(`[AC Spam] ${name || discord || playerId} için ${sent}/${SPAM_DM_COUNT} adet /dm-player (paralel) gönderildi.`);
        if (discord || license) watchForDisconnectionAfterAcCall({ discord, license, name });

        if (sent === 0) {
            const firstError = outcomes.find((o) => o.status === 'rejected');
            const errorMessage = firstError?.reason?.message || 'bilinmeyen hata';
            console.log(`[Hata] AC Spam: ${errorMessage}`);
            return { success: false, reason: 'error', message: `Gönderilirken hata oluştu: ${errorMessage}` };
        }
        return { success: true, message: `${sent}/${SPAM_DM_COUNT} adet AC mesajı gönderildi.` };
    } catch (error) {
        console.log(`[Hata] AC Spam: ${error.message}`);
        return { success: false, reason: 'error', message: `Gönderilirken hata oluştu: ${error.message}` };
    }
}

// AC çağrılan kişiyi 3 dakika boyunca connections-webhook'ta CANLI izler (tarama
// değil, messageCreate event'ine geçici bir dinleyici eklenip süre dolunca ya da
// eşleşme bulununca kaldırılıyor) - sunucudan çıkarsa (normal ya da ban ile) Windows
// bildirimi gönderir. Süre içinde hiçbir şey olmazsa sessizce bırakılır.
const AC_CALL_WATCH_MS = 3 * 60 * 1000;

function watchForDisconnectionAfterAcCall({ discord, license, name }) {
    if (!discord && !license) return;

    const listener = (message) => {
        if (message.channel.id !== CONNECTIONS_WEBHOOK_CHANNEL_ID) return;
        const entry = parseConnectionsWebhookEntry(message.embeds?.[0]);
        if (!entry || entry.online) return; // sadece ayrılma/reddedilme olayları ilgimizi çekiyor
        const matches = (license && entry.license === license) || (discord && entry.discord === discord);
        if (!matches) return;

        clearTimeout(timeoutId);
        client.removeListener('messageCreate', listener);

        const banned = Boolean(entry.reason && /ban/i.test(entry.reason));
        const displayName = entry.name || name || discord;
        console.log(`[AC Çağır] ${displayName} AC çağrıldıktan sonra ${banned ? 'BANLANDI' : 'sunucudan çıktı'} (sebep: ${entry.reason || 'belirtilmedi'}).`);

        // Windows bildirimi kolayca gözden kaçabildiği için (köşede sessizce
        // görünüp kayboluyor) burada onun yerine gerçek bir pop-up (native dialog)
        // kullanılıyor - kapatılana kadar ekranda kalır, gözden kaçmaz.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
        dialog.showMessageBox(mainWindow, {
            type: banned ? 'warning' : 'info',
            title: banned ? `🚫 ${displayName} BANLANDI` : `🚪 ${displayName} sunucudan çıktı`,
            message: banned
                ? `${displayName}, AC çağrıldıktan sonra banlandı.\nSebep: ${entry.reason}`
                : `${displayName}, AC çağrıldıktan sonra sunucudan ayrıldı.${entry.reason ? `\nSebep: ${entry.reason}` : ''}`,
            buttons: ['Tamam']
        });
    };

    client.on('messageCreate', listener);
    const timeoutId = setTimeout(() => {
        client.removeListener('messageCreate', listener);
    }, AC_CALL_WATCH_MS);
}

// Kimlik Sorgula sonucundan doğrudan "/fg ban" ya da "/fg offline-ban" gönderir -
// AC Çağır'la aynı kanala (ac-komut, AC_KOMUT_CHANNEL_ID). "fg ban" oyun içi
// Player ID ister (kişi şu an oyunda değilse/ID bilinmiyorsa kullanılamaz),
// "fg offline-ban" license ister (Kimlik Sorgula'nın zaten zorunlu tuttuğu alan,
// bu yüzden pratikte her zaman kullanılabilir).
async function performLookupFgBan({ type, playerId, license, reason }) {
    const safeReason = String(reason || '').trim();
    if (!safeReason) {
        return { success: false, message: 'Sebep boş bırakılamaz.' };
    }
    if (type === 'ban' && !playerId) {
        return { success: false, message: 'Oyun içi ID bilinmiyor - "/fg ban" için kişi şu an oyunda olmalı.' };
    }
    if (type === 'offline-ban' && !license) {
        return { success: false, message: 'License bilinmiyor - "/fg offline-ban" gönderilemedi.' };
    }

    try {
        const komutChannel = client.channels.cache.get(AC_KOMUT_CHANNEL_ID);
        if (!komutChannel) throw new Error(`ac-komut kanalı bulunamadı (${AC_KOMUT_CHANNEL_ID})`);

        if (type === 'ban') {
            await komutChannel.sendSlash(FG_BOT_ID, 'fg ban', playerId, safeReason);
            console.log(`[Kimlik Sorgula] /fg ban id:${playerId} gönderildi (sebep: ${safeReason}).`);
            return { success: true, message: `/fg ban gönderildi (ID: ${playerId}).` };
        } else {
            await komutChannel.sendSlash(FG_BOT_ID, 'fg offline-ban', license, safeReason);
            console.log(`[Kimlik Sorgula] /fg offline-ban ${license} gönderildi (sebep: ${safeReason}).`);
            return { success: true, message: `/fg offline-ban gönderildi (${license}).` };
        }
    } catch (error) {
        console.log(`[Hata] Kimlik Sorgula /fg komutu: ${error.message}`);
        return { success: false, message: `Gönderilirken hata oluştu: ${error.message}` };
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

ipcMain.on('ticket-claim', async (event, channelId) => {
    try {
        await performTicketClaim(channelId);
    } catch (error) {
        console.log(`[Hata] Claim işlemi başarısız: ${error.message}`);
    }
});

ipcMain.on('ticket-close', async (event, channelId) => {
    try {
        await performTicketClose(channelId);
    } catch (error) {
        console.log(`[Hata] Kapatma işlemi başarısız: ${error.message}`);
    }
});

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

ipcMain.on('ticket-ban', async (event, { channelId, reason }) => {
    try {
        await performTicketBan(channelId, reason);
    } catch (error) {
        console.log(`[Hata] Ban mesajı gönderilemedi: ${error.message}`);
    }
});

ipcMain.on('ticket-ban-confirm', async (event, { channelId, reason }) => {
    try {
        await performTicketBanConfirm(channelId, reason);
    } catch (error) {
        console.log(`[Hata] /fg ban komutları gönderilemedi: ${error.message}`);
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

// debug.log'a token'ın tamamı değil, sadece ilk birkaç karakteri + yıldızlar yazılsın.
function maskToken(token) {
    if (!token) return '';
    if (token.length <= 6) return '*'.repeat(token.length);
    return token.slice(0, 4) + '*'.repeat(token.length - 4);
}

function getMaskedMobileUrl() {
    return `http://${getLocalLanIp()}:${MOBILE_PORT}/?token=${maskToken(MOBILE_ACCESS_TOKEN)}`;
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

    // Logo - mobile.html'in <img> etiketi buradan çekiyor. Token gerekmiyor (hassas
    // veri değil, sadece görsel) - token'sız istek atan biri sadece logoyu görür.
    if (req.method === 'GET' && reqUrl.pathname === '/logo.png') {
        try {
            const logoBuffer = fs.readFileSync(path.join(__dirname, 'logo.png'));
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
            res.end(logoBuffer);
        } catch (error) {
            res.writeHead(404);
            res.end();
        }
        return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/tickets') {
        if (!hasValidToken(reqUrl)) return sendJson(res, 401, { error: 'Geçersiz erişim kodu' });
        return sendJson(res, 200, getTicketChannels());
    }

    const actionMatch = reqUrl.pathname.match(/^\/api\/tickets\/(\d+)\/(kontrol|cancel|ban|hold|ban-confirm|claim|close)$/);
    if (req.method === 'POST' && actionMatch) {
        if (!hasValidToken(reqUrl)) return sendJson(res, 401, { error: 'Geçersiz erişim kodu' });
        const [, channelId, action] = actionMatch;
        try {
            if (action === 'kontrol') await performTicketKontrol(channelId);
            else if (action === 'cancel') performTicketCancel(channelId);
            else if (action === 'hold') performTicketHold(channelId);
            else if (action === 'claim') await performTicketClaim(channelId);
            else if (action === 'close') await performTicketClose(channelId);
            else if (action === 'ban' || action === 'ban-confirm') {
                let body = '';
                for await (const chunk of req) body += chunk;
                let reason = '';
                try { reason = JSON.parse(body || '{}').reason || ''; } catch (e) {}
                if (action === 'ban') await performTicketBan(channelId, reason);
                else await performTicketBanConfirm(channelId, reason);
            }
            return sendJson(res, 200, { ok: true });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: error.message });
        }
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/lookup') {
        if (!hasValidToken(reqUrl)) return sendJson(res, 401, { error: 'Geçersiz erişim kodu' });
        try {
            const result = await resolvePlayerIdentity(reqUrl.searchParams.get('query') || '');
            return sendJson(res, 200, { result });
        } catch (error) {
            return sendJson(res, 500, { error: error.message });
        }
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/ac-call') {
        if (!hasValidToken(reqUrl)) return sendJson(res, 401, { error: 'Geçersiz erişim kodu' });
        let body = '';
        for await (const chunk of req) body += chunk;
        let target = {};
        try { target = JSON.parse(body || '{}'); } catch (e) {}
        try {
            const result = await performAcCall(target);
            return sendJson(res, 200, result);
        } catch (error) {
            return sendJson(res, 500, { success: false, message: error.message });
        }
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/ac-call-spam') {
        if (!hasValidToken(reqUrl)) return sendJson(res, 401, { error: 'Geçersiz erişim kodu' });
        let body = '';
        for await (const chunk of req) body += chunk;
        let target = {};
        try { target = JSON.parse(body || '{}'); } catch (e) {}
        try {
            const result = await performAcCallSpam(target);
            return sendJson(res, 200, result);
        } catch (error) {
            return sendJson(res, 500, { success: false, message: error.message });
        }
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/lookup-fg-ban') {
        if (!hasValidToken(reqUrl)) return sendJson(res, 401, { error: 'Geçersiz erişim kodu' });
        let body = '';
        for await (const chunk of req) body += chunk;
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch (e) {}
        try {
            const result = await performLookupFgBan(payload);
            return sendJson(res, 200, result);
        } catch (error) {
            return sendJson(res, 500, { success: false, message: error.message });
        }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bulunamadı' }));
});

function startApp() {
    console.log("[Sistem] Nexora Kontrol Merkezi başlatılıyor...");
    validateNexoraApiKey();
    // Windows'taki gerçek "başlangıçta çalıştır" kaydını her açılışta config.env'deki
    // tercihle senkron tutuyoruz (exe taşınmış/yeniden paketlenmiş olsa bile).
    app.setLoginItemSettings({ openAtLogin: openAtLoginEnabled });
    mainWindow = new BrowserWindow({
        width: PANEL_LAYOUT_SIZES[panelLayout].width,
        height: PANEL_LAYOUT_SIZES[panelLayout].height,
        title: "Nexora Kontrol Merkezi",
        autoHideMenuBar: true,
        resizable: false,
        // Native Windows başlık çubuğu (siyah, panelden kopuk duran şerit) kaldırılıp
        // yerine index.html'deki ".titlebar" (panelle aynı temada, sürüklenebilir,
        // kendi küçült/kapat butonları olan) geçiyor - kullanıcı isteğiyle "üst kısmı
        // panelle birleştir" (bkz. IPC: window-minimize / window-close).
        frame: false,
        icon: path.join(__dirname, 'icon.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('index.html');

    mobileServer.listen(MOBILE_PORT, '0.0.0.0', () => {
        const mobileUrl = getMobileUrl();
        console.log(`[Mobil] Aynı Wi-Fi'daki telefondan erişim: ${getMaskedMobileUrl()}`);
        if (mainWindow) mainWindow.webContents.send('mobile-url', mobileUrl);
        mobileServerReady = true;
        broadcastSystemStatus();
    });

    attemptLogin();
}

// --- OTOMATİK YENİDEN BAĞLANMA ---
// Kütüphane geçici ağ kopmalarını (wifi dalgalanması vb.) zaten kendi içinde
// sürekli deniyor (5sn arayla, WebSocketManager.reconnect) - burada elle bir şey
// yapmamıza gerek yok. Bizim eklediğimiz iki durum: (1) İLK giriş (client.login)
// zaman aşımına uğrarsa/başarısız olursa kütüphane hiç denemiyor, o yüzden kendi
// yeniden deneme döngümüzü kuruyoruz. (2) Oturum tamamen geçersiz kılınırsa
// ("invalidated" - genelde token değişmiş/oturum sonlandırılmış demek) kütüphane
// shard'ları yok edip tamamen duruyor, yeni bir client.login() gerekiyor.
const RECONNECT_DELAY_MS = 15000;
const MAX_RECONNECT_ATTEMPTS = 5;
let reconnectAttempts = 0;
let hasConnectedBefore = false;

function attemptLogin() {
    console.log(`[Bağlantı] Discord'a giriş deneniyor... (deneme ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS + 1})`);
    const LOGIN_TIMEOUT_MS = 25000;
    const loginTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Giriş ${LOGIN_TIMEOUT_MS / 1000} saniye içinde tamamlanmadı. Muhtemelen güvenlik duvarı/antivirüs Discord bağlantısını (WebSocket) engelliyor - dosya dışlaması bunu kapsamaz, ayrıca Windows Güvenlik Duvarı izni de gerekiyor.`)), LOGIN_TIMEOUT_MS);
    });
    Promise.race([client.login(process.env.USER_TOKEN), loginTimeout]).catch((error) => {
        console.log(`[Hata] Discord girişi başarısız: ${error.message}`);
        discordStatus = 'hata';
        broadcastSystemStatus();

        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.log('[Bağlantı] Maksimum yeniden bağlanma denemesi aşıldı, otomatik deneme durduruldu.');
            if (mainWindow) {
                dialog.showMessageBox(mainWindow, {
                    type: 'error',
                    title: 'Discord Bağlantısı Kurulamadı',
                    message: `${MAX_RECONNECT_ATTEMPTS} deneme sonunda Discord'a bağlanılamadı:\n${error.message}\n\nToken'ın geçerli olduğundan ve internet bağlantından emin olup programı yeniden başlat.`,
                    buttons: ['Tamam']
                });
            }
            return;
        }

        reconnectAttempts++;
        console.log(`[Bağlantı] ${RECONNECT_DELAY_MS / 1000} saniye sonra yeniden denenecek.`);
        setTimeout(attemptLogin, RECONNECT_DELAY_MS);
    });
}

client.on('invalidated', () => {
    console.log('[Bağlantı] Discord oturumu geçersiz kılındı (invalidated) - kütüphane kendiliğinden yeniden bağlanmayı bırakır, elle yeniden giriş deneniyor.');
    discordStatus = 'hata';
    broadcastSystemStatus();
    if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'Discord Bağlantısı Koptu',
            message: 'Discord oturumu sıfırlandı, otomatik olarak yeniden bağlanılmaya çalışılıyor...',
            buttons: ['Tamam']
        });
    }
    reconnectAttempts = 0; // yeni bir kopma döngüsü, sayaç sıfırlansın
    setTimeout(attemptLogin, 3000);
});

client.on('error', (error) => {
    console.log(`[Hata] Discord bağlantı hatası: ${error.message}`);
    discordStatus = 'hata';
    broadcastSystemStatus();
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
        frame: false,
        icon: path.join(__dirname, 'icon.ico'),
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

    // Mevcut config.env'deki diğer ayarları (tarama/ban mesajı vb.) korumak için
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
        if (isRunningFromTemporaryLocation()) {
            console.log(`[Kurulum] UYARI: Uygulama geçici bir klasörden çalışıyor (${__dirname}) - ayarlar kalıcı olmayabilir.`);
            await dialog.showMessageBox({
                type: 'warning',
                title: 'Geçici Klasörden Çalışıyor',
                message: 'Nexora Panel şu an geçici bir klasörden çalışıyor gibi görünüyor (muhtemelen ZIP dosyasının içinden, hiç çıkarmadan açıldı).\n\nBu durumda girdiğin ayarlar (Discord token, API anahtarı vb.) her açılışta sıfırlanır - çünkü Windows bu klasörü her seferinde yeniden, geçici olarak oluşturuyor.\n\nÇözüm: "Nexora Panel-win32-x64" klasörünü ZIP dosyasının içinden Masaüstü gibi kalıcı bir klasöre çıkar (klasöre sağ tık → "Tümünü Çıkart") ve programı oradan çalıştır.',
                buttons: ['Anladım']
            });
        }
        showSetupWindow();
    }
});

// "webhook-system" kanalı - AC botunun (FeloxAC) silent aim vb. şüpheli tespit
// raporlarını attığı kanal. Yeni mesaj geldiğinde Windows bildirimi gönderiyoruz.
const SUSPICIOUS_CHANNEL_ID = '1522577961558085742';

// Aynı kişinin (license/steam/discord/name önceliğiyle) son 50 raporun içinde kaç kez
// düştüğünü hesaplamak için tutulan kayan pencere - her yeni raporda API'ye tekrar
// istek atmadan (optimizasyon) sadece bu diziye ekleyip en eskisini düşürüyoruz.
const recentSuspiciousReports = [];

// Discord'un özel emoji söz dizimini (<a:isim:id> / <:isim:id>) ve markdown
// biçimlendirmesini temizler - Windows bildirimleri düz metin gösterdiği için
// bunlar olduğu gibi kalırsa "<a:safe:1470797064857194590>" gibi çirkin bir kod görünür.
function stripDiscordMarkup(text) {
    return String(text || '')
        .replace(/<a?:\w+:\d+>/g, '')
        .replace(/[`*_~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function findEmbedField(embed, pattern) {
    const field = embed?.fields?.find((f) => pattern.test(String(f.name || '').trim()));
    return field ? stripDiscordMarkup(field.value) : null;
}

function extractSuspiciousIdentifier(embed) {
    return (
        findEmbedField(embed, /license/i) ||
        findEmbedField(embed, /steam/i) ||
        findEmbedField(embed, /discord/i) ||
        findEmbedField(embed, /^name$/i)
    );
}

// --- KİMLİK SORGULA: /player-info slash komutu (FG botu) ---
// Eskiden kill-log + connections-webhook kanallarını dakikalarca (60sn'ye kadar)
// sayfalayarak tarayan bir zincir vardı. Kullanıcı "license ile kimlik kontrolünü
// kaldır, sadece DC ID ve Player ID ile kontrol edelim, eski kontrol biçimini
// tamamen kaldır" dedi - FG botunun (Fiveguard, FG_BOT_ID) `/player-info` komutu
// (options: [0] user=Discord kullanıcı, [1] gameid=oyun içi ID, ikisi de opsiyonel
// ama YALNIZCA biri veriliyor) TEK bir anlık sorguda license/Steam adı/Steam
// ID/Discord/Oyun İçi ID/"Oyunda mı?"/"FG Banlı mı?" hepsini birden, DOĞRUDAN
// FG botundan (log taraması değil, canlı/otoriter cevap) veriyor - hem çok daha
// hızlı hem "FG Banlı mı?" artık GERÇEK/güncel bir cevap (eskiden webhook-system
// ban tespiti kaldırılmıştı çünkü unbans'ı hiç kontrol etmeyip eski/geçersiz
// banları "hâlâ banlı" gösteriyordu - bu sorun burada YOK, FG botu kendi güncel
// veritabanına bakıyor). Şema `_test_playerinfo.js` (geçici, silindi) ile canlı
// doğrulandı - application_id BOT_ID (FG_BOT_ID) ile birebir eşleşiyor.
// NOT: ID_COMMAND_CHANNEL_IDS[0] ile AYNI değer (ac-komut) ama o sabit bu dosyada
// DAHA SONRA tanımlanıyor - modül yüklenirken en üstten çalışan bir "const" olduğu
// için ona referans vermek yerine (TDZ hatası) burada doğrudan literal kullanılıyor.
const PLAYER_INFO_COMMAND_CHANNEL_ID = '1475520758095544490'; // ac-komut - kullanıcı bu kanalı belirtti
const PLAYER_INFO_TIMEOUT_MS = 15000; // ilk boş mesaj + embed'li edit'i beklemek için biraz pay bırakıldı
const CONNECTIONS_WEBHOOK_CHANNEL_ID = '1513234125337919610';

// /player-info embed'inin alan adları küçük bir "↷" dekorasyon karakteriyle geliyor
// (bkz. canlı ekran görüntüleri) - o yüzden TAM eşleşme yerine BAŞLANGIÇ eşleşmesi
// kullanılıyor (parsePlayerInfoFromBotMessage'daki aynı derste öğrenilen yaklaşım).
function parsePlayerInfoEmbed(embed) {
    if (!embed?.fields?.length) return null;
    const fields = embed.fields;
    const clean = (v) => String(v || '').replace(/[`*_~]/g, '').trim();
    const find = (test) => fields.find((f) => test(String(f.name || '').trim()));

    const licenseField = find((n) => /^lisans/i.test(n));
    const steamIdField = find((n) => /^steam/i.test(n) && /id/i.test(n));
    const steamNameField = find((n) => /^steam/i.test(n) && !/id/i.test(n));
    const discordField = find((n) => /^discord/i.test(n) && !/kullan/i.test(n));
    const gameIdField = find((n) => /^oyun\s/i.test(n)); // "Oyunda mı?"dan ayırmak için boşluk şart
    const onlineField = find((n) => /^oyunda/i.test(n));
    const bannedField = find((n) => /^fg\s*banl/i.test(n));

    const gameIdRaw = gameIdField ? clean(gameIdField.value) : null;
    const isEvet = (f) => (f ? /evet/i.test(clean(f.value)) : null);

    return {
        license: licenseField ? clean(licenseField.value) : null,
        steamId: steamIdField ? clean(steamIdField.value) : null,
        steamName: steamNameField ? clean(steamNameField.value) : null,
        discord: discordField ? clean(discordField.value).replace(/^discord:/i, '') : null,
        gameId: /^\d+$/.test(gameIdRaw || '') ? gameIdRaw : null,
        online: isEvet(onlineField),
        banned: isEvet(bannedField),
    };
}

// Aynı anda birden fazla /player-info isteği (Kimlik Sorgula + !id komutu + Liste+Detay
// ticket paneli aynı anda tetiklenebilir) YARIŞ DURUMUNA yol açmasın diye TEK BİR
// kuyruktan sırayla işleniyor - "gönder, o botun kanaldaki BİR SONRAKİ mesajını bekle"
// deseni ancak aynı anda tek istek varsa güvenilir olur.
let playerInfoQueue = Promise.resolve();
function queryPlayerInfoCommand(params) {
    const run = () => queryPlayerInfoCommandImpl(params);
    const chained = playerInfoQueue.then(run, run);
    playerInfoQueue = chained.catch(() => {}); // bir istek hata verse bile kuyruk tıkanmasın
    return chained;
}

// channel.sendSlash()'ı DOĞRUDAN kullanmıyoruz - kendi içinde çağırdığı
// client.users.fetch(botId) canlı testte "Unauthorized" ile başarısız oldu (kök sebep
// belirsiz, muhtemelen oturuma özel bir kısıtlama - ama application-command-index API'si
// AYNI botun komutları için hiç başarısız olmadı). Bu yüzden ApplicationCommand'i şema
// verisinden ELLE inşa edip users.fetch()'e hiç gerek kalmadan komutu gönderiyoruz.
async function sendPlayerInfoSlashCommand(channel, discordId, gameId) {
    const API = channel.guild
        ? client.api.guilds[channel.guild.id]['application-command-index']
        : client.api.channels[channel.id]['application-command-index'];
    const data = await API.get();
    const cmdData = data.application_commands.find((c) => c.name === 'player-info' && c.application_id === FG_BOT_ID);
    if (!cmdData) throw new Error('player-info komutu şemada bulunamadı (bot izin verilmemiş/komut kaldırılmış olabilir).');

    const command = new DiscordApplicationCommand(client, cmdData);
    const fakeMessage = new DiscordMessage(client, {
        channel_id: channel.id,
        guild_id: channel.guild?.id || null,
        author: client.user,
        content: '',
        id: client.user.id,
    });
    // options sırası ÖNEMLİ (komut şemasındaki sırayla POZİSYONEL dolduruluyor):
    // [0] user (Discord ID/mention), [1] gameid - kullanılmayan undefined bırakılıyor.
    return command.sendSlashCommand(fakeMessage, [], [discordId || undefined, gameId || undefined]);
}

async function queryPlayerInfoCommandImpl({ discordId, gameId } = {}) {
    const channel = client.channels.cache.get(PLAYER_INFO_COMMAND_CHANNEL_ID);
    if (!channel) {
        console.log('[Oyuncu Bilgi] player-info kanalı bulunamadı.');
        return null;
    }

    // ÖNEMLİ: FG botu /player-info'yu ÖNCE embed'i BOŞ bir mesajla (muhtemelen "defer" -
    // arka planda işlenirken) gönderip birkaç saniye sonra AYNI mesajı embed'le EDİT
    // ediyor (canlı testte kesin doğrulandı - ilk messageCreate'te embeds.length: 0,
    // asıl içerik sonradan geliyor). Sadece messageCreate dinleyip "embeds boşsa atla"
    // dersek asıl yanıtı SONSUZA DEK kaçırırız (bu YÜZDEN "şu an çalışmıyor" oluyordu) -
    // bu yüzden hem messageCreate HEM messageUpdate dinlenip HANGİSİ önce embed doldurursa
    // ona göre karar veriliyor.
    const waitForReply = new Promise((resolve) => {
        const timeout = setTimeout(() => {
            client.removeListener('messageCreate', onCreate);
            client.removeListener('messageUpdate', onUpdate);
            resolve(null);
        }, PLAYER_INFO_TIMEOUT_MS);
        function tryResolve(message) {
            if (message.channelId !== PLAYER_INFO_COMMAND_CHANNEL_ID) return;
            if (message.author?.id !== FG_BOT_ID) return;
            if (!message.embeds?.length) return; // henüz boş kabuk - bekle, messageUpdate'i gözle
            if (message.interaction && message.interaction.commandName && message.interaction.commandName !== 'player-info') return;
            clearTimeout(timeout);
            client.removeListener('messageCreate', onCreate);
            client.removeListener('messageUpdate', onUpdate);
            resolve(message);
        }
        function onCreate(message) {
            tryResolve(message);
        }
        function onUpdate(oldMessage, newMessage) {
            tryResolve(newMessage);
        }
        client.on('messageCreate', onCreate);
        client.on('messageUpdate', onUpdate);
    });

    try {
        await sendPlayerInfoSlashCommand(channel, discordId, gameId);
    } catch (error) {
        console.log(`[Oyuncu Bilgi] /player-info gönderilemedi: ${error.message}`);
        return null;
    }

    const message = await waitForReply;
    if (!message) {
        console.log('[Oyuncu Bilgi] /player-info yanıtı zaman aşımına uğradı.');
        return null;
    }
    return parsePlayerInfoEmbed(message.embeds[0]);
}

// connections-webhook embed'i field değil, tek bir metin bloğu (description) -
// "Server ID: N", "Identifiers" listesinde steam/license/discord/ip JSON benzeri
// satırlar halinde. Field aramak yerine tüm metni birleştirip regex ile çekiyoruz.
// ÖNEMLİ: "New connection" mesajında Server ID YOK (kişi sunucuya daha yeni
// girdiği an için henüz atanmamış), sadece "New disconnection"da var. Bu yüzden
// "online" (şu an oyunda mı) bilgisini Server ID'nin varlığından değil, mesaj
// başlığından çıkarıyoruz. Başlık ("New connection"/"New disconnection") embed'in
// title'ında DEĞİL author.name'inde geliyor (canlı testte görüldü) - title her
// zaman boş olduğu için eski kod "online" hesabını hep false buluyordu, artık
// ikisi de deneniyor + tam eşleşme yerine anahtar kelime bazlı kontrol yapılıyor.
function parseConnectionsWebhookEntry(embed) {
    if (!embed) return null;
    const title = stripDiscordMarkup(embed.title) || stripDiscordMarkup(embed.author?.name) || '';
    const blob = [title, embed.description, ...(embed.fields || []).map((f) => `${f.name}\n${f.value}`)]
        .filter(Boolean)
        .join('\n');

    const nameMatch = blob.match(/\*\*(.+?)\*\*\s+(has left|is connecting|has joined|was)/i);
    const serverIdMatch = blob.match(/server\s*id:\s*(\d+)/i);
    const steamMatch = blob.match(/"?steam:([a-f0-9]+)"?/i);
    const licenseMatch = blob.match(/"?license:([a-f0-9]+)"?/i);
    const discordMatch = blob.match(/"?discord:(\d+)"?/i);
    const ipMatch = blob.match(/"?ip:([\d.]+)"?/i);
    const reasonMatch = blob.match(/reason:\s*(.+)/i);

    if (!serverIdMatch && !licenseMatch) return null;

    return {
        name: nameMatch ? stripDiscordMarkup(nameMatch[1]) : null,
        playerId: serverIdMatch ? serverIdMatch[1] : null,
        steam: steamMatch ? `steam:${steamMatch[1]}` : null,
        license: licenseMatch ? `license:${licenseMatch[1]}` : null,
        discord: discordMatch ? discordMatch[1] : null,
        ip: ipMatch ? ipMatch[1] : null,
        // "Reason: Exiting" (normal çıkış) ya da "Reason: You have been banned by
        // FeloxAC for cheating" (ban) - hangisi olduğunu ayırt etmek için kullanılıyor.
        reason: reasonMatch ? stripDiscordMarkup(reasonMatch[1]) : null,
        eventTitle: title || null,
        // "connection" geçiyor ama "disconnection"/"reject" geçmiyorsa online -
        // tam eşleşme yerine anahtar kelime araması (başlıkta ekstra emoji/boşluk
        // farkı olsa da bozulmasın diye).
        online: /connection/i.test(title) && !/disconnection/i.test(title) && !/reject/i.test(title),
    };
}

// --- LİSTE + DETAY panelinin ticket başına gösterdiği zengin kimlik bilgisi ---
// Kullanıcı elle bir sorgu yazmıyor (bu, Kimlik Sorgula'dan FARKLI bir akış) - ticket
// seçilince otomatik olarak: (1) ticket açılışında zaten yakalanmış oyun içi ID/license
// yoksa geçmişten bulunuyor (channelLicense/channelGameId, findPlayerInfoFromHistory),
// (2) findTargetUserId ile ticket'ı açan kişinin Discord ID'si bulunuyor, (3) Discord ID
// (yoksa oyun içi ID) ile /player-info sorgulanıp DOĞRUDAN/GÜNCEL sonuç gösteriliyor -
// artık log taraması/heuristik YOK, "FG Banlı mı?" FG botunun kendi güncel cevabı.
async function buildTicketDetail(channelId) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return null;

    let license = channelLicense.get(channelId) || null;
    let gameId = channelGameId.get(channelId) || null;

    // Bu ticket için canlı yakalama hiç olmadıysa (bkz. findPlayerInfoFromHistory yorumu),
    // geçmişten taze bul VE ileride Ban gibi diğer akışlar da yararlansın diye map'lere
    // de yaz (sadece bu fonksiyona özel bir önbellek değil, aynı channelLicense/channelGameId).
    if (!license || !gameId) {
        const historyInfo = await findPlayerInfoFromHistory(channel);
        if (historyInfo) {
            if (!license && historyInfo.license) {
                license = historyInfo.license;
                channelLicense.set(channelId, license);
            }
            if (!gameId && historyInfo.gameId) {
                gameId = historyInfo.gameId;
                channelGameId.set(channelId, gameId);
            }
        }
    }

    let discordId = null;
    try {
        discordId = await findTargetUserId(channel, null);
    } catch (error) {
        console.log(`[Ticket Detay] ${channel.name}: hedef kullanıcı bulunamadı: ${error.message}`);
    }

    let info = null;
    if (discordId || gameId) {
        info = await queryPlayerInfoCommand({ discordId, gameId: discordId ? null : gameId });
    }

    return {
        license: info?.license || license,
        gameId: info?.gameId || gameId,
        discordId: info?.discord || discordId,
        steam: info?.steamId || null,
        steamName: info?.steamName || null,
        online: info?.online ?? null,
        banned: info?.banned ?? null,
    };
}

ipcMain.on('request-ticket-detail', async (event, channelId) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    try {
        const detail = await buildTicketDetail(channelId);
        win.webContents.send('ticket-detail', { channelId, detail });
    } catch (error) {
        console.log(`[Ticket Detay] İstek başarısız: ${error.message}`);
        win.webContents.send('ticket-detail', { channelId, detail: null });
    }
});

// Sorgu metninden tür tahmini - kullanıcı isteğiyle ARTIK SADECE Discord ID ve Player
// (oyun içi) ID destekleniyor (license/isim ile arama TAMAMEN kaldırıldı, /player-info
// komutunun kendisi de zaten sadece bu ikisini kabul ediyor).
function detectLookupQueryType(q) {
    if (!/^\d+$/.test(q)) return null;
    return q.length >= 15 ? 'discordId' : 'playerId';
}

// /player-info slash komutuyla Discord ID ya da Player ID üzerinden TEK bir canlı
// sorguda kimlik bilgisi getirir - eski kill-log/connections-webhook tarama zinciri
// tamamen kaldırıldı (bkz. yukarıdaki PLAYER_INFO_COMMAND_CHANNEL_ID notu).
async function resolvePlayerIdentity(query) {
    const q = String(query || '').trim();
    if (!q) return null;

    const type = detectLookupQueryType(q);
    if (!type) {
        console.log(`[Kimlik Sorgula] "${q}" geçersiz sorgu - sadece Discord ID veya Oyun İçi (Player) ID destekleniyor.`);
        return null;
    }

    console.log(`[Kimlik Sorgula] ${type === 'discordId' ? 'Discord ID' : 'Player ID'} ${q} için /player-info sorgulanıyor...`);
    const info = await queryPlayerInfoCommand(type === 'discordId' ? { discordId: q } : { gameId: q });
    if (!info) {
        console.log(`[Kimlik Sorgula] "${q}" için /player-info sonuç vermedi.`);
        return null;
    }

    return {
        playerId: info.gameId,
        name: info.steamName,
        steam: info.steamId,
        discord: info.discord || (type === 'discordId' ? q : null),
        license: info.license,
        online: info.online,
        banned: info.banned,
        lastSeenAt: new Date().toISOString(),
    };
}

// --- "!id <sorgu>" KOMUTU (yetkili sohbet/bot-komut kanalları) ---
// Bu botu kullanan birkaç arkadaşın kendi bot instance'ı da AYNI kanalları dinliyor -
// biri "!id 256" yazınca hepsi aynı anda görüyor, hepsi cevap verirse aynı sonuç 5 kez
// yazılmış olur. EMOJİSİZ çözüm - reaction yerine bir "claim mesajı" kullanılıyor, sadece
// "Mesaj Gönder" izni yeterli (bu zaten şart, cevap da mesajla gidiyor):
// 1. Komutu gören her instance kısa rastgele bir gecikme bekler, komuttan SONRAKİ
//    mesajlara bakıp (kendi mesajı REFERANS ALAN, yani ona REPLY olan bir bot mesajı) var
//    mı diye kontrol eder - varsa başkası zaten üstlenmiş demektir, çekilir.
// 2. Yoksa HEMEN kendi "🔍 Sorgu üstlenildi, aranıyor..." claim mesajını REPLY olarak
//    gönderir - bu mesajın kendisi, artık diğer instance'ların 1. adımda göreceği "işaret".
// 3. Sorgu uzun sürebildiği için (60sn'ye kadar) kısa bir "sakinleşme" süresi sonra TEKRAR
//    kontrol edilir - neredeyse aynı anda birden fazla instance da claim mesajı göndermiş
//    olabilir (check+gönderme arasındaki dar ağ gecikmesi penceresi yüzünden). Birden
//    fazlaysa DETERMİNİSTİK bir kazanan seçilir (en küçük Discord kullanıcı ID'si - herkes
//    AYNI hesaplamayı yapıp AYNI sonuca varır) - kaybedenler kendi claim mesajlarını SİLİP
//    (bu da özel izin gerektirmiyor, kendi mesajını silmek her zaman serbest) çekilir.
// 4. Kazanan sorguyu çözüp SONUCU claim mesajına EDİT ile yazar (yeni mesaj atmaz) - yani
//    kanalda hep TEK bir mesaj kalır: önce "aranıyor...", sonra sonuç.
const ID_COMMAND_CHANNEL_IDS = ['1475520758095544490', '1470230482649223197', '1470230478274564289', '1502372307887194132', '1470230475485479097'];
const ID_COMMAND_CLAIM_TEXT = '🔍 Sorgu üstlenildi, aranıyor...';

function formatIdCommandResult(query, result) {
    if (!result) return `❌ "${query}" için sonuç bulunamadı.`;
    const lines = [`🔎 **Kimlik Sorgu Sonucu** ("${query}")`];
    if (result.playerId) lines.push(`Oyun İçi ID: ${result.playerId}`);
    if (result.name) lines.push(`Steam İsmi: ${result.name}`);
    if (result.steam) lines.push(`Steam: ${result.steam}`);
    if (result.discord) lines.push(`Discord: <@${result.discord}>`);
    if (result.license) lines.push(`License: ${result.license}`);
    if (result.online !== null && result.online !== undefined) lines.push(`Oyunda mı: ${result.online ? 'Evet' : 'Hayır'}`);
    if (result.banned) lines.push(`🚫 FG Banlı: Evet`);
    return lines.join('\n');
}

// Komuttan SONRA gelen, ona REPLY olan bot mesajlarını (claim/cevap mesajları) döndürür.
async function findIdCommandClaimReplies(commandMessage) {
    const recent = await commandMessage.channel.messages.fetch({ limit: 20, after: commandMessage.id });
    return [...recent.values()].filter((m) => m.author.bot && m.reference?.messageId === commandMessage.id);
}

async function handleIdCommand(message, query) {
    // Rastgele mikro-gecikme (100-900ms) - tüm instance'lar komutu AYNI ANDA görüyor,
    // bu gecikme "hepsi aynı milisaniyede claim mesajı atar" çakışmasını azaltır ama TEK
    // BAŞINA yeterli değil, bu yüzden aşağıda bir de DETERMİNİSTİK TIE-BREAK adımı var.
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 900));

    let claimMessage;
    try {
        const existing = await findIdCommandClaimReplies(message);
        if (existing.length > 0) {
            console.log(`[!id] "${query}" için başka bir instance zaten üstlenmiş, atlanıyor.`);
            return;
        }
        claimMessage = await message.reply(ID_COMMAND_CLAIM_TEXT);
    } catch (error) {
        console.log(`[!id] Claim aşamasında hata: ${error.message}`);
        return;
    }

    // "Sakinleşme" süresi - neredeyse aynı anda birden fazla instance da claim mesajı
    // göndermiş olabilir. Kısa bir süre bekleyip TEKRAR kontrol ediyoruz - bu sürede diğer
    // olası claim'ler de Discord'a işlenmiş olur. Birden fazla claim varsa DETERMİNİSTİK
    // bir kazanan seçiyoruz (en küçük Discord kullanıcı ID'si) - kaybedenler kendi claim
    // mesajlarını silip çekiliyor.
    await new Promise((resolve) => setTimeout(resolve, 1500 + Math.random() * 1000));
    try {
        const claimants = await findIdCommandClaimReplies(message);
        if (claimants.length > 1) {
            const winnerId = claimants.reduce((min, m) => (BigInt(m.author.id) < BigInt(min) ? m.author.id : min), claimants[0].author.id);
            if (winnerId !== client.user.id) {
                console.log(`[!id] "${query}" için ${claimants.length} instance aynı anda üstlenmiş, tie-break kaybedildi (kazanan: ${winnerId}) - claim mesajım siliniyor.`);
                await claimMessage.delete().catch(() => {});
                return;
            }
            console.log(`[!id] "${query}" için ${claimants.length} instance aynı anda üstlenmiş, tie-break kazanıldı - devam ediliyor.`);
        }
    } catch (error) {
        console.log(`[!id] Tie-break kontrolü yapılamadı (${error.message}), yine de devam ediliyor.`);
    }

    console.log(`[!id] "${query}" sorgusu üstlenildi, aranıyor...`);
    try {
        const result = await resolvePlayerIdentity(query);
        await claimMessage.edit(formatIdCommandResult(query, result));
    } catch (error) {
        console.log(`[Hata] !id "${query}": ${error.message}`);
        try {
            await claimMessage.edit(`⚠️ "${query}" aranırken bir hata oluştu: ${error.message}`);
        } catch (e) { /* düzenleme de başarısız olduysa yapacak bir şey yok */ }
    }
}

// Bu kişinin daha önce kaç kez düştüğünü (son 50 rapor içinde) kayan pencereye
// ekleyip hesaplar. Her mesaj (canlı ya da açılışta yakalanan) için tam olarak
// bir kez çağrılmalı, aksi halde sayaç şişer.
function recordSuspiciousReport(message) {
    const embed = message.embeds?.[0];
    const identifier = extractSuspiciousIdentifier(embed) || message.author?.id || message.id;
    const displayName = findEmbedField(embed, /^name$/i) || message.author?.username || 'Bilinmeyen';
    const playerId = findEmbedField(embed, /player\s*id/i);
    // "discord://" özel protokolü - https://discord.com/... linki tarayıcıda açılıp
    // oradan "Discord'ta Aç" ile yönlendirme gerektiriyordu, bu ise Discord kurulu ise
    // doğrudan uygulamayı (masaüstü istemcisini) açıp gidiyor, tarayıcı hiç araya girmiyor.
    // BİLEREK mesaj ID'si eklenmiyor (sadece guild/kanal) - Discord belirli bir mesaja
    // "jump" ederken o mesajın etrafını ayrıca sorguluyor, bu da tıklamayı gözle görülür
    // yavaşlatıyordu (kullanıcı canlı testte fark etti). Sadece kanala gitmek, ticket
    // kartındaki "Discord'da Aç" butonuyla (getTicketChannels/channelUrl) AYNI - AYNI
    // KADAR HIZLI - format, kanal zaten Discord'da önceden yüklenmiş/önbellekte oluyor.
    const channelUrl = message.guild ? `discord://-/channels/${message.guild.id}/${message.channel.id}` : null;

    recentSuspiciousReports.push(identifier);
    if (recentSuspiciousReports.length > 50) recentSuspiciousReports.shift();

    const occurrences = recentSuspiciousReports.filter((id) => id === identifier).length;
    return { embed, displayName, playerId, occurrences, channelUrl };
}

function showSuspiciousNotification({ embed, displayName, playerId, occurrences, channelUrl }) {
    if (!suspiciousNotifyEnabled || !Notification.isSupported()) return;

    const baseTitle = stripDiscordMarkup(embed?.title) || 'Şüpheli Aktivite';
    const whoText = playerId ? `${playerId} ID'li ${displayName}` : displayName;
    const repeated = occurrences >= 2;
    const notification = new Notification({
        title: repeated ? `🚨 ${occurrences}. KEZ DÜŞTÜ — ${baseTitle}` : `⚠️ ${baseTitle}`,
        body: repeated
            ? `${whoText} son 50 raporda ${occurrences}. kez tespit edildi!`
            : `${whoText} için yeni bir hile bildirimi geldi.`,
    });
    notification.on('click', () => {
        if (channelUrl) {
            shell.openExternal(channelUrl);
        } else if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
    notification.show();
}

// Açılışta son 50 mesajı bir kez çekip "kaçıncı kez düştü" sayaç penceresini
// dolduruyoruz (tek seferlik istek, tekrarlı polling yok - optimizasyon). Bu 50
// mesajın HİÇBİRİ için bildirim atılmıyor - bildirim sadece bundan sonra canlı
// gelen (messageCreate) mesajlar için gönderiliyor.
async function catchUpSuspiciousChannel() {
    const channel = client.channels.cache.get(SUSPICIOUS_CHANNEL_ID);
    if (!channel) {
        console.log(`[Şüpheli Bildirim] Kanal bulunamadı (${SUSPICIOUS_CHANNEL_ID}), takip başlatılamadı.`);
        return;
    }
    try {
        const recent = await channel.messages.fetch({ limit: 50 });
        if (recent.size === 0) return;

        const sorted = [...recent.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        for (const m of sorted) {
            recordSuspiciousReport(m);
        }
        console.log(`[Şüpheli Bildirim] Son ${sorted.length} mesaj tarandı (sayaç dolduruldu, bildirim atılmadı), takip aktif.`);
    } catch (error) {
        console.log(`[Şüpheli Bildirim] Son 50 mesaj çekilemedi: ${error.message}`);
    }
}

// --- FIVEGUARD (fiveguard.net) LOG KANALI BİLDİRİMİ ---
// webhook-system'daki (FeloxAC) sistemden AYRI, ikinci bir hile tespit kaynağı.
// Bu botun embed'lerinde Player ID yok - identite yine License/Steam/Discord/Name
// önceliğiyle (extractSuspiciousIdentifier, yukarıda zaten generic tanımlı) çıkarılıyor,
// bildirim gövdesinde Player ID yerine Name + Violation gösteriliyor.
const FIVEGUARD_CHANNEL_ID = '1470798988658610491';
const FIVEGUARD_BOT_ID = '1472770633455898736';

// Aynı kişinin son 50 rapor içinde kaç kez düştüğünü hesaplamak için ayrı bir kayan
// pencere - webhook-system'ınkiyle (recentSuspiciousReports) KARIŞTIRILMIYOR, iki
// farklı anticheat/kaynak birbirinden bağımsız sayılıyor.
const recentFiveguardReports = [];

function recordFiveguardReport(message) {
    const embed = message.embeds?.[0];
    // Bot her raporda log embed'ine EK olarak (öncesinde ya da sonrasında) sadece
    // video eki içeren AYRI bir mesaj da atıyor - o mesajda embed/Name alanı
    // olmadığı için, olmadığında bunu gerçek bir rapor SAYMIYORUZ (sayaca da
    // eklemiyoruz, bildirim de atmıyoruz) - aksi halde "fiveguard isimli kişi..."
    // gibi anlamsız bildirimler gidiyordu (bot kullanıcı adına düşüyordu).
    const displayName = findEmbedField(embed, /^name$/i);
    if (!displayName) return null;

    const identifier = extractSuspiciousIdentifier(embed) || message.author?.id || message.id;
    const violation = findEmbedField(embed, /violation/i);
    // Mesaj ID'si BİLEREK eklenmiyor (bkz. showSuspiciousNotification'daki aynı not) -
    // sadece kanala giden link, "Discord'da Aç" ticket butonuyla AYNI hızda açılıyor.
    const channelUrl = message.guild ? `discord://-/channels/${message.guild.id}/${message.channel.id}` : null;

    recentFiveguardReports.push(identifier);
    if (recentFiveguardReports.length > 50) recentFiveguardReports.shift();

    const occurrences = recentFiveguardReports.filter((id) => id === identifier).length;
    return { displayName, violation, occurrences, channelUrl };
}

function showFiveguardNotification({ displayName, violation, occurrences, channelUrl }) {
    if (!fiveguardNotifyEnabled || !Notification.isSupported()) return;

    const violationText = violation ? `: ${violation}` : '';
    const repeated = occurrences >= 2;
    const notification = new Notification({
        title: repeated ? `🚨 ${occurrences}. KEZ DÜŞTÜ — Fiveguard` : '⚠️ Fiveguard',
        body: repeated
            ? `${displayName} isimli kişi son 50 raporda ${occurrences}. kez Fiveguard logına düştü${violationText}`
            : `${displayName} isimli kişi Fiveguard logına düştü${violationText}`,
    });
    notification.on('click', () => {
        if (channelUrl) {
            shell.openExternal(channelUrl);
        } else if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
    notification.show();
}

// Açılışta son 50 mesajı bir kez çekip sayaç penceresini dolduruyoruz - webhook-system'daki
// catchUpSuspiciousChannel ile birebir aynı desen, bu 50 mesaj için bildirim atılmıyor.
async function catchUpFiveguardChannel() {
    const channel = client.channels.cache.get(FIVEGUARD_CHANNEL_ID);
    if (!channel) {
        console.log(`[Fiveguard Bildirim] Kanal bulunamadı (${FIVEGUARD_CHANNEL_ID}), takip başlatılamadı.`);
        return;
    }
    try {
        const recent = await channel.messages.fetch({ limit: 50 });
        if (recent.size === 0) return;

        const sorted = [...recent.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        for (const m of sorted) {
            recordFiveguardReport(m);
        }
        console.log(`[Fiveguard Bildirim] Son ${sorted.length} mesaj tarandı (sayaç dolduruldu, bildirim atılmadı), takip aktif.`);
    } catch (error) {
        console.log(`[Fiveguard Bildirim] Son 50 mesaj çekilemedi: ${error.message}`);
    }
}

client.on('ready', () => {
    if (hasConnectedBefore) {
        console.log(`[Bağlantı] Yeniden bağlanıldı: ${client.user.tag}`);
    } else {
        console.log(`[Bağlantı] Giriş yapıldı: ${client.user.tag}`);
        console.log(`[Ayar] CATEGORY_ID=${CATEGORY_ID}, LOG_CHANNEL_ID=${LOG_CHANNEL_ID}`);
    }
    discordStatus = 'bağlı';
    broadcastSystemStatus();
    reconnectAttempts = 0; // başarılı giriş - deneme sayacı sıfırlanır
    hasConnectedBefore = true;
    catchUpSuspiciousChannel();
    catchUpFiveguardChannel();
    refreshMyTickets();
});

client.on('channelCreate', async (channel) => {
    if (channel.parentId === CATEGORY_ID) {
        console.log(`[Yeni Ticket] Kanal oluşturuldu: ${channel.name} (${channel.id})`);
        if (mainWindow) {
            mainWindow.webContents.send('ticket-geldi');
        }
        broadcastTicketList();
    }
});

client.on('channelDelete', (channel) => {
    if (channel.parentId === CATEGORY_ID) {
        console.log(`[Ticket] Kanal kapatıldı: ${channel.name} (${channel.id})`);
        heldTickets.delete(channel.id);
        channelScans.delete(channel.id);
        channelLastLogMessage.delete(channel.id);
        myTickets.delete(channel.id);
        cheatingFlagged.delete(channel.id);
        channelLastResult.delete(channel.id);
        channelLicense.delete(channel.id);
        channelGameId.delete(channel.id);
        banClickedOnce.delete(channel.id);
        broadcastTicketList();
    }
});

// Ticket açılışında "MD PVP SYSTEM" botunun attığı "Otomatik Oyuncu Bilgi" mesajından
// license + oyun içi ID çıkarır. HEM canlı mesaj dinleyicisinde (messageCreate, aşağıda)
// HEM DE findPlayerInfoFromHistory'nin (buildTicketDetail/performTicketBanConfirm için)
// GEÇMİŞ TARAMASINDA kullanılan TEK ortak fonksiyon - ikisi asla birbirinden sapmasın diye.
function parsePlayerInfoFromBotMessage(message) {
    const combinedText = [
        message.content || '',
        ...(message.embeds || []).flatMap((e) => [
            e.title || '',
            e.description || '',
            ...(e.fields || []).map((f) => `${f.name} ${f.value}`)
        ])
    ].join(' ');
    const licenseMatch = combinedText.match(/license:[a-f0-9]+/i);

    // "Oyun İçi ID" alanı: kullanıcı oyundaysa bir sayı, değilse bir tire/çizgi gösteriyor.
    // hasGameIdField ayrı tutuluyor çünkü "alan var ama sayı değil" (oyunda değil) ile
    // "alan hiç yok" (bu mesajda bilgi yok, sessizce atla) farklı anlamlara geliyor.
    const gameIdField = (message.embeds || []).flatMap((e) => e.fields || []).find((f) => /oyun/i.test(f.name));
    let gameId = null;
    if (gameIdField) {
        const cleanValue = String(gameIdField.value).replace(/[`*_~]/g, '').trim();
        if (/^\d+$/.test(cleanValue)) gameId = cleanValue;
    }

    return {
        license: licenseMatch ? licenseMatch[0] : null,
        hasGameIdField: !!gameIdField,
        gameId,
    };
}

// channelLicense/channelGameId sadece CANLI messageCreate ile dolduğu için, panel bir
// ticket'ın "Otomatik Oyuncu Bilgi" mesajı gönderildiği SIRADA açık/dinlemiyor idiyse
// (uygulama sonradan başlatıldı/yeniden başladı) o ticket için hiç yakalanmamış olur -
// canlı örnekte görüldü (koro19 ticket'ı: bot mesajında license/oyun içi ID görünüyordu
// ama panel boş gösteriyordu). Bu fonksiyon, kanalın EN ESKİ mesajlarını (performTicketClose
// ile aynı desen - ham JSON, panelin o an dinliyor olup olmamasından bağımsız) tarayıp bilgiyi
// TAZE buluyor.
async function findPlayerInfoFromHistory(channel) {
    try {
        const rawMessages = await client.api.channels(channel.id).messages.get({ query: { after: '0', limit: 20 } });
        for (const message of rawMessages) {
            if (!message.author?.bot) continue;
            const info = parsePlayerInfoFromBotMessage(message);
            if (info.license || info.hasGameIdField) return info;
        }
    } catch (error) {
        console.log(`[Oyuncu Bilgi] ${channel.name}: geçmiş taranamadı: ${error.message}`);
    }
    return null;
}

client.on('messageCreate', async (message) => {

    // --- BEKLETİLEN TICKET BİLDİRİMİ ---
    // Müşteri beklemedeyken mesaj attığında Windows bildirimi (ses DEĞİL - eski
    // ses bildirimi kaldırıldı, artık native Notification tek başına yeterli)
    // gönderip ticket'ı otomatik beklemeden çıkarıyoruz. heldTickets'tan hemen
    // silindiği için müşterinin ardından yazacağı diğer mesajlar bu bloğu bir
    // daha tetiklemiyor (tekrar tekrar bildirim gitmesi buradan engellenmiş oluyor).
    if (heldTickets.has(message.channel.id) && !message.author.bot && message.author.id !== client.user.id) {
        console.log(`[Beklet] ${message.channel.name} kanalında yeni mesaj var, beklemeden çıkarılıyor.`);
        heldTickets.delete(message.channel.id);
        if (mainWindow) {
            mainWindow.webContents.send('ticket-hold-changed', { channelId: message.channel.id, held: false });
        }
        if (Notification.isSupported()) {
            const notification = new Notification({
                title: '⏸️ Beklemedeki Ticket Yanıtladı',
                body: `${message.channel.name} kanalında müşteri mesaj yazdı, ticket beklemeden çıkarıldı.`,
            });
            notification.on('click', () => {
                if (mainWindow) {
                    if (mainWindow.isMinimized()) mainWindow.restore();
                    mainWindow.focus();
                }
            });
            notification.show();
        }
        broadcastTicketList();
    }

    // --- ŞÜPHELİ AKTİVİTE (webhook-system) BİLDİRİMİ ---
    if (message.channel.id === SUSPICIOUS_CHANNEL_ID && message.author.id !== client.user.id) {
        const report = recordSuspiciousReport(message);
        showSuspiciousNotification(report);
    }

    // --- FIVEGUARD LOG KANALI BİLDİRİMİ ---
    if (message.channel.id === FIVEGUARD_CHANNEL_ID && message.author.id === FIVEGUARD_BOT_ID) {
        const report = recordFiveguardReport(message);
        if (report) showFiveguardNotification(report);
    }

    // --- "!id <sorgu>" KOMUTU ---
    if (ID_COMMAND_CHANNEL_IDS.includes(message.channel.id) && !message.author.bot) {
        const idMatch = message.content.trim().match(/^!id\s+(\S+)/i);
        if (idMatch) {
            handleIdCommand(message, idMatch[1]); // await YOK - dinleyiciyi bloklamasın, hata da kendi içinde yakalanıyor
        }
    }

    // --- LİSANS YAKALAMA (ticket açılışında botun attığı oyuncu bilgi mesajından) ---
    if (message.channel.parentId === CATEGORY_ID && message.author.bot) {
        const info = parsePlayerInfoFromBotMessage(message);
        if (info.license) {
            channelLicense.set(message.channel.id, info.license);
            console.log(`[Lisans] ${message.channel.name} için lisans yakalandı: ${info.license}`);
        }

        // "Oyun İçi ID" alanı: kullanıcı oyundaysa bir sayı, değilse bir tire/çizgi gösteriyor.
        if (info.hasGameIdField) {
            if (info.gameId) {
                channelGameId.set(message.channel.id, info.gameId);
                console.log(`[Oyun İçi ID] ${message.channel.name} için yakalandı: ${info.gameId} (kullanıcı oyunda)`);
            } else {
                channelGameId.delete(message.channel.id);
                console.log(`[Oyun İçi ID] ${message.channel.name}: kullanıcı şu an oyunda değil.`);
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
    if (nexoraStatus !== 'sağlıklı') {
        nexoraStatus = 'sağlıklı';
        broadcastSystemStatus();
    }
}

function reportNexoraFailure() {
    consecutiveNetworkFailures++;
    if (consecutiveNetworkFailures >= HEALTH_FAILURE_THRESHOLD) {
        nexoraStatus = 'sorunlu';
        broadcastSystemStatus();
        if (!healthAlertShown) {
            healthAlertShown = true;
            dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: '⚠️ Nexora API Sorunu',
                message: `Nexora API'ye art arda ${consecutiveNetworkFailures} kez ulaşılamadı.\nİnternet bağlantını veya nexorascanner.ac durumunu kontrol et.`,
                buttons: ['Tamam']
            });
        }
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
            nexoraStatus = 'sağlıklı';

            if (['free', 'starter'].includes(String(data.plan).toLowerCase())) {
                console.log('[Nexora] UYARI: Hesap planı Free/Starter görünüyor - tarama API çağrıları 403 ile reddedilecektir. Professional veya üstüne geçmen gerekiyor.');
            }
            if (data.subscription && data.subscription.active === false) {
                console.log('[Nexora] UYARI: Abonelik aktif görünmüyor.');
            }
        } else if (res.status === 401 || res.status === 403) {
            console.log(`[Nexora] UYARI: API key geçersiz veya plan yetersiz (HTTP ${res.status}). config.env içindeki NEXORA_API_KEY'i ve dashboard'daki planını kontrol et.`);
            nexoraStatus = 'sorunlu';
        } else {
            console.log(`[Nexora] API key doğrulanamadı: HTTP ${res.status}`);
            nexoraStatus = 'sorunlu';
        }
    } catch (error) {
        console.log(`[Nexora] API key doğrulanırken hata: ${error.message}`);
        nexoraStatus = 'sorunlu';
    }
    broadcastSystemStatus();
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