const { ipcRenderer, clipboard, shell } = require('electron');
const path = require('path');

function iconHtml(name) {
    return `<svg class="icon"><use href="#icon-${name}"></use></svg>`;
}

const soundSelect = document.getElementById('soundSelect');
const volumeSlider = document.getElementById('volumeSlider');
const volumeLabel = document.getElementById('volumeLabel');
const testBtn = document.getElementById('testBtn');

// --- SES AYARLARINI HATIRLA (localStorage - kalıcı, panel her açıldığında yüklenir) ---
const SOUND_STORAGE_KEY = 'nexora_sound';
const VOLUME_STORAGE_KEY = 'nexora_volume';

const savedSound = localStorage.getItem(SOUND_STORAGE_KEY);
if (savedSound) soundSelect.value = savedSound;

const savedVolume = localStorage.getItem(VOLUME_STORAGE_KEY);
if (savedVolume !== null) {
    volumeSlider.value = savedVolume;
    volumeLabel.innerText = `%${Math.round(savedVolume * 100)}`;
}

function playNotificationSound() {
    // Ses dosyasının tam yolunu nokta atışı buluyoruz
    const filePath = path.join(__dirname, 'sounds', soundSelect.value);
    const audio = new Audio('file://' + filePath);

    audio.volume = volumeSlider.value;

    // Eğer dosya yoksa ekrana hata mesajı fırlatır
    audio.play().catch(e => {
        alert(`Hata: '${soundSelect.value}' dosyası bulunamadı! Lütfen 'sounds' klasörüne bu isimde bir müzik dosyası attığından emin ol.`);
        console.error(e);
    });
}

soundSelect.addEventListener('change', () => {
    localStorage.setItem(SOUND_STORAGE_KEY, soundSelect.value);
});

volumeSlider.addEventListener('input', () => {
    const percent = Math.round(volumeSlider.value * 100);
    volumeLabel.innerText = `%${percent}`;
    localStorage.setItem(VOLUME_STORAGE_KEY, volumeSlider.value);
});

testBtn.addEventListener('click', () => {
    playNotificationSound();
});

ipcRenderer.on('ticket-geldi', () => {
    playNotificationSound();
});

// --- KİMLİK SORGULA (webhook-system loglarından derlenen yerel kayıt) ---
const lookupInput = document.getElementById('lookupInput');
const lookupBtn = document.getElementById('lookupBtn');
const lookupResult = document.getElementById('lookupResult');
const lookupEmpty = document.getElementById('lookupEmpty');
const acCallBtn = document.getElementById('acCallBtn');
const acCallCountRow = document.getElementById('acCallCountRow');
const acCall1xBtn = document.getElementById('acCall1xBtn');
const acCall2xBtn = document.getElementById('acCall2xBtn');
const acCall3xBtn = document.getElementById('acCall3xBtn');
const acCallStatus = document.getElementById('acCallStatus');
const acCallForceBtn = document.getElementById('acCallForceBtn');
const fgBanRow = document.getElementById('fgBanRow');
const fgBanBtn = document.getElementById('fgBanBtn');
const fgOfflineBanBtn = document.getElementById('fgOfflineBanBtn');
const fgBanReasonRow = document.getElementById('fgBanReasonRow');
const fgBanReasonInput = document.getElementById('fgBanReasonInput');
const fgBanSendBtn = document.getElementById('fgBanSendBtn');
const fgBanCancelBtn = document.getElementById('fgBanCancelBtn');
const fgBanStatus = document.getElementById('fgBanStatus');
let currentLookupResult = null;

function addLookupRow(label, value) {
    if (!value) return;
    const row = document.createElement('div');
    row.className = 'lookup-row';
    row.style.cursor = 'pointer';
    row.title = 'Kopyalamak için tıkla';
    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    const valueSpan = document.createElement('span');
    valueSpan.textContent = value;
    row.append(labelSpan, valueSpan);
    row.addEventListener('click', () => {
        clipboard.writeText(value);
        const original = valueSpan.textContent;
        valueSpan.textContent = 'Kopyalandı!';
        setTimeout(() => {
            valueSpan.textContent = original;
        }, 1000);
    });
    lookupResult.appendChild(row);
}

