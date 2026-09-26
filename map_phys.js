/* map_phys.js —— 从 raw json 建「体格必要项 → (部位路径, 工具)」权威映射
   用法: node map_phys.js [caseIdx]
   输出: recon/physmap_c<idx>.json  +  控制台打印未匹配项
   依据: getPhysicalCheckData.data.physicalChecks[*] { name/explainName/explainAnswer/positionId/tools/physicalCheckCategoryId }
         getPhysicalCheckData.data.positions        树（头部 > 双眼 > 左眼 …）
*/
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const D = path.join(ROOT, 'overall_cases/_源数据');
const RECON = path.join(ROOT, 'recon');
fs.mkdirSync(RECON, { recursive: true });

const caseNames = ['呕血068', '记忆力定向力减退、走路不稳', '双下肢浮肿', '血压升高'];
// raw 文件顺序 = 目录字典序，与 CASE_IDX 对应关系需按患者主诉核对
const files = fs.readdirSync(D).filter(x => x.endsWith('.json')).sort();

function norm(s) { return (s || '').replace(/\s+/g, '').replace(/[？?。.、；;：:，,+＋]+$/g, ''); }

function readAnswers(idx) {
  const safe = caseNames[idx].replace(/[\\/:*?"<>|]/g, '_');
  const p = path.join(ROOT, 'overall_cases/正确答案', safe + '.md');
  const txt = fs.readFileSync(p, 'utf8');
  const out = []; let cur = null;
  for (const ln of txt.split('\n')) {
    const sm = ln.match(/^###\s*1\.(\d)/); if (sm) cur = sm[1];
    const im = ln.match(/^\d+\.\s+\*\*(.+?)\*\*/);
    if (im && cur === '2') out.push(im[1].trim().replace(/（\d+分）\s*$/, '').replace(/\s*（.*?）\s*$/, '').trim());
  }
  return out;
}

// 用主诉把 raw 文件与 caseIdx 对齐
function chiefOf(j) {
  const s = JSON.stringify(j.getPatientInformation || {});
  const m = s.match(/"chiefComplaint":"(.*?)"/) || s.match(/"caseName":"(.*?)"/) || s.match(/"name":"(.*?)"/);
  return m ? m[1] : '';
}

function buildPosIndex(positions) {
  const idx = {};       // id -> {name, parentName, chain}
  const walk = (arr, chain) => {
    for (const p of arr || []) {
      const nm = p.name || p.positionName || '';
      const ch = chain.concat(nm ? [nm] : []);
      idx[p.id] = { name: nm, chain: ch, root: ch[0] || '', leaf: nm };
      const kids = p.childrens || p.children || p.positions || [];
      walk(kids, ch);
    }
  };
  walk(positions, []);
  return idx;
}

function main() {
  const CASE = process.argv[2] !== undefined ? parseInt(process.argv[2], 10) : null;
  const idxs = CASE === null ? [0, 1, 2, 3] : [CASE];
  const all = {};
  // 先建 文件 -> caseIdx 映射（按 正确答案 md 的体格必要项 与 raw 项名交集最大者）
  const parsed = files.map(fn => {
    const j = JSON.parse(fs.readFileSync(path.join(D, fn), 'utf8'));
    const pcd = (j.getPhysicalCheckData && j.getPhysicalCheckData.data) || {};
    return { fn, j, checks: pcd.physicalChecks || [], positions: pcd.positions || [], categories: pcd.physicalCheckCategories || [], tools: pcd.tools || [] };
  });

  for (const idx of idxs) {
    const need = readAnswers(idx);
    // 找匹配度最高的 raw
    let best = null, bestHit = -1;
    // 优先按 meta.name 精确对齐 raw（勿只用"命中数最大"，同名项会串到别的病例文件）
    const exact = parsed.find(p => (p.j.meta && p.j.meta.name) === caseNames[idx]);
    if (exact) { best = exact; bestHit = need.filter(n => exact.checks.some(c => norm(c.explainName || c.name) === norm(n))).length; }
    else for (const p of parsed) {
      const names = new Set(p.checks.map(c => norm(c.explainName || c.name)));
      const hit = need.filter(n => names.has(norm(n))).length;
      if (hit > bestHit) { bestHit = hit; best = p; }
    }
    const posIdx = buildPosIndex(best.positions);
    const catName = {};
    const walkCat = arr => { for (const c of arr || []) { catName[c.id] = c.name; walkCat(c.childrens || c.children || []); } };
    walkCat(best.categories);
    const toolName = {};
    for (const t of best.tools) toolName[t.id] = t.name || t.toolName || '';

    const map = {}; const miss = [];
    for (const n of need) {
      const nn = norm(n);
      const hits = best.checks.filter(c => norm(c.explainName || c.name) === nn);
      if (!hits.length) { miss.push(n); continue; }
      const c = hits[0];
      const pos = posIdx[c.positionId] || null;
      map[n] = {
        region: pos ? pos.root : (catName[c.physicalCheckCategoryId] || ''),
        chain: pos ? pos.chain : [],
        a: pos ? pos.leaf : '',
        tool: toolName[c.toolId] || '',
        cat: catName[c.physicalCheckCategoryId] || '',
        answer: c.explainAnswer || c.answer || '',
      };
    }
    all[idx] = { file: best.fn, hit: bestHit, total: need.length, map, miss };
    console.log(`\n===== case${idx} ${caseNames[idx]}  raw=${best.fn} 命中 ${bestHit}/${need.length} =====`);
    for (const [k, v] of Object.entries(map)) {
      console.log(`  ${k}\n      region=${v.region} | chain=${v.chain.join('>')} | A=${v.a} | tool=${v.tool} | cat=${v.cat}`);
    }
    if (miss.length) console.log('  [raw 里找不到]', miss.join(' / '));
  }
  fs.writeFileSync(path.join(RECON, 'physmap.json'), JSON.stringify(all, null, 1));
  console.log('\n→ recon/physmap.json');
}
main();
