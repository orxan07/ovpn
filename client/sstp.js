// SSTP client workspace. Server repair tools remain in index.html.
function sstpBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0 B';
  const index = Math.min(4, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)));
  return `${(value / 1024 ** index).toLocaleString('ru-RU', { maximumFractionDigits: index ? 1 : 0 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][index]}`;
}
function sstpDate(value) {
  return value ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : 'Ещё не подключался';
}
function sstpRate(value) { return value === null || value === undefined ? '—' : sstpBytes(value) + '/с'; }
function sstpBadge(client) {
  if (!sstpMonitorInfo?.lastSampleAt && !client.blocked) return '<span class="badge">Нет данных</span>';
  const label = client.blocked ? 'Заблокирован' : client.online ? 'Онлайн' : 'Офлайн';
  return `<span class="badge ${client.blocked ? 'blocked' : client.online ? 'active' : 'inactive'}">${label}</span>`;
}
function sstpStat(label, value, sub = '') {
  return `<div class="stat-item"><div class="stat-label">${esc(label)}</div><div class="stat-value" style="font-size:22px">${esc(value)}</div>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}</div>`;
}
function showSstpView(view) {
  sstpView = view;
  document.getElementById('sstpClientsPanel').hidden = view !== 'clients';
  document.getElementById('sstpServerPanel').hidden = view !== 'server';
  document.getElementById('sstpClientsTab').classList.toggle('active', view === 'clients');
  document.getElementById('sstpServerTab').classList.toggle('active', view === 'server');
  if (view === 'server') { loadSstpPortState(); loadSstpFirewallState(); loadSstpSingboxState(); }
}
function toggleSstpAdd() {
  const form = document.getElementById('sstpAddForm');
  form.hidden = !form.hidden;
  if (!form.hidden) document.getElementById('newSstpUser').focus();
}
function renderSstpClients() {
  const clients = sstpClients;
  const sum = field => clients.reduce((n, client) => n + (client[field] || 0), 0);
  const today = clients.reduce((n, client) => n + client.today.upload + client.today.download, 0);
  const speedAvailable = clients.some(client => client.downloadBps !== null);
  document.getElementById('sstpClientStats').innerHTML = [
    sstpStat('Подключены', `${clients.filter(c => c.online).length} из ${clients.length}`, `${clients.reduce((n, c) => n + c.sessions.length, 0)} активных сессий`),
    sstpStat('Трафик сегодня', sstpBytes(today), 'Загрузка + отдача · Москва'),
    sstpStat('Всего учтено', sstpBytes(sum('upload') + sum('download')), `${clients.filter(c => c.blocked).length} заблокированы`),
    sstpStat('Загрузка сейчас', speedAvailable ? sstpRate(sum('downloadBps')) : '—', `Отдача: ${speedAvailable ? sstpRate(sum('uploadBps')) : '—'}`),
  ].join('');
  const query = document.getElementById('sstpSearch').value.trim().toLowerCase();
  const filter = document.getElementById('sstpFilter').value;
  const sort = document.getElementById('sstpSort').value;
  const filtered = clients.filter(c => {
    if (filter === 'online' && !c.online) return false;
    if (filter === 'offline' && (c.online || c.blocked)) return false;
    if (filter === 'blocked' && !c.blocked) return false;
    return [c.name, c.note, c.ip, ...c.sessions.flatMap(s => [s.ip, s.callingSid])].join(' ').toLowerCase().includes(query);
  }).sort((a, b) => sort === 'traffic' ? (b.upload + b.download) - (a.upload + a.download) : sort === 'name' ? a.name.localeCompare(b.name) : Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  document.getElementById('sstpClientCount').textContent = `${filtered.length} / ${clients.length}`;
  document.getElementById('sstpClientRows').innerHTML = filtered.length ? filtered.map(c => {
    const quota = c.limitGb ? `${sstpBytes(c.upload + c.download)} из ${c.limitGb} GiB` : 'Без квоты';
    const warning = c.expired ? 'Срок доступа истёк' : c.quotaExceeded ? 'Квота исчерпана' : c.note;
    return `<article class="sstp-row">
      <div><button class="sstp-name" data-name="${encodeURIComponent(c.name)}" onclick="openSstpClient(decodeURIComponent(this.dataset.name))">${esc(c.name)}</button><span class="sstp-sub">${esc((warning || 'Без заметки').slice(0, 100))}</span></div>
      <div>${sstpBadge(c)}<span class="sstp-sub">${c.online ? `${c.sessions.length} сесс. · ${esc(c.sessions[0].ip || '—')}` : `Был: ${esc(sstpDate(c.lastSeen))}`}</span></div>
      <div class="sstp-value"><span class="sstp-mobile-label">Скорость ↓ / ↑</span>${c.online ? sstpRate(c.downloadBps) : '—'}<span class="sstp-sub">↑ ${c.online ? sstpRate(c.uploadBps) : '—'}</span></div>
      <div class="sstp-value"><span class="sstp-mobile-label">За сегодня</span>${sstpBytes(c.today.download + c.today.upload)}<span class="sstp-sub">↓ ${sstpBytes(c.today.download)} · ↑ ${sstpBytes(c.today.upload)}</span></div>
      <div class="sstp-value"><span class="sstp-mobile-label">Всего учтено</span>${sstpBytes(c.upload + c.download)}<span class="sstp-sub">${esc(quota)}</span></div>
      <button class="btn btn-ghost" data-name="${encodeURIComponent(c.name)}" onclick="openSstpClient(decodeURIComponent(this.dataset.name))" aria-label="Открыть клиента ${esc(c.name).replace(/"/g, '&quot;')}">Открыть</button>
    </article>`;
  }).join('') : `<p class="sstp-empty">${clients.length ? 'Ничего не найдено. Измените поиск или фильтр.' : 'Пока нет SSTP-клиентов. Добавьте первого клиента.'}</p>`;
  document.getElementById('sstpAccountingNote').textContent = sstpMonitorInfo ? `Учёт с ${sstpDate(sstpMonitorInfo.since)}. Только измеренный трафик; старые подключения и расход до включения учёта не восстановлены. Последний снимок: ${sstpMonitorInfo.lastSampleAt ? sstpDate(sstpMonitorInfo.lastSampleAt) : 'ожидается'}.` : '';
}
function openSstpClient(name) {
  sstpSelected = name;
  sstpSettingsFor = null;
  sstpActivityRequest++;
  document.getElementById('sstpClientList').hidden = true;
  document.getElementById('sstpClientStats').hidden = true;
  document.getElementById('sstpClientDetail').hidden = false;
  showSstpDetailTab('overview');
  renderSstpClientDetail();
}
function closeSstpClient() {
  sstpSelected = null;
  sstpSettingsFor = null;
  sstpActivityRequest++;
  document.getElementById('sstpClientList').hidden = false;
  document.getElementById('sstpClientStats').hidden = false;
  document.getElementById('sstpClientDetail').hidden = true;
}
function clearSstpWorkspace() {
  closeSstpClient();
  sstpClients = [];
  sstpMonitorInfo = null;
  document.getElementById('sstpClientRows').textContent = '';
  document.getElementById('sstpClientStats').textContent = '';
  document.getElementById('sstpClientNote').value = '';
  document.getElementById('newSstpPass').value = '';
  document.getElementById('sstpActivityRows').textContent = '';
}
function showSstpDetailTab(tab) {
  sstpDetailTab = tab;
  for (const name of ['overview', 'activity', 'settings']) {
    const suffix = name[0].toUpperCase() + name.slice(1);
    document.getElementById('sstpDetail' + suffix).hidden = name !== tab;
    document.getElementById('sstp' + suffix + 'Tab').classList.toggle('active', name === tab);
  }
  if (tab === 'activity') loadSstpActivity();
}
function renderSstpClientDetail() {
  if (!sstpSelected) return;
  const c = sstpClients.find(client => client.name === sstpSelected);
  if (!c) { closeSstpClient(); return; }
  document.getElementById('sstpDetailName').textContent = c.name;
  document.getElementById('sstpDetailState').innerHTML = sstpBadge(c) + (c.quotaExceeded ? ' <span class="muted">Квота исчерпана</span>' : c.expired ? ' <span class="muted">Срок доступа истёк</span>' : '');
  document.getElementById('sstpAccessBtn').textContent = c.blocked ? 'Разблокировать' : 'Заблокировать';
  document.getElementById('sstpDisconnectBtn').disabled = !c.online;
  document.getElementById('sstpDetailStats').innerHTML = [
    sstpStat('Загружено клиентом', sstpBytes(c.download), 'С начала учёта / сброса'),
    sstpStat('Отдано клиентом', sstpBytes(c.upload), 'С начала учёта / сброса'),
    sstpStat('Загрузка сейчас', c.online ? sstpRate(c.downloadBps) : '—'),
    sstpStat('Отдача сейчас', c.online ? sstpRate(c.uploadBps) : '—'),
  ].join('');
  document.getElementById('sstpDetailInfo').innerHTML = [
    ['Начало наблюдения', sstpDate(c.firstSeen)], ['Последняя активность', sstpDate(c.lastSeen)],
    ['Квота', c.limitGb ? `${c.limitGb} GiB · использовано ${sstpBytes(c.upload + c.download)}` : 'Без ограничений'],
    ['Доступ до', c.expiresAt ? sstpDate(c.expiresAt) : 'Без срока'],
    ['Назначение IP', c.ip === '*' ? 'Из серверного пула' : c.ip], ['Заметка', c.note || 'Не задана'],
  ].map(([label, value]) => `<div class="info-item"><div class="info-label">${esc(label)}</div><div class="info-value">${esc(String(value))}</div></div>`).join('');
  document.getElementById('sstpDetailSessions').innerHTML = c.sessions.length ? c.sessions.map(s => `<div class="sstp-session"><div class="sstp-session-head"><strong>${esc(s.ifname)} · ${esc(s.ip || '—')}</strong><button class="btn btn-ghost" data-if="${encodeURIComponent(s.ifname)}" onclick="disconnectSstpSession(decodeURIComponent(this.dataset.if))">Отключить сессию</button></div><div class="sstp-sub">Откуда: ${esc(s.callingSid || 'Нет данных')} · длительность ${esc(s.uptime || '—')} · ID ${esc(s.sid || '—')}</div><div class="sstp-sub">За эту сессию: ↓ ${sstpBytes(s.download)} · ↑ ${sstpBytes(s.upload)} · MTU ${s.mtu || '—'}</div><div class="sstp-sub">Ошибки RX/TX: ${s.rxErrors ?? '—'} / ${s.txErrors ?? '—'} · отброшено RX/TX: ${s.rxDropped ?? '—'} / ${s.txDropped ?? '—'}${s.countersAvailable ? '' : ' · счётчики недоступны'}</div></div>`).join('') : '<p class="muted">Нет активных подключений.</p>';
  const table = (head, rows) => `<div class="sstp-table-wrap"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  document.getElementById('sstpDetailHistory').innerHTML = c.history.length ? table(['Наблюдалась с', 'Завершение обнаружено', 'Откуда', 'Учтено ↓ / ↑'], c.history.slice(0, 20).map(s => `<tr><td>${esc(sstpDate(s.observedAt))}</td><td>${esc(sstpDate(s.endedAt))}</td><td>${esc(s.callingSid || '—')}</td><td>${sstpBytes(s.download)} / ${sstpBytes(s.upload)}</td></tr>`)) + '<p class="muted" style="margin-top:10px">Последние 20 из 100 сохраняемых сессий. Начало и завершение отмечены по наблюдениям сборщика; последние байты перед разрывом могут не попасть в учёт.</p>' : '<p class="muted">Завершённые сессии появятся после начала наблюдения.</p>';
  const days = Object.entries(c.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 30);
  document.getElementById('sstpDetailDays').innerHTML = days.length ? table(['Дата · Москва', 'Загрузка ↓', 'Отдача ↑', 'Сумма'], days.map(([date, bytes]) => `<tr><td>${esc(date)}</td><td>${sstpBytes(bytes.download)}</td><td>${sstpBytes(bytes.upload)}</td><td>${sstpBytes(bytes.download + bytes.upload)}</td></tr>`)) : '<p class="muted">Трафик ещё не измерен.</p>';
  if (sstpSettingsFor !== c.name) {
    document.getElementById('sstpClientNote').value = c.note;
    document.getElementById('sstpClientLimit').value = c.limitGb ?? '';
    const date = c.expiresAt ? new Date(c.expiresAt) : null;
    document.getElementById('sstpClientExpiry').value = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    document.getElementById('sstpSettingsMessage').textContent = '';
    document.getElementById('sstpIpAssignment').textContent = `Назначение IP: ${c.ip === '*' ? 'динамически из пула сервера' : c.ip}.`;
    sstpSettingsFor = c.name;
  }
}
async function saveSstpClient() {
  const name = sstpSelected;
  const message = document.getElementById('sstpSettingsMessage');
  const button = document.getElementById('sstpSaveBtn');
  button.disabled = true;
  message.textContent = 'Сохранение…';
  try {
    const limit = document.getElementById('sstpClientLimit').value;
    const expiry = document.getElementById('sstpClientExpiry').value;
    await api('PATCH', `/api/sstp/clients/${encodeURIComponent(name)}`, { note: document.getElementById('sstpClientNote').value, limitGb: limit === '' ? null : Number(limit), expiresAt: expiry ? new Date(expiry).toISOString() : null });
    if (name !== sstpSelected) return;
    message.textContent = 'Настройки сохранены';
    await loadSstp();
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
}
async function sstpToggleAccess() {
  const c = sstpClients.find(client => client.name === sstpSelected);
  if (!c || !confirm(c.blocked ? `Разблокировать ${c.name}?` : `Заблокировать ${c.name}? Все его сессии будут отключены; новые подключения будут запрещены.`)) return;
  try { await api('POST', `/api/sstp/clients/${encodeURIComponent(c.name)}/access`, { blocked: !c.blocked }); await loadSstp(); }
  catch (error) { alert(error.message); await loadSstp(); }
}
async function sstpDisconnectClient() {
  if (!confirm(`Отключить все сессии ${sstpSelected}? Клиент сможет подключиться повторно.`)) return;
  try { await api('POST', `/api/sstp/clients/${encodeURIComponent(sstpSelected)}/disconnect`); await loadSstp(); }
  catch (error) { alert(error.message); }
}
async function resetSstpUsage() {
  if (!confirm(`Обнулить учтённый трафик ${sstpSelected}? Это освободит его квоту. История сессий сохранится.`)) return;
  try { await api('POST', `/api/sstp/clients/${encodeURIComponent(sstpSelected)}/reset-usage`); await loadSstp(); }
  catch (error) { alert(error.message); }
}
async function loadSstpActivity() {
  const name = sstpSelected;
  if (!name) return;
  const request = ++sstpActivityRequest;
  const output = document.getElementById('sstpActivityRows');
  output.innerHTML = '<p class="muted">Загрузка соединений…</p>';
  try {
    const result = await api('GET', `/api/sstp/clients/${encodeURIComponent(name)}/activity`);
    if (request !== sstpActivityRequest || name !== sstpSelected) return;
    document.getElementById('sstpActivityNote').textContent = result.note;
    output.innerHTML = result.entries.length ? result.entries.map(e => `<div class="sstp-activity-row"><div style="overflow-wrap:anywhere"><strong>${esc(e.domain || e.destination)}</strong>${e.domain ? `<span class="sstp-sub">${esc(e.destination)}</span>` : ''}<span class="sstp-sub">${esc(sstpDate(e.at))}</span></div><span>${esc(e.protocol)}</span><span class="badge ${e.outbound === 'outline' ? 'active' : ''}">${esc(e.outbound)}</span><span>${e.connections} соед.${e.failed ? '<span class="sstp-sub">Есть ошибка</span>' : ''}</span></div>`).join('') : `<p class="sstp-empty">${result.available ? 'В текущей выборке соединений нет. Запустите приложение клиента и обновите активность.' : 'Активность недоступна. Проверьте журнал и права доступа на сервере.'}</p>`;
  } catch (error) { if (request === sstpActivityRequest) output.textContent = error.message; }
}
function exportSstpClients() {
  const cell = value => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const rows = [['client', 'online', 'blocked', 'upload_bytes', 'download_bytes', 'today_upload_bytes', 'today_download_bytes', 'limit_gib', 'expires_at', 'last_seen', 'note'], ...sstpClients.map(c => [c.name, c.online, c.blocked, c.upload, c.download, c.today.upload, c.today.download, c.limitGb, c.expiresAt, c.lastSeen ? new Date(c.lastSeen).toISOString() : '', c.note])];
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'sstp-clients.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
