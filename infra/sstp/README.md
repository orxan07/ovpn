# SSTP-сервер на VPS (accel-ppp)

SSTP (Secure Socket Tunneling Protocol) — VPN-протокол поверх **TLS-over-TCP**.
Снаружи поток выглядит как обычный HTTPS, что позволяет проходить DPI операторов
(в т.ч. МТС), которые активно режут WireGuard и OpenVPN data-channel.

Этот раздел поднимает **production-ready SSTP-сервер** на Ubuntu 22.04/24.04 с
помощью `accel-ppp` (собирается из исходников, в репах Ubuntu пакета нет).

> Зачем это понадобилось: смотри [`docs/dpi-bypass.md`](../../docs/dpi-bypass.md)
> — история того, как мы по очереди ловили блокировки на WireGuard (UDP/443,
> UDP/51820, UDP/4500) и OpenVPN (TCP/14942, UDP/4500) и в итоге пришли к SSTP.

---

## Содержимое раздела

| Файл | Назначение |
|------|------------|
| `setup-sstp.sh` | Полная установка с нуля: build accel-ppp, TLS-cert, конфиг, systemd, NAT |
| `accel-ppp.conf.tpl` | Справочный шаблон конфига `accel-ppp` (фактический пишется setup-скриптом) |
| `accel-ppp.service` | systemd-юнит |
| `firewall.sh` | Идемпотентные iptables-правила для пере-применения после ребута |
| `sstp-firewall.service` | systemd-юнит автоприменения `firewall.sh` после старта VPS |
| `users.sh` | Управление пользователями SSTP (`list / add / remove / passwd`) |
| `sudoers.example` | Пример sudoers-правил, если админка крутится не от root |

---

## Быстрый старт

На свежем VPS (Ubuntu 22.04+):

```bash
git clone https://github.com/<your-org>/ovpn.git
cd ovpn/infra/sstp
sudo bash setup-sstp.sh
```

В конце скрипт распечатает реквизиты подключения:

```
====================== SSTP ready ======================
  Server      : 171.22.75.104
  Port        : 14942/TCP
  Login       : keenetic
  Password    : <случайные 16 hex>
  Tunnel net  : 10.27.0.0/24 (gw 10.27.0.1)
  ...
========================================================
```

Можно переопределить параметры через env:

```bash
sudo SSTP_PORT=14942 \
     SSTP_USER=keenetic \
     SSTP_PASS='my-strong-pass' \
     SSTP_NET=10.27.0.0/24 \
     SSTP_CN=171.22.75.104 \
     bash setup-sstp.sh
```

> **TCP-порт**: классический SSTP использует TCP/443. Если 443 у тебя занят nginx
> или другой панелью — выбери любой свободный TCP-порт. На клиенте Keenetic
> адрес сервера указывается как `IP:PORT` в одном поле.

---

## Управление через веб-админку

В админке (`vpn.rehimli.info`) есть отдельная вкладка **SSTP**:
- статус сервиса (active / aптайм / счётчик пользователей и сессий),
- кнопка **Перезапустить**,
- таблица активных сессий с кнопкой **Отключить**,
- CRUD пользователей: добавить (с автогенерацией пароля), сменить пароль, удалить,
- кнопка **Реквизиты** — модалка с готовой памяткой `Сервер / Логин / Пароль / MTU` для копирования клиенту,
- блок **Firewall/NAT для SSTP** — применить правила сейчас и включить автозапуск `sstp-firewall.service`.

Под капотом — модуль `server/sstp.js` + эндпоинты `/api/sstp/*`. Если Node работает не от `root`, нужно положить sudoers-файл (`sudoers.example`).

## Управление через CLI (резервный путь, если фронт лёг)

```bash
# список
sudo bash users.sh list

# добавить (пароль сгенерится, если не задан)
sudo bash users.sh add iphone
sudo bash users.sh add macbook 'my-pass-here'

# сменить пароль
sudo bash users.sh passwd iphone 'new-strong-pass'

# удалить (активная сессия будет прерывана)
sudo bash users.sh remove old-user
```

