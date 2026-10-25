'use strict';

const moment = require('moment-timezone');
const { getCountry, resolvePhoneJid } = require('../lib/phone-utils');

const TSİ      = 'Europe/Istanbul';

// ─── Presence helper ──────────────────────────────────────────────────────────
// Subscribes to presence for a JID and waits up to `timeoutMs` for the first
// presence.update event.  Returns { lastKnownPresence, lastSeen } or null.
function waitForPresence(sock, jid, timeoutMs = 6000) {
    return new Promise(resolve => {
        const bare = jid.split('@')[0] + '@s.whatsapp.net';
        let done = false;

        const cleanup = (result) => {
            if (done) return;
            done = true;
            sock.ev.off('presence.update', handler);
            clearTimeout(timer);
            resolve(result);
        };

        const handler = ({ id, presences }) => {
            // Presence events may carry the bare JID or device-suffixed variant
            const normId = id?.split('@')[0] + '@s.whatsapp.net';
            if (normId !== bare) return;
            const entry = presences[Object.keys(presences)[0]];
            cleanup(entry || null);
        };

        const timer = setTimeout(() => cleanup(null), timeoutMs);

        sock.ev.on('presence.update', handler);
        // Fire the subscribe after attaching the listener
        sock.presenceSubscribe(jid).catch(() => cleanup(null));
    });
}

