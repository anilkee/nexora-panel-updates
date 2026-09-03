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

const { Client, MessageSelectMenu, MessageAttachment } = require('discord.js-selfbot-v13');
// NOT: "/player-info" sorgulama mantığı (ve onun için gereken derin discord.js-selfbot-v13
// require'ları) artık ORTAK MODÜLDE: player-info.js. VDS'deki id-responder.js de AYNI dosyayı
// kullanıyor - eskiden iki ayrı elle-kopyalanmış sürüm vardı ve sessizce sapıp canlıda soruna
// yol açmıştı. Modül burada TOP-LEVEL require EDİLMİYOR (bkz. ensureAppFiles / getPlayerInfo).
const { exec } = require('child_process');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws'); // discord.js-selfbot-v13'ün zaten bağımlılığı - ayrı kurulum gerekmiyor

// --- OTOMATİK GÜNCELLEME ---
// Her yeni sürüm çıkardığında bu numarayı artır ve nexora-panel-updates repo'sundaki
// version.json + dosyaları güncelle. Program açılışta bunu kontrol eder, farklıysa
// dosyaları indirip üzerine yazar ve kendini yeniden başlatır. AYRICA (kullanıcı isteğiyle -
// artık herkes VDS'e bağlı, uygulamalar günlerce kapatılmadan açık kalabiliyor) belirli
// aralıklarla da tekrar kontrol ediyor, sadece açılışta değil - bkz. app.on('ready') içindeki
// setInterval.
const CURRENT_VERSION = '1.25.0';
const UPDATE_REPO_OWNER = 'anilkee';
const UPDATE_REPO_NAME = 'nexora-panel-updates';
// GÜVENLİK - BURAYA TOKEN GÖMME: bu dosya paketlenen uygulamanın içinde düz metin olarak
// dağıtılıyor (resources/app/main.js, asar yok), yani gömülen her token uygulamayı alan
// herkesin eline geçiyor. Depo public olduğu sürece istemcinin token'a ihtiyacı yok -
// kimliksiz istek çalışır. Depo tekrar private yapılırsa NEXORA_UPDATE_TOKEN ortam
// değişkeni tanımlanır; tanımlıysa istek onunla imzalanır, değilse kimliksiz gider.
const UPDATE_REPO_TOKEN = process.env.NEXORA_UPDATE_TOKEN || '';
// DİKKAT - YENİ DOSYA EKLERKEN İKİ AŞAMALI YAYIN ŞART: Bu liste güncelleyicinin İNDİRECEĞİ
// dosyaları belirliyor ve her istemci KENDİ SÜRÜMÜNDEKİ listeyi kullanıyor. Yani listeye yeni
// bir dosya eklenip AYNI sürümde main.js o dosyayı require ederse, ESKİ sürümdeki bir istemci
// güncellenirken yeni main.js'i indirir ama yeni dosyayı İNDİRMEZ ve açılışta MODULE_NOT_FOUND
// ile çöker (herkesin uygulaması bozulur). Doğru sıra:
//   1. AŞAMA: dosyayı bu listeye ekle + repoya yükle, ama main.js'te HENÜZ require ETME.
//   2. AŞAMA: herkes 1. aşamayı aldıktan sonra (15 dk içinde otomatik) require'ı ekle.
// "player-info.js" şu an 1. AŞAMADA - liste biliyor, main.js henüz require etmiyor.
const UPDATE_FILES = ['main.js', 'index.html', 'renderer.js', 'mobile.html', 'setup.html', 'player-info.js'];
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000; // periyodik kontrol - 15 dakikada bir

