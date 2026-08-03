const path = require('path');
const fs = require('fs');

// Bazı ağlarda (özellikle DPI atlatma araçlarıyla) IPv6 bağlantısı yarım çalışıp
// isteklerin uzun süre asılı kalmasına neden olabiliyor. IPv4'ü önceliklendiriyoruz.
require('dns').setDefaultResultOrder('ipv4first');

const CONFIG_ENV_PATH = path.join(__dirname, 'config.env');
require('dotenv').config({ path: CONFIG_ENV_PATH });

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
const { exec } = require('child_process');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

// --- OTOMATİK GÜNCELLEME ---
// Her yeni sürüm çıkardığında bu numarayı artır ve nexora-panel-updates repo'sundaki
// version.json + dosyaları güncelle. Program açılışta bunu kontrol eder, farklıysa
// dosyaları indirip üzerine yazar ve kendini yeniden başlatır.
const CURRENT_VERSION = '1.8.0';
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
// Koddan sabit veriliyor (config.env üzerinden değil) - böylece bir güncelleme
// yayınlandığında tüm kurulumlarda aynı anda değişir, her kullanıcı elle ayarlamaz.
const IGNORED_ROLE_ID = '1470230341569609898';
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

let autoReplyEnabled = process.env.AUTO_REPLY_ENABLED === 'true';
let welcomeMessage = process.env.WELCOME_MESSAGE || '';

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
const activeTickets = new Set();
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
                banStage: banClickedOnce.has(ch.id) ? 'second' : 'first'
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

ipcMain.on('lookup-player', async (event, query) => {
    const result = await resolvePlayerIdentity(query);
    if (mainWindow) mainWindow.webContents.send('lookup-player-result', { query, result });
});