function runLookup() {
    const query = lookupInput.value.trim();
    if (!query) return;
    lookupResult.style.display = 'none';
    lookupEmpty.style.display = 'block';
    lookupEmpty.textContent = 'Aranıyor... (yerel kayıtta yoksa kanal geçmişi taranıyor, birkaç saniye sürebilir)';
    lookupBtn.disabled = true;
    ipcRenderer.send('lookup-player', query);
}

lookupBtn.addEventListener('click', runLookup);
lookupInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runLookup();
});

ipcRenderer.on('lookup-player-result', (event, { result }) => {
    lookupBtn.disabled = false;
    lookupResult.innerHTML = '';
    currentLookupResult = result;
    acCallSending = false;
    acCallStatus.style.display = 'none';
    acCallCountRow.style.display = 'none';
    acCallForceBtn.style.display = 'none';
    fgBanSending = false;
    pendingFgBanType = null;
    fgBanRow.style.display = 'none';
    fgBanReasonRow.style.display = 'none';
    fgBanStatus.style.display = 'none';
    if (!result) {
        lookupResult.style.display = 'none';
        lookupEmpty.textContent = 'Kayıt bulunamadı.';
        lookupEmpty.style.display = 'block';
        acCallBtn.style.display = 'none';
        return;
    }
    lookupEmpty.style.display = 'none';
    if (result.staleNote) {
        const warning = document.createElement('p');
        warning.className = 'hint';
        warning.style.color = 'var(--warn)';
        warning.textContent = `⚠️ ${result.staleNote}`;
        lookupResult.appendChild(warning);
    }
    addLookupRow('Oyun İçi ID', result.playerId);
    addLookupRow('İsim', result.name);
    addLookupRow('Steam', result.steam);
    addLookupRow('Discord', result.discord);
    addLookupRow('License', result.license);
    addLookupRow('IP', result.ip);
    addLookupRow('Log ID', result.logId);
    addLookupRow('Rapor Türü', result.title);
    addLookupRow('Rapor Sayısı', String(result.reportCount || 1));
    if (result.lastSeenAt) {
        addLookupRow('Son Görülme', new Date(result.lastSeenAt).toLocaleString('tr-TR'));
    }
    lookupResult.style.display = 'block';
    acCallBtn.disabled = false;
    setButtonLabel(acCallBtn, 'AC Çağır');
    acCallBtn.style.display = 'flex';

    // "fg ban" oyun içi ID ister - kişi online değilse/ID bilinmiyorsa sadece
    // "fg offline-ban" (license ile) gösteriliyor.
    fgBanBtn.style.display = result.playerId ? 'flex' : 'none';
    fgOfflineBanBtn.style.display = 'flex';
    fgBanRow.style.display = 'flex';
});

acCallBtn.addEventListener('click', () => {
    acCallBtn.style.display = 'none';
    acCallForceBtn.style.display = 'none';
    acCallStatus.style.display = 'none';
    acCallCountRow.style.display = 'flex';
});

let acCallSending = false;
let lastAcCallCount = 1;

function runAcCall(count, force) {
    if (!currentLookupResult || acCallSending) return;
    acCallSending = true;
    lastAcCallCount = count;
    acCallForceBtn.style.display = 'none';
    acCallCountRow.style.display = 'none';
    acCallStatus.style.display = 'block';
    acCallStatus.style.color = '';
    acCallStatus.textContent = 'Gönderiliyor...';
    ipcRenderer.send('ac-call', {
        discord: currentLookupResult.discord,
        license: currentLookupResult.license,
        playerId: currentLookupResult.playerId,
        name: currentLookupResult.name,
        count,
        force,
    });
}

