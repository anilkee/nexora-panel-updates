const { ipcRenderer, clipboard, shell } = require('electron');
const path = require('path');

function iconHtml(name) {
    return `<svg class="icon"><use href="#icon-${name}"></use></svg>`;
}

// --- ÖZEL BAŞLIK ÇUBUĞU (frame:false, native pencere butonları yok) ---
document.getElementById('minimizeBtn')?.addEventListener('click', () => ipcRenderer.send('window-minimize'));
document.getElementById('closeAppBtn')?.addEventListener('click', () => ipcRenderer.send('window-close'));

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
const acSpamBtn = document.getElementById('acSpamBtn');
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
    acSpamSending = false;
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
        acSpamBtn.style.display = 'none';
        return;
    }
    lookupEmpty.style.display = 'none';
    if (result.banned) {
        const warning = document.createElement('p');
        warning.className = 'hint';
        warning.style.color = 'var(--danger)';
        warning.textContent = '🚫 Bu kişi Fiveguard tarafından banlı!';
        lookupResult.appendChild(warning);
    }
    addLookupRow('Oyun İçi ID', result.playerId);
    addLookupRow('Steam İsmi', result.name);
    addLookupRow('Steam', result.steam);
    addLookupRow('Discord', result.discord);
    addLookupRow('License', result.license);
    addLookupRow('Oyunda mı?', result.online === null || result.online === undefined ? null : (result.online ? 'Evet' : 'Hayır'));
    addLookupRow('FG Banlı mı?', result.banned === null || result.banned === undefined ? null : (result.banned ? 'Evet' : 'Hayır'));
    if (result.lastSeenAt) {
        addLookupRow('Sorgu Zamanı', new Date(result.lastSeenAt).toLocaleString('tr-TR'));
    }
    lookupResult.style.display = 'block';
    acCallBtn.disabled = false;
    setButtonLabel(acCallBtn, 'AC Çağır');
    acCallBtn.style.display = 'flex';
    // Spam da "/dm-player" kullanıyor - o yüzden AYNI şart (oyun içi ID) geçerli.
    acSpamBtn.style.display = result.playerId ? 'flex' : 'none';

    // "fg ban" oyun içi ID ister - kişi online değilse/ID bilinmiyorsa sadece
    // "fg offline-ban" (license ile) gösteriliyor.
    fgBanBtn.style.display = result.playerId ? 'flex' : 'none';
    fgOfflineBanBtn.style.display = 'flex';
    fgBanRow.style.display = 'flex';
});

acCallBtn.addEventListener('click', () => {
    acCallBtn.style.display = 'none';
    acSpamBtn.style.display = 'none';
    acCallForceBtn.style.display = 'none';
    acCallStatus.style.display = 'none';
    acCallCountRow.style.display = 'flex';
});

let acCallSending = false;
let acSpamSending = false;
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
    acSpamBtn.style.display = currentLookupResult && currentLookupResult.playerId ? 'flex' : 'none';
    acCallStatus.style.color = result.success ? 'var(--ok)' : 'var(--warn)';
    acCallStatus.textContent = `${result.success ? '✅' : '⚠️'} ${result.message}`;
});

acSpamBtn.addEventListener('click', () => {
    if (!currentLookupResult || acSpamSending) return;
    acSpamSending = true;
    acCallBtn.style.display = 'none';
    acSpamBtn.style.display = 'none';
    acCallForceBtn.style.display = 'none';
    acCallCountRow.style.display = 'none';
    acCallStatus.style.display = 'block';
    acCallStatus.style.color = '';
    acCallStatus.textContent = '10 mesaj gönderiliyor...';
    ipcRenderer.send('ac-call-spam', {
        discord: currentLookupResult.discord,
        license: currentLookupResult.license,
        playerId: currentLookupResult.playerId,
        name: currentLookupResult.name,
    });
});