Файл с паролями: `/etc/accel-ppp/chap-secrets`.

---

## Эксплуатация

```bash
# статус сервиса
sudo systemctl status accel-ppp

# рестарт после правок конфига
sudo systemctl restart accel-ppp

# активные сессии
sudo accel-cmd show sessions

# логи в реальном времени
sudo tail -f /var/log/accel-ppp/accel-ppp.log

# переприменить firewall-правила (после reboot, если нет iptables-persistent)
sudo bash firewall.sh

# включить автоприменение firewall-правил после старта VPS
sudo systemctl enable --now sstp-firewall
```

---

## Подключение клиентов

### Keenetic (роутер)
См. [`docs/keenetic-setup.md`](../../docs/keenetic-setup.md). Краткая суть:

- Веб-интерфейс → **Интернет → Другие подключения → VPN-подключения → Добавить подключение**
- Тип: **SSTP**
- Адрес сервера: `IP:PORT` в одном поле (например `171.22.75.104:14942`)
- Логин/пароль — из вывода `setup-sstp.sh`
- Тип аутентификации: **MS-CHAP v2**
- Доп. настройки: **Размер MTU = 1400**, **подстройка TCP MSS = вкл**, **проверка сертификата = выкл** (cert self-signed)
- Включить «Использовать для выхода в интернет» и «Получать маршруты от удалённой стороны»

### Windows
Встроенный VPN-клиент → SSTP → имя сервера (с портом через двоеточие) → MS-CHAP v2.
Self-signed сертификат: импортировать `server.crt` в Trusted Root, или включить
«не проверять сертификат» групповой политикой / реестром.

### macOS / iOS / Android
Нативной поддержки SSTP нет. Используй сторонние клиенты или подключайся
через роутер с SSTP-клиентом (Keenetic, MikroTik, OpenWrt с `sstp-client`).

---

## Что генерится при установке

| Путь | Содержимое |
|------|------------|
| `/etc/accel-ppp.conf` | основной конфиг |
| `/etc/accel-ppp/chap-secrets` | пользователи / пароли |
| `/etc/accel-ppp/sstp/server.crt` | TLS-cert (self-signed, 10 лет, RSA-2048) |
| `/etc/accel-ppp/sstp/server.key` | приватный ключ |
| `/etc/accel-ppp/sstp/server.pem` | combined PEM (cert+key) — используется accel-ppp |
| `/etc/systemd/system/accel-ppp.service` | systemd-юнит |
| `/etc/systemd/system/sstp-firewall.service` | systemd-юнит автоприменения `firewall.sh` |
| `/var/log/accel-ppp/accel-ppp.log` | основной лог |
| `/usr/sbin/accel-pppd` | бинарь (build из `/usr/local/src/accel-ppp`) |

`*.key` и `*.pem` **не должны попадать в git** — это в `.gitignore`.

---

## Обновление accel-ppp

```bash
cd /usr/local/src/accel-ppp
sudo git pull
sudo rm -rf build && mkdir build && cd build
sudo cmake -DBUILD_IPOE_DRIVER=FALSE -DBUILD_VLAN_MON_DRIVER=FALSE \
           -DCMAKE_INSTALL_PREFIX=/usr -DLUA=FALSE -DKDIR=no ..
sudo make -j$(nproc) install
sudo systemctl restart accel-ppp
```

---

## Удаление

```bash
sudo systemctl disable --now accel-ppp
sudo rm /etc/systemd/system/accel-ppp.service
sudo rm -rf /etc/accel-ppp /etc/accel-ppp.conf /var/log/accel-ppp
# не удаляет бинарь и /usr/local/src/accel-ppp — снеси вручную, если хочешь
```

И сними iptables-правила (или сделай `iptables -F` + перезагрузка, если не используешь iptables-persistent).