acCall1xBtn.addEventListener('click', () => runAcCall(1));
acCall2xBtn.addEventListener('click', () => runAcCall(2));
acCall3xBtn.addEventListener('click', () => runAcCall(3));
acCallForceBtn.addEventListener('click', () => runAcCall(lastAcCallCount, true));

ipcRenderer.on('ac-call-result', (event, result) => {
    acCallSending = false;
    acCallStatus.style.display = 'block';

    // Başka biri (ya da aynı kişi) bu oyuncuyu son 5 dakikada zaten çağırmış -
    // gönderme, kullanıcıya sor. "Yine de Gönder" force:true ile tekrar dener.
    if (result.reason === 'recent-call') {
        acCallStatus.style.color = 'var(--warn)';
        acCallStatus.textContent = `⚠️ ${result.message}`;
        acCallForceBtn.style.display = 'flex';
        return;
    }

    // Tekrar çağırabilmek için (ör. cevap gelmezse 2x/3x ile tekrar) butonu geri getiriyoruz.
    acCallBtn.style.display = 'flex';
    acCallStatus.style.color = result.success ? 'var(--ok)' : 'var(--warn)';
    acCallStatus.textContent = `${result.success ? '✅' : '⚠️'} ${result.message}`;
});

// --- KİMLİK SORGULA: "fg ban" / "fg offline-ban" ---
let fgBanSending = false;
let pendingFgBanType = null;

function openFgBanReason(type) {
    pendingFgBanType = type;
    fgBanRow.style.display = 'none';
    fgBanStatus.style.display = 'none';
    fgBanReasonRow.style.display = 'flex';
    fgBanReasonInput.value = '';
    fgBanReasonInput.focus();
}

fgBanBtn.addEventListener('click', () => openFgBanReason('ban'));
fgOfflineBanBtn.addEventListener('click', () => openFgBanReason('offline-ban'));

fgBanCancelBtn.addEventListener('click', () => {
    fgBanReasonRow.style.display = 'none';
    fgBanRow.style.display = 'flex';
    pendingFgBanType = null;
});

function submitFgBan() {
    if (!currentLookupResult || fgBanSending || !pendingFgBanType) return;
    const reason = fgBanReasonInput.value.trim();
    if (!reason) {
        fgBanReasonInput.focus();
        return;
    }
    fgBanSending = true;
    fgBanReasonRow.style.display = 'none';
    fgBanStatus.style.display = 'block';
    fgBanStatus.style.color = '';
    fgBanStatus.textContent = 'Gönderiliyor...';
    ipcRenderer.send('lookup-fg-ban', {
        type: pendingFgBanType,
        playerId: currentLookupResult.playerId,
        license: currentLookupResult.license,
        reason,
    });
}

fgBanSendBtn.addEventListener('click', submitFgBan);
fgBanReasonInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitFgBan();
});

ipcRenderer.on('lookup-fg-ban-result', (event, result) => {
    fgBanSending = false;
    pendingFgBanType = null;
    fgBanRow.style.display = 'flex';
    fgBanStatus.style.display = 'block';
    fgBanStatus.style.color = result.success ? 'var(--ok)' : 'var(--warn)';
    fgBanStatus.textContent = `${result.success ? '✅' : '⚠️'} ${result.message}`;
});

// --- AKTİF TARAMA / İPTAL KUTUCUKLARI ---
const activeScansCard = document.getElementById('activeScansCard');
const activeScansList = document.getElementById('activeScansList');

function updateActiveScansVisibility() {
    activeScansCard.style.display = activeScansList.children.length > 0 ? 'block' : 'none';
}

function addActiveScanRow(code) {
    if (document.getElementById(`scan-row-${code}`)) return;

    const row = document.createElement('div');
    row.id = `scan-row-${code}`;
    row.className = 'scan-row';

    const label = document.createElement('span');
    label.className = 'code';
    label.textContent = code;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel-btn';
    cancelBtn.innerHTML = `${iconHtml('x')}<span>İptal Et</span>`;
    cancelBtn.addEventListener('click', () => {
        ipcRenderer.send('cancel-scan', code);
        row.remove();
        updateActiveScansVisibility();
    });

    row.appendChild(label);
    row.appendChild(cancelBtn);
    activeScansList.appendChild(row);
    updateActiveScansVisibility();
}

