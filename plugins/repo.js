'use strict';

const axios  = require('axios');
const moment = require('moment-timezone');

const REPO_URL    = '';
const WEBSITE_URL = '';
const WA_CHANNEL  = '';
const SUPPORT_URL = '';

module.exports = {
    commands:    ['repo', 'repository', 'github'],
    description: 'Alpha bot bilgilerini gösterir',
    permission:  'public',
    group:       true,
    private:     true,

    run: async (sock, message, args, ctx) => {
        const { contextInfo } = ctx;
        const jid = message.key.remoteJid;

        let data = null;
        try {
            const res = await axios.get(
                'https://api.github.com/repos/AlphaB/silva-md-bot',
                { timeout: 10000 }
            );
            data = res.data;
        } catch { /* use fallback */ }

        const caption = data
            ? `*✨ Alpha — REPOSITORY INFO*\n\n` +
              `📦 *Repo:* ${data.name}\n` +
              `📝 *About:* ${data.description || 'WhatsApp MD Bot'}\n\n` +
              `⭐ *Stars:* ${data.stargazers_count.toLocaleString()}\n` +
              `🍴 *Forks:* ${data.forks_count.toLocaleString()}\n` +
              `💻 *Language:* ${data.language || 'JavaScript'}\n` +
              `📦 *Size:* ${(data.size / 1024).toFixed(1)} MB\n` +
              `📜 *License:* ${data.license?.name || 'MIT'}\n` +
              `⚠️ *Open Issues:* ${data.open_issues}\n` +
              `🕒 *Updated:* ${moment(data.updated_at).fromNow()}\n\n` +
              `⚡ _Alpha tarafından_`
            : `*✨ Alpha — REPOSITORY*\n\n` +
              `📦 *Repo:* silva-md-bot\n` +
              `💻 *Language:* JavaScript\n` +
              `📜 *License:* MIT\n\n` +
              `⚡ _Alpha tarafından_`;

        const imgUrl = 'https://files.catbox.moe/5uli5p.jpeg';

        await sock.sendMessage(jid, {
            image:   { url: imgUrl },
            caption,
            contextInfo: {
                ...contextInfo,
                externalAdReply: {
                    title:                 'Alpha — WhatsApp Botu',
                    body:                  'Yapımcı: Zlose',
                    thumbnailUrl:          imgUrl,
                    sourceUrl:             REPO_URL,
                    mediaType:             1,
                    renderLargerThumbnail: true
                }
            }
        }, { quoted: message });
    }
};
