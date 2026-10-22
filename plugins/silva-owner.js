'use strict';

const config = require('../config');

module.exports = {
    commands:    ['owner', 'creator'],
    description: 'Bot sahibinin iletişim bilgilerini gösterir',
    permission:  'public',
    group:       true,
    private:     true,
    run: async (sock, message, args, { sender, jid, contextInfo }) => {
        const ownerNumber = (config.OWNER_NUMBER || '').replace(/\D/g, '');
        const ownerName   = config.OWNER_NAME || 'Alpha';

        const vcard = [
            'BEGIN:VCARD',
            'VERSION:3.0',
            `FN:${ownerName}`,
            'ORG:Alpha — Yapımcı: Zlose',
            `TEL;type=CELL;type=VOICE;waid=${ownerNumber}:+${ownerNumber}`,
            'END:VCARD'
        ].join('\n');

        await sock.sendMessage(sender, {
            contacts: {
                displayName: ownerName,
                contacts: [{ vcard }]
            },
            contextInfo: {
                ...contextInfo,
                externalAdReply: {
                    title: '👑 Bot Sahibi',
                    body: 'Kişi bilgilerini görmek için dokun',
                    thumbnailUrl: config.ALIVE_IMG || 'https://files.catbox.moe/5uli5p.jpeg',
                    sourceUrl: 'https://wa.me/' + ownerNumber,
                    mediaType: 1,
                    renderLargerThumbnail: true
                }
            }
        }, { quoted: message });

    }
};
