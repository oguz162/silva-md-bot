'use strict';
const axios = require('axios');

// adviceslip.com has frequent timeouts — removed as primary.
// Using zenquotes.io (confirmed working 2026-06) as primary.

const LOCAL_ADVICE = [
    "Mola verin. Beyninizin iyi çalışabilmesi için dinlenmeye ihtiyacı vardır.",
    "Bugün yeterince su için. Küçük alışkanlıklar büyük değişimlere yol açar.",
    "Konuşmadan önce kendinize sorun: Doğru mu, nazik mi, gerekli mi?",
    "Kıyaslama, neşenin hırsızıdır. Kendi yarışını koş.",
    "Başlamak için harika olmanıza gerek yok, ancak harika olmak için başlamanız gerekir.",
    "Kendine, iyi bir arkadaşına davranacağın şekilde davran.",
    "Hedef mükemmellik değil, ilerlemedir.",
    "Yapabileceğiniz en iyi yatırım, kendinize yaptığınız yatırımdır.",
    "Her gün seni korkutan bir şey yap; gelişim işte orada yaşar.",
    "Affetmek, diğer kişiyle ilgili değildir. Kendinizi özgürleştirmekle ilgilidir.",
    "Eşyalara değil, deneyimlere yatırım yapın; anılar daha uzun süre kalıcıdır.",
    "İyi şeylere hayır de ki, harika olanlara evet diyebilesin.",
    "Enerjiniz en değerli kaynağınızdır. Onu koruyun.",
    "Tepki verme, yanıt ver. İkisi arasında fark vardır.",
    "Mükemmel anı beklemeyi bırakın. Anı yakalayın ve onu mükemmel kılın.",
];

module.exports = {
    commands:    ['advice', 'tip'],
    description: 'Rastgele bir tavsiye al',
    permission:  'public',
    group:       true,
    private:     true,

    run: async (sock, message, args, ctx) => {
        const { contextInfo } = ctx;
        const jid = message.key.remoteJid;
        let text;

        // 1. Try zenquotes.io (confirmed working 2026-06, has advice category)
        try {
            const res = await axios.get(
                'https://zenquotes.io/api/random',
                { headers: { 'User-Agent': 'Alpha-Bot/2.0' }, timeout: 7000 }
            );
            const q = Array.isArray(res.data) ? res.data[0] : res.data;
            if (q?.q && q?.a) {
                text = `💡 *Advice*\n\n"${q.q}"\n\n— _${q.a}_`;
            } else throw new Error('boş');
        } catch {
            // 2. Try adviceslip as secondary (was primary before; kept as backup)
            try {
                const res = await axios.get(
                    'https://api.adviceslip.com/advice',
                    { headers: { 'Accept': 'application/json' }, timeout: 5000 }
                );
                const slip = res.data?.slip;
                if (slip?.advice) {
                    text = `💡 *Advice #${slip.id}*\n\n"${slip.advice}"`;
                } else throw new Error('empty');
            } catch {
                // 3. Local fallback — always works
                text = `💡 *Advice*\n\n"${LOCAL_ADVICE[Math.floor(Math.random() * LOCAL_ADVICE.length)]}"`;
            }
        }

        await sock.sendMessage(jid, { text, contextInfo }, { quoted: message });
    }
};
