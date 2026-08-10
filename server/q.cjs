const db = require('better-sqlite3')('sentinella.db');
const sw = db.prepare("SELECT id,state FROM switches WHERE state!='DISARMED' ORDER BY rowid DESC LIMIT 1").get();
console.log('switch:', sw);
if (sw) {
  const subs = db.prepare('SELECT submitted_share FROM shares WHERE switch_id=? AND submitted_share IS NOT NULL').all(sw.id);
  console.log('quote sottomesse:', subs.length);
  subs.forEach(s => { const p = JSON.parse(s.submitted_share); console.log('  x =', p.x, '| y_len =', (p.y||'').length, '| y_head =', (p.y||'').slice(0,24)); });
}
