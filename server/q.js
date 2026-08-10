const db = require('better-sqlite3')('sentinella.db');
const sw = db.prepare("SELECT id, state FROM switches WHERE state IN ('APPROVAL_PENDING','GRACE','RELEASED') ORDER BY rowid DESC LIMIT 1").get();
console.log('switch:', sw);
const subs = db.prepare('SELECT submitted_share FROM shares WHERE switch_id = ? AND submitted_share IS NOT NULL').all(sw.id);
console.log('quote sottomesse:', subs.length);
for (const s of subs) { const p = JSON.parse(s.submitted_share); console.log('  x =', p.x, '| y len =', (p.y||'').length); }
console.log('totale righe shares:', db.prepare('SELECT COUNT(*) AS n FROM shares WHERE switch_id = ?').get(sw.id).n);
