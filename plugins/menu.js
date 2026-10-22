'use strict';

const fs      = require('fs');
const path    = require('path');
const config  = require('../config');
const { getStr } = require('../lib/theme');
const moment  = require('moment-timezone');

const WEBSITE = '...';
const TSİ      = 'Europe/Istanbul';

// ── Kategori tanımları ────────────────────────────────────────────────────────
// Her birinin `.menu 3` gibi detay görüntüleme için sayısal bir ID'si vardır
const CATEGORIES = [
    { id: 1,  icon: '⬇️',  name: 'İndiriciler',         cmds: ['yt','ytmp3','ytmp4','tiktok','instagram','facebook','spotify','soundcloud','capcut','apk','catbox','tourl','pinterest','reddit','twitter','threads','gdrive'] },
    { id: 2,  icon: '🎵',  name: 'Müzik & Ses',         cmds: ['play','shazam','lyrics','toaudio','bgm','addbgm','setbgm','clearbgm','transcribe','tts'] },
    { id: 3,  icon: '🤖',  name: 'Yapay Zeka & Zekâ',   cmds: ['ai','gpt4','gpt4o','gemini','bard','venice','openai','letmegpt','ask','silva','assistant','imagine','translate','define','calc','shorten','gitclone','anime','manga','describe','caption','carbon'] },
    { id: 4,  icon: '🔍',  name: 'Arama & Bilgi',       cmds: ['wiki','country','ip','currency','time','weather','numberfact','stalk','whois','dns','speedtest','ipinfo','screenshot','fetch','githubstalk'] },
    { id: 5,  icon: '🖼️', name: 'Medya & Çıkartmalar', cmds: ['sticker','stickersearch','togif','tojpeg','emojimix','textsticker','qrcode','react','ocr','ascii','color','getpp','togstatus','statussave','captionimage','quotly','viewonce'] },
    { id: 6,  icon: '👥',  name: 'Grup Yönetimi',       cmds: ['kick','promote','demote','ban','unban','banlist','tagall','hidetag','poll','multipoll','pollresult','lock','unlock','link','revoke','setname','setdesc','broadcast','purge','dmall','warn','mute','unmute','pin','unpin','edit','groupinfo','grouprules','groupstatus','setbio'] },
    { id: 7,  icon: '👋',  name: 'Karşılama & Etkinlik',cmds: ['welcome','goodbye','setwelcome','setgoodbye','welcomequiz','setquiz'] },
    { id: 8,  icon: '🛡️', name: 'Koruma',              cmds: ['antidemote','antidelete','antilink','anticall','antivv','antiscam','antibadwords','antibot','antifake','antiflood','antigm','antispam','afk','auditlog','blocklist','block','unblock','warn','warnlist','clearwarn'] },
    { id: 9,  icon: '😄',  name: 'Eğlence',             cmds: ['joke','fact','riddle','meme','quote','advice','compliment','flip','bible','pickup','roast','truth','dare','ship','pair','marry','divorce','slots','8ball'] },
    { id: 10, icon: '🔧',  name: 'Metin & Geliştirici Araçları', cmds: ['reverse','upper','lower','mock','binary','rot13','json','timestamp','regex','httpcode','password','hash','encode','decode','wordcount','urlencode','urldecode','morse','base64','carbon','cron','chmod','ascii'] },
    { id: 11, icon: '📊',  name: 'Seviye & Analitik',   cmds: ['level','rank','xp','leaderboard','analytics','topusers','peakhours','presence'] },
    { id: 12, icon: '📰',  name: 'Kanallar',            cmds: ['newsletter','followchannel','unfollowchannel','channelinfo'] },
    { id: 13, icon: '🎮',  name: 'Oyunlar',             cmds: ['rps','hangman','ttt','trivia','slots','8ball','scramble','flagquiz','mathquiz','wordchain','emojiguess','numberguess','wordgame','capitalquiz','tictactoe','typerace','dailychallenge','challenge'] },
    { id: 14, icon: '💰',  name: 'Finans & Kripto',     cmds: ['crypto','loan','savings','tax','split','salary','discount','currency','budget','expense','balances','networth','inflation','invest','bitcoin'] },
    { id: 15, icon: '📚',  name: 'Eğitim',              cmds: ['element','planet','zodiac','vocab','acronym','flag','nato','phrasebook','define','bible'] },
    { id: 16, icon: '📝',  name: 'Verimlilik',          cmds: ['remind','rremind','myreminders','bookmark','save','saved','notes','addnote','todo','autoreply','awaymsg','schedule','timer','expense'] },
    { id: 17, icon: '💪',  name: 'Sağlık & Fitness',    cmds: ['workout','stretching','calories','water','sleep','meditation','steps','yoga','bmi'] },
    { id: 18, icon: '🤝',  name: 'Ödünç & Alt Bot',     cmds: ['lend','approvelend','rejectlend','revokelend','lendlist','lendstatus','subbot','subbots','mybotinfo','getcode','paircode','getpair','sessioncode','connectbot'] },
    { id: 19, icon: '🕵️', name: 'Takip & Sorgulama',   cmds: ['stalk','devicecheck','whois','githubstalk','tiktokstalk','checkscam','virus','tempmail','dns','ipinfo'] },
    { id: 20, icon: 'ℹ️', name: 'Bot Bilgisi',         cmds: ['alive','ping','uptime','owner','getjid','repo','menu','help','support','call','botinfo'] },
    { id: 21, icon: '👑',  name: 'Sahip & Sudo',        cmds: ['sudo','setsudo','delsudo','getsudo','resetsudo','block','unblock','setmode','setprefix','setbotname','join','cmd','restart','shutdown','backupgroup','restoregroup','broadcast','eval','dmall','autojoin','cleanup','lendlimit'] },
];

