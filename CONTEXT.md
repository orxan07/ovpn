# WireGuard Admin Panel — контекст и план

## Что это

Веб-панель для управления WireGuard VPN на MTS VPS.
Позволяет видеть активных пользователей и добавлять новых без SSH.

---

## Инфраструктура VPS

| Параметр | Значение |
|---|---|
| Публичный IP | `171.22.75.104` |
| OS | Ubuntu 24.04 LTS |
| WireGuard порт | `443/UDP` |
| WireGuard интерфейс | `wg0` |
| Подсеть клиентов | `10.20.0.0/24` |
| Адрес VPS в туннеле | `10.20.0.1` |
| sing-box TUN | `sbtun` |
| Клиентские конфиги | `/etc/wireguard/clients/*.conf` |
| Серверный конфиг | `/etc/wireguard/wg0.conf` |
| sing-box конфиг | `/etc/sing-box/config.json` |

## Текущие клиенты

| Имя | IP | Устройство |
|---|---|---|
| `iphone` | `10.20.0.2` | iPhone 1 (владелец) |
| `macbook` | `10.20.0.3` | промежуточный |
| `iphone2` | `10.20.0.4` | iPhone 2 (владелец) |
| `friend` | `10.20.0.5` | друг |

## Особенности

- Мегафон (и некоторые другие операторы) режет UDP на мобильной сети
- Решение: sing-box (SFI) на iPhone вместо нативного WireGuard приложения
- На Wi-Fi нужен конфиг с `route_exclude_address: ["171.22.75.104/32"]`
- На мобильной сети — без этого параметра
- Outline используется для обхода блокировок YouTube/Telegram/Instagram/etc через split-routing на VPS

---

## План веб-панели

### Стек

- **Backend:** Node.js (Express) на VPS — имеет доступ к WireGuard и файловой системе
- **Frontend:** простой React или vanilla HTML/JS
- **Связь:** REST API
- **Деплой:** systemd сервис на VPS, порт `8080` (или другой), закрытый паролём

### Фичи MVP

1. **Список пользователей** — таблица со всеми peer'ами:
   - имя клиента
   - IP в туннеле
   - статус (активен / нет handshake)
   - время последнего handshake
   - transfer (rx/tx)

2. **Добавить клиента** — форма:
   - имя
   - автоматически выбирает следующий свободный IP
   - генерирует ключи
   - добавляет peer в `wg0`
   - сохраняет `.conf` файл
   - показывает QR-код для сканирования

3. **Удалить клиента** — убирает peer из WireGuard и удаляет файлы ключей

4. **Показать QR / конфиг** — для существующего клиента

### Опционально (после MVP)

- sing-box конфиг для iPhone (mobile/wifi) — генерировать и показывать прямо в панели
- Логи трафика по клиенту
- Ограничение полосы

---

## Архитектура backend API

```
GET  /api/peers          — список всех peer'ов с состоянием из `wg show`
POST /api/peers          — создать нового клиента (имя в body)
DELETE /api/peers/:name  — удалить клиента
GET  /api/peers/:name/qr — QR-код в base64 PNG
GET  /api/peers/:name/config — текст .conf файла
```

### Как получить данные из WireGuard

```bash
sudo wg show wg0 dump
# Вывод: pubkey, preshared, endpoint, allowed_ips, last_handshake, rx, tx, keepalive
```

Backend парсит этот вывод и сопоставляет с файлами в `/etc/wireguard/clients/`.

### Как создать клиента (логика)

1. Найти следующий свободный IP в `10.20.0.0/24` (текущий максимум + 1)
2. `wg genkey | tee NAME.key | wg pubkey > NAME.pub`
3. Записать `NAME.conf`
4. `wg set wg0 peer PUBKEY allowed-ips IP/32`
5. Дописать peer в `wg0.conf`
6. Вернуть конфиг и QR

---

## Структура проекта

```
/Users/orxan/ovpn/
├── CONTEXT.md          ← этот файл
├── server/
│   ├── package.json
│   ├── index.js        ← Express API
│   └── wg.js           ← утилиты для работы с WireGuard
└── client/
    ├── index.html
    └── app.js          ← или React
```

---

## Безопасность

- API должно быть защищено — минимум Bearer токен или basic auth
- Backend крутится только на localhost или внутри туннеля, не на публичном IP напрямую
- Все команды через `sudo` — нужно настроить sudoers для пользователя сервиса

Пример `/etc/sudoers.d/wg-admin`:
```
wgadmin ALL=(ALL) NOPASSWD: /usr/bin/wg, /usr/bin/wg-quick, /usr/bin/qrencode
```

---

## Следующие шаги

1. Создать `server/` — Node.js Express API с командами wg
2. Создать `client/` — простой UI (таблица peers + форма добавления)
3. Задеплоить на VPS как systemd сервис
4. Настроить sudoers на VPS
5. Открыть порт панели только внутри WireGuard туннеля (10.20.0.0/24)