ipcRenderer.on('ac-call-spam-result', (event, result) => {
    acSpamSending = false;
    acCallStatus.style.display = 'block';
    acCallBtn.style.display = 'flex';
    acSpamBtn.style.display = currentLookupResult && currentLookupResult.playerId ? 'flex' : 'none';
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

// "Kontrol Red" - kişi kontrolü reddettiğinde AC ekibi #kontrol-log'a "<id> | Kontrol red" +
// ekran görüntüsü yazıyordu. Ekran görüntüsü oyun/telefon tarafından geldiği için bot onu kendisi
// üretemez; kullanıcı "panele yapıştırayım" dedi - bu satır Ctrl+V ile resmi alıp gönderiyor.
function toggleKontrolRedRow(card, channelId) {
    const existing = card.querySelector('.kontrol-red-row');
    if (existing) {
        existing.remove();
        banReasonOpenFor = null;
        return;
    }

    // Ban sebebi satırıyla AYNI kilit kullanılıyor - alan açıkken ticket listesi yenilenip
    // yapıştırılmış görüntüyü silmesin diye.
    banReasonOpenFor = channelId;

    const row = document.createElement('div');
    row.className = 'kontrol-red-row';

    const pasteBox = document.createElement('div');
    pasteBox.className = 'kontrol-red-paste';
    pasteBox.tabIndex = 0;
    pasteBox.textContent = 'Ekran görüntüsünü buraya yapıştır (Ctrl+V)';

    let imageDataUrl = null;

    const preview = document.createElement('img');
    preview.className = 'kontrol-red-preview';
    preview.style.display = 'none';

    const setImage = (dataUrl) => {
        imageDataUrl = dataUrl;
        preview.src = dataUrl;
        preview.style.display = 'block';
        pasteBox.textContent = 'Görüntü eklendi - değiştirmek için tekrar yapıştır';
        pasteBox.classList.add('has-image');
    };

    const readImageFile = (file) => {
        const reader = new FileReader();
        reader.onload = () => setImage(reader.result);
        reader.readAsDataURL(file);
    };

    pasteBox.addEventListener('paste', (e) => {
        const items = (e.clipboardData && e.clipboardData.items) || [];
        for (const item of items) {
            if (item.type && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    readImageFile(file);
                    e.preventDefault();
                    return;
                }
            }
        }
    });

    // Sürükle-bırak da çalışsın (dosyayı sürükleyip bırakmak yapıştırmaktan kolay olabiliyor).
    pasteBox.addEventListener('dragover', (e) => { e.preventDefault(); pasteBox.classList.add('dragging'); });
    pasteBox.addEventListener('dragleave', () => pasteBox.classList.remove('dragging'));
    pasteBox.addEventListener('drop', (e) => {
        e.preventDefault();
        pasteBox.classList.remove('dragging');
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) readImageFile(file);
    });

    const sendBtn = document.createElement('button');
    sendBtn.className = 'ticket-btn ban-btn';
    sendBtn.innerHTML = `${iconHtml('check')}<span>Gönder</span>`;
    sendBtn.onclick = () => {
        // Görüntü ZORUNLU DEĞİL - bazen elde ekran görüntüsü olmayabilir, kayıt yine de düşsün.
        ipcRenderer.send('ticket-kontrol-red', { channelId, imageDataUrl });
        row.remove();
        banReasonOpenFor = null;
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ticket-btn';
    cancelBtn.innerHTML = iconHtml('x');
    cancelBtn.setAttribute('aria-label', 'İptal');
    cancelBtn.onclick = () => {
        row.remove();
        banReasonOpenFor = null;
    };

    row.appendChild(pasteBox);
    row.appendChild(preview);
    row.appendChild(sendBtn);
    row.appendChild(cancelBtn);
    card.appendChild(row);
    pasteBox.focus();
}

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

        const kontrolRedBtn = document.createElement('button');
        kontrolRedBtn.className = 'ticket-btn kontrol-red-btn';
        kontrolRedBtn.innerHTML = `${iconHtml('x')}<span>Kontrol Red</span>`;
        kontrolRedBtn.onclick = () => toggleKontrolRedRow(card, ticket.id);
        actions.appendChild(kontrolRedBtn);

        const holdBtn = document.createElement('button');
        holdBtn.className = 'ticket-btn hold-btn';
        setHoldButtonState(holdBtn, ticket.id, ticket.held);
        actions.appendChild(holdBtn);

        if (ticket.channelUrl) {
            const openBtn = document.createElement('button');
            openBtn.className = 'ticket-btn open-btn';
            openBtn.innerHTML = `${iconHtml('discord')}<span>Discord'da Aç</span>`;
            openBtn.onclick = () => shell.openExternal(ticket.channelUrl);
            actions.appendChild(openBtn);
        }

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

let lastTicketsSnapshot = [];

function renderTicketList(tickets) {
    if (banReasonOpenFor) return; // sebep girilirken listeyi yenileyip alanı silme
    lastTicketsSnapshot = tickets;
    ticketsList.innerHTML = '';
    tickets.forEach((ticket) => ticketsList.appendChild(renderTicketCard(ticket)));
    updateTicketsVisibility();
    // Liste + Detay yerleşimi: sol kompakt liste + sadece seçili kartın görünmesi. Klasik/Yan
    // Panel'de bu iki fonksiyon da zararsız (CSS zaten #ldTicketList'i ve .detail-active
    // filtresini sadece data-layout="list-detail" iken devreye sokuyor).
    renderCompactTicketList(tickets);
    applyDetailSelection();
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

ipcRenderer.on('kontrol-red-result', (event, result) => {
    // Sonuç bilgisi ticket kartı yenilenmiş olabileceği için kartta değil, kısa bir
    // bildirim olarak gösteriliyor (main.js zaten Windows bildirimi de gönderiyor).
    console.log('[Kontrol Red]', result.message);
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

// --- FIVEGUARD BİLDİRİMİ AÇMA/KAPAMA ---
const fiveguardNotifyToggle = document.getElementById('fiveguardNotifyToggle');

ipcRenderer.on('fiveguard-notify-status', (event, status) => {
    fiveguardNotifyToggle.checked = status;
});

fiveguardNotifyToggle.addEventListener('change', (e) => {
    ipcRenderer.send('toggle-fiveguard-notify', e.target.checked);
});

ipcRenderer.send('request-fiveguard-notify-status');

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

// --- BÖLÜM GEÇİŞİ (tickets / lookup / status / settings) ---
// Tek bir kaynak: body[data-section]. Görünürlük tamamen CSS'te (.section-block kuralları,
// bkz. index.html <style>) - burada ASLA .style.display kullanılmıyor, çünkü inline style
// 3 yerleşim modunun (classic/sidebar/list-detail) hepsinde aynı elemanları paylaşıyor ve
// inline style CSS kurallarının önüne geçip layout değiştirince "takılı kalmış" görünürlük
// bug'ına yol açardı. Aynı fonksiyon; klasikteki dişli/geri, yan paneldeki ikonlar ve
// liste+detay'daki sekmelerin HEPSİ tarafından kullanılıyor (hepsi ".nav-target").
const SECTION_NAMES = ['tickets', 'lookup', 'history', 'status', 'chat', 'settings'];

function setActiveSection(name) {
    if (!SECTION_NAMES.includes(name)) name = 'tickets';
    document.body.dataset.section = name;
    document.querySelectorAll('.nav-target').forEach((el) => {
        el.classList.toggle('active', el.dataset.section === name);
    });
    if (name === 'settings') ipcRenderer.send('request-debug-log');
    if (name === 'history') ipcRenderer.send('request-lookup-history');
    // Sohbet sekmesine her girişte en alta kaydır - kullanıcı sekmeyi açtığında en son
    // mesajları görsün, geçmişin başında kalmasın. Ayrıca okunmamış rozetini sıfırla.
    if (name === 'chat') {
        scrollChatToBottom();
        unreadChatCount = 0;
        updateChatBadge();
    }
}

document.querySelectorAll('.nav-target').forEach((el) => {
    el.addEventListener('click', () => setActiveSection(el.dataset.section));
});

setActiveSection('tickets');

// --- SOHBET (botu kullanan herkesin birbiriyle konuştuğu, Discord'dan BAĞIMSIZ sistem) ---
// main.js'teki chatSocket (VDS'e WebSocket) üzerinden gelen olayları ('chat-event' IPC) çiziyor,
// yazılan mesajı 'chat-send' ile main.js'e gönderiyor. Kimlik (avatar+isim) main.js tarafında
// zaten giriş yapılmış Discord hesabından ekleniyor - burada elle bir şey yapmaya gerek yok.
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const chatOnlineHint = document.getElementById('chatOnlineHint');
const chatPresence = document.getElementById('chatPresence');

function scrollChatToBottom() {
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
}

function formatChatTime(ts) {
    try {
        return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    } catch (error) {
        return '';
    }
}

function appendChatMessage(msg) {
    if (!chatMessages) return;
    const emptyEl = chatMessages.querySelector('#chatEmpty');
    if (emptyEl) emptyEl.remove();

    const row = document.createElement('div');
    row.className = 'chat-message';

    const avatar = document.createElement('img');
    avatar.className = 'chat-avatar';
    avatar.src = msg.avatarUrl || '';
    avatar.alt = '';
    avatar.addEventListener('error', () => { avatar.style.visibility = 'hidden'; });

    const body = document.createElement('div');
    body.className = 'chat-message-body';

    const head = document.createElement('div');
    head.className = 'chat-message-head';
    const author = document.createElement('span');
    author.className = 'chat-message-author';
    author.textContent = msg.username || 'Bilinmeyen';
    const time = document.createElement('span');
    time.className = 'chat-message-time';
    time.textContent = formatChatTime(msg.timestamp);
    head.appendChild(author);
    head.appendChild(time);

    const text = document.createElement('div');
    text.className = 'chat-message-text';
    text.textContent = msg.text || '';

    body.appendChild(head);
    body.appendChild(text);
    row.appendChild(avatar);
    row.appendChild(body);
    chatMessages.appendChild(row);
}

function renderChatHistory(messages) {
    if (!chatMessages) return;
    chatMessages.innerHTML = '';
    if (!messages || messages.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'chat-empty';
        empty.id = 'chatEmpty';
        empty.textContent = 'Henüz mesaj yok.';
        chatMessages.appendChild(empty);
    } else {
        messages.forEach(appendChatMessage);
    }
    if (document.body.dataset.section === 'chat') scrollChatToBottom();
}

// O an sohbete bağlı olan herkesi avatar+isim rozeti olarak çiziyor (eskiden sadece
// "N kişi bağlı" metni vardı). Veri zaten sunucudan presence olayında avatarUrl ile
// birlikte geliyordu - burada gösterilmiyordu.
function renderChatPresence(users) {
    const list = Array.isArray(users) ? users : [];
    if (chatOnlineHint) {
        chatOnlineHint.textContent = list.length > 0 ? `${list.length} kişi bağlı` : 'Şu an kimse bağlı değil.';
    }
    if (!chatPresence) return;
    chatPresence.innerHTML = '';
    list.forEach((u) => {
        const item = document.createElement('div');
        item.className = 'chat-presence-item';

        const avatar = document.createElement('img');
        avatar.className = 'chat-presence-avatar';
        avatar.src = u.avatarUrl || '';
        avatar.alt = '';
        avatar.addEventListener('error', () => { avatar.style.visibility = 'hidden'; });

        const name = document.createElement('span');
        name.className = 'chat-presence-name';
        name.textContent = u.username || 'Bilinmeyen';

        item.appendChild(avatar);
        item.appendChild(name);
        chatPresence.appendChild(item);
    });
}

// --- Sohbet sekmesi AKTİF DEĞİLKEN gelen mesajlar için nav butonlarında (klasik dişli/sidebar
// ikonu/list-detail sekmesi - hepsi ".chat-nav-badge" taşıyor) küçük bir sayaç rozeti. Sekmeye
// girilince (setActiveSection) sıfırlanıyor.
let unreadChatCount = 0;
const chatNavBadges = document.querySelectorAll('.chat-nav-badge');

function updateChatBadge() {
    chatNavBadges.forEach((el) => {
        if (unreadChatCount > 0) {
            el.textContent = unreadChatCount > 9 ? '9+' : String(unreadChatCount);
            el.style.display = 'block';
        } else {
            el.style.display = 'none';
        }
    });
}

ipcRenderer.on('chat-event', (event, msg) => {
    if (!msg) return;
    if (msg.type === 'history') {
        renderChatHistory(msg.messages);
    } else if (msg.type === 'presence') {
        renderChatPresence(msg.users);
    } else if (msg.type === 'message') {
        appendChatMessage(msg);
        if (document.body.dataset.section === 'chat') {
            scrollChatToBottom();
        } else {
            unreadChatCount++;
            updateChatBadge();
        }
    }
});

function sendChatMessage() {
    if (!chatInput) return;
    const text = chatInput.value.trim();
    if (!text) return;
    ipcRenderer.send('chat-send', text);
    chatInput.value = '';
}

chatSendBtn?.addEventListener('click', sendChatMessage);
chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
});

// main.js WebSocket bağlantısı Discord girişinden hemen sonra kuruluyor - panel açılışında
// (kullanıcı sohbet sekmesine hiç girmese bile) mevcut geçmiş/online listesini isteyip
// önbelleğe alalım ki sekmeye ilk girildiğinde boş görünmesin.
ipcRenderer.send('request-chat-state');

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

// --- PANEL YERLEŞİMİ (klasik / yan panel / liste+detay) ---
// Tercih main.js'de config.env'e ("PANEL_LAYOUT") kalıcı olarak yazılıyor çünkü pencere
// BOYUTU da layout'a göre değişiyor (bkz. main.js PANEL_LAYOUT_SIZES) - bu, renderer henüz
// yüklenmeden main process'in ilk pencereyi doğru boyutta açabilmesi için gerekli (localStorage
// sadece renderer'da var, ilk açılış boyutuna yetişemez). Panel açıldığında main.js'e
// 'request-panel-layout' ile soruyoruz, o da kayıtlı değeri 'panel-layout' ile geri yolluyor.
const layoutButtons = document.querySelectorAll('.layout-btn');

function applyPanelLayout(layout) {
    if (!layout || !['classic', 'sidebar', 'list-detail'].includes(layout)) layout = 'classic';
    document.body.dataset.layout = layout;
    layoutButtons.forEach((b) => b.classList.toggle('active', b.dataset.layout === layout));
    // Yerleşim değişince o an seçili bölüm yeni yerleşimde de anlamlı kalsın diye "tickets"a
    // dönüyoruz (ör. klasikte iken settings açıkken sidebar'a geçilirse dişli zaten gizleniyor
    // olurdu ama sekme/ikon karşılığı hâlâ vurgulanmamış kalırdı).
    setActiveSection(document.body.dataset.section && SECTION_NAMES.includes(document.body.dataset.section) ? document.body.dataset.section : 'tickets');
    applyDetailSelection();
}

layoutButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
        const layout = btn.dataset.layout;
        applyPanelLayout(layout);
        ipcRenderer.send('set-panel-layout', layout);
    });
});