ipcMain.on('ac-call', async (event, target) => {
    const result = await performAcCall(target || {});
    if (mainWindow) mainWindow.webContents.send('ac-call-result', result);
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

// Ticket'ı claim eder: otomatik karşılama sistemindekiyle aynı mesajı/sticker'ı
// manuel olarak gönderir. Mesaj gönderilince "ESKİ SİSTEMLER" bloğu zaten kanalı
// myTickets'a ekleyip claimed hale getiriyor.
async function performTicketClaim(channelId) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;
    try {
        if (welcomeMessage) {
            await channel.send(welcomeMessage);
        } else {
            await channel.send({ stickers: ['749054660769218631'] });
        }
        console.log(`[Panel] ${channel.name}: claim edildi, karşılama mesajı gönderildi.`);
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

    console.log(`[Panel] ${channel.name}: ban sebebi kaydedildi (sebep: ${safeReason}), ticket kanalına mesaj atılmadı.`);

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

    const license = channelLicense.get(channelId);
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

    const gameId = channelGameId.get(channelId);

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

// Kimlik Sorgula sonucundaki kişiyi AC'ye çağırır: hem ac-komut kanalına
// "/dm-player id:<oyun içi ID> message:<AC mesajı>" gönderir hem de duyuru
// kanalında kişiyi (Discord ID ile) etiketleyip AC ticket mesajını atar.
// Discord ID ve license'ın İKİSİ de yoksa (kimlik tam doğrulanmamış demektir)
// hiçbir şey göndermeden "yetersiz bilgi" hatası döner.
async function performAcCall({ discord, license, playerId, name }) {
    if (!discord || !license) {
        console.log(`[AC Çağır] Yetersiz bilgi (discord: ${discord || 'yok'}, license: ${license || 'yok'}), hiçbir şey gönderilmedi.`);
        return { success: false, reason: 'insufficient', message: 'Discord ID veya License eksik - yetersiz bilgi, AC çağrılmadı.' };
    }

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
        await announceChannel.send(`<@${discord}> ${acTicketMessage}`);
        console.log(`[AC Çağır] Duyuru kanalına etiketlendi (${name || discord}).`);
        results.push('duyuru kanalına etiketlendi');

        return { success: true, message: results.join(', ') + '.' };
    } catch (error) {
        console.log(`[Hata] AC Çağır: ${error.message}`);
        return { success: false, reason: 'error', message: `Gönderilirken hata oluştu: ${error.message}` };
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
        console.log(`[Mobil] Aynı Wi-Fi'daki telefondan erişim: ${getMaskedMobileUrl()}`);
        if (mainWindow) mainWindow.webContents.send('mobile-url', mobileUrl);
        mobileServerReady = true;
        broadcastSystemStatus();
    });

    console.log('[Bağlantı] Discord\'a giriş deneniyor...');
    const LOGIN_TIMEOUT_MS = 25000;
    const loginTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Giriş ${LOGIN_TIMEOUT_MS / 1000} saniye içinde tamamlanmadı. Muhtemelen güvenlik duvarı/antivirüs Discord bağlantısını (WebSocket) engelliyor - dosya dışlaması bunu kapsamaz, ayrıca Windows Güvenlik Duvarı izni de gerekiyor.`)), LOGIN_TIMEOUT_MS);
    });
    Promise.race([client.login(process.env.USER_TOKEN), loginTimeout]).catch((error) => {
        console.log(`[Hata] Discord girişi başarısız: ${error.message}`);
        discordStatus = 'hata';
        broadcastSystemStatus();
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

// --- KİMLİK SORGULA: kill-log + connections-webhook zinciri ---
// kill-log kanalları oyuncunun ID+isim+license'ını verir, connections-webhook o
// license ile steam/discord/ip'sini verir. Yerel kayıtta yoksa bu iki kaynağı
// istek üzerine (sadece sorgulandığında) tarıyoruz - arka planda sürekli çekmiyoruz.
const KILL_LOG_CHANNEL_IDS = ['1470948766340223188', '1492906523603636484', '1492906545342578748'];
const CONNECTIONS_WEBHOOK_CHANNEL_ID = '1513234125337919610';
// Mesaj sayısı yerine ZAMAN bütçesiyle sınırlıyoruz - kanallar çok yoğun olabildiği
// için sabit bir mesaj sayısı bazen yetersiz kalıyordu. Zincirde en fazla 2 tarama
// art arda gelir (kill-log'lar paralel taranıyor -> tek tarama sayılır, sonra
// connections-webhook) - ikisi de bu bütçeyi kullansa toplam ~14sn'yi geçmez.
const LOOKUP_SCAN_TIME_BUDGET_MS = 7000;
// Player ID -> kill-log'da license bulunduktan sonra connections-webhook'ta o
// license'ı doğrulama adımı özel: bu bilginin kanalda mutlaka var olduğu biliniyor,
// bu yüzden normal 7sn bütçesi yerine (kullanıcı isteğiyle) çok daha derin taranıyor.
const LOOKUP_LICENSE_VERIFY_TIME_BUDGET_MS = 45000;
// Discord ID / isim / license ile arandığında SADECE connections-webhook taranır
// (kill-log'a hiç bakılmaz) - kullanıcı isteğiyle en az 30sn.
const LOOKUP_CONNECTIONS_TIME_BUDGET_MS = 30000;
// Discord ID/isim/license akışında kişi online çıkarsa Player ID'sini bulmak için
// kill-log'a bakılıyor - standart 7sn'de bulunamadığı görüldüğü için (kişi henüz
// hiç kill-log'a girmemiş de olabilir) buradaki tarama da uzatıldı.
const LOOKUP_KILLLOG_VERIFY_TIME_BUDGET_MS = 20000;
const LOOKUP_SCAN_PAGE_DELAY_MS = 150; // sayfalar arası rate-limit'e nazik bekleme

// Bir kanalın geçmişini 100'erli sayfalar hâlinde (en yeniden eskiye) süre
// dolana kadar tarar, matchFn ilk gerçek (falsy olmayan) sonucu döndürdüğünde durur.
async function scanChannelHistory(channelId, matchFn, timeBudgetMs = LOOKUP_SCAN_TIME_BUDGET_MS) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
        console.log(`[Kimlik Sorgula] Kanal bulunamadı: ${channelId}`);
        return null;
    }

    const startedAt = Date.now();
    const deadline = startedAt + timeBudgetMs;
    let before;
    let pages = 0;
    let scanned = 0;
    while (Date.now() < deadline) {
        let batch;
        try {
            batch = await channel.messages.fetch({ limit: 100, before });
        } catch (error) {
            console.log(`[Kimlik Sorgula] "${channel.name}" taranırken hata (${pages} sayfa, ${scanned} mesaj sonra): ${error.message}`);
            return null;
        }
        pages++;
        if (batch.size === 0) break;
        scanned += batch.size;

        for (const message of batch.values()) {
            const result = matchFn(message);
            if (result) {
                console.log(`[Kimlik Sorgula] "${channel.name}": eşleşme bulundu (${pages} sayfa, ${scanned} mesaj, ${Date.now() - startedAt}ms).`);
                return result;
            }
        }

        if (batch.size < 100) break; // kanalın başına gelindi
        before = batch.last().id;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, LOOKUP_SCAN_PAGE_DELAY_MS));
    }
    console.log(`[Kimlik Sorgula] "${channel.name}": eşleşme bulunamadı (${pages} sayfa, ${scanned} mesaj, ${Date.now() - startedAt}ms).`);
    return null;
}

// Kill-log embed'i "Öldüren"/"Ölen Oyuncu" (isim + "(ID: N)") ve license'lardan
// oluşuyor. Canlı testte license'ın BAZEN isim field'ının KENDİ değeri içinde
// (alt satırda), bazen AYRI bir field olarak geldiği görüldü - ikisini de
// deniyoruz: önce aynı field içinde ara, yoksa daha sonra gelen "düz" license
// field'larını sırayla (killer önce, victim sonra) eşle.
function parseKillLogEntries(embed) {
    if (!embed?.fields?.length) return [];
    const idHolders = [];
    const looseLicenses = [];
    for (const field of embed.fields) {
        const value = String(field.value || '');
        const idMatch = value.match(/^(.*?)\s*\(ID:\s*(\d+)\)/i);
        const licenseInSameValue = value.match(/license:[a-f0-9]+/i);
        if (idMatch) {
            idHolders.push({
                name: stripDiscordMarkup(idMatch[1]),
                playerId: idMatch[2],
                license: licenseInSameValue ? licenseInSameValue[0] : null,
            });
            continue;
        }
        if (licenseInSameValue) looseLicenses.push(licenseInSameValue[0]);
    }
    let looseIndex = 0;
    return idHolders.map((holder) => (holder.license ? holder : { ...holder, license: looseLicenses[looseIndex++] || null }));
}

// Üç kill-log kanalı SIRAYLA değil PARALEL taranıyor. Ayrıca ilk bulunan sonuç
// gelir gelmez dönüyoruz (diğer ikisinin taramasını arka planda bırakıp
// beklemiyoruz) - önceden Promise.all üçünün de bitmesini beklediği için biri
// hemen bulsa bile toplam süre en yavaş kanal kadar (7sn) uzuyordu.
function firstNonNull(promises) {
    return new Promise((resolve) => {
        let remaining = promises.length;
        if (remaining === 0) return resolve(null);
        for (const p of promises) {
            p.then((value) => {
                remaining--;
                if (value) resolve(value);
                else if (remaining === 0) resolve(null);
            }).catch(() => {
                remaining--;
                if (remaining === 0) resolve(null);
            });
        }
    });
}

async function findInKillLogs({ playerId, license, timeBudgetMs } = {}) {
    const matchFn = (message) => {
        const embed = message.embeds?.[0];
        const entries = parseKillLogEntries(embed);
        const match = entries.find(
            (e) => (playerId && e.playerId === playerId) || (license && e.license === license)
        );
        if (match && !match.license) {
            const rawFields = (embed?.fields || []).map((f) => `[${f.name}] ${f.value}`.slice(0, 90)).join(' || ');
            console.log(`[Kimlik Sorgula] UYARI: ${match.name} (ID: ${match.playerId}) için license bulunamadı. Ham alanlar: ${rawFields}`);
        }
        return match || null;
    };
    const hit = await firstNonNull(
        KILL_LOG_CHANNEL_IDS.map((channelId) => scanChannelHistory(channelId, matchFn, timeBudgetMs))
    );
    return hit ? { ...hit, title: 'Kill Log' } : null;
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

    if (!serverIdMatch && !licenseMatch) return null;

    return {
        name: nameMatch ? stripDiscordMarkup(nameMatch[1]) : null,
        playerId: serverIdMatch ? serverIdMatch[1] : null,
        steam: steamMatch ? `steam:${steamMatch[1]}` : null,
        license: licenseMatch ? `license:${licenseMatch[1]}` : null,
        discord: discordMatch ? discordMatch[1] : null,
        ip: ipMatch ? ipMatch[1] : null,
        eventTitle: title || null,
        // "connection" geçiyor ama "disconnection"/"reject" geçmiyorsa online -
        // tam eşleşme yerine anahtar kelime araması (başlıkta ekstra emoji/boşluk
        // farkı olsa da bozulmasın diye).
        online: /connection/i.test(title) && !/disconnection/i.test(title) && !/reject/i.test(title),
    };
}

async function findInConnectionsWebhook({ playerId, license, discordId, name, timeBudgetMs } = {}) {
    return scanChannelHistory(
        CONNECTIONS_WEBHOOK_CHANNEL_ID,
        (message) => {
            const entry = parseConnectionsWebhookEntry(message.embeds?.[0]);
            if (!entry) return null;
            if (license && entry.license === license) return entry;
            if (playerId && entry.playerId === playerId) return entry;
            if (discordId && entry.discord === discordId) return entry;
            if (name && entry.name && entry.name.toLowerCase() === name.toLowerCase()) return entry;
            return null;
        },
        timeBudgetMs
    );
}

// Sorgu metninden tür tahmini: "license:" ile başlıyorsa license, sadece
// rakamsa uzunluğuna göre Discord ID (snowflake, 15+ hane) ya da Player ID
// (kısa - sunucuda birkaç yüz oyuncu var), aksi halde isim.
function detectLookupQueryType(q) {
    if (/^license:/i.test(q)) return 'license';
    if (/^\d+$/.test(q)) return q.length >= 15 ? 'discordId' : 'playerId';
    return 'name';
}

// Tam zincir - iki farklı yön var:
//
// 1) PLAYER ID ile sorulursa: kill-log'larda o ID'yi arayıp license buluruz,
//    sonra o license'ı connections-webhook'ta doğrularız. FiveM sunucusu her
//    restart'ta Player ID sayacını sıfırladığı için ("42" farklı zamanlarda
//    farklı kişilere ait olabilir) BU SORGU HİÇ CACHE'TEN KISA DEVRE YAPILMAZ -
//    her seferinde taze kill-log taraması yapılır ve player_index.json'a Player
//    ID ANAHTARIYLA YAZILMAZ (sadece license/discord ile - onlar restart'tan
//    etkilenmez). Kişinin connections-webhook'taki EN SON olayı "New connection"
//    değilse (şu an oyunda değilse) sonuç "stale" (bu ID artık başka birine ait
//    olabilir) uyarısıyla dönüyor.
//
// 2) DISCORD ID / İSİM / LICENSE ile sorulursa: önce yerel cache'e bakılır
//    (bunlar kalıcı kimlikler, restart'tan etkilenmez). Yoksa connections-
//    webhook'ta o kişinin EN SON olayı bulunur - "New connection" ise kişi hâlâ
//    oyunda demektir, kill-log'da license'ıyla arayıp güncel Player ID'sini de
//    buluruz. "New disconnection"/"Rejected connection" ise kişi oyunda değildir
//    (Player ID yok), kill-log'a hiç bakılmaz.
async function resolvePlayerIdentity(query) {
    const q = String(query || '').trim();
    if (!q) return null;

    const type = detectLookupQueryType(q);

    if (type === 'playerId') {
        console.log(`[Kimlik Sorgula] Player ID ${q} için kill-log taranıyor...`);
        const killHit = await findInKillLogs({ playerId: q });
        if (!killHit) {
            console.log(`[Kimlik Sorgula] Player ID ${q} kill-log'larda bulunamadı.`);
            return null;
        }
        console.log(`[Kimlik Sorgula] Player ID ${q} -> ${killHit.name} (${killHit.license}). Şimdi connections-webhook'ta bulunana kadar (max ${LOOKUP_LICENSE_VERIFY_TIME_BUDGET_MS / 1000}sn) aranıyor...`);

        const connHit = await findInConnectionsWebhook({ license: killHit.license, timeBudgetMs: LOOKUP_LICENSE_VERIFY_TIME_BUDGET_MS });
        console.log(`[Kimlik Sorgula] connections-webhook sonucu: ${connHit ? `bulundu (online: ${connHit.online})` : 'bulunamadı'}.`);
        const merged = {
            playerId: killHit.playerId,
            name: connHit?.name || killHit.name || null,
            steam: connHit?.steam || null,
            discord: connHit?.discord || null,
            license: killHit.license,
            ip: connHit?.ip || null,
            logId: null,
            title: 'Kill Log',
            lastSeenAt: new Date().toISOString(),
            reportCount: 1,
            stale: !connHit?.online,
            staleNote: !connHit
                ? "connections-webhook'ta doğrulanamadı, bilgiler eski bir oturuma ait olabilir."
                : !connHit.online
                    ? `Bu kişi şu an oyunda görünmüyor (son olay: ${connHit.eventTitle}) - sunucu yeniden başlamış olabilir, bu ID artık başka birine ait olabilir.`
                    : null,
        };

        return merged;
    }

    // NOT: burada bilerek yerel cache'e bakılmıyor. Kişinin oyun içi ID'si (ve
    // online/offline durumu) her an değişebildiği için her sorguda gerçekten
    // taze bir tarama yapılıyor - "adam orada var" diye eski sonucu döndürüp
    // geçmemesi için (kullanıcı isteğiyle, player_index.json artık sadece
    // arşiv/geçmiş kayıt olarak yazılıyor, okunmuyor).

    // Discord ID / isim / license sorgusunda ana kaynak connections-webhook -
    // en az 30sn taranıyor. Kişi online çıkarsa (connections-webhook'ta Player ID
    // olmadığı için) bulunan license ile kill-log'da Player ID'si de aranıyor.
    console.log(`[Kimlik Sorgula] "${q}" (${type}) için connections-webhook taranıyor (min ${LOOKUP_CONNECTIONS_TIME_BUDGET_MS / 1000}sn)...`);
    const connQuery = type === 'discordId' ? { discordId: q } : type === 'license' ? { license: q } : { name: q };
    const connHit = await findInConnectionsWebhook({ ...connQuery, timeBudgetMs: LOOKUP_CONNECTIONS_TIME_BUDGET_MS });
    if (!connHit) {
        console.log(`[Kimlik Sorgula] "${q}" connections-webhook'ta bulunamadı.`);
        return null;
    }
    console.log(`[Kimlik Sorgula] "${q}" -> ${connHit.name} (online: ${connHit.online}, son olay: ${connHit.eventTitle}).`);

    let killHit = null;
    if (connHit.online && connHit.license) {
        console.log(`[Kimlik Sorgula] Kişi online, kill-log'da Player ID aranıyor (max ${LOOKUP_KILLLOG_VERIFY_TIME_BUDGET_MS / 1000}sn)...`);
        killHit = await findInKillLogs({ license: connHit.license, timeBudgetMs: LOOKUP_KILLLOG_VERIFY_TIME_BUDGET_MS });
        console.log(`[Kimlik Sorgula] kill-log sonucu: ${killHit ? `Player ID ${killHit.playerId}` : 'bulunamadı'}.`);
    }

    const merged = {
        playerId: connHit.playerId || killHit?.playerId || null,
        name: connHit.name || killHit?.name || null,
        steam: connHit.steam || null,
        discord: connHit.discord || null,
        license: connHit.license || killHit?.license || null,
        ip: connHit.ip || null,
        logId: null,
        title: connHit.eventTitle,
        lastSeenAt: new Date().toISOString(),
        reportCount: 1,
        stale: !connHit.online,
        staleNote: !connHit.online
            ? `Bu kişi şu an oyunda değil (son olay: ${connHit.eventTitle}) - Player ID yok.`
            : connHit.online && !killHit
                ? 'Kişi online ama kill-log\'da bulunamadı - henüz kimseyi öldürmemiş/ölmemiş olabilir, bu yüzden Player ID gösterilemiyor.'
                : null,
    };

    return merged;
}

