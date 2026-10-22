'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getStr, getActiveTheme } = require('./lib/theme');
const { extractMessageText, unwrapMessageContent } = require('./lib/message-utils');

let isJidGroup, areJidsSameUser, jidNormalizedUser, normalizeMessageContent;
try {
    ({ isJidGroup, areJidsSameUser, jidNormalizedUser, normalizeMessageContent } = require('@whiskeysockets/baileys'));
} catch {
    isJidGroup            = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');
    jidNormalizedUser     = (jid) => (jid || '').replace(/:[^@]+@/, '@');
    areJidsSameUser       = (a, b) => jidNormalizedUser(a) === jidNormalizedUser(b);
    normalizeMessageContent = (c) => c;
}

// Herhangi bir JID formatından yalın telefon numarası dizesini çıkarır
function jidToNum(jid) {
    if (!jid) return '';
    return jidNormalizedUser(jid).split('@')[0].replace(/\D/g, '');
}

// İki telefon numarası aynı aboneye aitse true döner.
// Eksik ülke kodlarını, son 9 anlamlı haneyi karşılaştırarak ele alır.
function sameNumber(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const minLen = Math.min(a.length, b.length);
    const tail   = Math.min(minLen, 9);
    return tail >= 6 && a.slice(-tail) === b.slice(-tail);
}

// ─── Yetki sabitleri ─────────────────────────────────────────────────────────
const PERM = {
    PUBLIC: 'public',
    ADMIN:  'admin',
    OWNER:  'owner'
};

// ─── Grup meta verisi önbelleği (5 dk TTL) ──────────────────────────────────
const groupCache = new Map();
const GROUP_CACHE_TTL = 5 * 60 * 1000;

async function getCachedGroupMetadata(sock, jid) {
    const hit = groupCache.get(jid);
    if (hit && Date.now() < hit.expiry) return hit.metadata;
    try {
        const metadata = await sock.groupMetadata(jid);
        groupCache.set(jid, { metadata, expiry: Date.now() + GROUP_CACHE_TTL });
        return metadata;
    } catch {
        return null;
    }
}

// Grup üyeliği değiştiğinde önbelleği geçersiz kıl
function bindGroupCacheInvalidation(sock) {
    sock.ev.on('group-participants.update', ({ id }) => groupCache.delete(id));
}

const sendTimestamps = [];
const MAX_SENDS_PER_MIN = 30;