// ── Kutu çizimi ───────────────────────────────────────────────────────────────
function hline(n = 38) { return '─'.repeat(n); }

function box(title, lines) {
    return `╭─「 ${title} 」\n${lines.map(l => `│  ${l}`).join('\n')}\n╰${hline()}`;
}

// ── Tüm aktif eklentileri yükle ───────────────────────────────────────────────
function loadPlugins() {
    const dir = path.join(__dirname);
    const out = [];
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
        try {
            const p = require(path.join(dir, f));
            if (Array.isArray(p.commands) && p.commands.length) out.push(p);
        } catch { }
    }
    return out;
}

// ── Kompakt genel bakış (`.menu`) ─────────────────────────────────────────────
function buildCompactMenu(plugins, pfx, botName, mode) {
    const allCmds   = new Set(plugins.flatMap(p => p.commands || []));
    const modeEmoji = mode === 'PUBLIC' ? '🟢' : mode === 'PRIVATE' ? '🔒' : '🔵';
    const now       = moment().tz(TZ);
    let totalAssigned = 0;

    const header =
        `\n╔══════════════════════════════════╗\n` +
        `║  ⚡  *${botName.toUpperCase().slice(0,26).padEnd(26)}*  ⚡  ║\n` +
        `║    _En Gelişmiş WhatsApp Botu_   ║\n` +
        `╚══════════════════════════════════╝\n`;

    const statusBlock = box(`📋 Bot Aktif`, [
        `◆ *Bot:*      ${botName}`,
        `◆ *Önek:*     \`${pfx}\``,
        `◆ *Mod:*      ${modeEmoji} ${mode}`,
        `◆ *Komutlar:* ${allCmds.size}`,
        `◆ *Tarih:*    ${now.format('ddd D MMM YYYY')}`,
        `◆ *Saat:*     ${now.format('hh:mm A')} EAT`,
    ]);

    // Komut sayılarıyla numaralı kategori listesi
    const catLines = [];
    for (const cat of CATEGORIES) {
        const found = [...new Set(cat.cmds.filter(c => allCmds.has(c)))];
        if (!found.length) continue;
        totalAssigned += found.length;
        const num = String(cat.id).padStart(2, ' ');
        catLines.push(`│  *${num}.* ${cat.icon}  ${cat.name.padEnd(22)} *(${found.length})*`);
    }

    const catBlock =
        `\n╭${hline()}\n` +
        `│  📋 *KOMUT KATEGORİLERİ*\n` +
        `│  _(tam liste için \`.menu <numara>\` yazın)_\n` +
        `├${hline()}\n` +
        catLines.join('\n') +
        `\n╰${hline()}`;

    const footer =
        `\n╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╮\n` +
        `│  📖 *Daha Fazla Örnek:*           │\n` +
        `│  \`${pfx}menu 3\`  → Yapay Zeka       │\n` +
        `│  \`${pfx}menu 6\`  → Grup Yönetimi    │\n` +
        `│  \`${pfx}menu 18\` → Ödünç & Alt Bot  │\n` +
        `│  \`${pfx}help <komut>\` → Komut yardımı│\n` +
        `╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯\n` +
        `\n> 🌐 _${WEBSITE}_\n` +
        `> ⚡ _Zlose tarafından yapıldı © ${now.year()}_`;

    return `${header}${statusBlock}\n${catBlock}\n${footer}`;
}