function removeActiveScanRow(code) {
    const row = document.getElementById(`scan-row-${code}`);
    if (row) row.remove();
    updateActiveScansVisibility();
}

ipcRenderer.on('scan-started', (event, { code }) => addActiveScanRow(code));
ipcRenderer.on('scan-ended', (event, { code }) => removeActiveScanRow(code));

// --- AKTİF TICKETLAR (Kontrol / Ban / Beklet) ---
const ticketsCard = document.getElementById('ticketsCard');
const ticketsList = document.getElementById('ticketsList');
const idleState = document.getElementById('idleState');

function updateTicketsVisibility() {
    const hasTickets = ticketsList.children.length > 0;
    ticketsCard.style.display = hasTickets ? 'block' : 'none';
    idleState.style.display = hasTickets ? 'none' : 'flex';
}

function setKontrolButtonState(btn, channelId, code) {
    if (code) {
        btn.innerHTML = `${iconHtml('x')}<span>İptal (${code})</span>`;
        btn.classList.add('active');
        btn.onclick = () => ipcRenderer.send('ticket-cancel', channelId);
    } else {
        btn.innerHTML = `${iconHtml('radar')}<span>Kontrol</span>`;
        btn.classList.remove('active');
        btn.onclick = () => ipcRenderer.send('ticket-kontrol', channelId);
    }
}

function setHoldButtonState(btn, channelId, held) {
    btn.innerHTML = held ? `${iconHtml('play')}<span>Kaldır</span>` : `${iconHtml('pause')}<span>Beklet</span>`;
    btn.classList.toggle('active', held);
    btn.onclick = () => ipcRenderer.send('ticket-hold', channelId);
}

let banReasonOpenFor = null; // sebep girilirken ticket listesinin yenilenip alanı silmesini önler

function toggleBanReasonRow(card, channelId, stage) {
    const existing = card.querySelector('.ban-reason-row');
    if (existing) {
        existing.remove();
        banReasonOpenFor = null;
        return;
    }

    banReasonOpenFor = channelId;

    const row = document.createElement('div');
    row.className = 'ban-reason-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Ban sebebi (örn: 3.p-dilber)';
    input.className = 'ban-reason-input';

    const sendBtn = document.createElement('button');
    sendBtn.className = 'ticket-btn ban-btn';
    sendBtn.innerHTML = `${iconHtml('check')}<span>Gönder</span>`;
    const submit = () => {
        if (!input.value.trim()) {
            input.focus();
            return;
        }
        const channel = stage === 'second' ? 'ticket-ban-confirm' : 'ticket-ban';
        ipcRenderer.send(channel, { channelId, reason: input.value.trim() });
        row.remove();
        banReasonOpenFor = null;
    };
    sendBtn.onclick = submit;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ticket-btn';
    cancelBtn.innerHTML = iconHtml('x');
    cancelBtn.setAttribute('aria-label', 'İptal');
    cancelBtn.onclick = () => {
        row.remove();
        banReasonOpenFor = null;
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
    });

    row.appendChild(input);
    row.appendChild(sendBtn);
    row.appendChild(cancelBtn);
    card.appendChild(row);
    input.focus();
}