ipcRenderer.on('panel-layout', (event, layout) => applyPanelLayout(layout));
ipcRenderer.send('request-panel-layout');

// --- LİSTE + DETAY: sol kompakt ticket listesi + tek seçili kartın detay alanında gösterimi ---
// Yan Panel ve Klasik'te TÜM ticket kartları normal şekilde görünür (bkz. CSS); sadece
// "list-detail" yerleşiminde #ticketsList içindeki kartlardan yalnızca seçili olan gösterilir
// (CSS: body[data-layout="list-detail"] #ticketsList .ticket-card { display:none } + .detail-active).
let selectedDetailTicketId = null;
const ldTicketList = document.getElementById('ldTicketList');

function statusDotColor(ticket) {
    if (ticket.flagged) return 'var(--danger)';
    if (ticket.held) return 'var(--warn)';
    return ticket.claimed ? 'var(--ok)' : 'var(--text-lo)';
}

function renderCompactTicketList(tickets) {
    if (!ldTicketList) return;
    ldTicketList.innerHTML = '';
    if (tickets.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ld-list-empty';
        empty.textContent = 'Ticket bekleniyor...';
        ldTicketList.appendChild(empty);
        selectedDetailTicketId = null;
        lastFetchedDetailId = null;
        if (ldDetailInfo) {
            ldDetailInfo.innerHTML = '';
            ldDetailInfo.classList.remove('has-data');
        }
        return;
    }
    // Seçili ticket artık listede yoksa (kapatıldı vb.) ilk ticket'a düş.
    if (!tickets.some((t) => t.id === selectedDetailTicketId)) {
        selectedDetailTicketId = tickets[0].id;
    }
    tickets.forEach((ticket) => {
        const row = document.createElement('div');
        row.className = 'ld-list-item';
        row.dataset.ticketId = ticket.id;
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = statusDotColor(ticket);
        const label = document.createElement('span');
        label.className = 't';
        label.textContent = ticket.name;
        row.appendChild(dot);
        row.appendChild(label);
        row.addEventListener('click', () => selectDetailTicket(ticket.id));
        ldTicketList.appendChild(row);
    });
}