async function fetchUpdateRepoFile(filePath) {
    const headers = {
        'Accept': 'application/vnd.github.v3.raw',
        'User-Agent': 'NexoraPanel-Updater'
    };
    // Token sadece varsa ekleniyor - public repoda kimliksiz istek zaten çalışıyor.
    if (UPDATE_REPO_TOKEN) headers['Authorization'] = `Bearer ${UPDATE_REPO_TOKEN}`;
    const res = await fetch(
        `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/contents/${filePath}`,
        { headers }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

// --- EKSİK DOSYA GÜVENLİK AĞI (yeni dosya eklerken çökmeyi önler) ---
// Güncelleyicinin indireceği dosya listesi (UPDATE_FILES) her istemcide KENDİ sürümünden
// okunuyor. Yani listeye yeni bir dosya eklendiğinde, HENÜZ ESKİ sürümdeki bir istemci
// güncellenirken yeni main.js'i indirir ama yeni dosyayı İNDİRMEZ - o dosya require edilseydi
// uygulama açılışta MODULE_NOT_FOUND ile çökerdi. Bunu imkânsız kılmak için:
//   * player-info.js TOP-LEVEL require EDİLMİYOR (aşağıdaki getPlayerInfo ile tembel yükleniyor),
//   * ve açılışta eksik olan HER dosya repodan indiriliyor (aşağıdaki fonksiyon).
// Böylece hangi sürümden gelinirse gelinsin uygulama kendini onarıyor, sürüm beklemeye gerek yok.
async function ensureAppFiles() {
    for (const file of UPDATE_FILES) {
        const target = path.join(__dirname, file);
        if (fs.existsSync(target)) continue;
        console.log(`[Güncelleme] Eksik dosya tespit edildi: ${file} - indiriliyor...`);
        try {
            const content = await fetchUpdateRepoFile(file);
            fs.writeFileSync(target, content);
            console.log(`[Güncelleme] ${file} indirildi.`);
        } catch (error) {
            console.log(`[Güncelleme] ${file} indirilemedi: ${error.message}`);
        }
    }
}

// Ortak modül TEMBEL yükleniyor - ensureAppFiles() çalıştıktan sonraki ilk kullanımda.
let playerInfoApi = null;
function getPlayerInfo() {
    if (!playerInfoApi) {
        playerInfoApi = require('./player-info.js').createPlayerInfo(client);
    }
    return playerInfoApi;
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

        // ÖNCEDEN burada BLOKLAYICI bir dialog.showMessageBox vardı ("Tamam" tıklanana kadar
        // relaunch beklerdi) - artık periyodik kontroller de (bkz. UPDATE_CHECK_INTERVAL_MS)
        // aynı fonksiyonu kullandığı için, kullanıcı ekranın başında değilken güncelleme
        // "Tamam"a tıklanana kadar askıda kalırdı. Bunun yerine uygulamanın zaten başka
        // yerlerde kullandığı BLOKLAMAYAN Windows bildirimi kullanılıyor - relaunch hemen
        // gerçekleşiyor, kimse bildirimi görmese/tıklamasa bile güncelleme tamamlanır.
        if (Notification.isSupported()) {
            const notification = new Notification({
                title: `✅ Nexora Panel v${remote.version} güncellendi`,
                body: (remote.changelog || '').split('\n')[0] || 'Uygulama yeniden başlatılıyor...',
            });
            notification.show();
        }

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
    const result = await getPlayerInfo().resolvePlayerIdentity(query);
    botLog('lookup', { sorgu: query, bulundu: result ? (result.name || result.playerId || 'evet') : 'hayır' });
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
const activeScans = new Map(); // kod -> { cancelled: boolean }

function registerScan(code) {
    activeScans.set(code, { cancelled: false });
    if (mainWindow) mainWindow.webContents.send('scan-started', { code });
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
    console.log(`[İptal] Tarama iptal edildi: ${code}`);

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
        reportStatEvent('claim');
        botLog('ticket-claim', { ticket: channel.name });
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
        reportStatEvent('close');
        botLog('ticket-close', { ticket: channel.name });
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
        reportStatEvent('ban');
        botLog('ticket-ban', { ticket: channel.name, sebep: safeReason, license, 'oyun ici id': gameId });
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
        // Duyuru mesajinin KENDISI kanit oluyor: kisi bundan sonra cikarsa #kontrol-log'a
        // "AC cagrisi su mesajda yapildi" diye linki dusuluyor.
        const announceMessage = await announceChannel.send(`<@${discord}> ${acTicketMessage} ${callCount}x`);
        console.log(`[AC Çağır] Duyuru kanalına etiketlendi (${name || discord}, ${callCount}x).`);
        results.push(`duyuru kanalına ${callCount}x olarak etiketlendi`);

        botLog('ac-call', { kisi: discord, isim: name, 'kacinci': `${callCount}x`, license });
        watchForDisconnectionAfterAcCall({ discord, license, name, acCallMessageUrl: buildMessageUrl(announceMessage) });

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

// AC ekibinin "kontrol-log" kanali (MD PVP YETKİLİ & LOG sunucusu). Ekip buraya elle
// "<discord id> | kont çağırılınca q" gibi satirlar yaziyordu - kullanici bunu otomatiklestirmek
// istedi: "kontrole cagirinca quiti kanitlariyla birlikte log dus ... ve fg offline ban at".
const KONTROL_LOG_CHANNEL_ID = '1473372352078286951';

// --- KONTROL-LOG KAYIT BİÇİMİ ---
// Ekip eskiden "<id> | Kontrol red" gibi tek satır yazıyordu; kullanıcı "kendin güzel bir
// desenle yaz" dediği için kayıtlar okunaklı, tutarlı bir düzene çekildi: başlık + kişi +
// bilgiler + kanıtlar + yapılan işlem. Discord'un kendi zaman etiketi (<t:unix:f>) kullanılıyor -
// herkesin kendi saat diliminde doğru görünür.
const KONTROL_LOG_AYIRAC = '─────────────────────';

function discordZaman(date = new Date()) {
    const unix = Math.floor(date.getTime() / 1000);
    return `<t:${unix}:f> (<t:${unix}:R>)`;
}

// Kişiyi hem tıklanabilir etiket hem KOPYALANABİLİR ham ID olarak yazar - ekip ID'yi
// sık sık kopyalayıp başka yere yapıştırıyor.
function kisiSatiri(discordId, isim) {
    if (!discordId) return `👤 **Kişi:** ${isim || 'bilinmiyor'}`;
    const isimEk = isim ? ` — ${isim}` : '';
    return `👤 **Kişi:** <@${discordId}> \`${discordId}\`${isimEk}`;
}

// Bir Discord mesajinin kalici linki - kanit olarak log satirina ekleniyor.
function buildMessageUrl(message) {
    if (!message) return null;
    const guildId = message.guildId || message.guild?.id;
    if (!guildId) return null;
    return `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`;
}

// NOT: Cikis sebebine (Exiting / connection timed out / vb.) GORE AYRIM YAPILMIYOR.
// Ilk tasarimda "sadece bilerek cikista (Exiting) ban at, timeout'ta atma" denmisti (interneti
// kopan masum biri banlanmasin diye) ama kullanici bunu bilerek reddetti:
// "nasil cikarsa ciksin ban at, sebebine gore degistirme, onu sahte yapiyolar, adami ac
// cagirdigim an cikmasi tesaduf olamaz" - yani timeout'u fisi cekerek KASTEN uretiyorlar.
// Sebep yine de log satirina yaziliyor (kanit/inceleme icin dursun).

// "Kontrol Red": kisi kontrolu reddettiginde AC ekibi #kontrol-log'a elle
// "<discord id> | Kontrol red" + ekran goruntusu yaziyordu. Artik panelden tek tikla gidiyor.
// Ekran goruntusu ZORUNLU DEGIL - elde goruntu yoksa kayit yine de dussun diye.
async function performKontrolRed(channelId, imageDataUrl) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
        return { success: false, message: 'Ticket kanalı bulunamadı.' };
    }

    // Hedef kisinin Discord ID'si - ticket kanalindan zaten bulunabiliyor (kontrol/ban
    // akislarinda kullanilan AYNI fonksiyon, yeni bir tahmin yontemi uydurulmadi).
    let targetUserId = null;
    try {
        targetUserId = await findTargetUserId(channel, null);
    } catch (error) {
        console.log(`[Kontrol Red] Hedef bulunamadı: ${error.message}`);
    }
    if (!targetUserId) {
        return { success: false, message: `${channel.name}: hedef kullanıcı bulunamadı, kayıt düşülmedi.` };
    }

    const files = [];
    if (imageDataUrl) {
        try {
            // data:image/png;base64,AAAA... -> Buffer
            const base64 = String(imageDataUrl).split(',')[1] || '';
            const buffer = Buffer.from(base64, 'base64');
            if (buffer.length > 0) files.push(new MessageAttachment(buffer, 'kontrol-red.png'));
        } catch (error) {
            console.log(`[Kontrol Red] Ekran görüntüsü işlenemedi: ${error.message}`);
        }
    }

    // Kontrol reddi ARTIK BAN SEBEBİ (kullanıcı isteği). License ile "/fg offline-ban" atılıyor
    // ve komut TICKET KANALINDAN gönderiliyor - ac-komut kanalından DEĞİL ("fg offline bani
    // ticket uzerinden at"). Sebep biçimi: "kontrol red -<botu kullanan kişi>".
    const { license, kaynak: licenseKaynak } = await resolveTicketLicense(channel, targetUserId);
    const banSebebi = `kontrol red -${client.user.username}`;
    let banHatasi = null;
    let banGonderildi = false;
    if (license) {
        try {
            await channel.sendSlash(FG_BOT_ID, 'fg offline-ban', license, banSebebi);
            banGonderildi = true;
            reportStatEvent('ban');
            console.log(`[Kontrol Red] ${channel.name}: /fg offline-ban gönderildi (${license}, sebep: ${banSebebi}).`);
        } catch (error) {
            banHatasi = error.message;
            console.log(`[Hata] Kontrol Red /fg offline-ban gönderilemedi: ${error.message}`);
        }
    } else {
        console.log(`[Kontrol Red] ${channel.name}: license bulunamadı, ban gönderilemedi.`);
    }

    try {
        const kontrolLogChannel = client.channels.cache.get(KONTROL_LOG_CHANNEL_ID)
            || await client.channels.fetch(KONTROL_LOG_CHANNEL_ID);

        let islemSatiri;
        if (banGonderildi) islemSatiri = `🚫 **İşlem:** \`/fg offline-ban\` gönderildi — sebep: \`${banSebebi}\``;
        else if (license) islemSatiri = `⚠️ **İşlem:** \`/fg offline-ban\` GÖNDERİLEMEDİ — ${banHatasi}`;
        else islemSatiri = '⚠️ **İşlem:** license bulunamadığı için ban gönderilemedi';

        const govde = [
            '🚫 **KONTROL REDDEDİLDİ**',
            KONTROL_LOG_AYIRAC,
            kisiSatiri(targetUserId, null),
            `🎫 **Ticket:** ${channel.name}`,
            license ? `🔑 **License:** \`${license}\` _(${licenseKaynak})_` : '🔑 **License:** bulunamadı',
            `🕐 **Zaman:** ${discordZaman()}`,
            `🧑‍💻 **Kaydeden:** <@${client.user.id}>`,
            files.length ? '📎 **Kanıt:** ekran görüntüsü ekte' : '📎 **Kanıt:** ekran görüntüsü eklenmedi',
            islemSatiri,
        ].join('\n');
        await kontrolLogChannel.send({ content: govde, files });

        const ekBilgi = files.length ? ' (ekran görüntüsüyle)' : ' (ekran görüntüsü yok)';
        botLog('kontrol-red', {
            ticket: channel.name,
            kisi: targetUserId,
            'ekran görüntüsü': files.length ? 'var' : 'yok',
            license: license || 'bulunamadı',
            'license kaynağı': licenseKaynak || '-',
            ban: banGonderildi ? `gönderildi (${banSebebi})` : (license ? `HATA: ${banHatasi}` : 'license yok'),
        });
        console.log(`[Kontrol Red] ${channel.name} için kayıt düşüldü: ${targetUserId}${ekBilgi}.`);

        const banNotu = banGonderildi
            ? ' + /fg offline-ban gönderildi'
            : (license ? ` (ban HATASI: ${banHatasi})` : ' (license yok, ban atılmadı)');
        return { success: true, message: `Kontrol red kaydı düşüldü: ${targetUserId}${ekBilgi}${banNotu}.` };
    } catch (error) {
        console.log(`[Hata] Kontrol red kaydı düşülemedi: ${error.message}`);
        return { success: false, message: `Kayıt düşülemedi: ${error.message}` };
    }
}

// AC cagrildiktan sonra oyundan cikan kisiyi #kontrol-log'a KANITLARIYLA yazar; cikis
// "Exiting" (bilerek cikma) ise ayrica otomatik "/fg offline-ban" atar.
async function logKontrolQuit({ entry, displayName, discord, license, acCallMessageUrl, disconnectMessageUrl }) {
    const hedefId = entry.discord || discord || '';

    const satirlar = [];
    satirlar.push('🚪 **KONTROLE ÇAĞIRINCA OYUNDAN ÇIKTI**');
    satirlar.push(KONTROL_LOG_AYIRAC);
    satirlar.push(kisiSatiri(hedefId, displayName));
    if (license) satirlar.push(`🔑 **License:** \`${license}\``);
    if (entry.reason) satirlar.push(`📄 **Çıkış sebebi:** ${entry.reason}`);
    satirlar.push(`🕐 **Zaman:** ${discordZaman()}`);
    if (acCallMessageUrl || disconnectMessageUrl) {
        satirlar.push('');
        satirlar.push('**📎 Kanıtlar**');
        if (acCallMessageUrl) satirlar.push(`• AC çağrısı: ${acCallMessageUrl}`);
        if (disconnectMessageUrl) satirlar.push(`• Çıkış kaydı: ${disconnectMessageUrl}`);
    }
    satirlar.push('');

    // Cikis sebebi NE OLURSA OLSUN ban atiliyor (bkz. yukaridaki not) - tek sart license'in
    // bilinmesi, cunku "/fg offline-ban" onunla calisiyor.
    let banSonucu = null;
    if (license) {
        banSonucu = await performLookupFgBan({
            type: 'offline-ban',
            license,
            reason: 'kontrol çağırınca oyundan quit',
        });
        satirlar.push(banSonucu.success
            ? '🚫 **İşlem:** otomatik `/fg offline-ban` gönderildi.'
            : `⚠️ **İşlem:** otomatik ban GÖNDERİLEMEDİ — ${banSonucu.message}`);
    } else {
        satirlar.push('⚠️ **İşlem:** license bulunamadı, otomatik ban gönderilemedi — elle bakılmalı.');
    }

    try {
        const kontrolLogChannel = client.channels.cache.get(KONTROL_LOG_CHANNEL_ID)
            || await client.channels.fetch(KONTROL_LOG_CHANNEL_ID);
        await kontrolLogChannel.send(satirlar.join('\n'));
        botLog(banSonucu && banSonucu.success ? 'auto-ban-quit' : 'kontrol-quit', {
            kisi: hedefId,
            isim: displayName,
            'çıkış sebebi': entry.reason,
            license,
            kanit: disconnectMessageUrl,
        }, { basarili: banSonucu ? banSonucu.success : undefined });
        console.log(`[Kontrol Log] ${displayName} için "kontrol çağırınca quit" kaydı düşüldü${banSonucu?.success ? ' + otomatik ban' : ''}.`);
    } catch (error) {
        console.log(`[Hata] kontrol-log kaydı düşülemedi: ${error.message}`);
    }
}

function watchForDisconnectionAfterAcCall({ discord, license, name, acCallMessageUrl }) {
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

        // KONTROLE CAGIRINCA QUIT: kisi AC cagrildiktan sonra oyundan KENDI ISTEGIYLE ciktiysa
        // (Reason: Exiting) bu, ekibin elle "<id> | kont çağırılınca q" diye logladigi durum.
        // Artik bot hem kanit linkleriyle #kontrol-log'a yaziyor hem de otomatik offline-ban atiyor.
        // Ban FG botu tarafinda license ile calisiyor - license bu cikis kaydinin icinde geliyor.
        if (!banned) {
            logKontrolQuit({
                entry,
                displayName,
                discord,
                license: entry.license || license,
                acCallMessageUrl,
                disconnectMessageUrl: buildMessageUrl(message),
            });
        }
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
            botLog('lookup-ban', { komut: `/fg ban id:${playerId}`, sebep: safeReason });
            return { success: true, message: `/fg ban gönderildi (ID: ${playerId}).` };
        } else {
            await komutChannel.sendSlash(FG_BOT_ID, 'fg offline-ban', license, safeReason);
            console.log(`[Kimlik Sorgula] /fg offline-ban ${license} gönderildi (sebep: ${safeReason}).`);
            botLog('lookup-ban', { komut: '/fg offline-ban', license, sebep: safeReason });
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

ipcMain.on('ticket-kontrol-red', async (event, { channelId, imageDataUrl }) => {
    let result;
    try {
        result = await performKontrolRed(channelId, imageDataUrl);
    } catch (error) {
        console.log(`[Hata] Kontrol red işlemi başarısız: ${error.message}`);
        result = { success: false, message: error.message };
    }
    if (mainWindow) mainWindow.webContents.send('kontrol-red-result', result);
    // Sonuc gozden kacmasin diye Windows bildirimi de gonderiliyor (uygulamanin baska
    // yerlerde de kullandigi, BLOKLAMAYAN desen).
    try {
        if (Notification.isSupported()) {
            new Notification({
                title: result.success ? '✅ Kontrol Red kaydedildi' : '⚠️ Kontrol Red başarısız',
                body: result.message,
            }).show();
        }
    } catch (error) { /* bildirim gosterilemedi - islem yine de tamamlandi */ }
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
            const result = await getPlayerInfo().resolvePlayerIdentity(reqUrl.searchParams.get('query') || '');
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

// Sohbet ve denetim kaydi icin gereken iki paylasimli anahtari VDS'ten cekip config.env'e
// yazar. Kullanicidan HICBIR islem istenmez.
//
// Neden koda gomulu degil: guncelleme deposu PUBLIC. Neden kullaniciya sorulmuyor: panel genis
// bir kitleye dagitiliyor, "config.env'ine su satiri ekle" demek mumkun degil - zaten guncelleme
// mekanizmasini tam da bunun icin yaptik.
//
// Guvenlik notu: bu degerler ONCEDEN de dagitilan her kopyada koda gomulu duruyordu, yani
// uygulamayi indiren herkeste vardi - burada tutmak bir kayip DEGIL. Kazanc: yeniden dagitim
// yapmadan VDS'ten dondurulebiliyorlar. Kotuye kullanimda yapilabilecek en fazla sey log
// kanallarina gurultu basmak; sunucu tarafinda IP basina hiz siniri var.
async function ensureClientSecrets() {
    if (CHAT_SERVER_SECRET && BOT_LOG_SECRET) return;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(`${STATS_SERVER_URL}/istemci-ayar`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ayar = await res.json();
        if (ayar.chatSecret && !CHAT_SERVER_SECRET) {
            CHAT_SERVER_SECRET = ayar.chatSecret;
            saveConfigValue('CHAT_SERVER_SECRET', ayar.chatSecret);
        }
        if (ayar.botLogSecret && !BOT_LOG_SECRET) {
            BOT_LOG_SECRET = ayar.botLogSecret;
            saveConfigValue('BOT_LOG_SECRET', ayar.botLogSecret);
        }
        console.log('[Ayar] İstemci anahtarları sunucudan alındı ve config.env\'e yazıldı.');
    } catch (error) {
        // Basarisiz olursa panel yine acilir - sadece sohbet/denetim kaydi susar, bir sonraki
        // acilista tekrar denenir. Ticket/kontrol/ban akislari bundan ETKILENMEZ.
        console.log(`[Ayar] İstemci anahtarları alınamadı (${error.message}) - sohbet/denetim kaydı bu oturumda devre dışı.`);
    }
}

app.on('ready', async () => {
    await checkForUpdates(); // güncelleme varsa burada indirip yeniden başlatır, devam etmez
    await ensureAppFiles();  // eski bir sürümden gelindiyse eksik kalan dosyaları tamamlar
    await ensureClientSecrets(); // sohbet/denetim anahtarlarını sunucudan çeker (kullanıcı hiçbir şey yapmaz)

    // Uygulama günlerce kapatılmadan açık kalabildiği için (herkes artık VDS'e bağlı, elle
    // yeniden başlatmaya gerek kalmıyor) SADECE açılışta değil, periyodik olarak da tekrar
    // kontrol ediliyor - yeni bir sürüm bulunursa checkForUpdates kendi içinde indirip
    // relaunch ediyor, burada ekstra bir şey yapmaya gerek yok.
    setInterval(() => {
        checkForUpdates();
    }, UPDATE_CHECK_INTERVAL_MS);

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
const CONNECTIONS_WEBHOOK_CHANNEL_ID = '1513234125337919610';

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
        info = await getPlayerInfo().queryPlayerInfoCommand({ discordId, gameId: discordId ? null : gameId });
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

// --- SOHBET (botu kullanan herkesin birbiriyle konuştuğu, Discord'dan BAĞIMSIZ sistem) ---
// Kullanıcı "yeni bir sekme, botu kullanan herkesin birbiriyle konuşabileceği bir sistem, VDS
// üzerinden hallet, Discord'a bağlı olmasın" dedi. VDS'de sürekli çalışan `chat-server.js`'e
// (aynı desende: paylaşımlı secret, Task Scheduler ile kalıcı - ama claim sunucusundan AYRI
// port/süreç, biri çökerse diğerini etkilemesin diye) WebSocket ile bağlanılıyor. Kimlik
// (avatar+isim) zaten giriş yapılmış Discord hesabından okunuyor ama MESAJLAŞMANIN KENDİSİ
// Discord API'sini hiç kullanmıyor - sunucu sadece bağlı herkese "kim, ne yazdı" broadcast ediyor.
const CHAT_SERVER_URL = 'ws://185.211.100.43:28418';
// DEPO PUBLIC OLDUĞU İÇİN BU SECRET ARTIK KODA GÖMÜLMÜYOR - config.env'den okunuyor.
// Eskiden burada düz metin duruyordu; depo herkese açık hale gelince VDS'in sohbet/istatistik
// ucu (28418) internetten taklit edilebilir olurdu. Eksikse sohbet+istatistik sessizce
// devre dışı kalır, panelin GERİ KALANI normal çalışmaya devam eder.
let CHAT_SERVER_SECRET = process.env.CHAT_SERVER_SECRET || '';
const CHAT_RECONNECT_DELAY_MS = 5000;
// Bağlantı normal kapanırsa ('close' event) zaten hemen yeniden deneniyor - ama TCP bağlantısı
// bazen (ör. laptop uyku modundan çıkışı, ağ kesintisi) hiçbir 'close'/'error' ateşlemeden
// "zombi" kalabiliyor - karşı taraf gerçekten dinlemiyor ama yerel soket hâlâ OPEN görünüyor.
// Bunu yakalamak için standart ws deseni: periyodik ping gönder, pong gelmezse bağlantıyı
// zorla kapat (bu 'close' event'ini tetikleyip normal yeniden bağlanma akışına düşürür).
const CHAT_HEARTBEAT_INTERVAL_MS = 10000;
// EK güvenlik ağı: yukarıdaki mekanizmaların HİÇBİRİ (her ne sebeple olursa olsun) tetiklenmeden
// bağlantı kopuk kalırsa, bu periyodik kontrol "bağlı değilsem tekrar dene"yi garantiliyor. Kullanıcı
// "5 saniyede bir VDS'e bağlı mıyım diye kontrol etsin" dedi - 5000ms'ye çekildi (öncesi 30000ms).
const CHAT_WATCHDOG_INTERVAL_MS = 5000;

let chatSocket = null;
let chatReconnectTimer = null;
// Renderer'daki sohbet sekmesi WS bağlantısı kurulduktan ÇOK SONRA (kullanıcı sekmeye ilk kez
// geçtiğinde) açılabiliyor - o ana kadar gelen 'history'/'presence' mesajları kaçmasın diye
// son halleri burada da tutuluyor, sekme açılınca 'request-chat-state' ile bunlar isteniyor.
let lastChatHistory = [];
let lastChatPresence = [];

function connectChatSocket() {
    if (!client.user) return; // Discord'a henüz giriş yapılmadı, isim/avatar hazır değil
    // Secret yoksa bağlanmayı hiç deneme: sunucu reddeder ve sonsuz yeniden bağlanma döngüsüne gireriz.
    if (!CHAT_SERVER_SECRET) return;
    if (chatSocket && (chatSocket.readyState === WebSocket.OPEN || chatSocket.readyState === WebSocket.CONNECTING)) return;

    let socket;
    try {
        socket = new WebSocket(CHAT_SERVER_URL);
    } catch (error) {
        console.log(`[Sohbet] Bağlantı kurulamadı: ${error.message}`);
        scheduleChatReconnect();
        return;
    }
    chatSocket = socket;

    // Ping/pong nabzı - bkz. CHAT_HEARTBEAT_INTERVAL_MS yorumu. 'close' event'inden BAĞIMSIZ,
    // bu soket için ayrı bir interval - başka bir bağlantıya ait pong'la karışmasın diye
    // her yeni socket kendi heartbeat'ini kuruyor ve kendi close'unda temizliyor.
    let awaitingPong = false;
    const heartbeat = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (awaitingPong) {
            console.log('[Sohbet] Sunucudan pong gelmedi (zombi bağlantı), zorla kapatılıp yeniden denenecek.');
            socket.terminate(); // 'close' event'ini tetikler, yeniden bağlanma oradan devam eder
            return;
        }
        awaitingPong = true;
        socket.ping();
    }, CHAT_HEARTBEAT_INTERVAL_MS);
    socket.on('pong', () => { awaitingPong = false; });

    socket.on('open', () => {
        console.log('[Sohbet] VDS sohbet sunucusuna bağlandı.');
        socket.send(JSON.stringify({
            type: 'hello',
            secret: CHAT_SERVER_SECRET,
            userId: client.user.id,
            username: client.user.displayName || client.user.username,
            avatarUrl: client.user.displayAvatarURL({ size: 128, format: 'png' }),
            // Sürüm bildirimi: VDS paneli "kim hangi sürümde" gösterebilsin diye. Kullanıcı her
            // yayından sonra "herkes güncellendi mi" diye merak ediyordu - artık bakıp görebiliyor.
            // Bu alanı GÖNDERMEYEN bir istemci, bu özellikten ÖNCEKİ bir sürümde demektir.
            version: CURRENT_VERSION,
        }));
    });

    socket.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (error) {
            return;
        }
        if (msg.type === 'history') lastChatHistory = msg.messages || [];
        if (msg.type === 'presence') lastChatPresence = msg.users || [];
        if (msg.type === 'message') {
            lastChatHistory = [...lastChatHistory, msg].slice(-200);
        }
        // VDS "kendi kendini izleme" uyarısı (bkz. chat-server.js'teki karşılıklı izleme notu):
        // VDS'in Discord tarafı (id-responder) çökerse sohbet sunucusu bunu yayınlıyor. Discord
        // KENDİNE DM atmaya izin vermediği için (canlı test edildi) haber verme yolu bu: panelde
        // bloklamayan bir Windows bildirimi - uygulamanın zaten kullandığı desenle aynı.
        if (msg.type === 'alert' && msg.text) {
            console.log(`[Sohbet] VDS uyarısı: ${msg.text}`);
            try {
                new Notification({
                    title: msg.level === 'ok' ? 'Nexora Panel - VDS' : 'Nexora Panel - VDS Uyarısı',
                    body: String(msg.text).slice(0, 300),
                }).show();
            } catch (error) {
                console.log(`[Sohbet] Uyarı bildirimi gösterilemedi: ${error.message}`);
            }
        }
        if (mainWindow) mainWindow.webContents.send('chat-event', msg);
    });

    socket.on('close', () => {
        console.log('[Sohbet] Bağlantı koptu, birkaç saniye sonra yeniden denenecek.');
        clearInterval(heartbeat);
        if (chatSocket === socket) chatSocket = null;
        scheduleChatReconnect();
    });

    socket.on('error', (error) => {
        console.log(`[Sohbet] Bağlantı hatası: ${error.message}`);
    });
}

// Güvenlik ağı: 'close' event'i her ne sebeple olursa olsun hiç tetiklenmeden bağlantı
// kopuk/kurulmamış kalırsa (ör. ilk bağlantı denemesi sırasında beklenmedik bir durum),
// bu periyodik kontrol "bağlı değilsem tekrar dene"yi garanti ediyor. connectChatSocket zaten
// zaten OPEN/CONNECTING durumundaysa hiçbir şey yapmıyor, o yüzden zararsız/idempotent.
setInterval(() => {
    if (!client.user) return;
    if (chatSocket && (chatSocket.readyState === WebSocket.OPEN || chatSocket.readyState === WebSocket.CONNECTING)) return;
    console.log('[Sohbet] Watchdog: bağlı değil, yeniden bağlanma deneniyor.');
    connectChatSocket();
}, CHAT_WATCHDOG_INTERVAL_MS);

function scheduleChatReconnect() {
    if (chatReconnectTimer) return;
    chatReconnectTimer = setTimeout(() => {
        chatReconnectTimer = null;
        connectChatSocket();
    }, CHAT_RECONNECT_DELAY_MS);
}

ipcMain.on('chat-send', (event, text) => {
    const trimmed = String(text || '').trim();
    if (!trimmed || !chatSocket || chatSocket.readyState !== WebSocket.OPEN) return;
    chatSocket.send(JSON.stringify({ type: 'message', text: trimmed }));
});

// Renderer sohbet sekmesini açtığında (WS bağlantısı ondan çok önce kurulmuş olabilir) mevcut
// geçmiş+online listesini almak için bunu çağırıyor.
ipcMain.on('request-chat-state', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    win.webContents.send('chat-event', { type: 'history', messages: lastChatHistory });
    win.webContents.send('chat-event', { type: 'presence', users: lastChatPresence });
});

// --- İSTATİSTİK RAPORLAMA (basit lider tablosu - "kim ne kadar aktif") ---
// Sohbet sunucusuyla (chat-server.js) AYNI süreç/port, sadece ayrı bir HTTP ucu
// (/stats/event) - ayrı bir sunucu AÇILMADI. Ticket claim/ban/kontrol/close başarılı
// olduğunda buraya "fire-and-forget" bir olay bildirimi gönderiliyor; VDS'e ulaşılamasa
// bile hata YUTULUR, gerçek ticket işlemi ASLA bu yüzden bloklanmaz/başarısız sayılmaz.
const STATS_SERVER_URL = 'http://185.211.100.43:28418';
const STATS_EVENT_TIMEOUT_MS = 3000;

// --- MERKEZİ DENETİM KAYDI ---
// Kullanıcı "botun yaptığı her işlemi logla, gerektiğinde kontrol edebileyim" dedi. Log kanalları
// kullanıcının KENDİ özel sunucusunda; arkadaşların hesapları o sunucuya ÜYE DEĞİL, oraya doğrudan
// yazamazlar. Bu yüzden kayıtlar VDS'e HTTP ile bildiriliyor, VDS de kullanıcının hesabıyla yazıyor.
// reportStatEvent ile AYNI desen: fire-and-forget, hata YUTULUR, asıl işlemi ASLA bloklamaz.
const BOT_LOG_URL = 'http://185.211.100.43:28419';
// Aynı gerekçe (bkz. CHAT_SERVER_SECRET): koda gömülmüyor, config.env'den geliyor.
// Eksikse denetim kaydı gönderilmez, asıl işlemler (ban/kontrol/claim) etkilenmez.
let BOT_LOG_SECRET = process.env.BOT_LOG_SECRET || '';
const BOT_LOG_TIMEOUT_MS = 3000;

function botLog(tur, detay, options = {}) {
    if (!client.user) return;
    if (!BOT_LOG_SECRET) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BOT_LOG_TIMEOUT_MS);
    fetch(`${BOT_LOG_URL}/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bot-Log-Secret': BOT_LOG_SECRET },
        body: JSON.stringify({
            tur,
            kim: client.user.displayName || client.user.username,
            kimId: client.user.id,
            surum: CURRENT_VERSION,
            detay,
            basarili: options.basarili,
        }),
        signal: controller.signal,
    }).catch(() => { /* log gönderilemedi - asıl işlem etkilenmemeli, sessiz geçiliyor */ })
      .finally(() => clearTimeout(timeout));
}

function reportStatEvent(type) {
    if (!client.user) return;
    if (!CHAT_SERVER_SECRET) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STATS_EVENT_TIMEOUT_MS);
    fetch(`${STATS_SERVER_URL}/stats/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Chat-Secret': CHAT_SERVER_SECRET },
        body: JSON.stringify({
            userId: client.user.id,
            username: client.user.displayName || client.user.username,
            avatarUrl: client.user.displayAvatarURL({ size: 128, format: 'png' }),
            type,
        }),
        signal: controller.signal,
    }).catch((error) => {
        console.log(`[İstatistik] Olay gönderilemedi (${type}): ${error.message}`);
    }).finally(() => clearTimeout(timeout));
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
    connectChatSocket();
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
    // İKİ uçtan birden bakılıyor:
    //   * EN ESKİ 20 mesaj - normal akışta "Otomatik Oyuncu Bilgi" gömülüsü ticket açılır açılmaz düşüyor.
    //   * EN YENİ 100 mesaj - ticket "genel destek" olarak açılıp SONRADAN AC kategorisine sevk
    //     edildiyse gömülü çok daha geç düşüyor ve ilk 20'nin dışında kalıyor. Kullanıcı bunu
    //     bildirdi: "o ticketlarda yukardaki bu license kısmını okuyamıyosun".
    const partiler = [
        { query: { after: '0', limit: 20 }, etiket: 'en eski 20' },
        { query: { limit: 100 }, etiket: 'en yeni 100' },
    ];
    for (const parti of partiler) {
        try {
            const rawMessages = await client.api.channels(channel.id).messages.get({ query: parti.query });
            for (const message of rawMessages) {
                if (!message.author?.bot) continue;
                const info = parsePlayerInfoFromBotMessage(message);
                if (info.license || info.hasGameIdField) return info;
            }
        } catch (error) {
            console.log(`[Oyuncu Bilgi] ${channel.name}: geçmiş taranamadı (${parti.etiket}): ${error.message}`);
        }
    }
    return null;
}