async function safeSend(sock, jid, content, opts = {}) {
    if (!jid || !sock?.sendMessage) return null;

    // Açıkça geçersiz JID'leri reddet.  Geçerli DM sonekleri: @s.whatsapp.net, @lid, @c.us
    // Geçerli grup soneki: @g.us.  Bunların dışındaki her şey (örn. yalın telefon numarası) reddedilir.
    const validSuffix = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')
        || jid.endsWith('@g.us') || jid.endsWith('@c.us') || jid.endsWith('@newsletter');
    if (!validSuffix) {
        console.error(`❌ SEND ABORTED — invalid JID "${jid}" (must end @s.whatsapp.net / @lid / @g.us)`);
        return null;
    }

    const isLidDm  = jid.endsWith('@lid');
    const _preview = (content?.text || content?.caption || '[media]').toString().slice(0, 60);
    const _to      = jid.split('@')[0];

    // Hız sınırı + rastgele gecikme (jitter)
    const now = Date.now();
    while (sendTimestamps.length && now - sendTimestamps[0] > 60000) sendTimestamps.shift();
    if (sendTimestamps.length >= MAX_SENDS_PER_MIN) {
        const wait = 60000 - (now - sendTimestamps[0]);
        await new Promise(r => setTimeout(r, Math.min(wait, 3000)));
    }
    const jitter = Math.floor(Math.random() * 400) + 100;
    await new Promise(r => setTimeout(r, jitter));
    sendTimestamps.push(Date.now());

    // @lid DM: göndermeden önce giden uçtan uca (E2E) oturumu (prekey'ler) kur.
    // Bu olmadan Baileys mesajı kuyruğa alır ancak WA, botun o LID hesabı için
    // kayıtlı bir gönderme oturumu olmadığından mesajı sessizce düşürür.
    // m.key.remoteJid'i doğrudan kullan — burada asla @s.whatsapp.net'e yeniden oluşturma veya eşleme yapma.
    if (isLidDm && typeof sock.assertSessions === 'function') {
        try { await sock.assertSessions([jid], false); } catch { /* kritik değil */ }
    }

    // Deneme 1 — birincil: m.key.remoteJid olduğu gibi, tam seçeneklerle (quoted + contextInfo)
    try {
        const result = await sock.sendMessage(jid, content, opts);
        console.log(`✉️  OUT  to=${_to}  "${_preview}"`);
        return result;
    } catch (err) {
        console.error(`❌ SEND FAILED (attempt 1)  to=${jid}: ${err.message}`);
    }

    // Deneme 2 — alıntılı yanıtı kaldır.
    // WhatsApp Business mesajları, Baileys'in alıntı bağlamını oluştururken eklediği
    // bir messageContextInfo sarmalayıcısı taşır; WA Business sunucuları bunu reddeder.
    // Ayrıca içerikteki contextInfo'dan newsletter forwardedNewsletterMessageInfo'yu da kaldır.
    if (opts.quoted) {
        const { quoted: _q, ...optsNoQuote } = opts;
        const safeContent = { ...content };
        if (safeContent.contextInfo?.forwardedNewsletterMessageInfo) {
            const { forwardedNewsletterMessageInfo: _n, ...ci } = safeContent.contextInfo;
            safeContent.contextInfo = Object.keys(ci).length ? ci : undefined;
        }
        try {
            const result = await sock.sendMessage(jid, safeContent, optsNoQuote);
            console.log(`✉️  OUT (no-quote retry)  to=${_to}  "${_preview}"`);
            return result;
        } catch (err2) {
            console.error(`❌ SEND FAILED (attempt 2 no-quote)  to=${jid}: ${err2.message}`);
        }
    }

    // Deneme 3 — düz metin, hiçbir seçenek olmadan
    if (content?.text || content?.caption) {
        const plainText = content.text || content.caption;
        try {
            const result = await sock.sendMessage(jid, { text: plainText });
            console.log(`✉️  OUT (plain fallback)  to=${_to}  "${_preview}"`);
            return result;
        } catch (err3) {
            console.error(`❌ SEND FAILED (attempt 3 plain)  to=${jid}: ${err3.message}`);
        }
    }

    return null;
}

// Newsletter filigranı — yalnızca özel sohbetlerde güvenli; gruplara boş nesne verilir
const GLOBAL_CONTEXT_INFO = {
    forwardingScore: 999,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
        newsletterJid: '120363200367779016@newsletter',
        newsletterName: '◢◤ Alpha ◢◤',
        serverMessageId: 144
    }
};

// ─── Eklenti yükleyici ───────────────────────────────────────────────────────
const plugins = [];
const pluginDir = path.join(__dirname, 'plugins');

function loadPlugins() {
    if (!fs.existsSync(pluginDir)) return;
    const files = fs.readdirSync(pluginDir).filter(f => f.endsWith('.js'));

    for (const file of files) {
        const pluginPath = path.join(pluginDir, file);
        try {
            delete require.cache[require.resolve(pluginPath)];
            const plugin = require(pluginPath);

            // Dizi dışa aktarımlarını destekle (örn. module.exports = [plugin1, plugin2, ...])
            const mods = Array.isArray(plugin) ? plugin : [plugin];

            for (const mod of mods) {
                if (!mod) continue;
                if (!mod.commands && mod.name) mod.commands = [mod.name];
                if (!mod.run && typeof mod.handler === 'function') mod.run = mod.handler;

                if (Array.isArray(mod.commands) && mod.commands.length && typeof mod.run === 'function') {
                    plugins.push(mod);
                } else {
                    if (mods.length === 1) console.warn(`[Plugin] Skipped: ${file} — missing commands or run/handler`);
                }
            }
        } catch (err) {
            console.error(`[Plugin] Error loading ${file}: ${err.message}`);
        }
    }
    console.log(`[Plugin] ✅ ${plugins.length} plugins loaded successfully`);
}

loadPlugins();