// Bu kişinin daha önce kaç kez düştüğünü (son 50 rapor içinde) kayan pencereye
// ekleyip hesaplar. Her mesaj (canlı ya da açılışta yakalanan) için tam olarak
// bir kez çağrılmalı, aksi halde sayaç şişer.
function recordSuspiciousReport(message) {
    const embed = message.embeds?.[0];
    const identifier = extractSuspiciousIdentifier(embed) || message.author?.id || message.id;
    const displayName = findEmbedField(embed, /^name$/i) || message.author?.username || 'Bilinmeyen';

    recentSuspiciousReports.push(identifier);
    if (recentSuspiciousReports.length > 50) recentSuspiciousReports.shift();

    const occurrences = recentSuspiciousReports.filter((id) => id === identifier).length;
    return { embed, displayName, occurrences };
}

function showSuspiciousNotification({ embed, displayName, occurrences }) {
    if (!suspiciousNotifyEnabled || !Notification.isSupported()) return;

    const baseTitle = stripDiscordMarkup(embed?.title) || 'Şüpheli Aktivite';
    const repeated = occurrences >= 2;
    const notification = new Notification({
        title: repeated ? `🚨 ${occurrences}. KEZ DÜŞTÜ — ${baseTitle}` : `⚠️ ${baseTitle}`,
        body: repeated
            ? `${displayName} son 50 raporda ${occurrences}. kez tespit edildi!`
            : `${displayName} için yeni bir hile bildirimi geldi.`,
    });
    notification.on('click', () => {
        if (mainWindow) {
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

client.on('ready', () => {
    console.log(`[Bağlantı] Giriş yapıldı: ${client.user.tag}`);
    console.log(`[Ayar] CATEGORY_ID=${CATEGORY_ID}, LOG_CHANNEL_ID=${LOG_CHANNEL_ID}`);
    discordStatus = 'bağlı';
    broadcastSystemStatus();
    catchUpSuspiciousChannel();
    refreshMyTickets();
});

client.on('channelCreate', async (channel) => {
    if (channel.parentId === CATEGORY_ID) {
        console.log(`[Yeni Ticket] Kanal oluşturuldu: ${channel.name} (${channel.id})`);
        if (mainWindow) {
            mainWindow.webContents.send('ticket-geldi');
        }

        // Discord bu event'i sadece gerçekten yeni açılan kanallarda değil, bir kanal
        // izin/rol değişikliği (örn. claim edilmesi) yüzünden bize sonradan görünür
        // olduğunda da gönderebiliyor. İçinde zaten insan mesajı varsa bu eski bir
        // ticket demektir - otomatik karşılama listesine ekleyip eski konuşmaya
        // tekrar "hoş geldin" mesajı atmayalım.
        try {
            const recentMessages = await channel.messages.fetch({ limit: 10 });
            const hasHumanMessage = recentMessages.some((m) => !m.author.bot);
            if (hasHumanMessage) {
                console.log(`[Karşılama] "${channel.name}" zaten insan mesajı içeriyor, otomatik karşılama uygulanmayacak.`);
                broadcastTicketList();
                return;
            }
        } catch (error) {
            console.log(`[Karşılama] "${channel.name}" geçmişi kontrol edilemedi: ${error.message}`);
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
        channelLicense.delete(channel.id);
        channelGameId.delete(channel.id);
        banClickedOnce.delete(channel.id);
        broadcastTicketList();
    }
});

client.on('messageCreate', async (message) => {

    // --- BEKLETİLEN TICKET BİLDİRİMİ ---
    // Müşteri beklemedeyken mesaj attığında sesi TEK SEFER çalıp ticket'ı otomatik
    // beklemeden çıkarıyoruz. heldTickets'tan hemen silindiği için müşterinin
    // ardından yazacağı diğer mesajlar bu bloğu bir daha tetiklemiyor (tekrar tekrar
    // ses çalması buradan engellenmiş oluyor).
    if (heldTickets.has(message.channel.id) && !message.author.bot && message.author.id !== client.user.id) {
        console.log(`[Beklet] ${message.channel.name} kanalında yeni mesaj var, beklemeden çıkarılıyor.`);
        heldTickets.delete(message.channel.id);
        if (mainWindow) {
            mainWindow.webContents.send('ticket-geldi');
            mainWindow.webContents.send('ticket-hold-changed', { channelId: message.channel.id, held: false });
        }
        broadcastTicketList();
    }

    // --- ŞÜPHELİ AKTİVİTE (webhook-system) BİLDİRİMİ ---
    if (message.channel.id === SUSPICIOUS_CHANNEL_ID && message.author.id !== client.user.id) {
        const report = recordSuspiciousReport(message);
        showSuspiciousNotification(report);
    }

    // --- LİSANS YAKALAMA (ticket açılışında botun attığı oyuncu bilgi mesajından) ---
    if (message.channel.parentId === CATEGORY_ID && message.author.bot) {
        const combinedText = [
            message.content || '',
            ...message.embeds.flatMap((e) => [
                e.title || '',
                e.description || '',
                ...(e.fields || []).map((f) => `${f.name} ${f.value}`)
            ])
        ].join(' ');
        const licenseMatch = combinedText.match(/license:[a-f0-9]+/i);
        if (licenseMatch) {
            channelLicense.set(message.channel.id, licenseMatch[0]);
            console.log(`[Lisans] ${message.channel.name} için lisans yakalandı: ${licenseMatch[0]}`);
        }

        // "Oyun İçi ID" alanı: kullanıcı oyundaysa bir sayı, değilse bir tire/çizgi gösteriyor.
        const gameIdField = message.embeds.flatMap((e) => e.fields || []).find((f) => /oyun/i.test(f.name));
        if (gameIdField) {
            const cleanValue = gameIdField.value.replace(/[`*_~]/g, '').trim();
            if (/^\d+$/.test(cleanValue)) {
                channelGameId.set(message.channel.id, cleanValue);
                console.log(`[Oyun İçi ID] ${message.channel.name} için yakalandı: ${cleanValue} (kullanıcı oyunda)`);
            } else {
                channelGameId.delete(message.channel.id);
                console.log(`[Oyun İçi ID] ${message.channel.name}: kullanıcı şu an oyunda değil.`);
            }
        }
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