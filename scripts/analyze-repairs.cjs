const fs = require('node:fs');
const filename = process.argv[2];
if (!filename) throw new Error('Usage: node scripts/analyze-repairs.cjs <history.html>');
const html = fs.readFileSync(filename, 'utf8');
const plain = value => value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const issues = [];
let records = 0;
for (const [, row] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
  const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(match => plain(match[1]));
  if (cells.length < 10 || !/\d{1,2}\.\d{1,2}\.\d{4}/.test(cells[0])) continue;
  records++;
  if (cells[5]) issues.push(cells[5]);
}
// Categories overlap when a record mentions several symptoms.
const categories = [
  ['Немає GPRS / GSM', /gprs|gsm|жсм|жпрс|гпрс|жпр|джпрс/i],
  ['Немає GPS / пропадає GPS', /gps|гпс|жпс|джпс|джипіес/i],
  ['Трекер не працює', /не працю|непрац|не роб|нероб/i],
  ['Трекер зависає', /завис|завіс|висне|віша|повис/i],
  ['Проблема з SIM-карткою', /сім|сим|sim/i],
  ['Немає живлення / запобіжник', /живлен|запобіж|предохран/i],
  ['Встановлення на нове авто', /нов.{0,15}(машин|автобус|авто|трол)|поставити|встановити/i],
  ['Перенесення / заміна трекера', /перестав|перенес|замін|заміна|помін/i]
].map(([label, regex]) => ({ label, count: issues.filter(issue => regex.test(issue)).length }));
console.log(JSON.stringify({ records, issues: issues.length, categories: categories.sort((a,b) => b.count-a.count) }, null, 2));