function selectDetailTicket(id) {
    selectedDetailTicketId = id;
    setActiveSection('tickets');
    applyDetailSelection();
}

// Hem #ticketsList'teki (detay alanında gösterilecek) kartın hem de #ldTicketList'teki
// (sol kompakt liste) seçili satırın vurgusunu tek yerden, anında günceller - böylece bir
// ticket'a tıklayınca sonraki veri yenilenmesini (ticket-list event'i) beklemeden aktif
// satır hemen değişir.
function applyDetailSelection() {
    document.querySelectorAll('#ticketsList .ticket-card').forEach((card) => {
        card.classList.toggle('detail-active', card.id === `ticket-${selectedDetailTicketId}`);
    });
    document.querySelectorAll('#ldTicketList .ld-list-item').forEach((row) => {
        row.classList.toggle('active', row.dataset.ticketId === String(selectedDetailTicketId));
    });
    refreshDetailInfoIfNeeded();
}

// --- LİSTE + DETAY: seçili ticket için zengin kimlik bilgisi ---
// Ticket açılırken zaten yakalanan license/oyun içi ID (main.js, channelLicense/channelGameId)
// + ticket açan kişinin Discord ID'si + bunlarla connections-webhook'ta bulunan EN SON olay
// (steam, online durumu, varsa "Reason" metni) main process'ten 'request-ticket-detail' ile
// isteniyor. Kasıtlı olarak eskiden kaldırılan FeloxAC ban-webhook/weapons-webhook'a DÖNÜLMEDİ
// (o, artık geçersiz/eski banları "hâlâ banlı" gibi gösterip yanıltıcı çıkmıştı) - onun yerine
// zaten kullanılan connections-webhook'un "Reason" alanı (banla çıkarıldıysa bunu içeriyor)
// bilgilendirici bir NOT olarak gösteriliyor, kesin "BANLI" iddiası olarak DEĞİL.
const ldDetailInfo = document.getElementById('ldDetailInfo');
let lastFetchedDetailId = null;

