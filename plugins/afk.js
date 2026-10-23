'use strict';

let afkActive = false;
let afkReason  = 'Herhangi bir neden belirtilmedi';
let afkSince   = 0;

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

module.exports = {
    commands:    ['afk', 'back'],
    description: 'Sahibi için AFK modu — siz uzaktayken bot herkese otomatik yanıt verir',
    permission:  'owner',
    group:       true,
    private:     true,

    isAfk:      () => afkActive,
    getAfkData: () => ({ reason: afkReason, since: afkSince }),

    run: async (sock, message, args, ctx) => {
        const { safeSend, contextInfo } = ctx;
        const cmdText = (message.message?.conversation || message.message?.extendedTextMessage?.text || '')
            .trim().split(/\s+/)[0].replace(/^[^a-zA-Z]*/, '').toLowerCase();

        if (cmdText === 'afk') {
            afkActive = true;
            afkReason  = args.join(' ') || 'Herhangi bir neden belirtilmedi';
            afkSince   = Date.now();
            await safeSend({
                text: `🌙 *AFK Modu Etkinleştirildi*\n\n📝 Sebep: ${afkReason}\n\n_.back komutunu kullanana kadar mesaj gönderen herkes otomatik yanıt alacaktır._`,
                contextInfo
            }, { quoted: message });
            return;
        }

        if (cmdText === 'back') {
            if (!afkActive) {
                await sock.sendMessage(message.key.remoteJid, { text: '✅ AFK modu şu anda etkin değil.', contextInfo }, { quoted: message });
                return;
            }
            const duration = formatDuration(Date.now() - afkSince);
            afkActive = false;
            await safeSend({
                text: `🌸 *tekrar hoşgeldiniz!*\n\n⏱ Şu kadar süre uzaktaydın: *${duration}*.`,
                contextInfo
            }, { quoted: message });
        }
    }
};
