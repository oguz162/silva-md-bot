const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ── Persistent storage helpers ────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, def = {}) {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch { return def; }
}
function writeJson(file, data) {
    try { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2)); } catch {}
}

// ── Bellek içi hatırlatıcı deposu (oturum süresince varlığını korur) ───────────────────────
const reminders = new Map(); // key → { jid, from, text, fireAt, timerId }

// ── Kelime filtresi depolama ───────────────────────────────────────────────────────
let wordFilters = readJson('word-filters.json', {});
// { "groupJid": ["word1", "word2", ...] }

// ── Slowmode storage ──────────────────────────────────────────────────────────
let slowmodeSettings = readJson('slowmode.json', {});
// { "groupJid": { enabled: true, seconds: 10 } }
const slowmodeTrack = new Map(); // "groupJid:senderJid" → lastMsgTimestamp

// ── onMessage hook: word filter + slowmode enforcement ────────────────────────
const onMessagePlugin = {
    commands: ['__advanced_onmessage__'],
    description: 'Kelime filtresi ve yavaş mod için dahili onMessage kancası',
    permission: 'public',
    run: async () => {},
    onMessage: async (sock, message, text, { jid, from, isGroup }) => {
        if (!isGroup || !text) return;

        // Word filter
        const filters = wordFilters[jid];
        if (filters?.length) {
            const lower = text.toLowerCase();
            const hit = filters.find(w => lower.includes(w.toLowerCase()));
            if (hit) {
                try {
                    await sock.sendMessage(jid, { delete: message.key });
                    await sock.sendMessage(jid, {
                        text: `⚠️ @${(message.key.participant || from).split('@')[0]} o kelimenin burada kullanılmasına izin verilmiyor.`,
                        mentions: [message.key.participant || from]
                    });
                } catch {}
                return;
            }
        }

        // Slowmode
        const sm = slowmodeSettings[jid];
        if (sm?.enabled && sm.seconds > 0) {
            const sender = message.key.participant || from;
            const trackKey = `${jid}:${sender}`;
            const last = slowmodeTrack.get(trackKey) || 0;
            const now = Date.now();
            if (now - last < sm.seconds * 1000) {
                try { await sock.sendMessage(jid, { delete: message.key }); } catch {}
                return;
            }
            slowmodeTrack.set(trackKey, now);
        }
    }
};

