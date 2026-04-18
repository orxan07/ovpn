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
  {
    name: 'Netflix',
    // Все домены идут по SNI/HTTPS, поэтому списка доменов почти всегда хватает.
    domains: [
      'netflix.com',         // основной сайт + API
      'netflix.net',
      'nflxext.com',         // статика, UI bundle
      'nflximg.com',         // постеры, картинки
      'nflximg.net',
      'nflxso.net',          // UI / заставки
      'nflxvideo.net',       // видео-CDN (Open Connect)
      'fast.com',            // спидтест Netflix
      'netflixdnstest1.com', // DNS-проверка региона (geo-fence)
      'netflixdnstest2.com',
      'netflixdnstest3.com',
      'netflixdnstest4.com',
      'netflixdnstest5.com',
      'netflixdnstest6.com',
      'netflixdnstest7.com',
      'netflixdnstest8.com',
      'netflixdnstest9.com',
      'netflixdnstest10.com',
    ],
    // ASN AS2906 (Netflix) — основные блоки Open Connect.
    // Нужны если sing-box работает в режиме без SNI-sniff, либо если
    // приложение Netflix использует QUIC и SNI не виден на промежуточном уровне.
    ipCidr: [
      '23.246.0.0/18',
      '37.77.184.0/21',
      '38.72.126.0/24',
      '45.57.0.0/17',
      '64.120.128.0/17',
      '66.197.128.0/17',
      '108.175.32.0/20',
      '185.2.220.0/22',
      '185.9.188.0/22',
      '192.173.64.0/18',
      '198.38.96.0/19',
      '198.45.48.0/20',
    ],
  },
];

module.exports = { PRESETS };