// ─── Bağlantı işleyicileri ───────────────────────────────────────────────────
function setupConnectionHandlers(sock) {
    bindGroupCacheInvalidation(sock);
    sock.ev.on('connection.update', ({ connection }) => {
        if (connection === 'open') console.log('[Handler] WhatsApp connection open.');
    });
    sock.ev.on('group-participants.update', async (update) => {
        for (const p of plugins) {
            if (typeof p.onGroupParticipantsUpdate !== 'function') continue;
            try { await p.onGroupParticipantsUpdate(sock, update); } catch { /* yoksay */ }
        }
    });
}

// ─── Komut tahmincisi ────────────────────────────────────────────────────────
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
        Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
    );
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return dp[m][n];
}

function predictCommand(typed, allPlugins) {
    const flat = [];
    for (const plugin of allPlugins)
        for (const cmd of (plugin.commands || []))
            flat.push({ cmd, plugin });

    // 1. Belirsiz olmayan önek eşleşmesi (yazılan ≥ 3 karakter, tam olarak bir komutla eşleşir)
    if (typed.length >= 3) {
        const hits = flat.filter(({ cmd }) => cmd.startsWith(typed));
        if (hits.length === 1)
            return { plugin: hits[0].plugin, match: hits[0].cmd, confidence: 'prefix' };
        if (hits.length > 1)
            return { matches: [...new Set(hits.map(h => h.cmd))], confidence: 'ambiguous' };
    }

    // 2. Levenshtein mesafesi ile bulanık eşleşme
    //    eşik = kısa komutlar için 1 (≤4 karakter), daha uzun olanlar için 2
    let best = null, bestDist = Infinity;
    for (const { cmd, plugin } of flat) {
        const dist = levenshtein(typed, cmd);
        const threshold = typed.length <= 4 ? 1 : 2;
        if (dist <= threshold && dist < bestDist) {
            best = { plugin, match: cmd, confidence: dist === 1 ? 'typo' : 'fuzzy' };
            bestDist = dist;
        }
    }
    return best;
}

// ─── Ana mesaj işleyicisi ────────────────────────────────────────────────────
function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