function refreshDetailInfoIfNeeded() {
    if (document.body.dataset.layout !== 'list-detail') return;
    if (!selectedDetailTicketId || selectedDetailTicketId === lastFetchedDetailId) return;
    lastFetchedDetailId = selectedDetailTicketId;
    const ticket = lastTicketsSnapshot.find((t) => t.id === selectedDetailTicketId);
    renderDetailInfoSkeleton(ticket);
    ipcRenderer.send('request-ticket-detail', selectedDetailTicketId);
}

function renderDetailInfoSkeleton(ticket) {
    if (!ldDetailInfo || !ticket) return;
    ldDetailInfo.innerHTML = '';
    ldDetailInfo.classList.add('has-data');
    const title = document.createElement('div');
    title.className = 'ld-detail-title';
    title.textContent = ticket.name;
    ldDetailInfo.appendChild(title);
    const sub = document.createElement('div');
    sub.className = 'ld-detail-sub';
    sub.textContent = ticket.claimed ? 'Claim edildi' : 'Claim edilmedi';
    ldDetailInfo.appendChild(sub);
    const loading = document.createElement('div');
    loading.className = 'ld-detail-loading';
    loading.textContent = 'Kimlik bilgileri yükleniyor...';
    ldDetailInfo.appendChild(loading);
}

