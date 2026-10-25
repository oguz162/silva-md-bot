'use strict';

const os      = require('os');
const config  = require('../config');
const { performance } = require('perf_hooks');
const { getActiveTheme } = require('../lib/theme');
const moment  = require('moment-timezone');

const TSİ      = 'Europe/Istanbul';

module.exports = {
    commands:    ['alive', 'bot', 'botinfo'],
    description: 'Bot durumunu gösterir',
    permission:  'public',
    group:       true,
    private:     true,

    run: async (sock, message, args, ctx) => {
        const { safeSend, contextInfo } = ctx;
        const t = getActiveTheme()?.global || {};

        const start = performance.now();
        const ping  = (performance.now() - start).toFixed(1);

        const upRaw = process.uptime();
        const h = Math.floor(upRaw / 3600);
        const m = Math.floor((upRaw % 3600) / 60);
        const s = Math.floor(upRaw % 60);
        const uptime = `${h}h ${m}m ${s}s`;

        const totalRam = (os.totalmem() / 1073741824).toFixed(2);
        const usedRam  = ((os.totalmem() - os.freemem()) / 1073741824).toFixed(2);

        const mode   = (config.MODE || 'PUBLIC').toUpperCase();
        const owner  = config.OWNER_NUMBER || global.botNum || 'Unknown';
        const prefix = config.PREFIX || '.';
        const theme  = (config.THEME || 'silva').toLowerCase();

        const now    = moment().tz(TZ);
        const date   = now.format('ddd, D MMM YYYY');
        const time   = now.format('hh:mm A');

        const botName  = t.botName  || 'Alpha';
        const footer   = t.footer   || 'Alpha';
        const alive    = t.alive    || 'Sistem çevrimiçi. Tüm işlevler normal.';
        const emoji    = t.aliveEmoji || '⚡';
        const modeEmoji = mode === 'PUBLIC' ? '🟢' : mode === 'PRIVATE' ? '🔒' : '🔵';
        const imageUrl = config.ALIVE_IMG || t.pic1 || 'https://files.catbox.moe/5uli5p.jpeg';

        const caption =
`${emoji}  *${botName}* — Aktif!

╭──────────────────
│ 🤖  *Bot:*      ${botName}
│ 👑  *Sahip:*    +${owner}
│ ⏱️  *Çalışma:* ${uptime}
│ ⚡  *Hız:*     ${ping} ms
│ 💾  *RAM:*      ${usedRam} / ${totalRam} GB
│ ${modeEmoji}  *Mod:*     ${mode}
│ 🎨  *Tema:*    ${theme}
│ 🔑  *Önek:*    ${prefix}
│ 📅  *Tarih:*   ${date}
│ 🕒  *Saat:*    ${time}
╰──────────────────

❝ ${alive} ❞

✦ ${footer}`;

        try {
            await safeSend({ image: { url: imageUrl }, caption, contextInfo }, { quoted: message });
        } catch {
            await safeSend({ text: caption, contextInfo }, { quoted: message });
        }
    }
};