function toggleCloseConfirmRow(card, channelId) {
    const existing = card.querySelector('.close-confirm-row');
    if (existing) {
        existing.remove();
        banReasonOpenFor = null;
        return;
    }

    banReasonOpenFor = channelId;

    const row = document.createElement('div');
    row.className = 'close-confirm-row';

    const label = document.createElement('span');
    label.className = 'close-confirm-label';
    label.textContent = 'Ticket silinecek, emin misin?';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'ticket-btn ban-btn';
    confirmBtn.innerHTML = `${iconHtml('check')}<span>Evet, Kapat</span>`;
    confirmBtn.onclick = () => {
        ipcRenderer.send('ticket-close', channelId);
        row.remove();
        banReasonOpenFor = null;
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ticket-btn';
    cancelBtn.innerHTML = iconHtml('x');
    cancelBtn.setAttribute('aria-label', 'Vazgeç');
    cancelBtn.onclick = () => {
        row.remove();
        banReasonOpenFor = null;
    };

    row.appendChild(label);
    row.appendChild(confirmBtn);
    row.appendChild(cancelBtn);
    card.appendChild(row);
}

function renderTicketCard(ticket) {
    const card = document.createElement('div');
    card.className = 'ticket-card' + (ticket.flagged ? ' flagged' : '');
    card.id = `ticket-${ticket.id}`;

    const nameEl = document.createElement('div');
    nameEl.className = 'ticket-name';
    nameEl.textContent = ticket.name;
    if (ticket.flagged) {
        const badge = document.createElement('span');
        badge.className = 'flag-badge';
        badge.innerHTML = `${iconHtml('alert')}<span>Hileci</span>`;
        nameEl.appendChild(badge);
    }
    card.appendChild(nameEl);

    const actions = document.createElement('div');
    actions.className = 'ticket-actions';

    if (!ticket.claimed) {
        const claimBtn = document.createElement('button');
        claimBtn.className = 'ticket-btn claim-btn';
        claimBtn.innerHTML = `${iconHtml('flag')}<span>Claim</span>`;
        claimBtn.onclick = () => ipcRenderer.send('ticket-claim', ticket.id);
        actions.appendChild(claimBtn);
    } else {
        const kontrolBtn = document.createElement('button');
        kontrolBtn.className = 'ticket-btn kontrol-btn';
        setKontrolButtonState(kontrolBtn, ticket.id, ticket.scanCode);
        actions.appendChild(kontrolBtn);

        const banBtn = document.createElement('button');
        banBtn.className = 'ticket-btn ban-btn' + (ticket.banStage === 'second' ? ' active' : '');
        banBtn.innerHTML = `${iconHtml('ban')}<span>Ban</span>`;
        banBtn.onclick = () => toggleBanReasonRow(card, ticket.id, ticket.banStage);
        actions.appendChild(banBtn);

        const holdBtn = document.createElement('button');
        holdBtn.className = 'ticket-btn hold-btn';
        setHoldButtonState(holdBtn, ticket.id, ticket.held);
        actions.appendChild(holdBtn);

        if (ticket.resultUrl) {
            const verdictKey = String(ticket.resultVerdict || '').toLowerCase();
            const verdictClass = verdictKey === 'cheating' ? 'danger' : verdictKey === 'warn' ? 'warn' : verdictKey === 'clean' ? 'ok' : 'neutral';
            const sonucBtn = document.createElement('button');
            sonucBtn.className = `ticket-btn sonuc-btn sonuc-${verdictClass}`;
            sonucBtn.innerHTML = `${iconHtml('external')}<span>Sonuç</span>`;
            sonucBtn.onclick = () => shell.openExternal(ticket.resultUrl);
            actions.appendChild(sonucBtn);
        }
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ticket-btn close-btn';
    closeBtn.innerHTML = `${iconHtml('trash')}<span>Kapat</span>`;
    closeBtn.onclick = () => toggleCloseConfirmRow(card, ticket.id);
    actions.appendChild(closeBtn);

    card.appendChild(actions);
    return card;
}

function renderTicketList(tickets) {
    if (banReasonOpenFor) return; // sebep girilirken listeyi yenileyip alanı silme
    ticketsList.innerHTML = '';
    tickets.forEach((ticket) => ticketsList.appendChild(renderTicketCard(ticket)));
    updateTicketsVisibility();
}

ipcRenderer.on('ticket-list', (event, tickets) => renderTicketList(tickets));

ipcRenderer.on('ticket-scan-started', (event, { channelId, code }) => {
    const card = document.getElementById(`ticket-${channelId}`);
    const btn = card?.querySelector('.kontrol-btn');
    if (btn) setKontrolButtonState(btn, channelId, code);
});

ipcRenderer.on('ticket-scan-ended', (event, { channelId }) => {
    const card = document.getElementById(`ticket-${channelId}`);
    const btn = card?.querySelector('.kontrol-btn');
    if (btn) setKontrolButtonState(btn, channelId, null);
});

ipcRenderer.on('ticket-hold-changed', (event, { channelId, held }) => {
    const card = document.getElementById(`ticket-${channelId}`);
    const btn = card?.querySelector('.hold-btn');
    if (btn) setHoldButtonState(btn, channelId, held);
});

ipcRenderer.send('request-ticket-list');

// --- MOBİL ERİŞİM LİNKİ ---
const mobileUrlField = document.getElementById('mobileUrlField');
const copyMobileUrlBtn = document.getElementById('copyMobileUrlBtn');

ipcRenderer.on('mobile-url', (event, url) => {
    mobileUrlField.value = url;
});

function setButtonLabel(btn, text) {
    const label = btn.querySelector('.label');
    if (label) label.textContent = text;
    else btn.textContent = text;
}

copyMobileUrlBtn.addEventListener('click', () => {
    if (!mobileUrlField.value || mobileUrlField.value === 'Bağlanılıyor...') return;
    clipboard.writeText(mobileUrlField.value);
    setButtonLabel(copyMobileUrlBtn, 'Kopyalandı!');
    setTimeout(() => setButtonLabel(copyMobileUrlBtn, 'Linki Kopyala'), 1500);
});

// --- TARAMA MESAJI ---
const scanMessageInput = document.getElementById('scanMessageInput');
const saveScanMessageBtn = document.getElementById('saveScanMessageBtn');

ipcRenderer.on('scan-message', (event, text) => {
    scanMessageInput.value = text || '';
});

saveScanMessageBtn.addEventListener('click', () => {
    ipcRenderer.send('set-scan-message', scanMessageInput.value);
    setButtonLabel(saveScanMessageBtn, 'Kaydedildi!');
    setTimeout(() => setButtonLabel(saveScanMessageBtn, 'Mesajı Kaydet'), 1500);
});

ipcRenderer.send('request-scan-message');

// --- BAN MESAJI ---
const banMessageInput = document.getElementById('banMessageInput');
const saveBanMessageBtn = document.getElementById('saveBanMessageBtn');

ipcRenderer.on('ban-message', (event, text) => {
    banMessageInput.value = text || '';
});

saveBanMessageBtn.addEventListener('click', () => {
    ipcRenderer.send('set-ban-message', banMessageInput.value);
    setButtonLabel(saveBanMessageBtn, 'Kaydedildi!');
    setTimeout(() => setButtonLabel(saveBanMessageBtn, 'Mesajı Kaydet'), 1500);
});

ipcRenderer.send('request-ban-message');

// --- AC ÇAĞIR MESAJLARI ---
const acMessageInput = document.getElementById('acMessageInput');
const acTicketMessageInput = document.getElementById('acTicketMessageInput');
const saveAcMessagesBtn = document.getElementById('saveAcMessagesBtn');

ipcRenderer.on('ac-message', (event, text) => {
    acMessageInput.value = text || '';
});

ipcRenderer.on('ac-ticket-message', (event, text) => {
    acTicketMessageInput.value = text || '';
});

saveAcMessagesBtn.addEventListener('click', () => {
    ipcRenderer.send('set-ac-message', acMessageInput.value);
    ipcRenderer.send('set-ac-ticket-message', acTicketMessageInput.value);
    setButtonLabel(saveAcMessagesBtn, 'Kaydedildi!');
    setTimeout(() => setButtonLabel(saveAcMessagesBtn, 'Mesajları Kaydet'), 1500);
});

ipcRenderer.send('request-ac-message');
ipcRenderer.send('request-ac-ticket-message');

// --- ŞÜPHELİ AKTİVİTE BİLDİRİMİ AÇMA/KAPAMA ---
const suspiciousNotifyToggle = document.getElementById('suspiciousNotifyToggle');

ipcRenderer.on('suspicious-notify-status', (event, status) => {
    suspiciousNotifyToggle.checked = status;
});

suspiciousNotifyToggle.addEventListener('change', (e) => {
    ipcRenderer.send('toggle-suspicious-notify', e.target.checked);
});

ipcRenderer.send('request-suspicious-notify-status');

// --- WINDOWS AÇILIŞINDA OTOMATİK BAŞLATMA ---
const openAtLoginToggle = document.getElementById('openAtLoginToggle');

ipcRenderer.on('open-at-login-status', (event, status) => {
    openAtLoginToggle.checked = status;
});

openAtLoginToggle.addEventListener('change', (e) => {
    ipcRenderer.send('toggle-open-at-login', e.target.checked);
});

ipcRenderer.send('request-open-at-login-status');

ipcRenderer.send('request-mobile-url');

// --- SÜRÜM NUMARASI ---
const versionLabel = document.getElementById('versionLabel');

ipcRenderer.on('app-version', (event, version) => {
    versionLabel.textContent = `v${version}`;
});

ipcRenderer.send('request-app-version');

// --- AYARLAR GÖRÜNÜMÜ (dişli / geri) ---
const mainView = document.getElementById('mainView');
const settingsView = document.getElementById('settingsView');
const settingsBtn = document.getElementById('settingsBtn');
const backBtn = document.getElementById('backBtn');

settingsBtn.addEventListener('click', () => {
    mainView.style.display = 'none';
    settingsView.style.display = 'block';
    ipcRenderer.send('request-debug-log');
});

backBtn.addEventListener('click', () => {
    settingsView.style.display = 'none';
    mainView.style.display = 'block';
});

// --- HESAP & SUNUCU AYARLARI ---
const ACCOUNT_FIELDS = ['USER_TOKEN', 'NEXORA_API_KEY', 'LOG_CHANNEL_ID', 'CATEGORY_ID', 'ANTICHEAT_ROLE_ID', 'IGNORED_IDS'];
const accountErrorBox = document.getElementById('accountErrorBox');
const saveAccountBtn = document.getElementById('saveAccountBtn');

ipcRenderer.on('account-settings', (event, values) => {
    ACCOUNT_FIELDS.forEach((key) => {
        const el = document.getElementById(key);
        if (el) el.value = values[key] || '';
    });
});

saveAccountBtn.addEventListener('click', () => {
    const values = {};
    ACCOUNT_FIELDS.forEach((key) => {
        values[key] = document.getElementById(key).value.trim();
    });
    accountErrorBox.style.display = 'none';
    saveAccountBtn.disabled = true;
    setButtonLabel(saveAccountBtn, 'Kaydediliyor...');
    ipcRenderer.send('save-setup', values);
});

ipcRenderer.on('setup-error', (event, message) => {
    accountErrorBox.textContent = message;
    accountErrorBox.style.display = 'block';
    saveAccountBtn.disabled = false;
    setButtonLabel(saveAccountBtn, 'Kaydet ve Yeniden Başlat');
});

ipcRenderer.send('request-account-settings');

// --- LOG GÖRÜNTÜLEME ---
const debugLogView = document.getElementById('debugLogView');
const refreshLogBtn = document.getElementById('refreshLogBtn');
const openLogFolderBtn = document.getElementById('openLogFolderBtn');

ipcRenderer.on('debug-log', (event, text) => {
    debugLogView.textContent = text || '(log boş)';
    debugLogView.scrollTop = debugLogView.scrollHeight;
});

refreshLogBtn.addEventListener('click', () => ipcRenderer.send('request-debug-log'));
openLogFolderBtn.addEventListener('click', () => ipcRenderer.send('open-debug-log-folder'));

ipcRenderer.send('request-debug-log');

// --- SİSTEM DURUMU ---
const statusDots = {
    discord: document.getElementById('statusDiscordDot'),
    nexora: document.getElementById('statusNexoraDot'),
    mobile: document.getElementById('statusMobileDot')
};
const statusTexts = {
    discord: document.getElementById('statusDiscordText'),
    nexora: document.getElementById('statusNexoraText'),
    mobile: document.getElementById('statusMobileText')
};

function setStatusRow(key, level, text) {
    statusDots[key].className = `status-dot ${level}`;
    statusTexts[key].textContent = text;
}

ipcRenderer.on('system-status', (event, status) => {
    setStatusRow(
        'discord',
        status.discord === 'bağlı' ? 'ok' : status.discord === 'hata' ? 'danger' : 'warn',
        status.discord === 'bağlı' ? 'Bağlı' : status.discord === 'hata' ? 'Bağlantı hatası' : 'Bağlanıyor...'
    );
    setStatusRow(
        'nexora',
        status.nexora === 'sağlıklı' ? 'ok' : status.nexora === 'sorunlu' ? 'danger' : 'warn',
        status.nexora === 'sağlıklı' ? 'Sağlıklı' : status.nexora === 'sorunlu' ? 'Sorunlu' : 'Kontrol ediliyor...'
    );
    setStatusRow('mobile', status.mobile ? 'ok' : 'warn', status.mobile ? 'Aktif' : 'Başlatılıyor...');
});

ipcRenderer.send('request-system-status');

// --- OSİLOSKOP TEMASI: MATRIX YAĞMURU ARKA PLANI ---
function createMatrixRain(canvas) {
    const ctx = canvas.getContext('2d');
    const fontSize = 15;
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';
    let columns = 0;
    let drops = [];

    function resize() {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
        columns = Math.max(1, Math.floor(canvas.width / fontSize));
        drops = Array.from({ length: columns }, () => Math.random() * -40);
    }
    resize();
    window.addEventListener('resize', resize);

    let running = false;
    let rafId = null;
    let lastTime = 0;

    function frame(time) {
        if (!running) return;
        rafId = requestAnimationFrame(frame);
        if (time - lastTime < 45) return;
        lastTime = time;

        ctx.fillStyle = 'rgba(9, 11, 10, 0.15)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = `${fontSize}px "Cascadia Mono", Consolas, monospace`;

        for (let i = 0; i < columns; i++) {
            const x = i * fontSize;
            const y = drops[i] * fontSize;

            ctx.fillStyle = '#eafff6';
            ctx.fillText(chars[(Math.random() * chars.length) | 0], x, y);
            ctx.fillStyle = '#49e6ba';
            ctx.fillText(chars[(Math.random() * chars.length) | 0], x, y - fontSize);

            if (y > canvas.height && Math.random() > 0.975) drops[i] = 0;
            drops[i]++;
        }
    }

    return {
        start() {
            if (running) return;
            running = true;
            lastTime = 0;
            rafId = requestAnimationFrame(frame);
        },
        stop() {
            running = false;
            if (rafId) cancelAnimationFrame(rafId);
        }
    };
}

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const matrixCanvasEl = document.getElementById('matrixCanvas');
const matrixRain = matrixCanvasEl ? createMatrixRain(matrixCanvasEl) : null;

// --- GÖRÜNÜM (TEMA SEÇİMİ) ---
const THEME_STORAGE_KEY = 'nexora_theme';
const themeButtons = document.querySelectorAll('.theme-btn');

function applyTheme(theme) {
    document.body.dataset.theme = theme;
    themeButtons.forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
    if (matrixRain) {
        if (theme === 'a' && !prefersReducedMotion) matrixRain.start();
        else matrixRain.stop();
    }
}

applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || 'a');

themeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
        localStorage.setItem(THEME_STORAGE_KEY, btn.dataset.theme);
        applyTheme(btn.dataset.theme);
    });
});