function detailField(label, value) {
    const item = document.createElement('div');
    item.className = 'ld-detail-item';
    const l = document.createElement('span');
    l.className = 'ld-detail-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'ld-detail-value';
    v.textContent = value || '—';
    item.appendChild(l);
    item.appendChild(v);
    return item;
}

function renderDetailInfoFields(channelId, info) {
    if (!ldDetailInfo || channelId !== selectedDetailTicketId) return;
    const loading = ldDetailInfo.querySelector('.ld-detail-loading');
    if (loading) loading.remove();
    if (!info) {
        const hint = document.createElement('div');
        hint.className = 'ld-detail-hint';
        hint.textContent = 'Bilgi alınamadı (kanal artık mevcut olmayabilir).';
        ldDetailInfo.appendChild(hint);
        return;
    }

    const grid = document.createElement('div');
    grid.className = 'ld-detail-grid';
    grid.appendChild(detailField('Oyun İçi ID', info.gameId));
    grid.appendChild(detailField('License', info.license));
    grid.appendChild(detailField('Discord', info.discordId));
    grid.appendChild(detailField('Steam', info.steamName ? `${info.steamName} (${info.steam || '—'})` : info.steam));
    ldDetailInfo.appendChild(grid);

    // /player-info'nun kendi cevabı - artık eskisi gibi "reason metninde ban geçiyor mu"
    // tahmini değil, FG botunun DOĞRUDAN/güncel "FG Banlı mı?" cevabı.
    if (info.banned) {
        const banBox = document.createElement('div');
        banBox.className = 'ld-detail-ban';
        banBox.innerHTML = `${iconHtml('ban')}<span>Fiveguard tarafından banlı</span>`;
        ldDetailInfo.appendChild(banBox);
    } else if (info.online !== null && info.online !== undefined) {
        const hint = document.createElement('div');
        hint.className = 'ld-detail-hint';
        hint.textContent = info.online ? 'Şu an oyunda.' : 'Şu an oyunda değil.';
        ldDetailInfo.appendChild(hint);
    }
}