// Ticket'ın license'ını bulmak için ÜÇ KADEMELİ arama - ucuzdan pahalıya sıralı, ilki tutunca durur:
//   1) Canlı yakalanan değer (channelLicense) - panel ticket açılışını gördüyse bedava.
//   2) Kanal geçmişi (findPlayerInfoFromHistory) - artık iki uçtan da bakıyor.
//   3) /player-info slash komutuyla Discord ID'den sorgulama - "genel destek" olarak açılıp
//      sonradan AC'ye sevk edilen ticketlarda gömülü HİÇ düşmemiş olabiliyor; bu kademe o
//      durumda bile license buluyor, çünkü kanaldan değil kişinin Discord ID'sinden gidiyor.
// Bulduğunu channelLicense/channelGameId'ye yazıyor ki aynı ticket için tekrar sorgulanmasın
// (her /player-info çağrısı gerçek bir Discord slash komutu = hesap için ekstra otomatik işlem).
async function resolveTicketLicense(channel, targetUserId) {
    const mevcut = channelLicense.get(channel.id);
    if (mevcut) return { license: mevcut, kaynak: 'canlı yakalama' };

    const historyInfo = await findPlayerInfoFromHistory(channel);
    if (historyInfo?.license) {
        channelLicense.set(channel.id, historyInfo.license);
        if (historyInfo.gameId) channelGameId.set(channel.id, historyInfo.gameId);
        console.log(`[Lisans] ${channel.name}: kanal geçmişinden bulundu: ${historyInfo.license}`);
        return { license: historyInfo.license, kaynak: 'kanal geçmişi' };
    }

    if (targetUserId) {
        try {
            const kimlik = await getPlayerInfo().resolvePlayerIdentity(targetUserId);
            if (kimlik?.license) {
                channelLicense.set(channel.id, kimlik.license);
                if (kimlik.playerId) channelGameId.set(channel.id, kimlik.playerId);
                console.log(`[Lisans] ${channel.name}: /player-info sorgusuyla bulundu: ${kimlik.license}`);
                return { license: kimlik.license, kaynak: '/player-info sorgusu' };
            }
        } catch (error) {
            console.log(`[Lisans] ${channel.name}: /player-info sorgusu başarısız: ${error.message}`);
        }
    }

    console.log(`[Lisans] ${channel.name}: license hiçbir kademede bulunamadı.`);
    return { license: null, kaynak: null };
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

    // --- "!id <sorgu>" KOMUTU: ARTIK MASAÜSTÜ UYGULAMASINDAN CEVAPLANMIYOR ---
    // Kullanıcı: "!id komutu gelince SADECE VDS'ten cevap gelsin, diğer kullanıcıları hiç
    // karıştırma, VDS direkt benim hesabımdan cevap versin, 2 mesaj atmasın."
    // Bu yüzden buradaki tetikleyici KALDIRILDI - artık komutu sadece VDS'de sürekli çalışan
    // id-responder.js (kullanıcının KENDİ hesabıyla giriş yapmış durumda) görüp yanıtlıyor.
    // Alttaki handleIdCommand/findIdCommandClaimReplies/buildIdCommandClaimText fonksiyonları
    // BİLEREK silinmedi (id-responder.js onların birebir kopyasını çalıştırıyor; ileride tekrar
    // masaüstünden cevaplama istenirse burayı geri açmak yeterli) - şu an sadece çağrılmıyorlar.
    // AYRICA savunmanın ikinci katmanı sunucu tarafında: claim-server.js artık "source" alanı
    // 'vds-id-responder' olmayan HİÇBİR isteğin claim kazanmasına izin vermiyor - yani henüz
    // güncelleme almamış eski sürümdeki arkadaş uygulamaları da cevap veremiyor.

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

    // NOT: Ticket kanalına 6 haneli kod yazıldığında mesajı SİLİP log kanalına kayıt
    // atan akış kullanıcı isteğiyle TAMAMEN KALDIRILDI (sendToLogChannel ile birlikte).
    // Artık 6 haneli kodlara hiç dokunulmuyor: ne siliniyor, ne loglanıyor.
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
    reportStatEvent('kontrol');
    botLog('ticket-kontrol', { ticket: channel.name, kod: code, hedef: targetUserId, link: downloadUrl });

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