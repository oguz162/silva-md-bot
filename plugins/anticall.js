'use strict';

const fs   = require('fs');
const path = require('path');
const { getStr } = require('../lib/theme');
const SETTINGS_PATH = path.join(__dirname, '../data/anti-call-settings.json');

const DEFAULT_SETTINGS = {
    rejectCalls:    true,
    blockCaller:    false,
    notifyAdmin:    true,
    autoReply:      "🚫 Arama kabul etmiyorum. Lütfen bunun yerine kısa mesaj gönderin..",
    blockedUsers:   []
};

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch { /* ignore */ }
    return { ...DEFAULT_SETTINGS };
}

function saveSettings(s) {
    try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2)); } catch { /* ignore */ }
}

const settings = loadSettings();

// Attach call listener to the socket once (called from silva.js connection.open)
function initCallHandler(sock, ownerJid) {
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (call.status !== 'offer') continue;
            const caller = call.from;

            if (settings.blockedUsers.includes(caller) || settings.rejectCalls) {
                try { await sock.rejectCall(call.id, caller); } catch { /* ignore */ }
            }

            if (settings.autoReply) {
                try {
                    await sock.sendMessage(caller, {
                        text: settings.autoReply,
                        contextInfo: {
                            externalAdReply: {
                                title:        'Çağrı Reddedildi',
                                body:         (getStr('botName') || 'Alpha') + ' Anti-Call',
                                thumbnailUrl: getStr('pic1') || 'https://files.catbox.moe/5uli5p.jpeg',
                                mediaType:    1
                            }
                        }
                    });
                } catch { /* ignore */ }
            }

            if (settings.notifyAdmin && ownerJid) {
                try {
                    await sock.sendMessage(ownerJid, {
                        text: `📞 *Arama Karşıtı Uyarı*\n\nArayan: ${caller}\nType: ${call.isVideo ? 'video' : 'voice'}\nStatus: Rejected`
                    });
                } catch { /* ignore */ }
            }

            if (settings.blockCaller && !settings.blockedUsers.includes(caller)) {
                settings.blockedUsers.push(caller);
                saveSettings(settings);
            }
        }
    });
    console.log('[AntiCall] Çağrı işleyicisi kaydedildi.');
}

module.exports = {
    commands:    ['anticall'],
    description: 'İstenmeyen arama korumasını yönetin — yalnızca sahibi',
    permission:  'owner',
    group:       false,
    private:     true,
    initCallHandler,

    run: async (sock, message, args, { sender, contextInfo }) => {
        const action = args[0]?.toLowerCase();

        if (!action) {
            return sock.sendMessage(sender, {
                text:
`🤖 *Çağrı Engelleme Durumu*
• Koruma: ${settings.rejectCalls ? 'ENABLED' : 'DISABLED'}
• Çağrıyı engelle: ${settings.blockCaller ? 'ON' : 'OFF'}
• Otomatik yanıt: ${settings.autoReply ? 'ON' : 'OFF'}
• Engellenen kullanıcılar: ${settings.blockedUsers.length}

Kullanım: .anticall [on|off|block <num>|unblock <num>]`,
                contextInfo
            }, { quoted: message });
        }

        switch (action) {
            case 'on':
                settings.rejectCalls = true;
                saveSettings(settings);
                await sock.sendMessage(sender, { text: '✅ Arama karşıtı koruma *etkin*.' }, { quoted: message });
                break;
            case 'off':
                settings.rejectCalls = false;
                saveSettings(settings);
                await sock.sendMessage(sender, { text: '✅ Arama karşıtı koruma *devre dışı*.' }, { quoted: message });
                break;
            case 'block': {
                const num = (args[1] || '').replace(/\D/g, '') + '@s.whatsapp.net';
                if (!args[1]) return sock.sendMessage(sender, { text: '❌ Kullanım: .anticall block <numara>' }, { quoted: message });
                if (settings.blockedUsers.includes(num)) return sock.sendMessage(sender, { text: 'ℹ️ Zaten engellendi.' }, { quoted: message });
                settings.blockedUsers.push(num);
                saveSettings(settings);
                await sock.sendMessage(sender, { text: `✅ ${args[1]} arama yapması engellendi.` }, { quoted: message });
                break;
            }
            case 'unblock': {
                const num = (args[1] || '').replace(/\D/g, '') + '@s.whatsapp.net';
                if (!args[1]) return sock.sendMessage(sender, { text: '❌ Kullanım: .anticall unblock <numara>' }, { quoted: message });
                settings.blockedUsers = settings.blockedUsers.filter(u => u !== num);
                saveSettings(settings);
                await sock.sendMessage(sender, { text: `✅ ${args[1]} unblocked.` }, { quoted: message });
                break;
            }
            default:
                await sock.sendMessage(sender, {
                    text: '❌ Bilinmeyen seçenek. Kullanım: .anticall [on|off|block|unblock]',
                    contextInfo
                }, { quoted: message });
        }
    }
};
