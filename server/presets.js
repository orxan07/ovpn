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
      'contest.com', 'fragment.com', 'tx.me',
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
      '2001:b28:f23d::/48',
      '2001:b28:f23f::/48',
      '2001:67c:4e8::/48',
      '2001:b28:f23c::/48',
      '2a0a:f280::/32',
    ],
  },
  {
    name: 'YouTube',
    domains: [
      'youtube.com',
      'youtu.be',
      'youtube-nocookie.com',
      'yt.be',
      'ytimg.com',              // thumbnails: i.ytimg.com, img.youtube.com
      'ggpht.com',              // avatars/thumbnails in mobile app: yt3.ggpht.com
      'googlevideo.com',        // video CDN
      'youtubei.googleapis.com',
      'youtube.googleapis.com',
      'googleapis.com',
      'googleusercontent.com',  // lh3.googleusercontent.com and similar image hosts
      'gstatic.com',
      'google.com',             // accounts / consent / mobile metadata
      'google.ru',
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
      'fbcdn.net', 'meta.com', 'm.me', 'messenger.com',
      'accountkit.com', 'facebook-hardware.com', 'facebookmail.com',
      'internet.org', 'oculus.com', 'oculuscdn.com', 'rocksdb.org',
      'workplace.com', 'workrooms.com',
    ],
    // Meta mobile apps and CDN often use direct IP/QUIC flows, not just SNI.
    // AS32934 major IPv4 ranges. Keep broad enough for Instagram media/CDN.
    ipCidr: [
      '31.13.24.0/21',
      '31.13.64.0/18',
      '31.13.96.0/19',
      '45.64.40.0/22',
      '57.144.0.0/14',
      '66.220.144.0/20',
      '69.63.176.0/20',
      '69.171.224.0/19',
      '74.119.76.0/22',
      '102.132.96.0/20',
      '103.4.96.0/22',
      '129.134.0.0/17',
      '157.240.0.0/17',
      '157.240.192.0/18',
      '163.70.128.0/17',
      '173.252.64.0/18',
      '179.60.192.0/22',
      '185.60.216.0/22',
      '185.89.216.0/22',
      '204.15.20.0/22',
      '2a03:2880::/32',
      '2620:0:1c00::/40',
    ],
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
    name: 'Anthropic / Claude',
    domains: [
      'anthropic.com',          // основной сайт + API (api.anthropic.com)
      'claude.ai',              // веб-чат
      'claudeusercontent.com',  // вложения / артефакты
    ],
    ipCidr: [],
  },
  {
    name: 'Cursor',
    domains: [
      'cursor.com',             // сайт, dashboard, api.cursor.com
      'cursor.sh',              // api2/api3/api4/repo42/authenticate/authenticator
      'cursor.so',              // legacy
      'cursorapi.com',          // marketplace.cursorapi.com
      'cursor-cdn.com',         // CDN бинарей и обновлений
      'anysphere.co',           // компания/служебные auth/telemetry endpoints
      'anysphere.com',
      // VS Code marketplace/update dependencies, used by Cursor for extensions.
      'marketplace.visualstudio.com',
      'gallery.vsassets.io',
      'update.code.visualstudio.com',
      'vscode.download.prss.microsoft.com',
      'vscode-unpkg.net',
      'open-vsx.org',
      // Часто нужны для расширений, MCP, авторизации и работы с репозиториями.
      'github.com',
      'githubusercontent.com',
      'githubassets.com',
      'githubcopilot.com',
      'github.dev',
      // зависимости которые Cursor дёргает напрямую:
      'openai.com',             // дублируется с OpenAI-пресетом, но оставим
      'anthropic.com',          // дублируется с Claude-пресетом
      'claude.ai',
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
