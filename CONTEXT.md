# WireGuard Admin Panel — контекст проекта

> Этот файл для быстрого погружения в новом чате. README.md — пользовательская документация, CONTEXT.md — технический контекст для разработки.

## Инфраструктура

| Параметр | Значение |
|---|---|
| Публичный IP | `171.22.75.104` |
| Домен панели | `https://vpn.rehimli.info` |
| OS | Ubuntu 24.04 LTS |
| WireGuard порт | `443/UDP` |
| WireGuard интерфейс | `wg0` |
| Подсеть клиентов | `10.20.0.0/24` |
| VPS адрес в туннеле | `10.20.0.1` |
| sing-box TUN интерфейс | `sbtun` |
| Клиентские конфиги WG | `/etc/wireguard/clients/` |
| Серверный конфиг WG | `/etc/wireguard/wg0.conf` |
| sing-box конфиг | `/etc/sing-box/config.json` |
| Панель на VPS | `/opt/wg-admin/` |
| Данные клиентов | `/opt/wg-admin/data/store.json` |
| Токен авторизации | `/opt/wg-admin/.env` → `AUTH_TOKEN=...` |

## Текущие клиенты

| Имя | IP | Устройство |
|---|---|---|
| `Parvin` | `10.20.0.2` | iPhone 1 |
| `Orxan` | `10.20.0.4` | iPhone 2 |
| `Yosr` | `10.20.0.5` | третий клиент |

## Особенности сети

- Мегафон режет WireGuard UDP на мобильной сети после handshake
- Решение: sing-box iOS (SFI) вместо нативного WireGuard приложения
- Два профиля на iPhone: **mobile** (без `route_exclude_address`) и **wifi** (с `route_exclude_address: ["171.22.75.104/32"]`)
- Outline (Shadowsocks) используется для split-routing заблокированных сайтов через sing-box на VPS
- WhatsApp звонки/видео требуют IP-диапазоны Meta в `route.rules[].ip_cidr` — без них DNS работает, но TURN серверы недоступны

## Структура проекта

```
/Users/orxan/ovpn/         ← локальная копия
/opt/wg-admin/             ← на VPS

├── client/
│   └── index.html         # SPA — один файл, без сборки, vanilla JS
├── server/
│   ├── index.js           # Express API + background poller (30s)
│   ├── wg.js              # WireGuard: ключи, пиры, конфиги, QR, sing-box
│   ├── store.js           # JSON хранилище: endpoints, limits, blocked, notes, configToken
│   ├── system.js          # /proc метрики: CPU, RAM, disk, network speed, uptime
│   ├── whitelist.js       # Редактор /etc/sing-box/config.json (домены + ip_cidr)
│   └── presets.js         # Предустановки: Telegram, YouTube, WhatsApp, Meta, Discord, OpenAI
├── scripts/
│   ├── setup-vps.sh       # Установка с нуля (Node, nginx, certbot, systemd, app команда)
│   └── deploy.sh          # Деплой обновлений
├── data/
│   └── store.json         # Создаётся автоматически на VPS
├── CONTEXT.md             # Этот файл
└── README.md              # Пользовательская документация
```

## Архитектура API

### Защищённые (Bearer token)
- `GET/POST /api/peers` — список, создание
- `GET/PATCH/DELETE /api/peers/:name` — детали, обновление, удаление
- `POST /api/peers/:name/block|unblock`
- `GET /api/peers/:name/config|download|qr` — конфиг, скачать .conf, QR
- `GET /api/peers/:name/singbox?mode=mobile|wifi` — sing-box JSON конфиг
- `GET /api/peers/:name/endpoints` — история IP-адресов
- `POST /api/peers/:name/config-token` — создать/обновить токен для remote profile
- `GET /api/system` — CPU/RAM/disk/network/uptime
- `GET /api/system/check` — статус sing-box, WireGuard, Outline
- `POST /api/system/restart/:service` — перезапуск sing-box или wg-quick@wg0
- `POST /api/system/rotate-token` — ротация токена авторизации (пишет в .env, активно сразу)
- `GET/POST /api/whitelist` — домены
- `DELETE /api/whitelist/:domain`
- `GET /api/whitelist/presets` — список пресетов
- `POST /api/whitelist/presets/apply` — применить пресет `{ name }`

### Публичный (без авторизации)
- `GET /config/:token?mode=mobile|wifi` — sing-box конфиг для remote profile в iOS приложении

## store.json структура

```json
{
  "ClientName": {
    "createdAt": 1712345678000,
    "blocked": false,
    "limitGb": null,
    "note": "Кому выдан",
    "configToken": "hex32chars",
    "endpoints": [
      { "ip": "1.2.3.4", "firstSeen": 0, "lastSeen": 0, "count": 1 }
    ]
  }
}
```

## Фоновый поллинг (каждые 30 сек)

В `server/index.js` — `setInterval`:
1. Трекает endpoint каждого пира → `store.trackEndpoint()`
2. Проверяет лимит трафика → если превышен, вызывает `wg.blockClient()` + `store.setBlocked()`

## Важные нюансы

- `getToken()` читает `.env` на каждый запрос — ротация токена работает без перезапуска сервиса
- `writeConfig()` в whitelist.js пишет через временный файл (`/tmp/`) + `sudo cp` — старый способ через shell escaping ломался на JSON с кавычками
- `/etc/wireguard` должен быть `chmod 750, chown root:orxan` иначе Node.js не видит клиентов
- sing-box читает все `.json` файлы из `/etc/sing-box/` — не клади туда клиентские конфиги
- `SERVER_PUBKEY` и `SERVER_ENDPOINT` захардкожены в `wg.js` — при смене VPS обновить там
- MTU для новых клиентов = 1200 (уменьшено для совместимости с мобильными сетями)

## Команды на VPS

```bash
app start|restart|stop|status|logs
cd /opt/wg-admin && git pull && app restart  # обновление
cat /opt/wg-admin/.env                        # посмотреть токен
```