// ── Kategori detay sayfası (`.menu <id>`) ─────────────────────────────────────
function buildCategoryMenu(cat, plugins, pfx) {
    const allCmds = new Set(plugins.flatMap(p => p.commands || []));
    const descMap = new Map(
        plugins.flatMap(p => (p.commands || []).map(c => [c, { desc: p.description || '', usage: p.usage || '', perm: p.permission || 'public' }]))
    );
    const found = [...new Set(cat.cmds.filter(c => allCmds.has(c)))];
    if (!found.length) return `❌ *${cat.name}* kategorisinde komut bulunamadı.`;

    const PERM_ICON = { owner: '👑', admin: '⚙️', public: '🌍' };
    const lines = found.map(c => {
        const info    = descMap.get(c) || {};
        const pIcon   = PERM_ICON[(info.perm || 'public').toLowerCase()] || '🌍';
        const shortD  = (info.desc || '').slice(0, 45);
        return `│  ${pIcon} \`${pfx}${c}\`${shortD ? `\n│     _${shortD}_` : ''}`;
    });

    const header =
        `\n${cat.icon} *${cat.name.toUpperCase()}*\n` +
        `_${found.length} komut mevcut_\n`;

    const cmdBlock =
        `╭${hline()}\n` +
        lines.join('\n│\n') +
        `\n╰${hline()}`;

    const footer =
        `\n╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╮\n` +
        `│ \`${pfx}help <komut>\` ayrıntı için │\n` +
        `│ \`${pfx}menu\` genel bakış için     │\n` +
        `╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯\n` +
        `\n_🌍 Herkese Açık  ⚙️ Yönetici  👑 Sahip_`;

    return `${header}${cmdBlock}${footer}`;
}

