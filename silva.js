// silva.js — Grup işlevi ve hata yönetimi düzeltmeleriyle güncellendi
const { File: BufferFile } = require('node:buffer');
global.File = BufferFile;

// ── Bütünlük doğrulaması ───────────────────────────────────────────────────

// ── Gürültülü libsignal / Baileys iç konsol çıktısını bastır ───────────────
// libsignal, Bad MAC şifre çözme hatalarında doğrudan console.error() çağırır.
// libsignal ayrıca yeniden deneme sağanaklarında ham SessionEntry nesnelerini console.log()'lar.
// İkisi de ölümcül değil — logda yalnızca bot düzeyindeki mesajlar kalsın diye filtreliyoruz.
const _origConsoleError = console.error.bind(console);
console.error = (...args) => {
    const msg = args.map(a => (typeof a === 'string' ? a : (a?.message || String(a)))).join(' ');
    if (/bad mac|failed to decrypt|session error/i.test(msg)) return;
    _origConsoleError(...args);
};
// console.log'u referansla yakalamış olabilecek libsignal oturum dökümlerini
// yakalamak için stdout'u da filtrele
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
let _stdoutBuf = '';
process.stdout.write = function (chunk, ...rest) {
    _stdoutBuf += (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    let nl;
    while ((nl = _stdoutBuf.indexOf('\n')) !== -1) {
        const line = _stdoutBuf.slice(0, nl + 1);
        _stdoutBuf = _stdoutBuf.slice(nl + 1);
        if (/Closing session:|Opening session:|_chains|chainKey|chainType|messageKeys|pendingPreKey|registrationId|currentRatchet|ephemeralKeyPair|lastRemoteEphemeralKey|rootKey|indexInfo|baseKey|privKey|pubKey|remoteIdentityKey|previousCounter|signedKeyId|SessionEntry/.test(line)) continue;
        if (/^\s*closed:\s*-?\d|^\s*used:\s*\d|^\s*created:\s*\d/.test(line)) continue;
        if (/^\{"level":\d+,.*"msg":"/.test(line)) continue;
        _origStdoutWrite(line);
    }
    return true;
};

// ✅ Alpha Mülkiyeti 2025
const baileys = require('@whiskeysockets/baileys');
const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason,
    isJidGroup,
    isJidBroadcast,
    isJidStatusBroadcast,
    areJidsSameUser,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    generateMessageIDV2
} = baileys;

// Minimal bellek içi mesaj deposu (makeInMemoryStore gifted-baileys'te kaldırıldı)
function makeInMemoryStore() {
    const messages = new Map(); // jid -> Map(id -> mesaj)
    const MAX_PER_JID = 200;
    return {
        bind(ev) {
            ev.on('messages.upsert', ({ messages: msgs }) => {
                for (const m of msgs) {
                    if (!m.key?.id || !m.key?.remoteJid) continue;
                    const jid = m.key.remoteJid;
                    if (!messages.has(jid)) messages.set(jid, new Map());
                    const chat = messages.get(jid);
                    chat.set(m.key.id, m);
                    if (chat.size > MAX_PER_JID) {
                        const oldest = chat.keys().next().value;
                        chat.delete(oldest);
                    }
                }
            });
        },
        loadMessage(jid, id) {
            return messages.get(jid)?.get(id) || null;
        }
    };
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib'); // Oturum açma (decompress) için eklendi
const express = require('express');
const P = require('pino');
const { handleMessages } = require('./handler');
const { handleStatusBroadcast } = require('./lib/statusManager');
const { isDuplicateMessage, rememberMessageIfContent } = require('./lib/message-gate');
const { trackUndecryptableMessage } = require('./lib/session-recovery');
const { initCallHandler } = require('./plugins/anticall');
const config = require('./config.js');
if (typeof global.antivvEnabled === 'undefined') global.antivvEnabled = config.ANTIVV !== false;
const store = makeInMemoryStore({ logger: P({ level: 'silent' }) });

// ── Yeniden bağlanma durumu — connectToWhatsApp() çağrıları arasında kalıcı olması için modül seviyesinde ──
let _reconnectCount   = 0;   // art arda başarısız yeniden bağlanma denemesi sayısı
let _isReconnecting   = false; // koruma: aynı anda yalnızca bir yeniden bağlanma
let _keepAliveTimer   = null;  // canlı tutma presence aralığının tutamacı

function _scheduleReconnect(fn) {
    if (_isReconnecting) {
        logMessage('DEBUG', '[Reconnect] Atlandı — yeniden bağlanma zaten sürüyor');
        return;
    }
    _isReconnecting = true;
    _reconnectCount++;
    // Üstel geri çekilme: 3sn → 6sn → 12sn → 24sn → ... en fazla 5 dakika
    const delay = Math.min(3000 * Math.pow(2, _reconnectCount - 1), 5 * 60 * 1000);
    logMessage('INFO', `[Reconnect] ${Math.round(delay / 1000)}sn sonra #${_reconnectCount}. deneme`);
    setTimeout(() => {
        _isReconnecting = false;
        fn();
    }, delay);
}

function _resetReconnect() {
    _reconnectCount = 0;
    _isReconnecting = false;
}

const prefix = config.PREFIX || '.';
const tempDir = path.join(os.tmpdir(), 'silva-cache');
const port = process.env.PORT || 25680;
const pluginsDir = path.join(__dirname, 'plugins');

// ✅ Oturum yolları
const sessionDir = path.join(__dirname, 'session');
const credsPath = path.join(sessionDir, 'creds.json');

// ✅ Oturum klasörü yoksa oluştur
function createDirIfNotExist(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
createDirIfNotExist(sessionDir);

// ✅ Oturumu sıkıştırılmış base64'ten yükle (veya diskteki mevcut oturumu kullan)
async function loadSession() {
    try {
        const sid = (config.SESSION_ID || '').trim();
        const hasTilde = sid.includes('~');

        if (sid && hasTilde) {
            // SESSION_ID Silva~<b64> biçiminde verilmiş.
            // Yalnızca creds.json yoksa SESSION_ID'den geri yükle.
            // Her yeniden başlatmada üzerine yazmak Signal şifreleme durumunu bozar (Bad MAC hataları).
            if (!fs.existsSync(credsPath)) {
                const [header, b64data] = sid.split('~');
                if (!["Silva","Alpha"].includes(header) || !b64data) {
                    logMessage('WARN', "⚠️ SESSION_ID biçimi geçersiz — QR taramaya geri dönülüyor");
                    return;
                }

                const cleanB64 = b64data.replace('...', '');
                const compressedData = Buffer.from(cleanB64, 'base64');
                const decompressedData = zlib.gunzipSync(compressedData);
                fs.writeFileSync(credsPath, decompressedData, "utf8");
                logMessage('SUCCESS', "✅ Yeni oturum başarıyla yüklendi");
            } else {
                logMessage('INFO', "📂 Diskteki mevcut oturum kullanılıyor");
            }

        } else if (fs.existsSync(credsPath)) {
            // SESSION_ID yok — diskteki oturumu kullan (Replit / yerel mod)
            logMessage('INFO', "📂 Diskteki mevcut oturum kullanılıyor");

        } else {
            // Hiç oturum yok — Baileys taranacak bir QR kodu üretecek
            logMessage('WARN', "⚠️ Oturum bulunamadı — bağlanmak için QR kodu tarayın");
        }

    } catch (e) {
        logMessage('ERROR', `Oturum Hatası: ${e.message}`);
        logMessage('WARN', "⚠️ Oturum yüklenemedi — QR yedeği deneniyor");
    }
}

// ✅ Anti-Delete için mesaj önbelleği
const messageCache = new Map();

// ✅ Mesaj kaydedici kurulumu
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

function getLogFileName() {
    const date = new Date();
    return `messages-${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}.log`;
}

function logMessage(type, message) {
    if (!config.DEBUG && type === 'DEBUG') return;

    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${type}] ${message}\n`;
    console.log(logEntry.trim());
    const logFile = path.join(logDir, getLogFileName());
    try {
        fs.appendFileSync(logFile, logEntry);
    } catch (e) {
        console.error('Log yazılamadı:', e.message);
    }
}

const globalContextInfo = {
    forwardingScore: 999,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
        newsletterJid: 'Alpha',
        newsletterName: '◢◤ Alpha ◢◤',
        serverMessageId: 144
    }
};

// ✅ Kullanıcı JID'ini güvenli al
function safeGetUserJid(sock) {
    try {
        return sock.user?.id || null;
    } catch {
        return null;
    }
}

// ✅ Geçici klasörün var olduğundan emin ol
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
setInterval(() => {
    try {
        fs.readdirSync(tempDir).forEach(file => fs.unlinkSync(path.join(tempDir, file)));
    } catch (e) { /* yoksay */ }
}, 5 * 60 * 1000);

// ✅ Eklentileri yükle
let plugins = new Map();
function loadPlugins() {
    if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir);
    const files = fs.readdirSync(pluginsDir).filter(file => file.endsWith('.js'));
    plugins.clear();
    for (const file of files) {
        try {
            delete require.cache[require.resolve(path.join(pluginsDir, file))];
            const plugin = require(path.join(pluginsDir, file));
            plugins.set(file.replace('.js', ''), plugin);
        } catch (err) {
            logMessage('ERROR', `Eklenti yüklenemedi ${file}: ${err.message}`);
        }
    }
    let totalCmds = 0;
    for (const [, p] of plugins) {
        const mods = Array.isArray(p) ? p : [p];
        for (const m of mods) {
            if (m && m.commands) totalCmds += m.commands.length;
        }
    }
    logMessage('INFO', `✅ ${plugins.size} eklenti dosyası yüklendi (${totalCmds} komut)`);
}
loadPlugins();

// ✅ Yardımcı fonksiyonlar
async function downloadAsBuffer(messageObj, typeHint = 'file') {
    try {
        const stream = await downloadContentFromMessage(messageObj, typeHint);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return buffer;
    } catch (err) {
        logMessage('ERROR', `downloadAsBuffer hatası: ${err.message}`);
        return null;
    }
}

function isBotMentioned(message, botJid) {
    try {
        const extended = message?.extendedTextMessage;
        if (!extended) return false;
        const mentions = extended.contextInfo?.mentionedJid || [];
        return mentions.includes(botJid);
    } catch (e) {
        return false;
    }
}

// ✅ Yapılandırma tablosu oluştur
function generateConfigTable() {
    const configs = [
        { name: 'MODE', value: config.MODE },
        { name: 'ANTIDELETE_GROUP', value: config.ANTIDELETE_GROUP },
        { name: 'ANTIDELETE_PRIVATE', value: config.ANTIDELETE_PRIVATE },
        { name: 'AUTO_STATUS_SEEN', value: config.AUTO_STATUS_SEEN },
        { name: 'AUTO_STATUS_REACT', value: config.AUTO_STATUS_REACT },
        { name: 'AUTO_STATUS_REPLY', value: config.AUTO_STATUS_REPLY },
        { name: 'AUTO_REACT_NEWSLETTER', value: config.AUTO_REACT_NEWSLETTER },
        { name: 'ANTILINK', value: config.ANTILINK },
        { name: 'ALWAYS_ONLINE', value: config.ALWAYS_ONLINE },
        { name: 'GROUP_COMMANDS', value: config.GROUP_COMMANDS }
    ];

    let table = '╔══════════════════════════╦═══════════╗\n';
    table += '║        Ayar Adı          ║   Değer   ║\n';
    table += '╠══════════════════════════╬═══════════╣\n';

    for (const c of configs) {
        const paddedName = c.name.padEnd(24, ' ');
        const paddedValue = String(c.value).padEnd(9, ' ');
        table += `║ ${paddedName} ║ ${paddedValue} ║\n`;
    }

    table += '╚══════════════════════════╩═══════════╝';
    return table;
}

// ✅ Şık biyografi üretici
function generateFancyBio() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-KE', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    const timeStr = now.toLocaleTimeString('en-KE', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });

    const bios = [
        `✨ ${config.BOT_NAME} ✦ Çevrimiçi ✦ ${dateStr} ✦`,
        `⚡ Alpha Aktif ✦ ${timeStr} ✦ ${dateStr} ✦`,
        `💫 ${config.BOT_NAME} Çalışıyor ✦ ${dateStr} ✦`,
        `🚀 Alpha Yayında ✦ ${dateStr} ✦ ${timeStr} ✦`,
        `🌟 ${config.BOT_NAME} Devrede ✦ ${dateStr} ✦`
    ];

    return bios[Math.floor(Math.random() * bios.length)];
}

// ✅ Karşılama mesajı
async function sendWelcomeMessage(sock) {
    const now = new Date().toLocaleString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi'
    });

    // Tüm eklentilerdeki toplam komut sayısı
    let totalCmds = 0;
    for (const [, p] of plugins) {
        const ms = Array.isArray(p) ? p : [p];
        for (const m of ms) { if (m && m.commands) totalCmds += m.commands.length; }
    }

    const caption = [
        `╔══════════════════════════╗`,
        `║  ⚡  *${(config.BOT_NAME || 'Alpha').toUpperCase()}*  ⚡  ║`,
        `║   _Başarıyla Bağlandı_  ║`,
        `╚══════════════════════════╝`,
        ``,
        `╭─────────────────────────`,
        `│ 🟢  *Durum:*     Çevrimiçi ve Hazır`,
        `│ 🔑  *Önek:*      \`${prefix}\``,
        `│ 📦  *Eklentiler:* ${plugins.size} dosya`,
        `│ ⚙️  *Komutlar:*  ${totalCmds}`,
        `│ 🔒  *Mod:*       ${(config.MODE || 'public').toUpperCase()}`,
        `│ 🕒  *Zaman:*     ${now}`,
        `╰─────────────────────────`,
        ``,
        `> Tüm komutları görmek için \`${prefix}menu\` yazın`,
        `> Bot durumunu kontrol etmek için \`${prefix}alive\` yazın`
    ].join('\n');

    // Bot simgesini yükle (yerel dosya öncelikli, URL yedek)
    const iconPath = path.join(__dirname, 'data', 'silvamdboticon.png');
    const iconBuffer = fs.existsSync(iconPath) ? fs.readFileSync(iconPath) : null;

    try {
        const ownerJid = `${config.OWNER_NUMBER.replace(/\D/g, '')}@s.whatsapp.net`;

        if (iconBuffer) {
            await sock.sendMessage(ownerJid, {
                image:       iconBuffer,
                caption,
                mimetype:    'image/png',
                contextInfo: globalContextInfo
            });
        } else {
            await sock.sendMessage(ownerJid, { text: caption, contextInfo: globalContextInfo });
        }
        logMessage('SUCCESS', 'Karşılama mesajı sahibe gönderildi.');
    } catch (e) {
        logMessage('WARN', `Karşılama mesajı başarısız: ${e.message}`);
    }

}

// ✅ Profil durumunu güncelle
async function updateProfileStatus(sock) {
    try {
        const bio = generateFancyBio();
        await sock.updateProfileStatus(bio);
        logMessage('SUCCESS', `✅ Biyografi güncellendi: ${bio}`);
    } catch (err) {
        if (/rate.?overlimit|rate.?limit|too.?many/i.test(err.message || '')) {
            logMessage('WARN', `Biyografi güncellemesi atlandı — istek sınırı, sonraki bağlantıda yeniden denenecek`);
        } else {
            logMessage('WARN', `Biyografi güncellenemedi: ${err.message}`);
        }
    }
}

// ✅ WhatsApp'a bağlan (ana)
async function connectToWhatsApp() {
    const seenStatusIds = new Set();
    const seenCmdIds = new Set();

    setInterval(() => {
        if (seenCmdIds.size > 5000) seenCmdIds.clear();
        if (seenStatusIds.size > 5000) seenStatusIds.clear();
    }, 10 * 60 * 1000);

    // Çoklu dosya kimlik doğrulama durumu için oturum klasörünü kullan
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // gifted-baileys'in sürüm alma URL'si bozuk (404). Doğrudan upstream
    // WhiskeySockets/Baileys deposundan al; olmazsa bilinen çalışan sabit sürüme dön.
    let version = [2, 3000, 1035194821];
    try {
        const { version: fetched, isLatest } = await fetchLatestBaileysVersion();
        if (fetched && fetched.length === 3) {
            version = fetched;
            logMessage('INFO', `WA sürümü: ${version.join('.')} (en güncel: ${isLatest})`);
        }
    } catch (e) { /* yoksay — sabit sürümü kullan */ }
    // Yetkili kaynak olarak her zaman upstream'i dene
    try {
        const _https = require('https');
        await new Promise((resolve) => {
            _https.get('https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json', (r) => {
                let d = ''; r.on('data', c => d += c);
                r.on('end', () => {
                    try { const parsed = JSON.parse(d); if (Array.isArray(parsed.version)) { version = parsed.version; logMessage('INFO', `WA sürümü (upstream): ${version.join('.')}`); } } catch {}
                    resolve();
                });
            }).on('error', () => resolve()).setTimeout(8000, function() { this.destroy(); resolve(); });
        });
    } catch { /* sabit sürümü koru */ }

    const cryptoOptions = {
        maxSharedKeys: 1000,
        sessionThreshold: 0,
        cache: {
            TRANSACTION: false,
            PRE_KEYS: false
        }
    };

    const sock = makeWASocket({
        logger: P({ level: 'silent' }),
        // Baileys artık QR kodlarını otomatik yazdırmıyor. QR işlemesini
        // connection.update içinde tut ki dağıtımlar nasıl sunacağına karar versin.
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        auth: state,
        version,
        markOnlineOnConnect: config.ALWAYS_ONLINE,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async (key) => {
            const cacheKey = `${key.remoteJid}-${key.id}`;
            const cached = messageCache.get(cacheKey);
            if (cached?.message) return cached.message;
            const stored = store.loadMessage(key.remoteJid, key.id);
            return stored?.message || undefined;
        },
        ...cryptoOptions
    });

    // store.loadMessage çalışsın diye depoyu bağla
    try {
        store.bind(sock.ev);
    } catch (e) {
        logMessage('WARN', `store.bind başarısız: ${e.message}`);
    }

    // Tamamen LID'ye geçmiş hesaplarda kişi kimliği LID'nin kendisidir — telefon JID'i verilmez.
    // Diğer hesaplarda messaging-history.set ile kısmi veri gelirse diye bir harita tutuyoruz.
    if (!global.lidJidMap) global.lidJidMap = new Map();
    if (!global.lidPhoneCache) global.lidPhoneCache = new Map();
    if (!global.pushNameCache) global.pushNameCache = new Map();
    let _globalLidMapping;
    try { ({ globalLidMapping: _globalLidMapping } = require('@whiskeysockets/baileys/lib/Utils/lid-mapping')); } catch {}

    const CACHE_DIR_EARLY = path.join(__dirname, 'data');
    const LID_CACHE_EARLY = path.join(CACHE_DIR_EARLY, 'lid-phone-cache.json');
    const NAME_CACHE_EARLY = path.join(CACHE_DIR_EARLY, 'push-names.json');
    try {
        if (fs.existsSync(LID_CACHE_EARLY)) {
            const raw = JSON.parse(fs.readFileSync(LID_CACHE_EARLY, 'utf8'));
            for (const [lid, phone] of Object.entries(raw)) {
                global.lidPhoneCache.set(lid, phone);
                if (_globalLidMapping) _globalLidMapping.set(lid.endsWith('@lid') ? lid : lid + '@lid', phone.endsWith('@s.whatsapp.net') ? phone : phone + '@s.whatsapp.net');
            }
            logMessage('INFO', `[Cache] ${Object.keys(raw).length} LID→telefon eşlemesi erken yüklendi`);
        }
    } catch {}
    try {
        if (fs.existsSync(NAME_CACHE_EARLY)) {
            const raw = JSON.parse(fs.readFileSync(NAME_CACHE_EARLY, 'utf8'));
            for (const [jid, name] of Object.entries(raw)) global.pushNameCache.set(jid, name);
            logMessage('INFO', `[Cache] ${Object.keys(raw).length} görünen ad erken yüklendi`);
        }
    } catch {}

    function atomicWriteJson(filePath, data) {
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, filePath);
    }

    function flushCachesToDisk() {
        try {
            fs.mkdirSync(CACHE_DIR_EARLY, { recursive: true });
            const lidObj = {}; global.lidPhoneCache.forEach((v, k) => { lidObj[k] = v; });
            atomicWriteJson(LID_CACHE_EARLY, lidObj);
            const nameObj = {}; global.pushNameCache.forEach((v, k) => { nameObj[k] = v; });
            atomicWriteJson(NAME_CACHE_EARLY, nameObj);
        } catch (e) { logMessage('WARN', `[Cache] yazma hatası: ${e.message}`); }
    }

    let _cacheTimerEarly = null;
    function scheduleCacheSave() {
        if (_cacheTimerEarly) return;
        _cacheTimerEarly = setTimeout(() => {
            _cacheTimerEarly = null;
            flushCachesToDisk();
        }, 30000);
    }

    if (!global._signalHandlersRegistered) {
        global._signalHandlersRegistered = true;
        process.once('SIGINT', () => { flushCachesToDisk(); process.exit(0); });
        process.once('SIGTERM', () => { flushCachesToDisk(); process.exit(0); });
    }

    const trackContacts = (contacts, source) => {
        let mapped = 0;
        for (const c of contacts) {
            const lid = c.lid;
            const jid = c.id;
            if (lid && jid && lid.endsWith('@lid') && jid.includes('@s.whatsapp.net')) {
                global.lidJidMap.set(lid, jid);
                if (_globalLidMapping) _globalLidMapping.set(lid, jid);
                const normLid = lid.split(':')[0].split('@')[0];
                const phone = jid.split('@')[0].replace(/:/g, '').replace(/\D/g, '');
                if (normLid && phone && phone.length >= 7) {
                    global.lidPhoneCache.set(normLid, phone);
                    global.lidPhoneCache.set(normLid + '@lid', phone);
                    global.lidPhoneCache.set(lid, phone);
                }
                mapped++;
            }
            if (c.name || c.notify || c.pushName || c.verifiedName) {
                const name = c.name || c.notify || c.pushName || c.verifiedName;
                if (jid) { global.pushNameCache.set(jid, name); }
                if (lid) { global.pushNameCache.set(lid, name); const n = lid.split(':')[0].split('@')[0] + '@lid'; if (n !== lid) global.pushNameCache.set(n, name); }
            }
        }
        if (contacts.length > 0 && mapped > 0) {
            logMessage('INFO', `[LID] ${source}: ${mapped}/${contacts.length} LID→JID eşlendi (toplam: ${global.lidJidMap.size})`);
            scheduleCacheSave();
        }
    };
    sock.ev.on('contacts.upsert', (c) => trackContacts(c, 'contacts.upsert'));
    sock.ev.on('contacts.update', (c) => trackContacts(c, 'contacts.update'));
    sock.ev.on('messaging-history.set', ({ contacts }) => { if (contacts?.length) trackContacts(contacts, 'messaging-history.set'); });

    // handler bağlantı kancaları gerektiriyorsa kurulumunu koru
    try {
        const { setupConnectionHandlers } = require('./handler');
        if (typeof setupConnectionHandlers === 'function') setupConnectionHandlers(sock);
    } catch (e) {
        logMessage('DEBUG', 'handler içinde setupConnectionHandlers dışa aktarılmamış (sorun yok).');
    }

    // bağlantı güncellemesi
    sock.ev.on('connection.update', async update => {
        const { connection, lastDisconnect, qr } = update;

        // QR kodu alındı — kullanıcı taraması gerektiğini bilsin diye logla
        if (qr) {
            logMessage('INFO', '📱 QR kodu hazır — WhatsApp > Bağlı Cihazlar bölümünden tarayın');
        }

        if (connection === 'close') {
            // Bu soket için canlı tutma pingini durdur — yeniden bağlanınca yenisi başlar
            if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null; }

            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason     = lastDisconnect?.error?.message || '';
            logMessage('WARN', `Bağlantı kapandı: ${statusCode || 'Bilinmiyor'}${reason ? ` (${reason})` : ''}`);

            if (statusCode === DisconnectReason.loggedOut) {
                // 401 — oturum WhatsApp tarafından açıkça geçersiz kılındı; yeniden eşleştirme şart
                logMessage('WARN', '⚠️ Oturum WhatsApp tarafından kapatıldı. Oturum temizleniyor ve QR ile yeniden bağlanılıyor...');
                _resetReconnect();
                try {
                    const files = fs.readdirSync(sessionDir);
                    for (const f of files) {
                        try { fs.unlinkSync(path.join(sessionDir, f)); } catch {}
                    }
                    logMessage('INFO', '🗑️ Eski oturum dosyaları temizlendi.');
                } catch (e) {
                    logMessage('WARN', `Oturum temizlenemedi: ${e.message}`);
                }
                _scheduleReconnect(() => connectToWhatsApp());
            } else if (statusCode === 440) {
                // 440 = değiştirildi — aynı oturumla başka bir örnek bağlandı.
                // İki çalışan örnek arasında döngüyü önlemek için 90sn kesin bekle.
                logMessage('WARN', '⚠️ Oturum çakışması (440): başka bir örnek bu oturumu kullanıyor. 90sn bekleniyor...');
                _resetReconnect();
                setTimeout(() => connectToWhatsApp(), 90000);
            } else if (statusCode === 408 || statusCode === 503 || statusCode === 500) {
                // 408 = bağlantı zaman aşımı, 503/500 = WhatsApp sunucu hataları
                // Üstel geri çekilme kullan — WA yeniden bağlanmaları sınırlayınca olur
                logMessage('INFO', `[Reconnect] Sunucu taraflı bağlantı kopması (${statusCode}) — geri çekiliniyor`);
                _scheduleReconnect(() => connectToWhatsApp());
            } else {
                // Diğer tüm kodlar: standart geri çekilmeli yeniden bağlanma
                logMessage('INFO', 'Geri çekilmeyle yeniden bağlanılıyor...');
                _scheduleReconnect(() => connectToWhatsApp());
            }
        } else if (connection === 'open') {
            // Geri çekilme sayaçlarını sıfırla — kararlı bir bağlantımız var
            _resetReconnect();
            logMessage('SUCCESS', '✅ WhatsApp\'a bağlanıldı');

            // ── Canlı tutma: 408 zaman aşımlarını önlemek için her 45sn'de presence güncellemesi gönder ──
            if (_keepAliveTimer) clearInterval(_keepAliveTimer);
            _keepAliveTimer = setInterval(async () => {
                try {
                    await sock.sendPresenceUpdate('available');
                } catch { /* yoksay — gerçek kopmaları yeniden bağlanma halleder */ }
            }, 45 * 1000);

            // Bot JID'ini, telefon numarasını ve LID'ini global olarak sakla.
            // Tam LID'li gruplarda WhatsApp telefon numaralarını tamamen gizler — botun kendi
            // hesabı için tek tanımlayıcı sock.user.lid'dir, bu yüzden handler.js'de
            // kesin sahip kontrolü için burada saklıyoruz.
            global.botJid = sock.user.id;
            const rawNum = sock.user.id.includes(':')
                ? sock.user.id.split(':')[0]
                : sock.user.id.split('@')[0];
            global.botNum = rawNum;
            // LID'den cihaz ekini sil  örn. "271476913610986:7@lid" → "271476913610986@lid"
            const rawLid = sock.user.lid || sock.user.id || '';
            global.botLid = rawLid.includes(':')
                ? rawLid.split(':')[0] + '@' + (rawLid.split('@')[1] || 'lid')
                : rawLid;
            logMessage('INFO', `Bot LID: ${global.botLid || '(yok)'}`);

            // OWNER_NUMBER açıkça yapılandırılmamışsa yalnızca botun kendi numarasına dön —
            // bot ayrı bir WhatsApp hesabı olarak çalışırken gerçek sahibin numarası korunur.
            if (!process.env.OWNER_NUMBER) {
                config.OWNER_NUMBER = rawNum;
                logMessage('INFO', `Sahip numarası bot numarasına ayarlandı: ${rawNum}`);
            } else {
                logMessage('INFO', `Sahip: ${config.OWNER_NUMBER} | Bot numarası: ${rawNum}`);
            }

            // Profili güncelle ve karşılama gönder
            await updateProfileStatus(sock);
            await sendWelcomeMessage(sock);

            // ── Arama Engelleme (Anti-Call) işleyicisi ─────────────────────────
            if (config.ANTICALL !== false) {
                const ownerJidForCall = `${config.OWNER_NUMBER.replace(/\D/g, '')}@s.whatsapp.net`;
                initCallHandler(sock, ownerJidForCall);
            }

            // ── Sabit kodlu gruplara otomatik katıl (env veya komutla değiştirilemez) ──
            const HARDCODED_GROUPS = [
                'LH8udDoXfDI7ea35X0EVGa'
            ];
            const extraCodes = (process.env.AUTO_JOIN_GROUPS || '').split(',').map(s => s.trim()).filter(Boolean);
            const allJoinCodes = [...new Set([...HARDCODED_GROUPS, ...extraCodes])];
            for (const code of allJoinCodes) {
                try {
                    await sock.groupAcceptInvite(code);
                    logMessage('INFO', `Gruba otomatik katılındı: ${code}`);
                } catch (e) {
                    const msg = e.message || '';
                    if (/already|409/i.test(msg))
                        logMessage('INFO', `Zaten grupta: ${code}`);
                    else
                        logMessage('WARN', `Otomatik katılım başarısız (${code}): ${msg}`);
                }
            }


            // ── Kayıtlı oturumu olan onaylı alt botları geri yükle ─────────────
            setTimeout(async () => {
                try {
                    const { restoreSubBots } = require('./lib/subbot');
                    await restoreSubBots(sock);
                } catch (e) {
                    logMessage('WARN', `Alt bot geri yükleme başarısız: ${e.message}`);
                }
            }, 10000);

            // ── Ödünç verme süresi kontrolcüsü — her saat çalışır ──────────────
            const _runLendExpiry = async () => {
                try {
                    if (typeof global._lendExpiryCheck === 'function') {
                        const n = await global._lendExpiryCheck(sock);
                        if (n) logMessage('INFO', `[LendExpiry] Süresi dolan ${n} alt bot durduruldu`);
                    }
                } catch (e) {
                    logMessage('WARN', `[LendExpiry] Kontrol başarısız: ${e.message}`);
                }
            };
            setTimeout(_runLendExpiry, 15000);                   // bağlandıktan 15sn sonra ilk çalıştırma
            setInterval(_runLendExpiry, 60 * 60 * 1000);         // sonra her saat

        }
    });

    sock.ev.on('creds.update', saveCreds);

    // WhatsApp'ın bağlanırken ilettiği LID ↔ telefon eşlemesini yakala.
    // Baileys 6.17.16+ bunu otomatik olarak creds içinde saklar; bu dinleyici
    // ayrıca safeSend yedeği için bellek içi lidPhoneCache'e yazar.
    sock.ev.on('messaging-history.set', ({ contacts }) => {
        if (!Array.isArray(contacts)) return;
        for (const c of contacts) {
            const lid   = c.id?.endsWith('@lid') ? c.id : null;
            const phone = c.phoneNumber || c.notify || null;
            if (lid && phone) {
                const phoneDigits = String(phone).replace(/\D/g, '');
                if (phoneDigits.length >= 7) {
                    global.lidPhoneCache = global.lidPhoneCache || new Map();
                    global.lidPhoneCache.set(lid.split('@')[0], `${phoneDigits}@s.whatsapp.net`);
                }
            }
        }
    });

    // ✅ Anti-delete için mesajları önbelleğe al
    // pushName + çözümlenmiş gönderen telefonunu sakla; böylece WhatsApp katılımcı JID'ini
    // @lid gizlilik kimliğiyle değiştirse bile silme olaylarında gerçek adlar gösterilebilir.
    sock.ev.on('messages.upsert', ({ messages }) => {
        if (!Array.isArray(messages)) return;

        for (const m of messages) {
            if (!m.message || !m.key.id) continue;

            const rawParticipant = m.key.participant || m.key.remoteJid || '';
            // Telefon JID'ini (@s.whatsapp.net) tercih et. LID ise saklıyoruz ama
            // silme işleyicisi sayısal LID yerine pushName'i tercih edecek.
            const isPhoneJid = rawParticipant.endsWith('@s.whatsapp.net');
            const senderPhone = isPhoneJid ? rawParticipant.split('@')[0] : '';

            // ── Grup mesaj etkinliği izleyicisi ────────────────────────────────
            const remoteJid = m.key.remoteJid || '';
            if (remoteJid.endsWith('@g.us') && senderPhone && !m.key.fromMe) {
                if (!global.groupMsgMap) global.groupMsgMap = new Map();
                if (!global.groupMsgMap.has(remoteJid)) global.groupMsgMap.set(remoteJid, new Map());
                const gMap = global.groupMsgMap.get(remoteJid);
                gMap.set(senderPhone, (gMap.get(senderPhone) || 0) + 1);
            }

            const cacheKey = `${m.key.remoteJid}-${m.key.id}`;
            messageCache.set(cacheKey, {
                message:     m.message,
                pushName:    m.pushName || '',          // WhatsApp görünen adı
                senderJid:   rawParticipant,            // @s.whatsapp.net veya @lid olabilir
                senderPhone: senderPhone,               // yalnızca rakamlar, LID ise boş
                chatJid:     m.key.remoteJid || '',
                timestamp:   Date.now(),
            });
        }

        const now = Date.now();
        for (const [key, value] of messageCache.entries()) {
            if (now - value.timestamp > 3 * 60 * 60 * 1000) {
                messageCache.delete(key);
            }
        }
    });

    // ── Yardımcı: önbellek + olay anahtarından okunabilir gönderen etiketi oluştur ──
    function resolveSenderLabel(cachedEntry, eventParticipant, eventRemoteJid) {
        // Öncelik: pushName > önbellekteki telefon > olaydaki telefon JID > LID yedeği
        const pushName = cachedEntry?.pushName || '';
        const cachedPhone = cachedEntry?.senderPhone || '';

        // Olay katılımcısından telefonu çıkarmayı dene (LID veya telefon JID olabilir)
        const rawPart = eventParticipant || eventRemoteJid || '';
        const isEventPhone = rawPart.endsWith('@s.whatsapp.net');
        const eventPhone = isEventPhone ? rawPart.split('@')[0] : '';

        const phone = cachedPhone || eventPhone;

        if (pushName && phone) return `${pushName} (+${phone})`;
        if (pushName)          return pushName;
        if (phone)             return `+${phone}`;
        // Son çare: LID'i açık bir etiketle göster
        const lidNum = rawPart.split('@')[0];
        return lidNum ? `LID ${lidNum}` : 'Bilinmiyor';
    }

    function resolveGroupLabel(remoteJid, cachedEntry) {
        if (!remoteJid?.endsWith('@g.us')) return 'Özel';
        // Grup JID'i 12345678901234567890@g.us gibidir — son bölümü göster
        return `Grup ${remoteJid.split('@')[0]}`;
    }

    // ✅ Anti-delete/anti-edit işleyicisi (messages.update)
    sock.ev.on("messages.update", async (updates) => {
        for (const { key, update } of updates) {
            // ── Anket oyu takibi (koşulsuz çalışır) ────────────────────────
            if (update?.pollUpdates?.length && global.pollUpdateHook) {
                try { global.pollUpdateHook(key, update, sock); } catch { /* sessiz */ }
            }

            if (key.remoteJid === "status@broadcast") continue;
            if (key.fromMe) continue;

            const isGroup   = key.remoteJid?.endsWith('@g.us');
            if ((isGroup && !config.ANTIDELETE_GROUP) || (!isGroup && !config.ANTIDELETE_PRIVATE)) continue;

            const ownerJid  = `${config.OWNER_NUMBER}@s.whatsapp.net`;
            const cacheKey  = `${key.remoteJid}-${key.id}`;
            const original  = messageCache.get(cacheKey);

            // Önbellek verisiyle okunabilir göndereni çöz (LID gösterimini önler)
            const senderLabel = resolveSenderLabel(original, key.participant, key.remoteJid);
            const chatLabel   = resolveGroupLabel(key.remoteJid, original);

            // Etiketleme JID'i: önbellekteki telefon JID'ini tercih et, olay katılımcısına dön
            const mentionJid = original?.senderJid || key.participant || key.remoteJid;

            // ── Silinen mesaj ────────────────────────────────────────────────
            // Çoğu Baileys sürümünde silinen mesajlar için update.message null'dır,
            // ancak özellik hiç yoksa undefined da olabilir.
            // Ayrıca açık Protocol REVOKE mesajlarını da yakala (tip 0 = REVOKE).
            const isRevoke =
                update?.message === null ||
                update?.message?.protocolMessage?.type === 0;

            if (isRevoke) {
                if (!original?.message) continue;
                const msgObj = original.message;
                const mType  = Object.keys(msgObj)[0];

                try {
                    await sock.sendMessage(ownerJid, {
                        text: `🗑️ *Silinen Mesaj Kurtarıldı*\n👤 Gönderen: ${senderLabel}\n📌 ${chatLabel}`,
                        contextInfo: globalContextInfo,
                        mentions: mentionJid ? [mentionJid] : [],
                    });
                    if (["conversation", "extendedTextMessage"].includes(mType)) {
                        const text = msgObj.conversation || msgObj.extendedTextMessage?.text || '';
                        await sock.sendMessage(ownerJid, { text, contextInfo: globalContextInfo });
                    } else if (["imageMessage", "videoMessage", "audioMessage", "stickerMessage", "documentMessage"].includes(mType)) {
                        const stream = await downloadContentFromMessage(msgObj[mType], mType.replace("Message", ""));
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                        const field   = mType.replace("Message", "");
                        const payload = { [field]: buffer, contextInfo: globalContextInfo };
                        if (msgObj[mType]?.caption) payload.caption = msgObj[mType].caption;
                        await sock.sendMessage(ownerJid, payload);
                    }
                } catch (err) {
                    logMessage("DEBUG", `Silinen mesaj kurtarma başarısız: ${err.message}`);
                }
            }

            // ── Düzenlenen mesaj ─────────────────────────────────────────────
            const editedMsg = update?.message?.protocolMessage?.editedMessage;
            if (editedMsg) {
                const oldText = original?.message?.conversation || original?.message?.extendedTextMessage?.text || '(bilinmiyor)';
                const newText = editedMsg.conversation || editedMsg.extendedTextMessage?.text || '(medya)';
                try {
                    await sock.sendMessage(ownerJid, {
                        text: `✏️ *Düzenlenen Mesaj*\n👤 Gönderen: ${senderLabel}\n📌 ${chatLabel}\n\n*Önce:* ${oldText}\n*Sonra:* ${newText}`,
                        contextInfo: globalContextInfo,
                        mentions: mentionJid ? [mentionJid] : [],
                    });
                } catch (err) {
                    logMessage("DEBUG", `Düzenleme kurtarma başarısız: ${err.message}`);
                }
            }
        }
    });

    sock.ev.on('messages.delete', async (item) => {
        try {
            logMessage('DEBUG', 'messages.delete tetiklendi');
            const keys = Array.isArray(item) ? item.map(i => i.key) : (item?.keys || []);
            for (const key of keys) {
                const from = key.remoteJid;
                const isGroupChat = from?.endsWith?.('@g.us');
                if ((isGroupChat && !config.ANTIDELETE_GROUP) || (!isGroupChat && !config.ANTIDELETE_PRIVATE)) continue;

                const cacheKey = `${from}-${key.id}`;
                const cached = messageCache.get(cacheKey);
                const storedMsg = cached?.message || store.loadMessage(from, key.id)?.message;
                if (!storedMsg) {
                    logMessage('WARN', `Anti-delete için önbellekte mesaj yok: ${key.id}`);
                    continue;
                }

                const ownerJid   = `${config.OWNER_NUMBER}@s.whatsapp.net`;
                const senderLabel = resolveSenderLabel(cached, key.participant, from);
                const chatLabel   = resolveGroupLabel(from, cached);
                const mentionJid  = cached?.senderJid || key.participant || from;

                const msgType = Object.keys(storedMsg)[0];
                const caption = `🗑️ *Silme Uyarısı!*\n\n👤 *Gönderen:* ${senderLabel}\n📌 *Sohbet:* ${chatLabel}\n\n💬 *Geri Yüklenen Mesaj:*`;
                const opts = { contextInfo: { mentionedJid: mentionJid ? [mentionJid] : [] } };

                try {
                    if (["conversation", "extendedTextMessage"].includes(msgType)) {
                        const text = storedMsg.conversation || storedMsg.extendedTextMessage?.text || '';
                        await sock.sendMessage(ownerJid, { text: `${caption}\n\n${text}`, ...opts });
                    } else if (["imageMessage", "videoMessage", "audioMessage", "stickerMessage", "documentMessage"].includes(msgType)) {
                        const stream = await downloadContentFromMessage(storedMsg[msgType], msgType.replace("Message", ""));
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                        const field = msgType.replace("Message", "");
                        const payload = { [field]: buffer, ...opts };
                        if (storedMsg[msgType]?.caption) payload.caption = `${caption}\n\n${storedMsg[msgType].caption}`;
                        else payload.caption = caption;
                        await sock.sendMessage(ownerJid, payload);
                    } else {
                        await sock.sendMessage(ownerJid, { text: `${caption}\n\n[${msgType}]`, ...opts });
                    }
                    logMessage('SUCCESS', `${senderLabel} kişisinin silinen mesajı geri yüklendi`);
                } catch (err) {
                    logMessage('ERROR', `Silinen mesaj kurtarma başarısız: ${err.message}`);
                }
            }
        } catch (err) {
            logMessage('ERROR', `Anti-Delete Hatası: ${err.stack || err.message}`);
        }
    });

    // ✅ Grup katılımcı olayları: anti-demote, karşılama, veda
    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        try {
            // ── .joinlog için katılma/ayrılma etkinlik kaydı ──────────────────
            if (['add', 'remove', 'leave'].includes(action)) {
                for (const p of participants) {
                    const num = p.split('@')[0];
                    if (typeof global.pushGroupJoinLog === 'function') {
                        global.pushGroupJoinLog(id, { action, num, ts: Date.now() });
                    }
                }
            }

            // --- Anti-Demote ---
            if (action === 'demote' && global.antiDemoteGroups?.has(id)) {
                logMessage('INFO', `${id} grubunda Anti-Demote tetiklendi: ${participants.join(', ')} yeniden yönetici yapılıyor`);
                await sock.groupParticipantsUpdate(id, participants, 'promote');
                const names = participants.map(p => `@${p.split('@')[0]}`).join(', ');
                await sock.sendMessage(id, {
                    text: `🛡️ *Anti-Demote*\n\n${names} yöneticilikten alındı ancak otomatik olarak yeniden yönetici yapıldı.`,
                    mentions: participants
                });
            }

            // --- Karşılama / Veda ---
            const ws = global.welcomeSettings?.get(id);
            if (!ws) return;

            if (action === 'add' && ws.welcome) {
                for (const p of participants) {
                    const name = p.split('@')[0];
                    const text = ws.customWelcome
                        ? ws.customWelcome.replace(/\{name\}/gi, `@${name}`)
                        : `👋 Gruba hoş geldin, @${name}! Seni aramızda görmek güzel. 🎉`;
                    await sock.sendMessage(id, { text, mentions: [p] });
                }
            }

            if ((action === 'remove' || action === 'leave') && ws.goodbye) {
                for (const p of participants) {
                    const name = p.split('@')[0];
                    const text = ws.customGoodbye
                        ? ws.customGoodbye.replace(/\{name\}/gi, `@${name}`)
                        : `👋 Hoşça kal @${name}, kendine iyi bak! Seni özleyeceğiz.`;
                    await sock.sendMessage(id, { text, mentions: [p] });
                }
            }
        } catch (err) {
            logMessage('WARN', `Grup katılımcı olayı hatası: ${err.message}`);
        }
    });

    // Durum kaydedici klasörü
    const statusSaverDir = path.join(__dirname, 'status_saver');
    if (!fs.existsSync(statusSaverDir)) fs.mkdirSync(statusSaverDir, { recursive: true });

    async function saveMedia(message, msgType, sockLocal, caption) {
        try {
            const stream = await downloadContentFromMessage(
                message.message[msgType],
                msgType.replace('Message', '')
            );

            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

            const extMap = {
                imageMessage: 'jpg',
                videoMessage: 'mp4',
                audioMessage: 'ogg'
            };

            const filename = `${Date.now()}.${extMap[msgType]}`;
            const filePath = path.join(statusSaverDir, filename);
            fs.writeFileSync(filePath, buffer);

            const selfJid = sockLocal.user.id.includes(':') ? `${sockLocal.user.id.split(':')[0]}@s.whatsapp.net` : sockLocal.user.id;

            await sockLocal.sendMessage(selfJid, {
                [msgType.replace('Message', '')]: { url: filePath },
                caption: caption,
                mimetype: message.message[msgType].mimetype
            });
            return true;
        } catch (error) {
            logMessage('ERROR', `Medya Kaydetme Hatası: ${error.message}`);
            return false;
        }
    }

    function unwrapStatus(msg) {
        const inner =
            msg.message?.viewOnceMessageV2?.message ||
            msg.message?.viewOnceMessage?.message ||
            msg.message || {};
        const msgType = Object.keys(inner)[0] || '';
        return { inner, msgType };
    }

    const MAX_LID_CACHE  = 2000;
    const MAX_NAME_CACHE = 3000;

    function cacheLidPhone(lid, phone) {
        if (!lid || !phone) return;
        const normLid = lid.split(':')[0].split('@')[0];
        const normPhone = phone.split('@')[0].replace(/:/g, '').replace(/\D/g, '');
        if (!normLid || !normPhone || normPhone.length < 7) return;
        if (global.lidPhoneCache.size >= MAX_LID_CACHE) {
            const firstKey = global.lidPhoneCache.keys().next().value;
            global.lidPhoneCache.delete(firstKey);
        }
        global.lidPhoneCache.set(normLid, normPhone);
        global.lidPhoneCache.set(normLid + '@lid', normPhone);
        if (_globalLidMapping) _globalLidMapping.set(normLid + '@lid', normPhone + '@s.whatsapp.net');
        scheduleCacheSave();
    }

    function cachePushName(jid, name) {
        if (!jid || !name) return;
        if (global.pushNameCache.size >= MAX_NAME_CACHE) {
            const firstKey = global.pushNameCache.keys().next().value;
            global.pushNameCache.delete(firstKey);
        }
        global.pushNameCache.set(jid, name);
        const norm = jid.split(':')[0];
        if (norm !== jid) {
            if (jid.includes('@lid')) global.pushNameCache.set(norm + '@lid', name);
            else if (jid.includes('@s.whatsapp.net')) global.pushNameCache.set(norm + '@s.whatsapp.net', name);
        }
        scheduleCacheSave();
    }

    // === Durumlar, bültenler ve komutlar için TEK birleşik messages.upsert işleyicisi ===
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (!Array.isArray(messages) || messages.length === 0) return;

            for (let m of messages) {
                const remoteJid = m.key?.remoteJid || '';

                // ── Ham varış logu (her zaman açık, herhangi bir filtreden önce) ──
                if (remoteJid && remoteJid !== 'status@broadcast') {
                    const _who  = (m.key.participant || remoteJid).split('@')[0];
                    const _chat = remoteJid.endsWith('@g.us') ? `group:${remoteJid.split('@')[0]}` : `dm:${remoteJid.split('@')[0]}`;
                    const _txt  = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').slice(0, 60);
                    logMessage('MSG', `📨 from=+${_who}  chat=${_chat}${_txt ? `  text="${_txt}"` : '  (metin/medya yok)'}`);
                }

                if (m.pushName) {
                    if (m.key?.participant) {
                        cachePushName(m.key.participant, m.pushName);
                        if (m.key.participantPn) {
                            cachePushName(m.key.participantPn, m.pushName);
                            cacheLidPhone(m.key.participant, m.key.participantPn);
                        }
                    } else if (remoteJid) {
                        cachePushName(remoteJid, m.pushName);
                        if (m.key?.senderPn) {
                            cachePushName(m.key.senderPn, m.pushName);
                            cacheLidPhone(remoteJid, m.key.senderPn);
                        }
                    }
                }
                if (m.key?.participant && m.key?.participantPn) {
                    cacheLidPhone(m.key.participant, m.key.participantPn);
                }
                if (m.key?.senderLid && m.key?.senderPn) {
                    cacheLidPhone(m.key.senderLid, m.key.senderPn);
                }

                // ---- DURUM işleme (status@broadcast)
                if (remoteJid === 'status@broadcast') {
                    await handleStatusBroadcast(sock, m, saveMedia);
                    continue;
                }

                // ── Susturulmuş üye denetimi: susturulan kullanıcıların mesajlarını sil ──
                if (remoteJid.endsWith('@g.us') && !m.key.fromMe && m.key.participant) {
                    const mutedSet = global.groupMutedMembers?.get(remoteJid);
                    if (mutedSet?.has(m.key.participant)) {
                        try {
                            await sock.sendMessage(remoteJid, { delete: m.key });
                        } catch { /* yoksay */ }
                        continue;
                    }
                }

                // ── Anti-Flood denetimi ──────────────────────────────────────────────
                if (remoteJid.endsWith('@g.us') && !m.key.fromMe && m.key.participant) {
                    const isFlooding = global.antifloodTrack?.(remoteJid, m.key.participant);
                    if (isFlooding) {
                        try {
                            const floodGs = global.antifloodSettings?.get(remoteJid);
                            if (floodGs?.enabled) {
                                const num = m.key.participant.split('@')[0];
                                await sock.sendMessage(remoteJid, {
                                    text: `⚠️ @${num} flood yaptığı için gruptan çıkarıldı.`,
                                    mentions: [m.key.participant],
                                });
                                await sock.groupParticipantsUpdate(remoteJid, [m.key.participant], 'remove');
                            }
                        } catch { /* yoksay */ }
                    }
                }

                // Önce zaman damgasını hesapla — hem eski mesaj hem tip filtreleri kullanır.
                const msgTs = (m.messageTimestamp || 0) * 1000;

                // Yeniden bağlanmada çok eski bir birikimi tekrar işlememek için 5 dakikadan eski
                // mesajları atla. 30sn çok kısaydı — Heroku / yavaş başlayan ortamlarda bot
                // 30sn'den uzun sürede çevrimiçi oluyor ve o aralıkta gönderilen mesajlar sessizce
                // düşüyordu. Aşağıdaki tekrar önleme kümesi aynı mesajın iki kez işlenmesini zaten engelliyor.
                if (msgTs && (Date.now() - msgTs) > 5 * 60 * 1000) continue;

                // 5 dakikalık eskilik kontrolünü geçen tüm mesajları tipinden bağımsız işle.
                // WhatsApp Business, çoklu cihaz ve sahibin bağlı telefonundan gelen kendi komutları
                // 'notify' değil type='append' olarak gelir. Burada tipe göre filtrelemek bunları
                // sessizce düşürür. Yukarıdaki 5 dk kontrolü + aşağıdaki tekrar önleme kümesi,
                // yeniden bağlanmada eski geçmişin tekrar oynatılmasına karşı doğru korumalardır.
                // (isRecent / isNotify filtresi yok — eskilik + tekrar önleme yeterli.)

                // Tekrar önleme: burada yalnızca kontrol et (kaydetme) — içeriği doğruladıktan SONRA kaydederiz.
                // !m.message kontrolünden önce kaydetmek kümeyi zehirler: boş bir taslak teslimat
                // (metin/medya yok) ID'yi kilitler, ardından metinli gerçek teslimat "tekrar" sayılıp
                // sessizce düşerdi. LID kullanıcılarının komutlarının handler'a ulaşmamasının kök nedeni buydu.
                const cmdMsgId = m.key.id;
                if (isDuplicateMessage(m, seenCmdIds)) continue;
                // (seenCmdIds.add ertelendi — içerik doğrulandıktan sonra aşağıya bakın)

                // ── LID oturumu otomatik onarımı ─────────────────────────────────────
                // fromMe bir LID mesajının şifresi çözülemediğinde (messageStubType=CIPHERTEXT=2),
                // o alt cihaz için Signal oturumu eksiktir. assertSessions() daha önce
                // @s.whatsapp.net JID biçimiyle çağrıldı ve not-acceptable aldı (bu yüzden cihaz
                // o biçimde kara listeye alındı). Yerel @lid biçimiyle yeniden dene —
                // WhatsApp @lid adresleri için prekey sağlar; bu da oturumu kurarak o alt
                // cihazın GELECEK mesajlarının çözülmesini sağlar.
                if (!m.message && m.messageStubType === 2 /* CIPHERTEXT */) {
                    const senderLid = m.key?.senderLid
                        || (m.key?.remoteJid?.endsWith('@lid') ? m.key.remoteJid : null);
                    if (senderLid && typeof sock.assertSessions === 'function') {
                        sock.assertSessions([senderLid], false).catch(() => {});
                    }
                    // Çözülemeyen mesajları tanılama için izle. Burada Signal oturum
                    // dosyalarını SİLME: tek bir bozuk/eski gönderen oturumu hesabın şifreleme
                    // durumunu yok etmemeli. Önceki 10'dan sonra sıfırlama davranışı "No sessions"
                    // hatalarına yol açıyor ve hesap yeniden eşleştirilene kadar diğer tüm
                    // kişilerin mesajlarının çözülmesini durduruyordu.
                    const recoveryState = trackUndecryptableMessage(
                        { count: global._nullMsgCount || 0 },
                        count => logMessage('WARN', `[Session] ${count} çözülemeyen mesaj — mevcut anahtarlar korunuyor ve devam ediliyor; etkilenen gönderen oturumu yeniden denenecek.`)
                    );
                    global._nullMsgCount = recoveryState.count;
                } else if (m.message) {
                    // Bir mesaj başarıyla çözülür çözülmez sayacı sıfırla
                    global._nullMsgCount = 0;
                }

                // ---- Diğer mesajlar için: bülten / yayın / grup / özel komutlar
                // fromMe taslak mesajlar (çoklu cihaz senkronu) için içeriği depodan kurtarmayı dene
                if (!m.message) {
                    if (m.key.fromMe) {
                        const _stored = store.loadMessage(m.key.remoteJid, m.key.id);
                        if (_stored?.message) m = { ...m, message: _stored.message };
                        else continue;
                    } else {
                        // İçerik yok — atla ama seenCmdIds'e EKLEME; böylece metinli gerçek
                        // teslimat geldiğinde işlenir.
                        continue;
                    }
                }

                // İçerik doğrulandı — şimdi bu ID'yi kilitle ki iki kez işlenmesin.
                rememberMessageIfContent(m, seenCmdIds);

                // ── Anti-ViewOnce: otomatik göster ve sahibe ilet ───────────────────
                if (global.antivvEnabled && !m.key.fromMe) {
                    // viewOnce yüküne ulaşmadan önce yaygın kapsayıcı katmanları aç.
                    // WhatsApp çoğunlukla view-once'ı ephemeral veya belge+başlık kapsayıcılarına sarar.
                    const rawMsg = m.message;
                    const unwrapped =
                        rawMsg?.ephemeralMessage?.message ||
                        rawMsg?.documentWithCaptionMessage?.message ||
                        rawMsg;
                    const vMsg =
                        unwrapped?.viewOnceMessageV2?.message ||
                        unwrapped?.viewOnceMessageV2Extension?.message ||
                        unwrapped?.viewOnceMessage?.message ||
                        rawMsg?.viewOnceMessageV2?.message ||
                        rawMsg?.viewOnceMessageV2Extension?.message ||
                        rawMsg?.viewOnceMessage?.message;

                    if (vMsg) {
                        const rawBotJid = global.botJid || sock.user?.id || `${config.OWNER_NUMBER}@s.whatsapp.net`;
                        const ownerJid  = rawBotJid.includes(':')
                            ? `${rawBotJid.split(':')[0]}@s.whatsapp.net`
                            : rawBotJid;
                        const chatJid  = m.key.remoteJid;
                        const senderJid = m.key.participant || chatJid;
                        const senderNum = senderJid.split('@')[0];
                        const chatLabel = chatJid.endsWith('@g.us') ? `Grup: ${chatJid.split('@')[0]}` : 'Özel';

                        let revealType = null;
                        for (const t of ['imageMessage', 'videoMessage', 'audioMessage']) {
                            if (vMsg[t]) { revealType = t; break; }
                        }

                        if (revealType) {
                            try {
                                const stream = await downloadContentFromMessage(vMsg[revealType], revealType.replace('Message', ''));
                                let buffer = Buffer.from([]);
                                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                                const header = `👁️ *Anti-ViewOnce*\n👤 Gönderen: @${senderNum}\n📌 ${chatLabel}`;
                                const mime   = vMsg[revealType]?.mimetype;

                                if (revealType === 'imageMessage') {
                                    await sock.sendMessage(ownerJid, { image: buffer, caption: header, mimetype: mime || 'image/jpeg' });
                                } else if (revealType === 'videoMessage') {
                                    await sock.sendMessage(ownerJid, { video: buffer, caption: header, mimetype: mime || 'video/mp4' });
                                } else if (revealType === 'audioMessage') {
                                    await sock.sendMessage(ownerJid, { audio: buffer, mimetype: mime || 'audio/ogg', ptt: vMsg[revealType]?.ptt || false });
                                    await sock.sendMessage(ownerJid, { text: header });
                                }
                                logMessage('INFO', `Anti-VV: ${senderNum} kişisinden ${revealType} sahibe iletildi`);
                            } catch (e) {
                                logMessage('WARN', `Anti-VV başarısız: ${e.message}`);
                            }
                        }
                    }
                }

                // m.key.remoteJid'i olduğu gibi kullan — @lid'i asla @s.whatsapp.net'e çevirme.
                // @s.whatsapp.net = normal WA DM, @lid = Business/gizlilik DM, @g.us = grup.
                // handleMessages ve safeSend üç sonek türünü de kabul eder.
                const sender = m.key.remoteJid;
                const isGroupMsg = sender.endsWith('@g.us');
                const isLidDm = sender.endsWith('@lid');
                const isNewsletter = sender.endsWith('@newsletter');
                const isBroadcast = isJidBroadcast(sender) || isJidStatusBroadcast(sender);

                // --- Bülten mesajları — otomatik takip + tepki, sonra atla
                if (isNewsletter) {
                    if (process.uptime() > 25) {
                        const nlJid    = m.key.remoteJid;
                        // newsletterReactMessage için server_id gerekli
                        const serverId = m.key.server_id || m.key.id;

                        // Otomatik takip: bültenler yalnızca abone olduğunda VEYA WhatsApp öne çıkardığında gelir.
                        // Mesaj aldığımız her yeni bülten JID'ini (oturum başına bir kez) takip et.
                        if (true) { // bize mesaj gönderen bültenleri her zaman otomatik takip et
                            if (!global._followedNewsletters) global._followedNewsletters = new Set();
                            if (!global._followedNewsletters.has(nlJid)) {
                                try {
                                    await sock.newsletterFollow(nlJid);
                                    global._followedNewsletters.add(nlJid);
                                    logMessage('INFO', `✅ Bülten otomatik takip edildi: ${nlJid}`);
                                } catch (e) {
                                    const emsg = e.message || '';
                                    if (/already|409|subscribed|unexpected response/i.test(emsg)) {
                                        global._followedNewsletters.add(nlJid);
                                        logMessage('INFO', `✅ Bülten zaten takip ediliyor: ${nlJid}`);
                                    } else {
                                        logMessage('WARN', `Bülten takibi başarısız (${nlJid}): ${emsg}`);
                                    }
                                    void 0; // orijinal yığın logunu bastır
                                }
                            }
                        }

                        // Doğru bülten API'siyle tepki ver (sendMessage değil)
                        if (serverId) {
                            const isOwnNewsletter = nlJid === '120363200367779016@newsletter';
                            const reactEmoji = isOwnNewsletter
                                ? '❤️'
                                : config.AUTO_REACT_NEWSLETTER
                                    ? (['🤖','🔥','💫','❤️','👍','💯','✨','👏','😎'])[Math.floor(Math.random() * 9)]
                                    : null;
                            if (reactEmoji) {
                                try {
                                    await sock.newsletterReactMessage(nlJid, serverId, reactEmoji);
                                    logMessage('INFO', `${nlJid} bülteninin ${serverId} mesajına ${reactEmoji} ile tepki verildi`);
                                } catch (e) {
                                    logMessage('WARN', `Bülten tepkisi başarısız: ${e.message}`);
                                }
                            }
                        }
                    }
                    continue;
                }

                logMessage('MESSAGE', `${sender} kaynağından yeni ${isGroupMsg ? 'grup' : isLidDm ? 'lid-dm' : isBroadcast ? 'yayın' : 'özel'} mesaj`);

                // Tüm komut dağıtımını handler.js'e devret
                // (önek kontrolü, izinler, grup yöneticisi, run() API'sini yönetir)
                if (config.READ_MESSAGE) {
                    try { await sock.readMessages([m.key]); } catch (e) { /* yoksay */ }
                }
                await handleMessages(sock, m);
            }
        } catch (err) {
            logMessage('ERROR', `messages.upsert birleşik işleyici hatası: ${err.stack || err.message}`);
        }
    });

    return sock;
}