module.exports = [

    onMessagePlugin,

    // ── Native WhatsApp Poll ─────────────────────────────────────────────────
    {
        commands: ['poll', 'createpoll', 'vote'],
        description: 'Yerel bir WhatsApp anketi oluşturun. Kullanım: .poll Soru | Seçenek1 | Seçenek2 | ...',
        permission: 'public',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply } = ctx;
            const text = args.join(' ').trim();
            if (!text.includes('|')) return reply(
                // '📊 *Anket Oluştur*\n\nUsage:\n`.poll Soru | Seçenek 1 | Seçenek 2 | Seçenek 3`\n\nExample:\n.poll Favorite fruit? | Apple | Banana | Mango | Orange`\n\nMax 12 options.'
            );
            const parts = text.split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length < 3) return reply('❌ Need at least 1 question + 2 options.\n\nÖrnek: `.poll En iyi işletim sistemi? | Android | iOS | Windows`');
            const [question, ...options] = parts;
            if (options.length > 12) return reply('❌ En fazla 12 seçeneğe izin verilir.');
            try {
                await sock.sendMessage(jid, {
                    poll: {
                        name: question,
                        values: options,
                        selectableCount: 1
                    }
                }, { quoted: message });
            } catch (e) {
                reply(`❌ Anket başarısız oldu: ${e.message}`);
            }
        }
    },

    // ── Multi-select Poll ────────────────────────────────────────────────────
    {
        commands: ['multipoll', 'multivote'],
        description: 'Kullanıcıların birden fazla seçenek belirleyebildiği anket. Kullanım: .multipoll Soru | Seçenek1 | Seçenek2 ...',
        permission: 'public',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply } = ctx;
            const text = args.join(' ').trim();
            const parts = text.split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length < 3) return reply('❌ Soru + en az 2 seçenek gereklidir. Örnek: `.multipoll Sevdiğiniz tüm meyveleri seçin | Elma | Mango | Portakal``');
            const [question, ...options] = parts;
            try {
                await sock.sendMessage(jid, {
                    poll: {
                        name: question,
                        values: options.slice(0, 12),
                        selectableCount: options.length > 12 ? 12 : options.length
                    }
                }, { quoted: message });
            } catch (e) {
                reply(`❌ Anket başarısız oldu: ${e.message}`);
            }
        }
    },

    // ── Reminder ─────────────────────────────────────────────────────────────
    {
        commands: ['remind', 'reminder', 'remindme'],
        description: 'Zaman ayarlı bir hatırlatıcı oluşturun. Kullanım: .remind 10m Market alışverişi yap',
        permission: 'public',
        run: async (sock, message, args, ctx) => {
            const { jid, from, reply } = ctx;
            if (!args.length) return reply(
                '⏰ *Hatırlatıcı*\n\nKullanım: `.remind <süre> <mesaj>`\n\nSüre biçimleri:\n• `30s` — 30 saniye\n• `5m` — 5 dakika\n• `2h` — 2 saat\n• `1d` — 1 gün\n\nÖrnekler:\n`.remind 10m İlacını al`\n`.remind 2h Annemi ara`\n`.remind 1d Kirayı öde``'
            );
            const timeStr = args[0].toLowerCase();
            const text = args.slice(1).join(' ').trim() || 'Reminder!';
            let ms = 0;
            if (/^\d+s$/.test(timeStr)) ms = parseInt(timeStr) * 1000;
            else if (/^\d+m$/.test(timeStr)) ms = parseInt(timeStr) * 60000;
            else if (/^\d+h$/.test(timeStr)) ms = parseInt(timeStr) * 3600000;
            else if (/^\d+d$/.test(timeStr)) ms = parseInt(timeStr) * 86400000;
            else return reply('❌ Geçersiz süre. Şunu kullanın: 30s, 5m, 2h, 1d');
            if (ms < 5000) return reply('❌ Minimum hatırlatma süresi 5 saniyedir.');
            if (ms > 7 * 24 * 3600000) return reply('❌ Maksimum hatırlatıcı süresi 7 gündür.');

            const fireAt = Date.now() + ms;
            const id = `${jid}-${Date.now()}`;
            const mins = Math.round(ms / 60000);
            const displayTime = ms < 60000 ? `${ms / 1000}s` : ms < 3600000 ? `${Math.round(ms/60000)}m` : ms < 86400000 ? `${Math.round(ms/3600000)}h` : `${Math.round(ms/86400000)}d`;

            const timerId = setTimeout(async () => {
                reminders.delete(id);
                try {
                    await sock.sendMessage(jid, {
                        text: `⏰ *Hatırlatma!*\n\n${text}\n\n_Set ${displayTime} ago_`,
                        mentions: [from]
                    });
                } catch {}
            }, ms);

            reminders.set(id, { jid, from, text, fireAt, timerId });
            reply(`⏰ *Hatırlatıcı Ayarlandı!*\n\n📝 *Not:* ${text}\n⏱ *Yangınlar:* ${displayTime}\n🕐 *At:* ${new Date(fireAt).toLocaleTimeString()}\n\nZamanı geldiğinde buradan sana seslenirim!`);
        }
    },

    // ── List reminders ───────────────────────────────────────────────────────
    {
        commands: ['reminders', 'myreminders', 'listreminders'],
        description: 'Etkin hatırlatıcılarınızı listeleyin',
        permission: 'public',
        run: async (sock, message, args, ctx) => {
            const { jid, from, reply } = ctx;
            const mine = [...reminders.values()].filter(r => r.jid === jid && r.from === from);
            if (!mine.length) return reply('📭 Bu sohbette aktif hatırlatıcınız bulunmuyor.');
            const lines = mine.map((r, i) => {
                const left = Math.max(0, r.fireAt - Date.now());
                const mins = Math.round(left / 60000);
                return `${i + 1}. ⏰ *${r.text}* — in ${mins < 1 ? '<1' : mins}m`;
            });
            reply(`⏰ *Hatırlatıcılarınız (${mine.length})*\n\n${lines.join('\n')}`);
        }
    },

    // ── Word Filter ──────────────────────────────────────────────────────────
    {
        commands: ['addfilter', 'filterword', 'blockword'],
        description: 'Belirli bir kelimeyi içeren mesajları otomatik olarak siler. Kullanım: .addfilter <kelime>',
        permission: 'admin',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply } = ctx;
            const word = args.join(' ').trim().toLowerCase();
            if (!word) return reply('Kullanım: `.addfilter <kelime>`\nÖrnek: `.addfilter spam``');
            if (!wordFilters[jid]) wordFilters[jid] = [];
            if (wordFilters[jid].includes(word)) return reply(`⚠️ *"${word}"* zaten filtrelenmiş durumda.`);
            wordFilters[jid].push(word);
            writeJson('word-filters.json', wordFilters);
            reply(`✅ Kelime filtresi eklendi: *"${word}"*\n\nBu kelimeyi içeren iletiler otomatik olarak silinecektir..`);
        }
    },

    {
        commands: ['removefilter', 'unfilter', 'unblockword'],
        description: 'Bir kelime filtresini kaldırın',
        permission: 'admin',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply } = ctx;
            const word = args.join(' ').trim().toLowerCase();
            if (!wordFilters[jid]?.length) return reply('📭 Bu grupta herhangi bir kelime filtresi etkin değil.');
            const idx = wordFilters[jid].indexOf(word);
            if (idx === -1) return reply(`❌ *"${word}"* filtre listesinde değil.`);
            wordFilters[jid].splice(idx, 1);
            writeJson('word-filters.json', wordFilters);
            reply(`✅ Filtre kaldırıldı: *"${word}"*`);
        }
    },

    {
        commands: ['listfilters', 'filterlist', 'wordfilters'],
        description: 'Bu gruptaki etkin sözcük filtrelerini listele',
        permission: 'public',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply } = ctx;
            const list = wordFilters[jid];
            if (!list?.length) return reply('📭 Bu grupta herhangi bir kelime filtresi etkin değil.\n\nYöneticiler, `.addfilter <kelime>` komutuyla filtre ekleyebilirler.`');
            reply(`🚫 *Kelime Filtreleri (${list.length})*\n\n${list.map((w, i) => `${i + 1}. \`${w}\``).join('\n')}\n\nBu kelimeleri içeren mesajlar otomatik olarak silinir.`);
        }
    },

    {
        commands: ['clearfilters', 'resetfilters'],
        description: 'Bu gruptaki tüm kelime filtrelerini kaldırın',
        permission: 'admin',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply } = ctx;
            if (!wordFilters[jid]?.length) return reply('📭 Temizlenecek filtre yok.');
            delete wordFilters[jid];
            writeJson('word-filters.json', wordFilters);
            reply('✅ Bu grup için tüm kelime filtreleri kaldırıldı.');
        }
    },

    // ── Slowmode ─────────────────────────────────────────────────────────────
    {
        commands: ['slowmode', 'slow'],
        description: 'Kullanıcı başına mesajlar arasına bir bekleme süresi (cooldown) koyun. Kullanım: .slowmode 30 (saniye) veya .slowmode off',
        permission: 'admin',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply } = ctx;
            const arg = (args[0] || '').toLowerCase();
            if (arg === 'off' || arg === 'disable' || arg === '0') {
                delete slowmodeSettings[jid];
                writeJson('slowmode.json', slowmodeSettings);
                return reply('✅ Bu grup için yavaş mod *devre dışı*.');
            }
            const secs = parseInt(arg);
            if (isNaN(secs) || secs < 1) return reply('Kullanım:\n`.yavaş mod 30` — 30 saniye bekleme süresi\n`.slowmode off — devre dışı bırak');
            if (secs > 3600) return reply('❌ Maksimum yavaş mod süresi 3600 saniyedir (1 saat).');
            slowmodeSettings[jid] = { enabled: true, seconds: secs };
            writeJson('slowmode.json', slowmodeSettings);
            reply(`🐢 *Yavaş mod açık*Kullanıcıların beklemesi gerekiyor *${secs} mesajlar arasında saniye*.\n\nDevre dışı bırakmak için \`.slowmode off\` yazın.`);
        }
    },

    // ── Disappearing Messages ─────────────────────────────────────────────────
    {
        commands: ['disappear', 'disappearing', 'ephemeral'],
        description: 'Toggle disappearing messages in a chat',
        permission: 'admin',
        run: async (sock, message, args, ctx) => {
            const { jid, reply } = ctx;
            const arg = (args[0] || '').toLowerCase();
            let duration = 604800; // 7 days default
            if (arg === 'off' || arg === '0') duration = 0;
            else if (arg === '24h' || arg === '1d') duration = 86400;
            else if (arg === '7d' || arg === '7') duration = 604800;
            else if (arg === '90d' || arg === '90') duration = 7776000;
            try {
                await sock.sendMessage(jid, { disappearingMessagesInChat: duration });
                if (duration === 0) reply('✅ Disappearing messages *disabled*.');
                else reply(`✅ Disappearing messages set to *${arg === '24h' || arg === '1d' ? '24 hours' : arg === '90d' || arg === '90' ? '90 days' : '7 days'}*.\n\nAll new messages will auto-delete after this period.`);
            } catch (e) {
                reply(`❌ Failed: ${e.message}\n\nMake sure the bot has admin rights.`);
            }
        }
    },

    // ── Mention Admins ────────────────────────────────────────────────────────
    {
        commands: ['admins', 'tagadmins', 'mentionadmins', '@admins'],
        description: 'Mention all group admins',
        permission: 'public',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply, safeSend, groupMetadata } = ctx;
            const meta = groupMetadata || await sock.groupMetadata(jid).catch(() => null);
            if (!meta) return reply('❌ Could not fetch group info.');
            const adminList = (meta.participants || []).filter(p => p.admin);
            if (!adminList.length) return reply('⚠️ No admins found in this group.');
            const reason = args.join(' ').trim() || 'Attention needed';
            const mentions = adminList.map(p => p.id);
            const text = `📢 *Admins Mentioned*\n\n📝 *Reason:* ${reason}\n\n${adminList.map(p => `• @${p.id.split('@')[0]}`).join('\n')}`;
            await safeSend({ text, mentions }, { quoted: message });
        }
    },

    // ── Group Link ────────────────────────────────────────────────────────────
    {
        commands: ['grouplink', 'invitelink', 'groupinvite'],
        description: 'Get the group invite link (bot must be admin)',
        permission: 'admin',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply } = ctx;
            try {
                const code = await sock.groupInviteCode(jid);
                reply(`🔗 *Group Invite Link*\n\nhttps://chat.whatsapp.com/${code}\n\n_Share this link to invite people to the group._`);
            } catch (e) {
                reply(`❌ Failed to get invite link.\nMake sure I'm an admin: ${e.message}`);
            }
        }
    },

    // ── Revoke Group Link ─────────────────────────────────────────────────────
    {
        commands: ['revokelink', 'resetlink', 'newlink'],
        description: 'Revoke and reset the group invite link',
        permission: 'admin',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply } = ctx;
            try {
                const code = await sock.groupRevokeInvite(jid);
                reply(`✅ *Group link revoked!*\n\nNew link:\nhttps://chat.whatsapp.com/${code}\n\n_Old link is now invalid._`);
            } catch (e) {
                reply(`❌ Failed: ${e.message}`);
            }
        }
    },

    // ── Bulk Promote ──────────────────────────────────────────────────────────
    {
        commands: ['promote', 'makeadmin'],
        description: 'Promote mentioned users to admin (reply or mention)',
        permission: 'admin',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply, mentionedJid } = ctx;
            const targets = mentionedJid?.length
                ? mentionedJid
                : message.message?.extendedTextMessage?.contextInfo?.participant
                    ? [message.message.extendedTextMessage.contextInfo.participant]
                    : [];
            if (!targets.length) return reply('❌ Mention or reply to users to promote.\nExample: `.promote @user1 @user2`');
            try {
                await sock.groupParticipantsUpdate(jid, targets, 'promote');
                reply(`✅ Promoted ${targets.length} user(s) to admin:\n${targets.map(t => `• @${t.split('@')[0]}`).join('\n')}`);
            } catch (e) {
                reply(`❌ Failed: ${e.message}`);
            }
        }
    },

    // ── Bulk Demote ───────────────────────────────────────────────────────────
    {
        commands: ['demote', 'removeadmin'],
        description: 'Demote mentioned admins to regular member',
        permission: 'admin',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply, mentionedJid } = ctx;
            const targets = mentionedJid?.length
                ? mentionedJid
                : message.message?.extendedTextMessage?.contextInfo?.participant
                    ? [message.message.extendedTextMessage.contextInfo.participant]
                    : [];
            if (!targets.length) return reply('❌ Mention or reply to users to demote.\nExample: `.demote @user`');
            try {
                await sock.groupParticipantsUpdate(jid, targets, 'demote');
                reply(`✅ Demoted ${targets.length} user(s):\n${targets.map(t => `• @${t.split('@')[0]}`).join('\n')}`);
            } catch (e) {
                reply(`❌ Failed: ${e.message}`);
            }
        }
    },

    // ── Group Stats ───────────────────────────────────────────────────────────
    {
        commands: ['groupstats', 'gstats', 'groupinfo2'],
        description: 'Detailed group statistics',
        permission: 'public',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply, groupMetadata } = ctx;
            const meta = groupMetadata || await sock.groupMetadata(jid).catch(() => null);
            if (!meta) return reply('❌ Could not fetch group info.');
            const admins = (meta.participants || []).filter(p => p.admin);
            const members = (meta.participants || []).filter(p => !p.admin);
            const creation = meta.creation ? new Date(meta.creation * 1000).toLocaleDateString() : 'Unknown';
            reply(
                `📊 *Group Statistics*\n\n` +
                `📛 *Name:* ${meta.subject || 'N/A'}\n` +
                `👥 *Total Members:* ${meta.participants?.length || 0}\n` +
                `👑 *Admins:* ${admins.length}\n` +
                `👤 *Members:* ${members.length}\n` +
                `📅 *Created:* ${creation}\n` +
                `📝 *Description:* ${(meta.desc || 'No description').slice(0, 100)}\n` +
                `🔒 *Restrict:* ${meta.restrict ? 'Only admins can edit' : 'All members'}\n` +
                `📣 *Announce:* ${meta.announce ? 'Only admins can message' : 'All members can message'}`
            );
        }
    },

    // ── Ping / Latency ────────────────────────────────────────────────────────
    {
        commands: ['ping2', 'latency', 'ms'],
        description: 'Check bot response latency',
        permission: 'public',
        run: async (sock, message, args, ctx) => {
            const { jid, reply, safeSend } = ctx;
            const t = Date.now();
            const sent = await safeSend({ text: '🏓 Pinging...' }, { quoted: message });
            const latency = Date.now() - t;
            reply(`🏓 *Pong!*\n\n⚡ *Latency:* ${latency}ms\n🤖 *Status:* Online\n💾 *Memory:* ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
        }
    },

    // ── React to message ──────────────────────────────────────────────────────
    {
        commands: ['react', 'reaction'],
        description: 'React to a replied message with an emoji. Usage: .react 😍',
        permission: 'public',
        run: async (sock, message, args, ctx) => {
            const { jid, reply } = ctx;
            const emoji = args[0] || '👍';
            const quoted = message.message?.extendedTextMessage?.contextInfo;
            if (!quoted?.stanzaId) return reply('❌ Reply to a message first, then use `.react 😍`');
            try {
                await sock.sendMessage(jid, {
                    react: {
                        text: emoji,
                        key: {
                            remoteJid: jid,
                            fromMe: quoted.participant === (ctx.sock?.user?.id || ''),
                            id: quoted.stanzaId,
                            participant: quoted.participant
                        }
                    }
                });
            } catch (e) {
                reply(`❌ Reaction failed: ${e.message}`);
            }
        }
    },

    // ── Steal Sticker (convert media to sticker) ──────────────────────────────
    {
        commands: ['steal', 'stealsticker', 'takesticker'],
        description: 'Convert any replied image/video/sticker to a bot-branded sticker',
        permission: 'public',
        run: async (sock, message, args, ctx) => {
            const { jid, reply } = ctx;
            const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) return reply('❌ Reply to an image, video, or sticker with `.steal`');
            const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
            let buffer, mime;
            try {
                let media, mtype;
                if (quoted.imageMessage) { media = quoted.imageMessage; mtype = 'image'; mime = 'image/webp'; }
                else if (quoted.videoMessage) { media = quoted.videoMessage; mtype = 'video'; mime = 'video/webp'; }
                else if (quoted.stickerMessage) { media = quoted.stickerMessage; mtype = 'sticker'; mime = 'image/webp'; }
                else return reply('❌ Reply to an image, video, or sticker.');
                const stream = await downloadContentFromMessage(media, mtype);
                buffer = Buffer.concat(await (async function*() { for await (const chunk of stream) yield chunk; })().next().then(async function collect(acc, stream) {
                    const chunks = [];
                    for await (const c of stream) chunks.push(c);
                    return chunks;
                }));
            } catch {}
            if (!buffer) {
                // Simpler approach
                try {
                    const stickerMsg = quoted.stickerMessage;
                    if (stickerMsg) {
                        const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                        const stream = await downloadContentFromMessage(stickerMsg, 'sticker');
                        const chunks = [];
                        for await (const chunk of stream) chunks.push(chunk);
                        buffer = Buffer.concat(chunks);
                        mime = 'image/webp';
                    }
                } catch (e) { return reply(`❌ Could not download media: ${e.message}`); }
            }
            if (!buffer) return reply('❌ Could not download the media. Try again.');
            try {
                await sock.sendMessage(jid, { sticker: buffer }, { quoted: message });
            } catch (e) {
                reply(`❌ Sticker send failed: ${e.message}`);
            }
        }
    },

    // ── Broadcast to all group members' DMs (owner only) ──────────────────────
    {
        commands: ['broadcast2', 'bcastmembers'],
        description: 'DM a message to all members of the current group (owner only)',
        permission: 'owner',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply, groupMetadata } = ctx;
            const text = args.join(' ').trim();
            if (!text) return reply('Usage: `.broadcast2 <message>`\n\nThis sends a private DM to every group member.');
            const meta = groupMetadata || await sock.groupMetadata(jid).catch(() => null);
            if (!meta) return reply('❌ Could not fetch group info.');
            const members = (meta.participants || []).filter(p => !p.id.endsWith('@lid'));
            reply(`📤 Broadcasting to ${members.length} members... This may take a moment.`);
            let sent = 0, failed = 0;
            for (const p of members) {
                try {
                    await sock.sendMessage(p.id, { text: `📢 *Group Broadcast*\n\n${text}\n\n_From: ${meta.subject}_` });
                    sent++;
                    await new Promise(r => setTimeout(r, 800));
                } catch { failed++; }
            }
            reply(`✅ Broadcast complete!\n\n✔️ Sent: ${sent}\n❌ Failed: ${failed}`);
        }
    },

    // ── Anonymous Message ─────────────────────────────────────────────────────
    {
        commands: ['anon', 'anonymous', 'anonmsg'],
        description: 'Send an anonymous message to this group. Only bot knows who sent it.',
        permission: 'public',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, safeSend } = ctx;
            const text = args.join(' ').trim();
            if (!text) return ctx.reply('Usage: `.anon <your message>`\nYour identity will be hidden!');
            await safeSend({
                text: `🕵️ *Anonymous Message*\n\n${text}\n\n_💬 Use .anon to send an anonymous message_`
            });
        }
    },

    // ── Chat Statistics ───────────────────────────────────────────────────────
    {
        commands: ['chatstats', 'toptalkers', 'whotalks'],
        description: 'Show who talks most in this group',
        permission: 'public',
        group: true,
        run: async (sock, message, args, ctx) => {
            const { jid, reply } = ctx;
            const gMap = global.groupMsgMap?.get(jid);
            if (!gMap?.size) return reply('📊 Not enough data yet. Chat a bit more and try again!');
            const sorted = [...gMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
            const total = [...gMap.values()].reduce((a, b) => a + b, 0);
            const lines = sorted.map(([phone, count], i) => {
                const pct = Math.round(count / total * 100);
                const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
                return `${i + 1}. +${phone}\n   ${bar} ${count} msgs (${pct}%)`;
            });
            reply(`📊 *Top Talkers*\n\n${lines.join('\n\n')}\n\n_Total messages tracked: ${total}_`);
        }
    },

];
