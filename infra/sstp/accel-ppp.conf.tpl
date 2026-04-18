# Шаблон конфига accel-ppp для SSTP-сервера.
# Реальный /etc/accel-ppp.conf создаётся скриптом setup-sstp.sh
# с подстановкой переменных. Этот файл — справочный, для понимания структуры.

[modules]
log_file
sstp
auth_mschap_v2
auth_mschap_v1
auth_chap_md5
auth_pap
chap-secrets
ippool
sigchld
pppd_compat

[core]
log-error=/var/log/accel-ppp/core.log
thread-count=2

[log]
log-file=/var/log/accel-ppp/accel-ppp.log
log-emerg=/var/log/accel-ppp/emerg.log
log-fail-file=/var/log/accel-ppp/auth-fail.log
copy=1
level=3

[sstp]
verbose=1
accept=ssl
# combined PEM (cert + key) — accel-ppp ругается на отдельные ssl-keyfile/ssl-certificate
ssl-pemfile=/etc/accel-ppp/sstp/server.pem
bind=0.0.0.0
port=__SSTP_PORT__
ifname=sstp%d
# ppp-max-mtu=1400 даёт стабильность с Keenetic Hopper
ppp-max-mtu=1400
mppe=require

[ppp]
verbose=1
min-mtu=1280
mtu=1400
mru=1400
ccp=1
# обязательно для SSTP по спеке Microsoft
mppe=require
ipv4=require
ipv6=deny
# keepalive — иначе ZTE-модем/двойной NAT может тихо рвать сессию
lcp-echo-interval=20
lcp-echo-failure=3
lcp-echo-timeout=120

[client-ip-range]
disable

[ip-pool]
gw-ip-address=__SSTP_GW_IP__
__SSTP_POOL__

[dns]
dns1=1.1.1.1
dns2=8.8.8.8

[chap-secrets]
chap-secrets=/etc/accel-ppp/chap-secrets

[cli]
tcp=127.0.0.1:2001
