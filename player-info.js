// ORTAK MODÜL - "/player-info" (FG botu) sorgulama mantığının TEK doğru kaynağı.
//
// NEDEN VAR: Bu kod hem masaüstü uygulamasında (main.js - Kimlik Sorgula + Liste+Detay ticket
// paneli) hem VDS'deki `id-responder.js`'te ("!id" komutu) kullanılıyor. Eskiden İKİ AYRI
// KOPYA olarak ELLE senkron tutuluyordu ve bu CANLIDA SOMUT BİR HATAYA yol açtı: id-responder'da
// PLAYER_INFO_TIMEOUT_MS 12000, main.js'te 15000 kaldı - "!id" artık SADECE VDS'ten cevaplandığı
// için, her şeyi cevaplayan taraf en kısa süre tanıyan taraf oldu ve sorguların ~%60'ı zaman
// aşımına uğradı. Bu modül o sınıf hatayı kökten imkânsız kılıyor.
//
// TASARIM: Electron'a/uygulamaya HİÇ bağımlı değil - sadece giriş yapmış bir
// discord.js-selfbot-v13 `client` alıyor. Böylece hem Electron main process'inde hem VDS'deki
// düz Node sürecinde AYNEN çalışıyor.
// ÖNEMLİ: Aşağıdaki iki "derin" require (kütüphanenin iç dosyaları) ancak kütüphanenin ANA
// girişi bir kez yüklendikten sonra çalışır - aksi halde kütüphanenin kendi dairesel
// bağımlılıkları çözülemeyip "Class extends value [object Object] is not a constructor"
// hatası verir. main.js'te bu sıra tesadüfen doğruydu (önce Client require ediliyordu);
// bu modül tek başına da (VDS'te) yüklenebildiği için sırayı burada AÇIKÇA garantiliyoruz.
require('discord.js-selfbot-v13');
const DiscordApplicationCommand = require('discord.js-selfbot-v13/src/structures/ApplicationCommand');
const { Message: DiscordMessage } = require('discord.js-selfbot-v13/src/structures/Message');

// "/fg" ve "/player-info" komutlarını barındıran botun (MD PVP SYSTEM) kullanıcı/uygulama ID'si.
const FG_BOT_ID = '1470758770790498377';
// ac-komut kanalı - /player-info buraya gönderiliyor (kullanıcı bu kanalı belirtti).
const PLAYER_INFO_COMMAND_CHANNEL_ID = '1475520758095544490';
// İlk BOŞ mesaj + embed'li edit'i beklemek için pay bırakıldı (bkz. aşağıdaki defer notu).
const PLAYER_INFO_TIMEOUT_MS = 15000;
const ID_COMMAND_CLAIM_PREFIX = '🔍 Sorgu üstlenildi, aranıyor...';

// /player-info embed'inin alan adları küçük bir "↷" dekorasyon karakteriyle geliyor
// (bkz. canlı ekran görüntüleri) - o yüzden TAM eşleşme yerine BAŞLANGIÇ eşleşmesi kullanılıyor.
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

// Sorgu metninden tür tahmini - SADECE Discord ID ve Player (oyun içi) ID destekleniyor
// (license/isim ile arama kaldırıldı, /player-info komutunun kendisi de sadece bu ikisini alıyor).
function detectLookupQueryType(q) {
    if (!/^\d+$/.test(q)) return null;
    return q.length >= 15 ? 'discordId' : 'playerId';
}

function buildIdCommandClaimText(query) {
    return `${ID_COMMAND_CLAIM_PREFIX} ("${query}")`;
}