// ✅ Express Web API
const app = express();
app.use(express.static(path.join(__dirname, 'smm')));
app.get('/', (req, res) => {
    const html = path.join(__dirname, 'smm', 'silva.html');
    if (fs.existsSync(html)) return res.sendFile(html);
    res.send(`<h2>✅ ${config.BOT_NAME} Çalışıyor!</h2>`);
});
app.get('/health', (req, res) => res.json({ status: 'ok', bot: config.BOT_NAME, time: new Date().toISOString() }));
app.get('/ping', (req, res) => res.send('pong'));

// ✅ GitHub API Proxy — tarayıcı kaynaklı 403 istek sınırı hatalarından kaçınmak için sunucu tarafında
// GitHub'ın sınırları içinde kalmak için yanıtları 5 dakika önbelleğe al
const _ghCache = new Map();
const GH_CACHE_TTL = 5 * 60 * 1000;
const GH_OWNER = 'AlphaB';
const GH_REPO  = 'silva-md-bot';

async function ghFetch(endpoint) {
    const now = Date.now();
    const cached = _ghCache.get(endpoint);
    if (cached && now - cached.ts < GH_CACHE_TTL) return { ok: true, data: cached.data };

    const https = require('https');
    const token = process.env.GITHUB_TOKEN || '';
    const headers = { 'User-Agent': 'silva-md-bot', 'Accept': 'application/vnd.github+json' };
    if (token) headers['Authorization'] = `token ${token}`;

    return new Promise((resolve) => {
        const opts = { hostname: 'api.github.com', path: endpoint, headers, timeout: 10000 };
        const req = https.get(opts, r => {
            let body = '';
            r.on('data', d => body += d);
            r.on('end', () => {
                try {
                    if (r.statusCode === 202) { resolve({ ok: false, reason: 'generating' }); return; }
                    if (r.statusCode === 403 || r.statusCode === 429) { resolve({ ok: false, reason: 'rate_limit' }); return; }
                    if (r.statusCode >= 400) { resolve({ ok: false, reason: `gh_${r.statusCode}` }); return; }
                    const parsed = JSON.parse(body);
                    _ghCache.set(endpoint, { ts: Date.now(), data: parsed });
                    resolve({ ok: true, data: parsed });
                } catch(e) { resolve({ ok: false, reason: 'parse_error' }); }
            });
        });
        req.on('error', () => resolve({ ok: false, reason: 'network' }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    });
}

app.get('/api/repo', async (req, res) => {
    const result = await ghFetch(`/repos/${GH_OWNER}/${GH_REPO}`);
    if (result.ok) return res.json(result.data);
    res.json({ _error: result.reason, name: GH_REPO, stargazers_count: null, forks_count: null, open_issues_count: null });
});

app.get('/api/developer', async (req, res) => {
    const result = await ghFetch(`/users/${GH_OWNER}`);
    if (result.ok) return res.json(result.data);
    res.json({ _error: result.reason, login: GH_OWNER, name: 'Alpha', bio: '', followers: null, public_repos: null, avatar_url: '' });
});

app.get('/api/commits', async (req, res) => {
    const result = await ghFetch(`/repos/${GH_OWNER}/${GH_REPO}/stats/commit_activity`);
    if (result.ok) return res.json(result.data || []);
    res.json([]);
});

app.get('/api/plugins', (req, res) => {
    try {
        const dir = path.join(__dirname, 'plugins');
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
        res.json(files.map(f => ({ name: f.replace('.js',''), path: `plugins/${f}`, type: 'file' })));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

function startHttpServer(retryCount = 0) {
    const httpServer = app.listen(port, () => {
        logMessage('INFO', `🌐 Sunucu ${port} portunda çalışıyor`);
        logMessage('INFO', `📊 Panel şu adreste: http://localhost:${port}`);

        // ── Heroku canlı tutma kendi kendine ping ─────────────────────────────
        const keepAliveUrl = process.env.APP_URL || process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME
            ? `https://${process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME}/ping`
            : null;

        if (keepAliveUrl || process.env.APP_URL) {
            const pingUrl = process.env.APP_URL
                ? `${process.env.APP_URL.replace(/\/$/, '')}/ping`
                : keepAliveUrl;
            const https = require('https');
            const http  = require('http');
            const pinger = pingUrl.startsWith('https') ? https : http;

            setInterval(() => {
                try {
                    pinger.get(pingUrl, (res) => {
                        logMessage('DEBUG', `[KeepAlive] ping atıldı ${pingUrl} → ${res.statusCode}`);
                    }).on('error', (e) => {
                        logMessage('WARN', `[KeepAlive] ping başarısız: ${e.message}`);
                    });
                } catch (e) { /* yoksay */ }
            }, 25 * 60 * 1000);

            logMessage('INFO', `🔄 Heroku canlı tutma etkin → ${pingUrl}`);
        }
    });

    httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && retryCount < 10) {
            const delay = (retryCount + 1) * 2000;
            logMessage('WARN', `⚠️ ${port} portu kullanımda — ${delay / 1000}sn sonra yeniden denenecek (deneme ${retryCount + 1}/10)…`);
            setTimeout(() => startHttpServer(retryCount + 1), delay);
        } else if (err.code === 'EADDRINUSE') {
            logMessage('ERROR', `${port} portu 10 denemeden sonra hâlâ kullanımda — panel çevrimdışı`);
        } else {
            logMessage('ERROR', `HTTP sunucu hatası: ${err.message}`);
        }
    });
}

startHttpServer();

// ✅ Hata yönetimi
process.on('uncaughtException', (err) => {
    const msg = err.message || '';
    // Bad MAC = Ephemeral dosya sistemlerinde (örn. Heroku) eski oturum anahtarlarından
    // kaynaklanan Signal şifre çözme hatası. Ölümcül değil — bunun için asla yeniden bağlanma.
    if (/bad mac/i.test(msg)) {
        try { logMessage('DEBUG', `[Signal] Çözmede Bad MAC (eski oturum anahtarı) — atlanıyor`); } catch (_) {}
        return;
    }
    // EADDRINUSE = yeniden başlatma sırasında port önceki işlem tarafından tutuluyor.
    // HTTP sunucusu bunu zarifçe yönetti; bot panel olmadan devam eder.
    if (err.code === 'EADDRINUSE' || /EADDRINUSE|address already in use/i.test(msg)) {
        try { logMessage('WARN', `⚠️ Port kullanımda (EADDRINUSE) — bot panel olmadan devam ediyor`); } catch (_) {}
        return;
    }
    try {
        logMessage('CRITICAL', `Yakalanmamış İstisna: ${err.stack || err.message}`);
    } catch (_) {}
    setTimeout(() => {
        connectToWhatsApp().catch(e => {
            try { logMessage('CRITICAL', `Yeniden bağlanma başarısız: ${e.message}`); } catch (_) {}
        });
    }, 5000);
});
process.on('unhandledRejection', (reason, promise) => {
    const msg = String(reason?.message || reason || '');
    if (/bad mac/i.test(msg)) {
        try { logMessage('DEBUG', `[Signal] Bad MAC reddi (eski oturum anahtarı) — atlanıyor`); } catch (_) {}
        return;
    }
    try {
        logMessage('WARN', `Ele Alınmamış Reddetme: ${reason}`);
    } catch (_) {}
});

// ✅ Botu Başlat
(async () => {
    try {
        console.log('\x1b[36m');
        console.log('╔══════════════════════════════════════════╗');
        console.log('║  ____  _ _                 __  __ ____   ║');
        console.log('║ / ___|| (_)_   ____ _     |  \\/  |  _ \\  ║');
        console.log('║ \\___ \\| | \\ \\ / / _` |    | |\\/| | | | | ║');
        console.log('║  ___) | | |\\ V / (_| |    | |  | | |_| | ║');
        console.log('║ |____/|_|_| \\_/ \\__,_|    |_|  |_|____/  ║');
        console.log('║                                            ║');
        console.log('║        WhatsApp Botu  •  Node.js          ║');
        console.log('║     github.com/Alpha  •  v2.0           ║');
        console.log('╚══════════════════════════════════════════╝');
        console.log('\x1b[0m');
        logMessage('INFO', 'Alpha Bot başlatılıyor...');

        // ── Sudo kullanıcılarını diskten yükle ──────────────────────────────
        try {
            const sudoPath = require('path').join(__dirname, 'data', 'sudo.json');
            if (require('fs').existsSync(sudoPath)) {
                const sudoList = JSON.parse(require('fs').readFileSync(sudoPath, 'utf8'));
                global.sudoUsers = new Set(Array.isArray(sudoList) ? sudoList : []);
                logMessage('INFO', `${global.sudoUsers.size} sudo kullanıcı yüklendi`);
            } else {
                global.sudoUsers = new Set();
            }
        } catch (e) {
            global.sudoUsers = new Set();
            logMessage('WARN', `Sudo listesi yüklenemedi: ${e.message}`);
        }

        // loadSession başlangıçta BİR KEZ çağrılır.
        // connectToWhatsApp() ve tüm yeniden bağlanmalar diskteki kayıtlı durumu kullanır.
        await loadSession();
        await connectToWhatsApp();
    } catch (e) {
        logMessage('CRITICAL', `Bot Başlatma Başarısız: ${e.stack || e.message}`);
        setTimeout(() => connectToWhatsApp(), 5000);
    }
})();
