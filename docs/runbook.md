# Runbook: VPN на VPS

Краткий operational-гайд: что чем смотреть, что чем перезапускать.

## Контактная карточка

| Что | Где |
|-----|-----|
| VPS | `171.22.75.104` (Ubuntu 24.04, MTS Cloud) |
| SSH | `ssh root@171.22.75.104` |
| Админка WG-панели | https://vpn.rehimli.info |
| SSTP-сервер | TCP/14942, accel-ppp |
| WireGuard-сервер | UDP/443, wg0 (для прямых WG-клиентов) |
| sing-box | tun на wg0 (selective routing через Outline) |
| Логи nginx | `/var/log/nginx/` |
| Конфиг WG | `/etc/wireguard/wg0.conf` + `/etc/wireguard/clients/` |
| Конфиг SSTP | `/etc/accel-ppp.conf`, пользователи в `/etc/accel-ppp/chap-secrets` |
| Логи SSTP | `/var/log/accel-ppp/accel-ppp.log` |

## Сервисы и команды

```bash
# WG-админка (Node.js)
app status
app restart
app logs

# WireGuard
sudo systemctl status wg-quick@wg0
sudo wg show
sudo systemctl restart wg-quick@wg0

# sing-box
sudo systemctl status sing-box
sudo systemctl restart sing-box
sudo journalctl -u sing-box -f

# SSTP
sudo systemctl status accel-ppp
sudo systemctl restart accel-ppp
sudo accel-cmd show sessions
sudo tail -f /var/log/accel-ppp/accel-ppp.log

# nginx
sudo systemctl status nginx
sudo nginx -t && sudo systemctl reload nginx
```

## Диагностика «не работает интернет через VPN»

1. **Туннель поднят?**
   - WG: `sudo wg show` → `latest handshake` свежий.
   - SSTP: `sudo accel-cmd show sessions` → видна сессия с состоянием `active`.

2. **Идут ли байты?**
   - WG: в `wg show` смотри `transfer:` rx/tx.
   - SSTP: `ip -s link show <sstpN>` или `accel-cmd show sessions`.
   - Если RX>0 а TX=0 (или наоборот) — почти всегда DPI / MTU / NAT.

3. **NAT и IP-forward на VPS**:
   ```bash
   sysctl net.ipv4.ip_forward                            # должно быть 1
   sudo iptables -t nat -L POSTROUTING -n -v             # MASQUERADE для подсети туннеля
   ```

4. **Tcpdump на стороне VPS**:
   ```bash
   # проверить, что пакеты от клиента доходят:
   sudo tcpdump -ni any 'tcp port 14942 or proto 47' -c 50
   # внутри туннеля:
   sudo tcpdump -ni sstp0 -c 50
   ```

5. **С клиента**:
   ```bash
   # прямо с устройства, привязанного к VPN-политике:
   curl -4 https://ifconfig.me/ip      # должен показать IP VPS
   ```

## Перезапуск всего «по очереди»

Если всё лежит и непонятно, где именно:

```bash
sudo systemctl restart wg-quick@wg0
sudo systemctl restart accel-ppp
sudo bash /opt/wg-admin/infra/sstp/firewall.sh    # переприменить iptables (идемпотентно)
sudo systemctl restart sing-box
sudo systemctl restart sstp-singbox-route         # интеграция SSTP↔sing-box
sudo systemctl restart nginx
app restart
```

## Полная переустановка SSTP

```bash
sudo systemctl disable --now accel-ppp
sudo rm -rf /etc/accel-ppp /etc/accel-ppp.conf /var/log/accel-ppp
cd /opt/wg-admin/infra/sstp
sudo bash setup-sstp.sh
```

После этого на Keenetic заново вбить логин/пароль из вывода скрипта.

## Бэкап / восстановление

См. [`docs/disaster-recovery.md`](./disaster-recovery.md). Краткое:

```bash
# регулярный бэкап
sudo bash /opt/wg-admin/scripts/backup.sh
scp root@VPS:/root/vpn-backup-*.tar.gz ~/Backups/vpn/

# полный переезд на новый VPS
curl -fsSL https://raw.githubusercontent.com/orxan07/ovpn/main/scripts/bootstrap-vps.sh | bash -s -- --domain vpn.rehimli.info
sudo bash /opt/wg-admin/scripts/restore.sh /root/vpn-backup-LATEST.tar.gz
```

Один tar.gz содержит ВСЁ: WG-ключи, SSTP пользователей и cert,
sing-box whitelist, nft-правила интеграции, nginx + LE, сторэдж админки.
