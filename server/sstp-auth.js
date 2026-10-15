// Preserve chap-secrets syntax and unrelated records when changing one account.
const PREFIX = '# wg-admin-disabled:';

function tokens(line) {
  return [...line.matchAll(/"(?:\\.|[^"\\])*"|[^\s]+/g)];
}

function unquote(value) {
  if (!value.startsWith('"')) return value;
  return value.slice(1, -1).replace(/\\(.)/g, '$1');
}

function records(raw) {
  return raw.split('\n').flatMap((original, index) => {
    let line = original;
    const blocked = line.startsWith(PREFIX);
    if (blocked) {
      const encoded = line.slice(PREFIX.length).trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Некорректная запись заблокированного SSTP-клиента');
      line = Buffer.from(encoded, 'base64').toString('utf8');
      if (/[\r\n]/.test(line)) throw new Error('Некорректная запись SSTP-клиента');
    }
    if (!line.trim() || line.trimStart().startsWith('#')) return [];
    const fields = tokens(line);
    if (fields.length < 3) return [];
    return [{ index, line, blocked, fields, name: unquote(fields[0][0]),
      server: unquote(fields[1][0]), password: unquote(fields[2][0]),
      ip: fields[3] ? unquote(fields[3][0]) : '*' }];
  });
}

function find(raw, name) {
  const matches = records(raw).filter(record => record.name === name);
  if (!matches.length) throw new Error(`Пользователь ${name} не найден`);
  if (matches.length !== 1) throw new Error('Есть несколько записей с этим именем. Сначала устраните дубликаты в chap-secrets');
  return matches[0];
}

function change(raw, name, patch) {
  const record = find(raw, name);
  const lines = raw.split('\n');
  if (patch.remove) lines.splice(record.index, 1);
  else {
    let line = record.line;
    if (patch.password !== undefined) {
      const field = record.fields[2];
      // Passwords are encoded as a quoted field, including literal # or quotes.
      const encoded = '"' + patch.password.replace(/[\\"]/g, '\\$&') + '"';
      line = line.slice(0, field.index) + encoded + line.slice(field.index + field[0].length);
    }
    const blocked = patch.blocked === undefined ? record.blocked : patch.blocked;
    lines[record.index] = blocked ? PREFIX + Buffer.from(line).toString('base64') : line;
  }
  return lines.join('\n');
}

function append(raw, name, password) {
  if (records(raw).some(record => record.name === name)) throw new Error(`Пользователь ${name} уже существует`);
  const encoded = '"' + password.replace(/[\\"]/g, '\\$&') + '"';
  return raw + (raw && !raw.endsWith('\n') ? '\n' : '') + `${name}\t*\t${encoded}\t*\n`;
}

module.exports = { records, find, change, append };
