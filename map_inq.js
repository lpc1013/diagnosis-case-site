// 建立「问诊题 → 证据行(explainCategory - explain: explainAnswer)」映射
// 用途：定位诊断依据缺失行到底对应哪几道题
const fs = require('fs');
const path = require('path');
const IDX = parseInt(process.env.CASE_IDX || '0', 10);
const files = ['6413fe129416b901c07806dd.json'];
const dir = path.join(__dirname, 'overall_cases/_源数据');
const raws = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
const file = process.env.RAW || raws[IDX] || files[0];
const j = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const inq = j.getCaseInquiryData.data;

const catName = {}, expName = {}, expCatOf = {};
function walk(list) {
  (list || []).forEach(c => {
    (c.explainCategories || []).forEach(ec => {
      catName[ec.id] = ec.name;
      (ec.explains || []).forEach(e => { expName[e.id] = e.name; expCatOf[e.id] = ec.id; });
    });
    if (c.childrens) walk(c.childrens);
  });
}
walk(inq.inquiryCategories);

const need = new Set(inq.inquiryAnswers.map(a => a.inquiryId));
const all = [];
function walkQ(list, p) {
  (list || []).forEach(c => {
    const pp = p ? p + '>' + c.name : c.name;
    (c.inquiries || []).forEach(q => all.push({ path: pp, ...q }));
    if (c.childrens) walkQ(c.childrens, pp);
  });
}
walkQ(inq.inquiryCategories, '');

const rows = new Map();   // key = cat|exp
for (const q of all) {
  const isNeed = need.has(q.id);
  const cn = catName[q.explainCategoryId] || '?';
  const en = expName[q.inquiryExplainId] || '?';
  const key = cn + ' - ' + en;
  if (!rows.has(key)) rows.set(key, { need: [], extra: [] });
  rows.get(key)[isNeed ? 'need' : 'extra'].push({ q: q.question, a: q.explainAnswer });
}

console.log(`文件=${file}  题库${all.length}  必要${need.size}`);
console.log('\n=== 必要题产生的证据行（' + [...rows.values()].filter(r => r.need.length).length + ' 行） ===');
for (const [k, v] of rows) {
  if (!v.need.length) continue;
  console.log(`\n【${k}】必要答案: ${v.need.map(x => x.a).join('，')}`);
  v.need.forEach(x => console.log(`   ✔必 ${x.q}  → ${x.a}`));
  v.extra.forEach(x => console.log(`   ·选 ${x.q}  → ${x.a}`));
}
if (process.env.ALL) {
  console.log('\n=== 仅非必要题的证据行 ===');
  for (const [k, v] of rows) { if (v.need.length) continue; console.log(`【${k}】 ${v.extra.map(x => x.a).join('，')}`); }
}