function formatIdCommandResult(query, result) {
    if (!result) return `❌ Sonuç bulunamadı ("${query}")`;
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

// Giriş yapmış bir client'a bağlı sorgulama fonksiyonlarını üretir. `client` her iki tarafta da
// FARKLI bir nesne olduğu için (Electron main process / VDS düz Node süreci) fabrika deseni
// kullanılıyor - modülün kendisi hiçbir global duruma dokunmuyor.
function createPlayerInfo(client, options = {}) {
    const log = options.log || ((msg) => console.log(msg));

    // channel.sendSlash()'ı DOĞRUDAN kullanmıyoruz - kendi içinde çağırdığı
    // client.users.fetch(botId) canlı testte "Unauthorized" ile başarısız oldu (kök sebep
    // belirsiz, ama application-command-index API'si AYNI botun komutları için hiç başarısız
    // olmadı). Bu yüzden ApplicationCommand'i şema verisinden ELLE inşa ediyoruz.
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
        // options sırası ÖNEMLİ (şemadaki sırayla POZİSYONEL dolduruluyor):
        // [0] user (Discord ID), [1] gameid - kullanılmayan undefined bırakılıyor.
        return command.sendSlashCommand(fakeMessage, [], [discordId || undefined, gameId || undefined]);
    }

    async function queryPlayerInfoCommandImpl({ discordId, gameId } = {}) {
        const channel = client.channels.cache.get(PLAYER_INFO_COMMAND_CHANNEL_ID);
        if (!channel) {
            log('[Oyuncu Bilgi] player-info kanalı bulunamadı.');
            return null;
        }

        // ÖNEMLİ: FG botu /player-info'yu ÖNCE embed'i BOŞ bir mesajla (defer) gönderip birkaç
        // saniye sonra AYNI mesajı embed'le EDİT ediyor (canlı doğrulandı). Sadece messageCreate
        // dinlenirse asıl yanıt SONSUZA DEK kaçırılır - bu yüzden HEM messageCreate HEM
        // messageUpdate dinleniyor, hangisi önce embed'i doldurursa o kullanılıyor.
        const waitForReply = new Promise((resolve) => {
            const timeout = setTimeout(() => {
                client.removeListener('messageCreate', onCreate);
                client.removeListener('messageUpdate', onUpdate);
                resolve(null);
            }, PLAYER_INFO_TIMEOUT_MS);
            function tryResolve(message) {
                if (message.channelId !== PLAYER_INFO_COMMAND_CHANNEL_ID) return;
                if (message.author?.id !== FG_BOT_ID) return;
                if (!message.embeds?.length) return; // henüz boş kabuk - bekle
                if (message.interaction && message.interaction.commandName && message.interaction.commandName !== 'player-info') return;
                clearTimeout(timeout);
                client.removeListener('messageCreate', onCreate);
                client.removeListener('messageUpdate', onUpdate);
                resolve(message);
            }
            function onCreate(message) { tryResolve(message); }
            function onUpdate(oldMessage, newMessage) { tryResolve(newMessage); }
            client.on('messageCreate', onCreate);
            client.on('messageUpdate', onUpdate);
        });

        try {
            await sendPlayerInfoSlashCommand(channel, discordId, gameId);
        } catch (error) {
            log(`[Oyuncu Bilgi] /player-info gönderilemedi: ${error.message}`);
            return null;
        }

        const message = await waitForReply;
        if (!message) {
            log('[Oyuncu Bilgi] /player-info yanıtı zaman aşımına uğradı.');
            return null;
        }
        return parsePlayerInfoEmbed(message.embeds[0]);
    }

    // Aynı anda birden fazla /player-info isteği YARIŞ DURUMUNA yol açmasın diye TEK BİR
    // kuyruktan sırayla işleniyor - "gönder, o botun BİR SONRAKİ mesajını bekle" deseni ancak
    // aynı anda tek istek varsa güvenilir olur.
    let playerInfoQueue = Promise.resolve();
    function queryPlayerInfoCommand(params) {
        const run = () => queryPlayerInfoCommandImpl(params);
        const chained = playerInfoQueue.then(run, run);
        playerInfoQueue = chained.catch(() => {}); // bir istek hata verse bile kuyruk tıkanmasın
        return chained;
    }

    async function resolvePlayerIdentity(query) {
        const q = String(query || '').trim();
        if (!q) return null;

        const type = detectLookupQueryType(q);
        if (!type) {
            log(`[Kimlik Sorgula] "${q}" geçersiz sorgu - sadece Discord ID veya Oyun İçi (Player) ID destekleniyor.`);
            return null;
        }

        log(`[Kimlik Sorgula] ${type === 'discordId' ? 'Discord ID' : 'Player ID'} ${q} için /player-info sorgulanıyor...`);
        const info = await queryPlayerInfoCommand(type === 'discordId' ? { discordId: q } : { gameId: q });
        if (!info) {
            log(`[Kimlik Sorgula] "${q}" için /player-info sonuç vermedi.`);
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

    return {
        sendPlayerInfoSlashCommand,
        queryPlayerInfoCommandImpl,
        queryPlayerInfoCommand,
        resolvePlayerIdentity,
    };
}

module.exports = {
    FG_BOT_ID,
    PLAYER_INFO_COMMAND_CHANNEL_ID,
    PLAYER_INFO_TIMEOUT_MS,
    ID_COMMAND_CLAIM_PREFIX,
    parsePlayerInfoEmbed,
    detectLookupQueryType,
    buildIdCommandClaimText,
    formatIdCommandResult,
    createPlayerInfo,
};
