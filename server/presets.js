// Предустановленные домены и IP-диапазоны для популярных сервисов
// Применяются через POST /api/whitelist/presets/apply

const PRESETS = [
  {
    name: 'Telegram',
    domains: [
      'telegram.org', 't.me', 'telegram.me', 'telegra.ph',
      'telesco.pe', 'tdesktop.com', 'telegram.dog',
      'telegramdownload.com', 'telegram-cdn.org',
      'comments.app', 'graph.org', 'quiz.directory',
      'contest.com', 'fragment.com',
    ],
    // Источник: https://core.telegram.org/resources/cidr.txt
    // Telegram MTProto подключается по жёстко прописанным IP DC,
    // поэтому без полного списка соединение быстро рвётся.
    ipCidr: [
      '91.105.192.0/23',
      '91.108.4.0/22',
      '91.108.8.0/22',
      '91.108.12.0/22',
      '91.108.16.0/22',
      '91.108.20.0/22',
      '91.108.56.0/22',
      '95.161.64.0/20',
      '149.154.160.0/20',
      '185.76.151.0/24',
    ],
  },
  {
    name: 'YouTube',
    domains: [
      'youtube.com', 'youtu.be', 'ytimg.com',
      'googlevideo.com', 'youtubei.googleapis.com',
    ],
    ipCidr: [],
  },
  {
    name: 'WhatsApp',
    domains: [
      'whatsapp.com', 'whatsapp.net', 'whatsapp-cdn.net',
      'static.whatsapp.net', 'mmg.whatsapp.net', 'wa.me',
      'whatsapp-cdn-shv.net',
    ],
    ipCidr: [
      '31.13.24.0/21', '31.13.64.0/18', '45.64.40.0/22',
      '66.220.144.0/20', '69.63.176.0/20', '69.171.224.0/19',
      '74.119.76.0/22', '102.132.96.0/20', '103.4.96.0/22',
      '129.134.0.0/17', '157.240.0.0/17', '163.70.128.0/17',
      '173.252.64.0/18', '179.60.192.0/22', '185.60.216.0/22',
      '204.15.20.0/22',
    ],
  },
  {
    name: 'Instagram / Facebook / Meta',
    domains: [
      'instagram.com', 'cdninstagram.com', 'ig.me', 'threads.net',
      'facebook.com', 'facebook.net', 'fb.com', 'fbsbx.com',
      'fbcdn.net', 'meta.com',
    ],
    ipCidr: [],
  },
  {
    name: 'Discord',
    domains: [
      'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net',
    ],
    ipCidr: [],
  },
  {
    name: 'OpenAI / ChatGPT',
    domains: [
      'openai.com', 'chatgpt.com', 'oaistatic.com',
      'oaiusercontent.com', 'sora.com',
    ],
    ipCidr: [],
  },
];

module.exports = { PRESETS };