// ─── Plugin ───────────────────────────────────────────────────────────────────
module.exports = {
    commands:    ['stalk', 'userinfo', 'lookup', 'wa'],
    description: 'Tam profil kartı: resim, durum, son görülme, cihazlar, ülke',
    usage:       '.stalk @user  |  Yanıtla mesaj  |  .stalk 555XXXXXXXX',
    permission:  'public',
    group:       true,
    private:     true,

    run: async (sock, message, args, { sender, contextInfo, mentionedJid }) => {

        // ── Resolve target ──────────────────────────────────────────────────
        let targetJid   = null;
        let lidNotCached = false;

        const ctxInfo   = message.message?.extendedTextMessage?.contextInfo;
        const rawQuoted = ctxInfo?.participant || ctxInfo?.remoteJid;

        if (rawQuoted) {
            targetJid = resolvePhoneJid(rawQuoted);
            if (!targetJid && rawQuoted.endsWith('@lid')) lidNotCached = true;
        }
        if (!targetJid && mentionedJid?.length) {
            targetJid = resolvePhoneJid(mentionedJid[0]);
        }
        if (!targetJid && args[0]) {
            const digits = args[0].replace(/\D/g, '');
            if (digits.length >= 7) targetJid = `${digits}@s.whatsapp.net`;
        }
        if (!targetJid) {
            const from = message.key.participant || message.key.remoteJid;
            targetJid  = resolvePhoneJid(from);
        }

        if (!targetJid) {
            return sock.sendMessage(sender, {
                text: lidNotCached
                    ? '⚠️ Bu kullanıcının numarası henüz önbelleğe alınmamış; ondan önce bir mesaj göndermesini isteyin, ardından tekrar deneyin.'
                    : '❌ Birinden bahsedin, mesajına yanıt verin veya bir telefon numarası belirtin.',
                contextInfo
            }, { quoted: message });
        }

        const number = targetJid.split('@')[0];

        await sock.sendMessage(sender, {
            text: `🔍 Profil getiriliyor: +${number}…`,
            contextInfo
        }, { quoted: message });

        // ── Fire all queries in parallel (presence runs concurrently) ──────
        const [
            statusResult,
            bizResult,
            picResult,
            devResult,
            presenceResult,
        ] = await Promise.allSettled([
            sock.fetchStatus(targetJid),
            sock.getBusinessProfile(targetJid),
            sock.profilePictureUrl(targetJid, 'image', 6000),
            typeof sock.getUSyncDevices === 'function'
                ? sock.getUSyncDevices([targetJid], false, false)
                : Promise.resolve([]),
            waitForPresence(sock, targetJid, 6000),
        ]);

        // ── Parse ──────────────────────────────────────────────────────────
        const statusList  = statusResult.status  === 'yerine getirilmiş' ? (statusResult.value  || []) : [];
        const biz         = bizResult.status      === 'yerine getirilmiş' ? bizResult.value      : null;
        const picUrl      = picResult.status      === 'yerine getirilmiş' ? picResult.value      : null;
        const devJids     = devResult.status       === 'yerine getirilmiş' ? (devResult.value    || []) : [];
        const presence    = presenceResult.status  === 'yerine getirilmiş' ? presenceResult.value : null;

        // Status / about
        const statusEntry = statusList.find?.(e => e?.status)?.status;
        const statusText  = statusEntry?.status || null;

        // Push name
        const pushName = global.pushNameCache?.get(number)
                      || global.pushNameCache?.get(targetJid)
                      || null;

        // Country
        const country = getCountry(number);

        // Devices
        const companions = devJids.filter(d => d.device !== 0).length;
        let deviceLine;
        if (devJids.length === 0) {
            deviceLine = '📱 Yalnızca telefon (veya veri erişimi yok)';
        } else if (companions === 0) {
            deviceLine = '📱 Yalnızca telefon';
        } else {
            deviceLine = `📱 Telefon + ${companions} companion${companions > 1 ? 's' : ''} (Web / Masaüstü)`;
        }

        // Account type
        const isBiz = !!(biz?.wid);

        // ── Last seen / presence ───────────────────────────────────────────
        let presenceLine;
        if (!presence) {
            presenceLine = '🕐 Gizli / Gizlilik kısıtlamalı';
        } else if (presence.lastKnownPresence === 'available') {
            presenceLine = '🟢 Şu an çevrim içi';
        } else if (presence.lastSeen) {
            const ts  = moment.unix(presence.lastSeen).tz(TZ);
            const now = moment().tz(TZ);
            const diff = now.diff(ts, 'dakika');
            let ago;
            if (diff < 1)          ago = 'Şu anda';
            else if (diff < 60)    ago = `${diff} önce`;
            else if (diff < 1440)  ago = `${Math.floor(diff / 60)}h ${diff % 60}m ago`;
            else                   ago = ts.format('D MMM YYYY, h:mm A');
            presenceLine = `🕐 Son görülme: ${ago}`;
        } else {
            presenceLine = `⚪ Çevrim dışı (son görülme gizli)`;
        }

        // ── Business extras ────────────────────────────────────────────────
        let bizBlock = '';
        if (biz?.wid) {
            const rows = [];
            if (biz.description) rows.push(`📝 *About:*    ${biz.description.slice(0, 100)}${biz.description.length > 100 ? '…' : ''}`);
            if (biz.email)        rows.push(`📧 *Email:*    ${biz.email}`);
            if (biz.website?.[0]) rows.push(`🌐 *Web sitesi:*  ${biz.website[0]}`);
            if (biz.address)      rows.push(`📍 *Adres:*  ${biz.address}`);
            if (rows.length)      bizBlock = '\n│\n│ ' + rows.join('\n│ ');
        }

        // ── Build card ─────────────────────────────────────────────────────
        const now        = moment().tz(TZ);
        const fetchedAt  = now.format('D MMM YYYY, h:mm A');
        const accountTag = isBiz ? '🏢 WhatsApp Business' : '👤 Kişisel';

        const lines = [
            `╭──────────────────────────────`,
            `│ 🔎 *Kullanıcı Profil Kartı*`,
            `│ ─────────────────────────────`,
            `│ 📞 *Numara:*    +${number}`,
        ];
        if (pushName)   lines.push(`│ 👤 *İsim:*      ${pushName}`);
        lines.push(
            `│ 🌍 *Country:*   ${country}`,
            `│ 🏷️ *Hesap:*   ${accountTag}`,
            `│ ${presenceLine}`,
            `│ 💻 *Cihazlar:*   ${deviceLine}`,
        );
        if (statusText) lines.push(`│ 💬 *Durum:*    "${statusText.slice(0, 90)}${statusText.length > 90 ? '…' : ''}"`);
        if (bizBlock)   lines.push(bizBlock);
        lines.push(
            `│ ─────────────────────────────`,
            `│ 🕑 _Getirildi: ${fetchedAt}_`,
            `╰──────────────────────────────`,
        );

        const caption = lines.join('\n');

        if (picUrl) {
            try {
                await sock.sendMessage(sender, {
                    image:   { url: picUrl },
                    caption,
                    contextInfo
                }, { quoted: message });
                return;
            } catch { /* fall through to text */ }
        }

        await sock.sendMessage(sender, { text: caption, contextInfo }, { quoted: message });
    }
};