// ── Tekil komut yardımı (`.help <cmd>`) ───────────────────────────────────────
function buildCommandHelp(cmdName, plugins, pfx) {
    const plugin = plugins.find(p => (p.commands || []).includes(cmdName));
    if (!plugin) {
        return `❌ \`${pfx}${cmdName}\` komutu bulunamadı.\n\nTüm komutlara göz atmak için \`${pfx}menu\` kullanın.`;
    }
    const aliases = (plugin.commands || []).filter(c => c !== cmdName);
    const perm    = (plugin.permission || 'public').toLowerCase();
    const permTag = perm === 'owner' ? '👑 Yalnızca sahip' : perm === 'admin' ? '⚙️ Yalnızca yönetici' : '🌍 Herkese açık';

    return [
        ``,
        `📖 *Komut Yardımı*`,
        ``,
        box(`${pfx}${cmdName}`, [
            `◆ *Açıklama:*`,
            `   ${plugin.description || 'Açıklama mevcut değil.'}`,
            ``,
            `◆ *Kullanım:*`,
            `   ${plugin.usage ? plugin.usage.replace(/\./g, pfx) : `\`${pfx}${cmdName}\``}`,
            ``,
            `◆ *Yetki:*       ${permTag}`,
            `◆ *Grup:*        ${plugin.group ? '✅ Evet' : '❌ Hayır'}`,
            `◆ *Özel Mesaj:*  ${plugin.private !== false ? '✅ Evet' : '❌ Hayır'}`,
            ...(aliases.length ? [`◆ *Takma Adlar:* ${aliases.map(a => `\`${pfx}${a}\``).join(' • ')}`] : []),
        ]),
        ``,
        `> _Tüm komutlara göz atmak için \`${pfx}menu\` kullanın_`
    ].join('\n');
}

// ── Eklenti ───────────────────────────────────────────────────────────────────
module.exports = {
    commands:    ['menu', 'help', 'list', 'cmds', 'commands'],
    description: 'Tüm komutları kategorili menüde gösterir — kategori detayı için .menu <numara> kullanın',
    usage:       '.menu | .menu <1-21> | .menu <kategori adı> | .help <komut>',
    permission:  'public',
    group:       true,
    private:     true,

    run: async (sock, message, args, ctx) => {
        const { prefix, contextInfo, safeSend } = ctx;
        const plugins = loadPlugins();
        const botName = getStr('botName') || config.BOT_NAME || 'Alpha';
        const mode    = (config.MODE || 'public').toUpperCase();
        const pfx     = prefix || '.';
        const imgUrl  = getStr('pic1') || config.ALIVE_IMG || 'https://files.catbox.moe/5uli5p.jpeg';

        const rawCmd = (
            message.message?.extendedTextMessage?.text ||
            message.message?.conversation || ''
        ).trim().split(/\s+/)[0].replace(/^[^\w]/, '').toLowerCase();

        // ── .help <komut> ───────────────────────────────────────────────────
        if (rawCmd === 'help' && args.length) {
            const cmdName = args[0].replace(/^\./, '').toLowerCase();
            return safeSend({ text: buildCommandHelp(cmdName, plugins, pfx), contextInfo }, { quoted: message });
        }

        // ── .menu <id|isim> — belirli bir kategorinin detayı ────────────────
        if (args.length) {
            const query = args.join(' ').toLowerCase().trim();

            const byNum  = /^\d+$/.test(query) ? CATEGORIES.find(c => c.id === parseInt(query, 10)) : null;
            const byName = !byNum ? CATEGORIES.find(c => c.name.toLowerCase().includes(query)) : null;
            const cat    = byNum || byName;

            if (cat) {
                return safeSend({ text: buildCategoryMenu(cat, plugins, pfx), contextInfo }, { quoted: message });
            }

            const cmdName = query.replace(/^\./, '');
            const plugin  = plugins.find(p => (p.commands || []).includes(cmdName));
            if (plugin) {
                return safeSend({ text: buildCommandHelp(cmdName, plugins, pfx), contextInfo }, { quoted: message });
            }

            const examples = CATEGORIES.slice(0, 6).map(c => `  \`${pfx}menu ${c.id}\` — ${c.icon} ${c.name}`).join('\n');
            return safeSend({
                text: `❌ *"${query}"* herhangi bir kategori veya komutla eşleşmedi.\n\n📋 *Şunları deneyin:*\n${examples}\n\nYa da genel bakış için \`${pfx}menu\` kullanın.`,
                contextInfo
            }, { quoted: message });
        }

        // ── .menu — kompakt genel bakış ──────────────────────────────────────
        const menuText = buildCompactMenu(plugins, pfx, botName, mode);

        // Önce görsel + açıklama dene, olmazsa düz metne dön
        try {
            await safeSend({ image: { url: imgUrl }, caption: menuText, contextInfo }, { quoted: message });
        } catch {
            await safeSend({ text: menuText, contextInfo }, { quoted: message });
        }
    }
};