ipcRenderer.on('ticket-detail', (event, { channelId, detail }) => renderDetailInfoFields(channelId, detail));


// ============================ GEÇMİŞ ARAMALAR ============================
// Kimlik Sorgula'da aranan herkes main.js tarafından diske yazılıyor. Burada listelenip
// seçilerek TOPLU işlem yapılabiliyor (AC Çağır / fg ban / fg offline-ban).
// Gönderim ve onay penceresi main.js'te - burası sadece seçim ve gösterim.

const histSearch = document.getElementById('histSearch');
const histList = document.getElementById('histList');
const histEmpty = document.getElementById('histEmpty');
const histCount = document.getElementById('histCount');
const histActions = document.getElementById('histActions');
const histStatus = document.getElementById('histStatus');
const histReasonRow = document.getElementById('histReasonRow');
const histReasonInput = document.getElementById('histReasonInput');

let histKayitlar = [];          // sunucudan gelen tam liste
let histSecili = new Set();     // secili anahtarlar
let histBekleyenBan = null;     // 'ban' | 'offline-ban' - sebep kutusu acikken
let histGonderiyor = false;

// main.js'teki lookupKey ile AYNI mantık - iki taraf aynı kaydı aynı anahtarla görmeli.
function histAnahtar(k) {
    return k.license || (k.discord ? 'd:' + k.discord : null) || (k.playerId ? 'p:' + k.playerId : null) || '';
}

function histGorunenler() {
    const q = (histSearch.value || '').trim().toLowerCase();
    if (!q) return histKayitlar;
    return histKayitlar.filter((k) => [k.name, k.playerId, k.discord, k.license, k.steam]
        .some((v) => v && String(v).toLowerCase().includes(q)));
}

