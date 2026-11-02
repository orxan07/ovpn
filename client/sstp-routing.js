let routingDraft = null;
let routingRequest = 0;
let routingBusy = false;
let routingOperation = 0;
let routingLoading = false;
let routingApplied = null;
function showWhitelistSection(section) {
  document.getElementById('whitelistGroupsPanel').hidden = section !== 'groups';
  document.getElementById('whitelistGlobalPanel').hidden = section !== 'global';
  document.getElementById('whitelistGroupsTab').classList.toggle('active', section === 'groups');
  document.getElementById('whitelistGlobalTab').classList.toggle('active', section === 'global');
  if (section === 'groups' && !routingDraft) loadRouting();
  else if (section === 'groups' && !routingBusy && !routingLoading) renderRouting();
}
function routingEditors() { return ['routingEditor', 'routingGroupsEditor'].map(id => document.getElementById(id)); }
function createRoutingGroup() {
  if (!routingDraft || routingBusy || routingLoading) return;
  routingDraft.groups.push({ id: 'group-' + crypto.randomUUID().slice(0, 8), name: 'Новая группа', domains: [] });
  renderRouting(); routingDirty();
  document.getElementById('routingGroupsEditor').lastElementChild?.previousElementSibling?.querySelector('input')?.focus();
}
function clearRouting() {
  routingRequest++; routingOperation++; routingDraft = null; routingApplied = null; routingBusy = false; routingLoading = false;
  for (const editor of routingEditors()) { editor.inert = false; editor.textContent = ''; }
  for (const id of ['routingAppliedGroups', 'routingAppliedProfiles']) document.getElementById(id).textContent = '';
  routingStatus('', true);
}
function routingDirty() {
  routingStatus('Черновик: группы и назначения изменены. На сервере пока действует версия ' + routingApplied.revision, routingBusy || routingLoading);
}
function routingStatus(message, disabled, error = false) {
  for (const id of ['routingMessage', 'routingBottomMessage', 'routingGroupsMessage', 'routingGroupsBottomMessage']) {
    const element = document.getElementById(id);
    if (element) { element.textContent = message; element.style.color = error ? '#fca5a5' : '#cbd5e1'; }
  }
  for (const id of ['routingApply', 'routingBottomApply', 'routingGroupsApply', 'routingGroupsBottomApply']) {
    const element = document.getElementById(id); if (element) element.disabled = disabled;
  }
}
async function loadRouting() {
  if (routingBusy) return;
  const request = ++routingRequest;
  routingLoading = true;
  for (const editor of routingEditors()) editor.inert = true;
  routingStatus('Загрузка…', true);
  try {
    const result = await api('GET', '/api/sstp/routing');
    if (request !== routingRequest) return;
    routingDraft = result; routingApplied = structuredClone(result); renderRouting();
    routingStatus(`Нет неприменённых изменений · версия ${result.revision}`, true);
  } catch (error) {
    if (request !== routingRequest) return;
    routingDraft = null; routingApplied = null;
    for (const editor of routingEditors()) editor.textContent = '';
    for (const id of ['routingAppliedGroups', 'routingAppliedProfiles']) document.getElementById(id).textContent = '';
    routingStatus(error.message, true, true);
  } finally { if (request === routingRequest) { routingLoading = false; for (const editor of routingEditors()) editor.inert = false; } }
}
function renderAppliedRouting() {
  for (const id of ['routingAppliedGroups', 'routingAppliedProfiles']) {
    const target = document.getElementById(id); target.replaceChildren();
    if (!routingApplied) continue;
    const card = document.createElement('section'); card.className = 'card';
    const heading = document.createElement('h2'); heading.textContent = `Применено на сервере · версия ${routingApplied.revision}`; card.append(heading);
    const active = routingApplied.profiles.filter(p => p.users.length);
    if (!active.length) {
      const p = document.createElement('p'); p.style.cssText = 'color:#b8c4d5;line-height:1.6';
      p.textContent = 'Ни одна группа не назначена клиентам. Все SSTP-клиенты используют общие правила. Создание группы само по себе не включает её для пользователей.';
      card.append(p);
    }
    for (const profile of active) {
      const row = document.createElement('div'); row.style.cssText = 'border-top:1px solid #2d3148;padding:14px 0;line-height:1.6;overflow-wrap:anywhere';
      const name = document.createElement('strong'); name.textContent = profile.name;
      const groups = document.createElement('p'); groups.textContent = 'Через Outline: ' + (profile.groups.map(g => routingApplied.groups.find(item => item.id === g)?.name || g).join(', ') || 'нет групп; всё напрямую');
      const clients = document.createElement('p'); clients.textContent = 'Клиенты: ' + profile.users.join(', '); clients.style.color = '#b8c4d5';
      row.append(name, groups, clients); card.append(row);
    }
    const help = document.createElement('p'); help.style.cssText = 'color:#b8c4d5;font-size:13px;line-height:1.6;margin-top:8px'; help.textContent = 'Это сохранённые назначения, а не статус текущего подключения. Несохранённые правки в редакторе ниже эту схему не меняют.'; card.append(help);
    target.append(card);
  }
}
function routingField(label, element) {
  const wrapper = document.createElement('label');
  wrapper.style.cssText = 'display:flex;flex-direction:column;gap:8px;color:#cbd5e1;font-size:14px;margin:14px 0';
  const title = document.createElement('span'); title.textContent = label; wrapper.append(title, element); return wrapper;
}
function routingInput(value, callback, multiline = false) {
  const element = document.createElement(multiline ? 'textarea' : 'input');
  if (!multiline) { element.type = 'text'; element.maxLength = 80; }
  else { element.rows = 7; element.spellcheck = false; }
  element.style.cssText = 'width:100%;background:#0f1117;color:#e2e8f0;border:1px solid #475569;border-radius:8px;padding:12px;font:inherit;resize:vertical';
  element.value = value;
  element.addEventListener('input', () => { callback(element.value); routingDirty(); });
  return element;
}
function routingButton(label, callback, danger = false) {
  const b = document.createElement('button'); b.className = 'btn ' + (danger ? 'btn-danger' : 'btn-ghost');
  b.textContent = label; b.type = 'button'; b.onclick = callback; return b;
}
function routingHeading(title, button) {
  const header = document.createElement('div'); header.className = 'sstp-heading';
  const h = document.createElement('h2'); h.textContent = title; h.style.marginBottom = '0'; header.append(h, button); return header;
}
function routingChoices(label, choices, selected, callback) {
  const section = document.createElement('fieldset'); section.style.cssText = 'border:0;margin:18px 0;min-width:0';
  const legend = document.createElement('legend'); legend.textContent = label; legend.style.cssText = 'font-size:14px;color:#cbd5e1;margin-bottom:8px'; section.append(legend);
  if (!choices.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Нет вариантов: группы создаются в Whitelist → Группы сервисов, пользователи — в SSTP → Клиенты.'; section.append(p); }
  for (const choice of choices) {
    const row = document.createElement('label'); row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 0;min-height:44px;overflow-wrap:anywhere';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.includes(choice.id);
    check.onchange = () => { callback(choice.id, check.checked); routingDirty(); };
    const text = document.createElement('span'); text.textContent = choice.name; row.append(check, text); section.append(row);
  }
  return section;
}
function renderRouting() {
  const editor = document.getElementById('routingEditor'); editor.replaceChildren();
  const groupEditor = document.getElementById('routingGroupsEditor'); groupEditor.replaceChildren();
  renderAppliedRouting();
  if (!routingDraft) return;
  const { groups, profiles, users, bindings = [] } = routingDraft;
  const addId = prefix => prefix + '-' + crypto.randomUUID().slice(0, 8);
  editor.append(routingHeading('Профили подключения', routingButton('Создать профиль', () => {
    profiles.push({ id: addId('profile'), name: 'Новый профиль', groups: groups.some(g => g.id === 'chatgpt') ? ['chatgpt'] : [], users: [] }); renderRouting(); routingDirty();
  })));
  const hint = document.createElement('p'); hint.style.cssText = 'color:#b8c4d5;line-height:1.6;margin:12px 0 20px';
  hint.textContent = 'Сначала добавьте отдельного SSTP-клиента во вкладке «Клиенты», затем назначьте его профилю. Без назначения клиент использует общие маршруты сервера.'; editor.append(hint);
  if (!profiles.length) {
    const empty = document.createElement('p'); empty.className = 'card'; empty.textContent = 'Профилей пока нет. Создайте профиль «Дети» и выберите группу ChatGPT.'; editor.append(empty);
  }
  for (const profile of profiles) {
    const card = document.createElement('article'); card.className = 'card';
    card.append(routingHeading(profile.name, routingButton('Удалить профиль', () => { routingDraft.profiles = profiles.filter(p => p.id !== profile.id); renderRouting(); routingDirty(); }, true)));
    card.append(routingField('Название профиля', routingInput(profile.name, value => { profile.name = value; })));
    card.append(routingChoices('Группы через Outline', groups.map(g => ({ id: g.id, name: `${g.name} · ${g.domains.length} доменов` })), profile.groups, (id, on) => { profile.groups = on ? [...profile.groups, id] : profile.groups.filter(g => g !== id); }));
    card.append(routingChoices('SSTP-клиенты этого профиля', [...users, ...profile.users.filter(name => !users.some(u => u.name === name)).map(name => ({ name, missing: true }))].map(u => {
      const assigned = profiles.find(p => p !== profile && p.users.includes(u.name));
      const address = bindings.find(b => b.name === u.name)?.ip;
      return { id: u.name, name: u.name + (u.missing ? ' · удалён, снимите назначение' : u.blocked ? ' · заблокирован' : '') + (assigned ? ' · уже в «' + assigned.name + '»' : '') + (address ? ' · ' + address : '') };
    }), profile.users, (name, on) => {
      if (on) { for (const p of profiles) p.users = p.users.filter(u => u !== name); profile.users.push(name); }
      else profile.users = profile.users.filter(u => u !== name);
      renderRouting();
    }));
    const note = document.createElement('p'); note.style.cssText = 'color:#b8c4d5;font-size:13px;line-height:1.6'; note.textContent = profile.groups.length ? 'Остальные сайты — через основную VPS. Состав выбранных групп обновляется для всех назначенных клиентов.' : 'Группы не выбраны: весь трафик профиля идёт напрямую через основную VPS.'; card.append(note); editor.append(card);
  }
  const groupHeading = document.createElement('h2'); groupHeading.textContent = 'Состав групп'; groupEditor.append(groupHeading);
  if (!groups.length) { const p = document.createElement('p'); p.className = 'card'; p.textContent = 'Групп пока нет. Создайте первую и добавьте домены сервиса.'; groupEditor.append(p); }
  for (const group of groups) {
    const card = document.createElement('article'); card.className = 'card'; card.style.marginTop = '16px';
    const used = profiles.filter(p => p.groups.includes(group.id));
    const del = routingButton('Удалить группу', () => { routingDraft.groups = groups.filter(g => g.id !== group.id); renderRouting(); routingDirty(); }, true);
    del.disabled = used.length > 0; del.title = used.length ? 'Сначала снимите группу с профилей' : '';
    card.append(routingHeading(group.name, del));
    const saved = routingApplied.groups.find(g => g.id === group.id);
    const savedProfiles = routingApplied.profiles.filter(p => p.groups.includes(group.id));
    const savedClients = [...new Set(savedProfiles.flatMap(p => p.users))];
    const applied = document.createElement('p'); applied.style.cssText = 'color:#b8c4d5;line-height:1.6;margin:14px 0';
    applied.textContent = !saved ? 'Новая группа · ещё не сохранена' : savedClients.length ? `Применена для ${savedClients.length} клиентов: ${savedClients.join(', ')}. Профили: ${savedProfiles.map(p => p.name).join(', ')}.` : 'Сохранена в каталоге · не назначена клиентам'; card.append(applied);
    card.append(routingField('Название группы', routingInput(group.name, value => { group.name = value; })));
    const domains = routingInput(group.domains.join('\n'), value => { group.domains = value.split(/[\s,]+/).filter(Boolean); }, true);
    domains.dataset.group = group.id;
    card.append(routingField('Домены, по одному на строке', domains));
    const fieldError = document.createElement('p'); fieldError.dataset.groupError = group.id; fieldError.style.cssText = 'color:#fca5a5;font-size:13px;line-height:1.6'; fieldError.setAttribute('role', 'alert'); card.append(fieldError);
    const note = document.createElement('p'); note.style.cssText = 'color:#b8c4d5;font-size:13px;line-height:1.6';
    note.textContent = 'Каждый домен включает поддомены. Без https://, путей и IP-адресов.' + (used.length ? ' В редакторе выбрана для профилей: ' + used.map(p => p.name).join(', ') + '.' : ' В редакторе не выбрана для профилей.'); card.append(note); groupEditor.append(card);
  }
  for (const [target, prefix] of [[editor, 'routing'], [groupEditor, 'routingGroups']]) {
    const footer = document.createElement('div'); footer.className = 'card sstp-actions';
    const apply = routingButton('Применить изменения', applyRouting); apply.id = prefix + 'BottomApply'; apply.className = 'btn btn-primary'; apply.disabled = document.getElementById('routingApply').disabled;
    const status = document.createElement('span'); status.id = prefix + 'BottomMessage'; status.setAttribute('role', 'status'); status.textContent = document.getElementById('routingMessage').textContent;
    footer.append(apply, status); target.append(footer);
  }
}
async function applyRouting() {
  if (!routingDraft || routingBusy || routingLoading) return;
  for (const group of routingDraft.groups) {
    const bad = group.domains.find(d => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z0-9-]+$/i.test(d));
    const field = [...document.querySelectorAll('[data-group]')].find(e => e.dataset.group === group.id);
    const hint = [...document.querySelectorAll('[data-group-error]')].find(e => e.dataset.groupError === group.id);
    const message = !group.domains.length ? 'Добавьте хотя бы один домен.' : bad ? `Укажите домен без https:// и путей: ${bad.replace(/^https?:\/\//, '').split('/')[0]}` : '';
    if (field) { field.setAttribute('aria-invalid', message ? 'true' : 'false'); field.style.borderColor = message ? '#f87171' : '#475569'; }
    if (hint) hint.textContent = message;
    if (message) { routingStatus('Исправьте домены в группе «' + group.name + '»', false, true); showPage('whitelist'); showWhitelistSection('groups'); field?.focus(); return; }
  }
  const request = routingRequest;
  const operation = ++routingOperation;
  routingBusy = true;
  for (const editor of routingEditors()) editor.inert = true;
  routingStatus('Применение всей конфигурации…', true);
  try {
    const result = await api('PUT', '/api/sstp/routing', { revision: routingDraft.revision, groups: routingDraft.groups, profiles: routingDraft.profiles });
    if (request !== routingRequest) return;
    routingDraft = result; routingApplied = structuredClone(result); renderRouting();
    routingStatus(result.warnings?.length ? result.warnings.join('. ') : `Применена версия ${result.revision}`, true);
  } catch (error) {
    if (request !== routingRequest) return;
    routingStatus(error.message, false, true);
  } finally { if (operation === routingOperation) { routingBusy = false; for (const editor of routingEditors()) editor.inert = false; } }
}
