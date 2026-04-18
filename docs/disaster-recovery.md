# Disaster recovery: переезд на новый VPS

Цель — поднять весь VPN-стек (WG + SSTP + sing-box + Outline + админка)
на чистом VPS максимум за 30 минут, не теряя ни клиентов, ни whitelist.

## Что бэкапится

`scripts/backup.sh` собирает в один tar.gz всё необходимое:

| Путь | Зачем |
|------|-------|
| `/etc/wireguard/` | приватный ключ сервера, клиенты, конфиги |
| `/etc/sing-box/` | whitelist, outbound на Outline, route rules |
| `/etc/accel-ppp/`, `/etc/accel-ppp.conf` | SSTP-сервер: TLS-cert и пользователи |
| `/etc/nginx/`, `/etc/letsencrypt/` | TLS для админки |
| `/etc/nftables.d/`, `/etc/nftables.conf` | в т.ч. `sstp-singbox.nft` (интеграция SSTP↔sing-box) |
| `/etc/systemd/system/*.service` | `accel-ppp`, `sstp-singbox-route`, `wg-admin`, `sing-box`, `outline` |
| `/etc/sudoers.d/wg-admin` | права для Node-процесса |
| `/opt/wg-admin/data/store.json` | метаданные клиентов админки |
| `/opt/wg-admin/server/.env` | AUTH_TOKEN |
| `/opt/outline/` | если Outline-сервер на этом VPS |

## Регулярный бэкап

На текущем VPS:

```bash
sudo bash /opt/wg-admin/scripts/backup.sh
# → создаёт /root/vpn-backup-YYYYMMDD-HHMM.tar.gz
```

Затащить локально:

```bash
scp root@171.22.75.104:/root/vpn-backup-*.tar.gz ~/Backups/vpn/
```

Рекомендую крон раз в неделю + хранение последних 4 архивов:

```bash
# /etc/cron.weekly/vpn-backup
#!/bin/bash
bash /opt/wg-admin/scripts/backup.sh
# чистка старых
find /root -maxdepth 1 -name 'vpn-backup-*.tar.gz' -mtime +28 -delete
```

> **Важно:** в архиве лежат приватные WG-ключи и пароли SSTP. Храни в
> зашифрованном месте (1Password, Bitwarden file attachment, gpg-encrypted на S3).

## Восстановление на новом VPS

### Шаг 1 — Подготовь VPS

Любой Ubuntu 24.04 LTS, минимум 1 vCPU / 1 GB RAM / 20 GB диска. Открой в
файрволе провайдера: `22/tcp`, `80/tcp`, `443/tcp`, `14942/tcp`, `51820/udp`,
`UDP/4500` (если используешь WG на UDP/4500).

### Шаг 2 — Bootstrap

Залогинься как root и поставь весь стек одной командой:

```bash
curl -fsSL https://raw.githubusercontent.com/orxan07/ovpn/main/scripts/bootstrap-vps.sh \
  | bash -s -- --domain vpn.rehimli.info
```

Скрипт ставит: `node`, `nginx`, `certbot`, `wireguard`, `sing-box`,
`accel-ppp` (из исходников), `nftables`, клонирует репо в `/opt/wg-admin`,
поднимает админку, выпускает Let's Encrypt-сертификат, поднимает SSTP-сервер.

### Шаг 3 — Перенеси DNS

В DNS-провайдере домена (`vpn.rehimli.info`) обнови `A`-запись на новый IP.
Подожди распространение (5-30 минут).

### Шаг 4 — Раскатай бэкап

Залей архив на новый VPS:

```bash
scp ~/Backups/vpn/vpn-backup-LATEST.tar.gz root@NEW_VPS:/root/
```

И накати:

```bash
sudo bash /opt/wg-admin/scripts/restore.sh /root/vpn-backup-LATEST.tar.gz
```

Скрипт:
- разворачивает все конфиги поверх свежей инсталляции,
- перезапускает `wg-admin`, `sing-box`, `accel-ppp`, `nginx`, `wg-quick@wg0`,
- если был `sstp-singbox-route` — поднимает и его.

### Шаг 5 — Проверка

```bash
# админка
curl -fsS https://vpn.rehimli.info/api/system | jq .ok

# WG
sudo wg show

# SSTP (должны быть пользователи из chap-secrets)
sudo accel-cmd show sessions

# sing-box
sudo systemctl status sing-box --no-pager

# интеграция SSTP↔sing-box
sudo nft list table inet sstp-singbox
```

В админке: вкладка **SSTP** → бейдж «Активна», вкладка **Whitelist** —
видны старые домены/IP.

### Шаг 6 — Клиенты

WG-клиенты (iPhone, Mac) и SSTP-клиент (Keenetic) подключатся **автоматически**:
у них зашит IP сервера в endpoint. Если меняли домен — поменяй endpoint.

## Что НЕ переносится автоматически

- **Outline-сервер** (если он отдельно): запусти `outline-installer`
  на новом VPS, обнови ss-URL в `/etc/sing-box/config.json` на новый.
  В админке есть редактор whitelist — там же можно править outline outbound.
- **Правила облачного файрвола** провайдера VPS (MTS Cloud) — это вне VPS,
  открыть руками.
- **DNS-записи** — менять руками у регистратора.

## Откат

Если новый VPS не взлетел — старый (если он живой) ничего не потерял,
просто переключи DNS обратно. Бэкапы не разрушают исходный VPS.

## Контрольный список (распечатай)

- [ ] Свежий бэкап есть и лежит локально
- [ ] Новый VPS готов, в облачном файрволе открыты порты
- [ ] DNS обновлён на новый IP
- [ ] `bootstrap-vps.sh` отработал без ошибок
- [ ] `restore.sh` отработал без ошибок
- [ ] `https://vpn.rehimli.info` открывается, токен принимает
- [ ] WG-клиент подключается
- [ ] SSTP-клиент подключается, видит интернет
- [ ] Telegram / ChatGPT работают через VPN (whitelist жив)
- [ ] (опц.) старый VPS погашен