function histZaman(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function histCiz() {
    const gorunen = histGorunenler();
    histList.innerHTML = '';

    if (histKayitlar.length === 0) {
        histEmpty.style.display = 'block';
        histCount.style.display = 'none';
        histActions.style.display = 'none';
        return;
    }
    histEmpty.style.display = 'none';

    for (const k of gorunen) {
        const anahtar = histAnahtar(k);
        const row = document.createElement('div');
        row.className = 'hist-row';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = histSecili.has(anahtar);
        cb.onchange = () => {
            if (cb.checked) histSecili.add(anahtar); else histSecili.delete(anahtar);
            histDurumTazele();
        };
        row.appendChild(cb);

        const main = document.createElement('div');
        main.className = 'hist-main';
        const ad = document.createElement('div');
        ad.className = 'hist-name';
        ad.textContent = k.name || k.playerId || k.discord || k.license || '(isimsiz)';
        const meta = document.createElement('div');
        meta.className = 'hist-meta';
        const parcalar = [];
        if (k.playerId) parcalar.push('ID ' + k.playerId);
        if (k.discord) parcalar.push('DC ' + k.discord);
        if (k.sorgulanma) parcalar.push(histZaman(k.sorgulanma));
        meta.textContent = parcalar.join('  ·  ');
        main.appendChild(ad);
        main.appendChild(meta);
        row.appendChild(main);

        const tags = document.createElement('div');
        tags.className = 'hist-tags';
        const durum = document.createElement('span');
        durum.className = 'hist-tag ' + (k.online ? 'online' : 'offline');
        durum.textContent = k.online ? 'OYUNDA' : 'ÇEVRİMDIŞI';
        tags.appendChild(durum);
        if (k.banned) {
            const b = document.createElement('span');
            b.className = 'hist-tag banned';
            b.textContent = 'BANLI';
            tags.appendChild(b);
        }
        row.appendChild(tags);

        // Satira tiklayinca da secilsin - kucuk kutuyu tutturmaya calismak zorunda kalma
        row.onclick = (e) => { if (e.target !== cb) { cb.checked = !cb.checked; cb.onchange(); } };
        histList.appendChild(row);
    }

    histDurumTazele();
}

function histDurumTazele() {
    const n = histSecili.size;
    histCount.style.display = 'block';
    histCount.textContent = `${histKayitlar.length} kayıt · ${n} seçili` +
        (histSearch.value.trim() ? ` · ${histGorunenler().length} filtrede` : '');
    histActions.style.display = n > 0 ? 'flex' : 'none';
    if (n === 0) {
        histReasonRow.style.display = 'none';
        histBekleyenBan = null;
    }
}

function histSeciliKayitlar() {
    return histKayitlar.filter((k) => histSecili.has(histAnahtar(k)));
}

function histGonder(tip, sebep) {
    if (histGonderiyor) return;
    const kayitlar = histSeciliKayitlar();
    if (kayitlar.length === 0) return;
    histGonderiyor = true;
    histStatus.style.display = 'block';
    histStatus.textContent = 'Onay bekleniyor...';
    // Onay penceresi ve gonderim main.js'te - "atmadan once uyar" orada.
    ipcRenderer.send('bulk-action', { tip, kayitlar, sebep, count: 1 });
}

document.getElementById('histRefresh').onclick = () => ipcRenderer.send('request-lookup-history');
histSearch.oninput = () => histCiz();

document.getElementById('histSelectAll').onclick = () => {
    const gorunen = histGorunenler();
    const hepsiSecili = gorunen.length > 0 && gorunen.every((k) => histSecili.has(histAnahtar(k)));
    // Filtre aciksa SADECE gorunenleri sec/birak - kullanicinin gormedigi kaydi secmek surpriz olur
    for (const k of gorunen) {
        if (hepsiSecili) histSecili.delete(histAnahtar(k)); else histSecili.add(histAnahtar(k));
    }
    histCiz();
};

document.getElementById('histClear').onclick = () => {
    if (!confirm('Tüm arama geçmişi silinsin mi? Bu işlem geri alınamaz.')) return;
    histSecili.clear();
    ipcRenderer.send('clear-lookup-history');
};

document.getElementById('histAcCallBtn').onclick = () => histGonder('ac-call', null);

document.getElementById('histBanBtn').onclick = () => {
    histBekleyenBan = 'ban';
    histReasonRow.style.display = 'flex';
    histReasonInput.value = '';
    histReasonInput.focus();
};
document.getElementById('histOfflineBanBtn').onclick = () => {
    histBekleyenBan = 'offline-ban';
    histReasonRow.style.display = 'flex';
    histReasonInput.value = '';
    histReasonInput.focus();
};
document.getElementById('histReasonCancel').onclick = () => {
    histReasonRow.style.display = 'none';
    histBekleyenBan = null;
};
document.getElementById('histReasonSend').onclick = () => {
    const sebep = (histReasonInput.value || '').trim();
    if (!sebep || !histBekleyenBan) return;
    const tip = histBekleyenBan;
    histReasonRow.style.display = 'none';
    histBekleyenBan = null;
    histGonder(tip, sebep);
};
histReasonInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('histReasonSend').click();
});

ipcRenderer.on('lookup-history', (event, kayitlar) => {
    histKayitlar = Array.isArray(kayitlar) ? kayitlar : [];
    // Artik var olmayan kayitlarin secimini dusur
    const mevcut = new Set(histKayitlar.map(histAnahtar));
    for (const a of [...histSecili]) if (!mevcut.has(a)) histSecili.delete(a);
    histCiz();
});

ipcRenderer.on('bulk-action-progress', (event, { sira, toplam, ad }) => {
    histStatus.style.display = 'block';
    histStatus.textContent = `Gönderiliyor: ${sira}/${toplam} — ${ad}`;
});

ipcRenderer.on('bulk-action-result', (event, result) => {
    histGonderiyor = false;
    histStatus.style.display = 'block';
    histStatus.textContent = result.message || 'Tamamlandı.';
    if (result.success) {
        histSecili.clear();
        histCiz();
        ipcRenderer.send('request-lookup-history');
    }
});
