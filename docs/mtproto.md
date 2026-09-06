# MTProto-прокси для Telegram

Отдельный прокси только для клиента Telegram. Это не VPN и не Outline:
браузер, YouTube и остальные приложения через него не ходят.

Поднят 2026-09-06 на Outline-VPS. Источник: официальный Docker-образ
Telegram, описание в [статье на Хабре](https://habr.com/en/articles/412759/).

## Зачем

Когда нужен живой Telegram на ноуте или телефоне без системного VPN.
Клиент Telegram сам умеет MTProto-прокси: Settings → Advanced → Connection type.

Трафик: устройство → Outline-VPS (`156.67.63.163:443`) → DC Telegram.
Владелец прокси не видит логины и содержимое чатов.

## Где крутится

На основной VPS (`171.22.75.104`) ставить нельзя: `443/tcp` занят nginx,
`443/udp` — WireGuard.

| Параметр | Значение |
|---|---|
| Хост | Outline-VPS, hostname `vm-pico` |
| Публичный IP | `156.67.63.163` |
| SSH | `ssh root@156.67.63.163` |
| Контейнер | `mtproto-proxy` |
| Образ | `telegrammessenger/proxy:latest` |
| Публичный порт | `443/tcp` → контейнер `:443` |
| Secret | `/root/mtproto-secret.txt` (не коммитить) |
| Volume | Docker volume `mtproto-config` |
| Статистика | внутри контейнера `http://127.0.0.1:2398/stats` |

На этой машине рядом живёт только Outline: `outline-ss-serv` на высоких
UDP-портах, TCP `25235` и manager на `35849`. `443/tcp` был свободен.

## Клиент

Собрать ссылку на сервере:

```bash
SECRET=$(cat /root/mtproto-secret.txt)
echo "https://t.me/proxy?server=156.67.63.163&port=443&secret=${SECRET}"
```

Открыть ссылку на устройстве — Telegram подставит прокси сам.
Вручную:

- Server: `156.67.63.163`
- Port: `443`
- Secret: из `/root/mtproto-secret.txt`

## Команды на Outline-VPS

```bash
docker ps --filter name=mtproto-proxy
docker logs --tail=50 mtproto-proxy
docker exec mtproto-proxy curl -s http://127.0.0.1:2398/stats
ss -lntup | grep ':443'
```

В stats смотреть `total_special_connections` — число текущих клиентов Telegram.

Перезапуск:

```bash
docker restart mtproto-proxy
```

Обновление образа (как рекомендует Telegram, с сохранением того же secret):

```bash
SECRET=$(cat /root/mtproto-secret.txt)
docker pull telegrammessenger/proxy:latest
docker stop mtproto-proxy
docker rm mtproto-proxy
docker run -d \
  --name=mtproto-proxy \
  --restart=always \
  -p 443:443 \
  -v mtproto-config:/data \
  -e SECRET="$SECRET" \
  -e WORKERS=1 \
  telegrammessenger/proxy:latest
```

Снести:

```bash
docker stop mtproto-proxy
docker rm mtproto-proxy
# docker volume rm mtproto-config
```

## Повторная установка с нуля

`--net=host` не использовать: Outline уже на host-сети, так проще не
перехватить чужие порты. Сначала `ss -lntup` — на `:443` не должно быть LISTEN.

```bash
apt-get update
apt-get install -y docker.io
systemctl enable --now docker

SECRET=$(openssl rand -hex 16)
echo "$SECRET" | tee /root/mtproto-secret.txt

docker pull telegrammessenger/proxy:latest

docker run -d \
  --name=mtproto-proxy \
  --restart=always \
  -p 443:443 \
  -v mtproto-config:/data \
  -e SECRET="$SECRET" \
  -e WORKERS=1 \
  telegrammessenger/proxy:latest

iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null \
  || iptables -I INPUT -p tcp --dport 443 -j ACCEPT
```

В панели облака этой VPS должен быть открыт TCP 443.

Если 443 когда-нибудь займут — публиковать `-p 8443:443` и в ссылке
указывать `port=8443`. Порт в `docker logs` тогда будет врать (контейнер
всегда думает, что снаружи 443).

## Диагностика

С ноута без VPN:

```bash
nc -vz 156.67.63.163 443
```

- timeout — файрвол VPS или security group облака
- connected, а Telegram нет — неверный secret или прокси выключен в клиенте

## Ограничения

- Только Telegram. Для остального — WG / SSTP / Outline на основной схеме.
- Утечка secret = чужие подключения на канал VPS. Сменить ключ и пересоздать контейнер.
- Обычный hex-secret без fake-TLS. Если DPI начнёт резать поток на 443,
  смотреть в сторону `ee`-секретов (другой сервер, не этот образ) или
  существующего Outline/SSTP.
- Этот стек не входит в `scripts/backup.sh` основной VPS. Secret и volume
  живут только на `vm-pico`.