async function handleMessages(sock, message) {
    try {
        // normalizeMessageContent, WhatsApp Business / çoklu cihaz sarmalayıcılarını açar:
        // ephemeralMessage, viewOnceMessage, documentWithCaptionMessage, editedMessage vb.
        // Bu olmadan Business hesaplarında, metin bir sarmalayıcı alanın bir seviye
        // derinine gömülü olsa bile msg.conversation === undefined olabilir.
        const rawMsg = message.message;
        if (!rawMsg) return;

        const _normalized = (typeof normalizeMessageContent === 'function'
            ? normalizeMessageContent(rawMsg)
            : rawMsg) || rawMsg;
        const msg = unwrapMessageContent(_normalized) || _normalized;


        // jid  = yanıt verilecek sohbet — her zaman m.key.remoteJid, ASLA yeniden oluşturulmaz.
        // Geçerli sonekler: @s.whatsapp.net (normal WA), @lid (Business / gizlilik DM),
        // @g.us (grup).  Burada @lid'i @s.whatsapp.net'e eşleme — safeSend oturum
        // kurulumunu ve telefon-JID yedeğini otomatik olarak halleder.
        const jid    = message.key.remoteJid;
        // from = komutu yazan kişi.
        // fromMe özel mesajlarda participant tanımsızdır ve jid alıcıdır —
        // gönderen değil.  Bunu düzelt, böylece ctx.from her zaman gerçek
        // göndereni ifade eder (fromMe ise botun kendi JID'i, gruptaysa participant,
        // gelen özel mesajlarda ise uzak JID).
        const _botOwnJid = global.botJid || '';
        const from = message.key.participant
            || (message.key.fromMe && !isJidGroup(jid) ? (_botOwnJid || jid) : jid);
        // sender = yanıtlar için sohbet JID'i (eski eklentilerin m.key.remoteJid beklentisiyle uyumlu)
        const sender = jid;
        if (!jid || !from) return;

        // ── Otomatik durum (presence): gelen her mesajda anında tetiklenir ──
        if (!message.key.fromMe && (config.AUTO_TYPING || config.AUTO_RECORDING)) {
            const presenceType = config.AUTO_RECORDING ? 'recording' : 'composing';
            try { await sock.sendPresenceUpdate(presenceType, jid); } catch { /* kritik değil */ }
        }

        // isGroup: @g.us = grup, @s.whatsapp.net / @lid / @c.us = DM
        const isGroup = isJidGroup(jid);

        // ── Çoklu önek ayrıştırıcı ───────────────────────────────────────────
        // PREFIX ortam değişkeni şunları destekler:
        //   '.'          → yalnızca nokta öneki
        //   '.,!,/,?'    → virgülle ayrılmış liste — herhangi biri çalışır
        //   'any'        → baştaki herhangi bir alfanümerik/boşluk olmayan tek karakter
        //   '' / 'none'  → önek gerekmez (yalın komut kelimeleri eşleştirilir)
        const rawPrefix   = (config.PREFIX || '.').trim();
        const noPrefixMode  = !rawPrefix || rawPrefix.toLowerCase() === 'none' || rawPrefix.toLowerCase() === 'false';
        const anyPrefixMode = rawPrefix.toLowerCase() === 'any';
        const prefixList    = (!noPrefixMode && !anyPrefixMode)
            ? rawPrefix.split(',').map(p => p.trim()).filter(Boolean)
            : [];
        // yardım metninde / eklenti çıktısında kullanılan birincil önek
        const prefix = prefixList[0] || (anyPrefixMode ? '.' : '');

        // ── Metni çıkar ──────────────────────────────────────────────────────
        // Bilinen tüm mesaj türlerini dolaş — WhatsApp Business ve daha yeni
        // WA sürümleri içeriği farklı sarar. Sıra: en özelden → en genele.
        const text = extractMessageText(rawMsg, normalizeMessageContent);

        // ── AFK otomatik yanıtı (önek kontrolünden önce çalışır, sahibin kendi mesajlarında çalışmaz) ──
        if (!message.key.fromMe) {
            const afkPlugin = plugins.find(p => p.commands?.includes('afk') && typeof p.isAfk === 'function');
            if (afkPlugin?.isAfk()) {
                const { reason, since } = afkPlugin.getAfkData();
                const th = getActiveTheme()?.global || {};
                await safeSend(sock, jid, {
                    text: [
                        `🤖 *${th.botName || 'Alpha'}*`,
                        ``,
                        `${th.greet2 ? `_${th.greet2}!_` : `_Merhaba!_`} Sahibim şu an *AFK* modunda.`,
                        `📝 *Neden:* ${reason}`,
                        `⏱ *Süre:* ${formatDuration(Date.now() - since)}`,
                        ``,
                        `_${th.footer || th.botName || 'Alpha'}_`
                    ].join('\n'),
                }, { quoted: message });
                return;
            }
        }

        // ── Bağlantı engelleyici (yalnızca grup, bot yönetici olmalı) ────────
        if (isGroup && !message.key.fromMe) {
            const antilinkOn = config.ANTILINK || global.antilinkGroups?.has(jid);
            if (antilinkOn) {
                const URL_REGEX = /(?:https?:\/\/|www\.)\S+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|gg|me|ly|co|app|xyz|info|tv|link|shop|live|club|online|site|store|pro|in|ng|ke|tz|ug|za|uk)\b(?:\/\S*)?/gi;
                if (URL_REGEX.test(text)) {
                    try {
                        await sock.sendMessage(jid, { delete: message.key });
                        const antlinkMsg = getStr('antlink') || `⚠️ @${from.split('@')[0]} bu grupta bağlantı paylaşmak yasaktır.`;
                        await safeSend(sock, jid, {
                            text: antlinkMsg,
                            mentions: [from]
                        });
                    } catch (e) {
                        console.error('[Antilink] delete failed:', e.message);
                    }
                    return;
                }
            }
        }

        // ── onMessage kancaları — TÜM mesajlar için tetiklenir (yalnızca komutlar değil) ──
        // Takip ve otomatik yanıt yalnızca diğer kişilerin mesajları içindir (botun kendisininkiler değil).
        if (!message.key.fromMe) {
            if (typeof global.trackMessage === 'function') try { global.trackMessage(jid, from); } catch {}
            if (typeof global.addXP === 'function') {
                try { global.addXP(jid, from); } catch {}
            }
            if (!isGroup && typeof global.checkAutoReply === 'function') {
                try {
                    const autoReply = global.checkAutoReply(from);
                    if (autoReply) {
                        await safeSend(sock, jid, { text: `💤 *Otomatik Yanıt:*\n\n${autoReply}` }, { quoted: message });
                    }
                } catch {}
            }
            if (isGroup && typeof global.checkWelcomeQuizAnswer === 'function') {
                try {
                    const result = global.checkWelcomeQuizAnswer(jid, from, text);
                    if (result?.passed) {
                        await safeSend(sock, jid, { text: `✅ @${from.split('@')[0]} karşılama sınavını geçti! Gruba hoş geldin! 🎉`, mentions: [from] });
                    }
                } catch {}
            }
        }
        // Eklenti onMessage kancaları herkes için tetiklenir — bağlı kişi
        // (fromMe=true) dahil — böylece sohbet duyarlı eklentiler hem özel hem de
        // grup sohbetlerinde sahibin kendi mesajlarına yanıt verir.
        for (const p of plugins) {
            if (typeof p.onMessage !== 'function') continue;
            try {
                await p.onMessage(sock, message, text, {
                    jid, sender, from, isGroup,
                    contextInfo: isGroup ? {} : GLOBAL_CONTEXT_INFO
                });
            } catch { /* eklenti onMessage hatalarını yoksay */ }
        }


        // ── Hangi önekin kullanıldığını (veya önek gerekip gerekmediğini) tespit et ──
        let usedPrefix = null;       // mesajda bulunan gerçek önek dizesi
        let commandText = '';        // öneki çıkarılmış metin

        if (noPrefixMode) {
            // Her mesaj bir komut olabilir — yalın kelimeleri eşleştir
            usedPrefix  = '';
            commandText = text.trim();
        } else if (anyPrefixMode) {
            // Alfanümerik / boşluk olmayan baştaki herhangi bir tek karakter = önek
            const first = text[0];
            if (first && !/^[a-zA-Z0-9\u00C0-\u024F\s]/.test(first)) {
                usedPrefix  = first;
                commandText = text.slice(1).trim();
            }
        } else {
            // Kesin önek listesi — her birini sırayla kontrol et, en uzun eşleşme kazanır
            const sorted = [...prefixList].sort((a, b) => b.length - a.length);
            for (const p of sorted) {
                if (text.startsWith(p)) {
                    usedPrefix  = p;
                    commandText = text.slice(p.length).trim();
                    break;
                }
            }
        }

        if (usedPrefix === null) {
            // "silva" veya "agent" kelimesinin önek olmadan yapay zeka asistanını tetiklemesine izin ver
            if (/^(silva|agent)\b/i.test(text.trim())) {
                usedPrefix  = '';
                commandText = text.trim();
            } else {
                // Hiçbir önek eşleşmedi — yazıyor göstergesini tetikle ve dur
                if (!message.key.fromMe && (config.AUTO_TYPING || config.AUTO_RECORDING)) {
                    const presenceType = config.AUTO_RECORDING ? 'recording' : 'composing';
                    try { await sock.sendPresenceUpdate(presenceType, jid); } catch { /* sorun yok */ }
                    setTimeout(async () => {
                        try { await sock.sendPresenceUpdate('paused', jid); } catch { /* sorun yok */ }
                    }, 2000);
                }
                return;
            }
        }

        const parts   = commandText.split(/\s+/);
        const command = (parts.shift() || '').toLowerCase();
        const args    = parts;
        if (!command) return;

        // ── Komut tahmincisi: yazım hatalarını / kısaltmaları çözümle ────────
        let resolvedCommand = command;
        let predictionNote  = null;
        const exactExists   = plugins.some(p => p.commands?.includes(command));
        if (!exactExists) {
            const prediction = predictCommand(command, plugins);
            if (prediction?.confidence === 'ambiguous') {
                const th = getActiveTheme()?.global || {};
                await safeSend(sock, jid, {
                    text: [
                        `❓ *Bunlardan birini mi demek istediniz?*`,
                        prediction.matches.map(c => `• \`${prefix}${c}\``).join('\n'),
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
                if (config.AUTO_TYPING || config.AUTO_RECORDING)
                    try { await sock.sendPresenceUpdate('paused', jid); } catch { /* sorun yok */ }
                return;
            } else if (prediction) {
                resolvedCommand = prediction.match;
                if (prediction.confidence !== 'exact') {
                    const th = getActiveTheme()?.global || {};
                    predictionNote = `_💡 Çalıştırılıyor_ \`${prefix}${resolvedCommand}\`${th.footer ? `\n_${th.footer}_` : ''}`;
                }
            }
        }

        // ── Grup meta verisini ÖNCE getir — LID çözümlemesi için gerekli ──────
        // Modern WhatsApp, grup mesajlarını telefon numarası yerine bir @lid
        // (gizlilik/hesap kimliği) ile gönderir. Herhangi bir karşılaştırma yapmadan
        // önce göndericinin gerçek telefon JID'ini bulmak için LID'i katılımcı listesinde aramalıyız.
        let isAdmin       = false;
        let isBotAdmin    = false;
        let groupMetadata = null;

        if (isGroup) {
            groupMetadata = await getCachedGroupMetadata(sock, jid);
        }

        // ── Gönderici telefonunu çözümle (@lid formatını ele al) ──────────────
        const isLid = typeof from === 'string' && from.endsWith('@lid');
        let resolvedFrom = from; // LID çözümlenirse gerçek telefon JID'i olacak

        if (isLid) {
            // 1. Grup katılımcı listesini dene (en doğru yöntem)
            if (groupMetadata?.participants) {
                for (const p of groupMetadata.participants) {
                    const pLid = p.lid || '';
                    if (pLid && (pLid === from || jidNormalizedUser(pLid) === jidNormalizedUser(from))) {
                        resolvedFrom = p.id; // LID'i gerçek telefon JID'i ile değiştir
                        break;
                    }
                }
            }

            // 2. silva.js tarafından doldurulan genel LID→telefon önbelleğine geri dön
            //    (alınan her mesaj, katılımcı LID + telefonunu cacheLidPhone ile önbelleğe alır)
            if (resolvedFrom === from && global.lidPhoneCache?.size) {
                const normLid = from.split(':')[0].split('@')[0];
                const cachedPhone = global.lidPhoneCache.get(normLid)
                    || global.lidPhoneCache.get(normLid + '@lid')
                    || global.lidPhoneCache.get(from);
                if (cachedPhone) {
                    resolvedFrom = cachedPhone.includes('@')
                        ? cachedPhone
                        : `${cachedPhone.replace(/\D/g, '')}@s.whatsapp.net`;
                }
            }
        }

        const fromNum = jidToNum(resolvedFrom);

        // ── Sahip / bot telefon numaralarını çözümle ──────────────────────────
        // Eski config nesnelerinin yanlış boş sonuca yol açmaması için önce doğrudan
        // process.env'den çek, ardından config ve global'e geri dön.
        const ownerRaw  = (process.env.OWNER_NUMBER || '').trim()
            || (typeof config.OWNER_NUMBER === 'string' ? config.OWNER_NUMBER.trim() : '')
            || (global.botNum || '');
        const ownerNum  = ownerRaw.replace(/\D/g, '');
        const botNum    = (global.botNum || '').replace(/\D/g, '');

        // Tamamen LID tabanlı gruplarda WhatsApp telefon numaralarını asla göstermez — tek
        // tanımlayıcı hesap LID'idir.  Göndericinin LID'i botun kendi LID'i ile
        // eşleşiyorsa aynı WhatsApp hesabıdırlar → sahip.
        // Karşılaştırmadan önce her iki taraf da normalleştirilmelidir (:cihazSoneki kaldırılır).
        const botLid     = jidNormalizedUser(global.botLid || '');
        const fromNorm   = jidNormalizedUser(from);

        const isSudo = global.sudoUsers?.size
            ? (global.sudoUsers.has(from) || global.sudoUsers.has(fromNorm) || global.sudoUsers.has(resolvedFrom)
               || (fromNum && [...global.sudoUsers].some(s => sameNumber(s.replace(/@.*/, ''), fromNum))))
            : false;

        const isOwner = message.key.fromMe
            || (botLid && fromNorm === botLid)
            || (botLid && jidNormalizedUser(resolvedFrom) === botLid)
            || (fromNum && ownerNum && (fromNum === ownerNum || sameNumber(fromNum, ownerNum)))
            || (fromNum && botNum   && (fromNum === botNum   || sameNumber(fromNum, botNum)))
            || isSudo;

        // ── Grup yöneticisi durumunu çözümle ──────────────────────────────────
        if (isGroup && groupMetadata?.participants) {
            const botJid     = sock.user?.id || '';
            const botPhone   = botNum;

            for (const p of groupMetadata.participants) {
                const role = p.admin;
                const isAdm = role === 'admin' || role === 'superadmin';
                const pPhone = (p.id || '').split('@')[0].replace(/\D/g, '');
                const pLid   = p.lid || '';

                // Bu katılımcı gönderici mi?
                const isSender =
                    areJidsSameUser(p.id, resolvedFrom) ||
                    (pLid && (pLid === from || jidNormalizedUser(pLid) === jidNormalizedUser(from))) ||
                    (pPhone && fromNum && sameNumber(pPhone, fromNum));

                // Bu katılımcı bot mu?
                const isBot =
                    areJidsSameUser(p.id, botJid) ||
                    (botLid && (jidNormalizedUser(p.id) === botLid || (pLid && jidNormalizedUser(pLid) === botLid))) ||
                    (botPhone && pPhone && sameNumber(pPhone, botPhone));

                if (isSender) isAdmin    = isAdm;
                if (isBot)    isBotAdmin = isAdm;
            }
        }

        // ── Birleşik bağlamı (context) oluştur ────────────────────────────────
        const ctx = {
            sock,
            conn:          sock,
            m:             message,
            message,
            sender,               // = jid (sohbet) — eklentilerin yanıt gönderdiği yer
            from,                 // = komutu yazan kişi
            jid,
            chat:          jid,
            isGroup,
            isAdmin,
            isBotAdmin,
            isOwner,
            isSudo,
            args,
            text,
            prefix,               // yardım metni için birincil/kanonik önek
            usedPrefix,           // bu komutu tetikleyen gerçek önek
            groupMetadata,
            contextInfo:   isGroup ? {} : GLOBAL_CONTEXT_INFO,
            mentionedJid:  msg.extendedTextMessage?.contextInfo?.mentionedJid || [],
            safeSend:      (content, opts) => safeSend(sock, jid, content, opts),
            reply:         (replyText) => safeSend(sock, jid, { text: replyText }, { quoted: message }),
            theme:         getActiveTheme()?.global || {},
            getStr,
            command:       resolvedCommand,
        };

        // ── Yasak kapısı — yasaklı kullanıcılar hiçbir komutu tetikleyemez (sahip her zaman muaf) ──
        if (!isOwner && global.bannedUsers?.size) {
            const senderNorm = jidNormalizedUser(from);
            if (global.bannedUsers.has(from) || global.bannedUsers.has(senderNorm) || global.bannedUsers.has(resolvedFrom)) {
                const th = getActiveTheme()?.global || {};
                return await safeSend(sock, jid, {
                    text: [
                        `⛔ *${th.botName || 'Alpha'}*`,
                        ``,
                        getStr('owner') || 'Bot komutlarını kullanmaktan yasaklandınız.',
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
            }
        }

        // ── Yönlendirme (dispatch) ────────────────────────────────────────────
        const RECORDING_CMDS = new Set(['play', 'song', 'sticker', 's', 'tiktok', 'tt', 'ttdl', 'tiktokdl', 'youtube', 'yt', 'instagram', 'igdl', 'ig', 'insta', 'facebook', 'fb', 'fbdl']);

        const fromNum2 = from.split('@')[0];
        const _chatLabel = isGroup ? `group:${jid.split('@')[0]}` : `dm:${jid.split('@')[0]}`;
        console.log(`⚡ CMD  "${usedPrefix}${resolvedCommand}"  from=+${fromNum2}  ${_chatLabel}  owner=${isOwner}  admin=${isAdmin}`);

        for (const plugin of plugins) {
            if (!plugin.commands.includes(resolvedCommand)) continue;

            const th = getActiveTheme()?.global || {};

            // ── Kapsam korumaları — temalı uyarılarla ────────────────────────
            const allowGroup   = plugin.group   !== false;
            const allowPrivate = plugin.private !== false;

            if (isGroup && !allowGroup) {
                await safeSend(sock, jid, {
                    text: [
                        `*${th.botName || 'Alpha'}*`,
                        ``,
                        getStr('private') || '⚠️ Bu özellik yalnızca özel sohbetlere yöneliktir.',
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
                continue;
            }

            if (!isGroup && !allowPrivate) {
                await safeSend(sock, jid, {
                    text: [
                        `*${th.botName || 'Alpha'}*`,
                        ``,
                        getStr('group') || '❗ Bu özellik yalnızca gruplara yöneliktir.',
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
                continue;
            }

            // ── Bot yönetici koruması ─────────────────────────────────────────
            if (plugin.botAdmin && !isBotAdmin) {
                await safeSend(sock, jid, {
                    text: [
                        `*${th.botName || 'Alpha'}*`,
                        ``,
                        getStr('botAdmin') || '❗ Lütfen önce bana yönetici rolü ver.',
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
                continue;
            }

            // ── Yetki kontrolü ────────────────────────────────────────────────
            const perm = (plugin.permission || PERM.PUBLIC).toLowerCase();
            let allowed = false;
            if      (perm === PERM.PUBLIC) allowed = true;
            else if (perm === PERM.ADMIN)  allowed = isAdmin || isOwner;
            else if (perm === PERM.OWNER)  allowed = isOwner;

            if (!allowed) {
                const alertKey = perm === PERM.OWNER ? 'owner' : 'admin';
                const fallback = perm === PERM.OWNER
                    ? '⛔ Bu komut yalnızca bot sahibine ayrılmıştır.'
                    : '⛔ Bu komut yalnızca grup yöneticilerine yöneliktir.';
                await safeSend(sock, jid, {
                    text: [
                        `*${th.botName || 'Alpha'}*`,
                        ``,
                        getStr(alertKey) || fallback,
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
                continue;
            }

            // ── Tahmin notu: kullanıcıya hangi komutun çözümlendiğini bildir ──
            if (predictionNote) {
                await safeSend(sock, jid, { text: predictionNote }, { quoted: message });
                predictionNote = null;
            }

            // ── Medya komutları için durumu (presence) kayıt olarak değiştir ──
            if (config.AUTO_RECORDING && RECORDING_CMDS.has(resolvedCommand)) {
                try { await sock.sendPresenceUpdate('recording', jid); } catch { /* kritik değil */ }
            }

            try {
                const PLUGIN_TIMEOUT_MS = 60_000;
                const _timeoutP = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Plugin timed out after ${PLUGIN_TIMEOUT_MS / 1000}s`)), PLUGIN_TIMEOUT_MS)
                );
                await Promise.race([plugin.run(sock, message, args, ctx), _timeoutP]);
            } catch (err) {
                const isTimeout = /timed out/i.test(err.message);
                console.error(`[Plugin:${command}] ${isTimeout ? '⏱ TIMEOUT' : ''} ${err.stack || err.message}`);
                const errTheme = getActiveTheme();
                const errMsg = isTimeout
                    ? `⏱ Bu komut çok uzun sürdü ve iptal edildi. Tekrar deneyin.`
                    : (errTheme?.error?.text || `⚠️ Komut hatası: ${err.message || 'bilinmeyen hata'}`);
                await safeSend(sock, jid, {
                    text: [
                        `*${th.botName || 'Alpha'}*`,
                        ``,
                        errMsg,
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
            }

            // ── Otomatik durum: yanıt verdikten sonra tekrar duraklatılmış duruma geç ──
            if (config.AUTO_TYPING || config.AUTO_RECORDING) {
                try { await sock.sendPresenceUpdate('paused', jid); } catch { /* kritik değil */ }
            }

            // ── Yalnızca ilk eşleşen eklentiyi çalıştır — bir yönlendirmeden sonra dur ──
            break;
        }
    } catch (err) {
        console.error('[Handler] Fatal:', err.stack || err.message);
    }
}

module.exports = { handleMessages, safeSend, setupConnectionHandlers, PERM, plugins, extractMessageText };
