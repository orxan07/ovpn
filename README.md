# WireGuard Admin Panel

Веб-панель для управления WireGuard VPN с поддержкой sing-box и Outline (Shadowsocks).

## Стек

- **VPS**: MTS Cloud, Ubuntu 24.04
- **VPN**:
  - **WireGuard** (`wg0`, UDP/443) — для прямых WG-клиентов и sing-box pipeline
  - **SSTP** (TCP/14942, `accel-ppp`) — для роутеров за DPI-операторами (например Keenetic Hopper за МТС). См. [`infra/sstp/`](infra/sstp/) и [`docs/dpi-bypass.md`](docs/dpi-bypass.md)
- **Обход блокировок**: sing-box + Outline/Shadowsocks
- **Панель**: Node.js + Express + vanilla JS SPA
- **Домен**: `https://vpn.rehimli.info` (nginx + Let's Encrypt)

## Архитектура

```
Клиент (iPhone/Mac)
  └── WireGuard туннель → VPS 171.22.75.104:443
        └── sing-box (tun на wg0)
              ├── заблокированные домены/IP → Outline (Shadowsocks)
              └── остальное → прямой выход
```

Sing-box работает как прозрачный прокси внутри WireGuard туннеля. Трафик к заблокированным сайтам (YouTube, Telegram, WhatsApp и др.) идёт через Outline, остальной — напрямую.

## Быстрый старт (установка на VPS)

```bash
curl -fsSL https://raw.githubusercontent.com/orxan07/ovpn/main/scripts/setup-vps.sh | bash
```

Скрипт:
1. Устанавливает Node.js, git, nginx, certbot
2. Клонирует репозиторий в `/opt/wg-admin`
3. Настраивает systemd сервис
4. Выдаёт SSL сертификат для домена
5. Добавляет глобальную команду `app`

После установки открой `https://vpn.rehimli.info` и войди с токеном из `/opt/wg-admin/.env`.

## Команды на VPS

```bash
app start      # запустить панель
app restart    # перезапустить
app stop       # остановить
app status     # статус
app logs       # логи в реальном времени
```

## Обновление

```bash
cd /opt/wg-admin && git pull && app restart
```

## Структура проекта

```
ovpn/
├── client/
│   └── index.html          # SPA (один файл, без сборки)
├── server/
│   ├── index.js            # Express API
│   ├── wg.js               # Управление WireGuard (ключи, пиры, конфиги)
│   ├── store.js            # JSON хранилище состояния клиентов
│   ├── system.js           # Системные метрики (CPU, RAM, диск, сеть)
│   ├── whitelist.js        # Редактор whitelist в /etc/sing-box/config.json
│   └── presets.js          # Предустановки доменов и IP для сервисов
├── scripts/
│   ├── setup-vps.sh         # Установка панели + WG с нуля
│   ├── bootstrap-vps.sh     # Полный bootstrap: пакеты + setup-vps + setup-sstp
│   ├── backup.sh            # Бэкап всего стека в один tar.gz
│   ├── restore.sh           # Восстановление из бэкапа на новом VPS
│   └── deploy.sh            # Деплой обновлений
├── infra/
│   └── sstp/                # SSTP-сервер на accel-ppp (см. infra/sstp/README.md)
│       ├── setup-sstp.sh
│       ├── accel-ppp.conf.tpl
│       ├── accel-ppp.service
│       ├── firewall.sh
│       ├── sstp-firewall.service       # systemd unit: восстановить iptables после reboot
│       ├── users.sh
│       ├── sstp-singbox.nft           # nft-правила: SSTP-трафик через sing-box
│       ├── sstp-singbox-route.service # systemd unit для них
│       ├── enable-singbox-integration.sh
│       └── disable-singbox-integration.sh
├── docs/
│   ├── dpi-bypass.md        # История: почему пришли к SSTP
│   ├── keenetic-setup.md    # Настройка Keenetic Hopper как SSTP-клиента
│   ├── runbook.md           # Operational-команды для всех сервисов
│   └── disaster-recovery.md # План переезда на новый VPS
└── data/
    └── store.json           # Данные клиентов (создаётся автоматически)
```

## Перенос на другой VPS

Один tar.gz файл — и всё: ключи WG, пользователи SSTP, TLS-cert SSTP, whitelist
sing-box, nginx + LE, nft-интеграция, метаданные клиентов админки.

```bash
# регулярный бэкап (раз в неделю / по требованию)
sudo bash /opt/wg-admin/scripts/backup.sh
scp root@VPS:/root/vpn-backup-*.tar.gz ~/Backups/vpn/

# на новом VPS — bootstrap + restore
curl -fsSL https://raw.githubusercontent.com/orxan07/ovpn/main/scripts/bootstrap-vps.sh \
  | bash -s -- --domain vpn.rehimli.info
sudo bash /opt/wg-admin/scripts/restore.sh /root/vpn-backup-LATEST.tar.gz
```

Подробности — [`docs/disaster-recovery.md`](docs/disaster-recovery.md).

## SSTP для DPI-проблемных провайдеров

Если оператор клиента (МТС, Билайн и т.п.) режет WireGuard и OpenVPN —
поднимается SSTP-сервер поверх TLS, который для DPI выглядит как обычный HTTPS.

```bash
# на VPS
cd /opt/ovpn/infra/sstp
sudo bash setup-sstp.sh
```

Скрипт собирает `accel-ppp` из исходников, генерит self-signed cert,
пишет конфиг, настраивает NAT/firewall, поднимает systemd-юнит и печатает
готовые реквизиты для подключения. Подробности — [`infra/sstp/README.md`](infra/sstp/README.md).

Настройка Keenetic-роутера как SSTP-клиента — [`docs/keenetic-setup.md`](docs/keenetic-setup.md).

## API

Все запросы требуют заголовок `Authorization: Bearer <token>`, кроме `/config/:token`.

### Клиенты

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/peers` | Список всех клиентов |
| POST | `/api/peers` | Создать клиента `{ name }` |
| GET | `/api/peers/:name` | Детали клиента |
| PATCH | `/api/peers/:name` | Обновить `{ newName, note, limitGb }` |
| DELETE | `/api/peers/:name` | Удалить клиента |
| POST | `/api/peers/:name/block` | Заблокировать |
| POST | `/api/peers/:name/unblock` | Разблокировать |
| GET | `/api/peers/:name/config` | WireGuard конфиг (текст) |
| GET | `/api/peers/:name/download` | Скачать `.conf` файл |
| GET | `/api/peers/:name/qr` | QR-код (base64 PNG) |
| GET | `/api/peers/:name/singbox?mode=mobile\|wifi` | sing-box конфиг (JSON) |
| GET | `/api/peers/:name/endpoints` | История IP-адресов |
| POST | `/api/peers/:name/config-token` | Создать/обновить токен для remote profile |

### Система

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/system` | CPU, RAM, диск, сеть, uptime |
| GET | `/api/system/check` | Статус sing-box, WireGuard, Outline |
| POST | `/api/system/restart/:service` | Перезапустить `sing-box` или `wg-quick@wg0` |
| POST | `/api/system/rotate-token` | Сгенерировать новый токен авторизации |

### Whitelist

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/whitelist` | Список доменов |
| POST | `/api/whitelist` | Добавить домен `{ domain }` |
| DELETE | `/api/whitelist/:domain` | Удалить домен |
| GET | `/api/whitelist/presets` | Список предустановок |
| POST | `/api/whitelist/presets/apply` | Применить пресет `{ name }` |

### Remote Profile (публичный)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/config/:token?mode=mobile\|wifi` | sing-box конфиг для импорта в приложение |

## Клиентские приложения

### iOS — WireGuard (стандартный режим)
Подходит для Wi-Fi. Импортируй `.conf` или QR-код из панели.

### iOS — sing-box SFI (мобильная сеть + Wi-Fi)
Мегафон и ряд других операторов блокируют WireGuard UDP после handshake. Решение — использовать sing-box как клиент.

1. Установи [sing-box](https://apps.apple.com/app/sing-box/id6451272673) из App Store
2. В панели открой клиента → вкладка **sing-box** → **Создать ссылку**
3. В sing-box: Profiles → + → Remote → вставь URL
4. Создай два профиля: Mobile (без `route_exclude_address`) и Wi-Fi (с `route_exclude_address`)

## Данные клиентов

Хранятся в `/opt/wg-admin/data/store.json`:

```json
{
  "client-name": {
    "createdAt": 1712345678000,
    "blocked": false,
    "limitGb": null,
    "note": "Кому выдан ключ",
    "configToken": "abc123...",
    "endpoints": [
      { "ip": "1.2.3.4", "firstSeen": 1712345678000, "lastSeen": 1712349999000, "count": 42 }
    ]
  }
}
```

WireGuard конфиги и ключи хранятся в `/etc/wireguard/clients/`.

## Предустановки whitelist

В панели на странице **Whitelist** → секция **Предустановки**:

| Сервис | Домены | IP-диапазоны |
|--------|--------|--------------|
| Telegram | telegram.org, t.me, ... | IPv4/IPv6 диапазоны из официального `cidr.txt` |
| YouTube | youtube.com, ytimg.com, ggpht.com, googlevideo.com, googleusercontent.com, ... | — |
| WhatsApp | whatsapp.com, wa.me, ... | 16 диапазонов Meta |
| Instagram / Facebook / Meta | instagram.com, fbcdn.net, cdninstagram.com, ... | основные диапазоны AS32934 Meta |
| Discord | discord.com, discordapp.com, ... | — |
| OpenAI / ChatGPT | openai.com, chatgpt.com, ... | — |
| Anthropic / Claude | anthropic.com, claude.ai, ... | — |
| Cursor | cursor.com, cursor.sh, cursorapi.com, cursor-cdn.com, VS Code/GitHub deps, ... | — |
| Netflix | netflix.com, nflxvideo.net, fast.com, ... | 12 диапазонов AS2906 (Open Connect) |

IP-диапазоны нужны для звонков и медиа (WhatsApp, Telegram) — они используют прямые IP без DNS.
