'use strict';

const responses = [
    '✅ Kesindir.',
    '✅ Hiç şüphesiz.',
    '✅ Evet, kesinlikle.',
    '✅ Most likely.',
    '✅ Büyük olasılıkla.',
    '🔮 Daha sonra tekrar sor.',
    '🔮 Şu an tahmin edilemiyor.',
    '🔮 Odaklan ve tekrar sor.',
    '❌ Buna bel bağlama.',
    '❌ Yanıtım hayır.',
    '❌ Kaynaklarım hayır diyor.',
    '❌ Çok şüpheli.',
    '❌ Görünüm pek iyi değil.'
];

module.exports = {
    commands:    ['8ball', 'magic8'],
    description: 'Sihirli 8-topa evet/hayır sorusu sor',
    permission:  'public',
    group:       true,
    private:     true,
    run: async (sock, message, args, { sender, groupId, contextInfo }) => {
        const question = args.join(' ');
        const chatId   = groupId || sender;
        if (!question) {
            return sock.sendMessage(chatId, {
                text: '🎱 Sihirli 8-topa bir soru sor! \nÖrnek: .8ball Zengin olacak mıyım?',
                contextInfo
            }, { quoted: message });
        }
        const answer = responses[Math.floor(Math.random() * responses.length)];
        await sock.sendMessage(chatId, {
            text: `🎱 *Sihirli 8-Top*\n\n❓ ${question}\n\n${answer}`,
            contextInfo
        }, { quoted: message });
    }
};
