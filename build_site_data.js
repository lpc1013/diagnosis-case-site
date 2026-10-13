/*
 * build_site_data.js
 * 把「选项反馈」(Layer1+Layer2) 与「正确答案」(Layer3) 两份 md，
 * 加上 raw json 的完整结构（病史分类、体格分支树、辅助三级树、诊断依据树）
 * 与 diag_cache 诊断库，抽取成 site/data/*.json。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'overall_cases');
const OUT = path.join(ROOT, 'site', 'data');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const norm = s => (s || '').replace(/\s+/g, '').replace(/[：:\/\\]/g, '').toLowerCase();
const stripMd = s => (s || '').replace(/\*\*/g, '').replace(/`/g, '').trim();

function readMd(folder, name) {
  const p = path.join(SRC, folder, name + '.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

const CASE_FILES = ['呕血068', '记忆力定向力减退、走路不稳', '双下肢浮肿', '血压升高'];

// 前端契约与病例配对只保留一份实现，构建期就地自检
const { validateCases } = require('./site/assets/js/data/schema.js');
const { matchRawFiles } = require('./site/assets/js/data/case-registry.js');
const { caseVersionOf, caseItems } = require('./site/assets/js/domain/case.js');

// 计分必要项计数：与前端 caseItems 同一份扁平化实现，避免这里再写一套 walk
const necCount = c => ['history', 'physical', 'aux', 'diagnosis', 'treatment']
  .reduce((a, sec) => a + caseItems(c.sections, sec).filter(i => i.nec).length, 0);

const RAW_DIR = path.join(SRC, '_源数据');

// 病例 ↔ 原始 JSON 必须由文件内容（meta.name）决定。
// 按目录枚举顺序取「第 idx 个文件」是个没有代码保证的假设：新增导出、换文件系统
// 都可能把 A 例的答案接到 B 例的结构上，而构建照样成功、页面照样能跑。
function pairRawFiles() {
  const files = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.json'));
  const entries = files.map(f => {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(RAW_DIR, f), 'utf8')); }
    catch (e) { throw new Error(`原始数据无法解析：${f} — ${e.message}`); }
    return { file: f, name: (j.meta && j.meta.name) || '', id: (j.meta && (j.meta._id || j.meta.id)) || '' };
  });
  const { map, errors } = matchRawFiles(CASE_FILES, entries);
  if (errors.length) throw new Error('病例与原始数据配对失败：\n  - ' + errors.join('\n  - '));
  return map;
}

const RAW_BY_CASE = pairRawFiles();
const toCost = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };

// ---------- 解析 选项反馈 (Layer1 + Layer2) ----------
function parseOptions(md) {
  const sec = {};
  const reSec = /^###\s*2\.(\d)\s+(.+)$/;
  let cur = null;
  for (const ln of md.split('\n')) {
    const m = ln.match(reSec);
    if (m) { cur = m[1]; sec[cur] = []; continue; }
    if (cur == null) continue;
    sec[cur].push(ln);
  }
  const out = { history: [], physical: [], aux: [], treatment: [] };

  // 2.1 病史
  if (sec['1']) {
    for (let i = 0; i < sec['1'].length; i++) {
      const qm = sec['1'][i].match(/^\d+\.\s+\*\*问\*\*：(.+)$/);
      if (qm) {
        let reply = '';
        const nx = sec['1'][i + 1];
        if (nx && nx.match(/^\s*-\s+\*\*患者回复\*\*：(.+)$/)) {
          reply = nx.match(/^\s*-\s+\*\*患者回复\*\*：(.+)$/)[1].trim();
          i++;
        }
        out.history.push({ q: stripMd(qm[1]), reply });
      }
    }
  }

  // 2.2 体格
  if (sec['2']) {
    let grp = '未分类', region = '';
    out.physical.push({ group: grp, region: '', items: [] });
    for (const ln of sec['2']) {
      const bold = ln.match(/^\*\*(.+?)\*\*\s*$/);
      const ital = ln.match(/^\*([^*]+)\*\s*$/);
      if (bold) { grp = stripMd(bold[1]); region = ''; out.physical.push({ group: grp, region: '', items: [] }); continue; }
      if (ital) { region = stripMd(ital[1]); out.physical.push({ group: grp, region, items: [] }); continue; }
      const bi = ln.match(/^-\s+(.+?)\s*[:：]\s*(.+)$/);
      if (bi) out.physical[out.physical.length - 1].items.push({ name: stripMd(bi[1]), result: bi[2].trim() });
    }
    out.physical = out.physical.filter(g => g.items.length);
  }

  // 2.3 辅助
  if (sec['3']) {
    let grp = '未分类';
    out.aux.push({ group: grp, items: [] });
    for (const ln of sec['3']) {
      const bold = ln.match(/^\*\*(.+?)\*\*(?:\s*（[^）]*）)?\s*$/);
      if (bold) { grp = stripMd(bold[1]); out.aux.push({ group: grp, items: [] }); continue; }
      const bi = ln.match(/^-\s+\*\*(.+?)\*\*\s*[:：]\s*(.+)$/);
      if (bi) { out.aux[out.aux.length - 1].items.push({ name: stripMd(bi[1]), result: bi[2].trim(), ref: '', sig: '' }); continue; }
      const ref = ln.match(/^\s*-\s*参考值[：:]\s*(.+)$/);
      const sig = ln.match(/^\s*-\s*临床意义[：:]\s*(.+)$/);
      const last = out.aux[out.aux.length - 1].items.slice(-1)[0];
      if (ref && last) last.ref = ref[1].trim();
      else if (sig && last) last.sig = sig[1].trim();
    }
    out.aux = out.aux.filter(g => g.items.length);
  }

  // 2.5 治疗
  if (sec['5']) {
    let grp = '未分类';
    out.treatment.push({ group: grp, items: [] });
    for (const ln of sec['5']) {
      const bold = ln.match(/^\*\*(.+?)\*\*\s*$/);
      if (bold) { grp = stripMd(bold[1]); out.treatment.push({ group: grp, items: [] }); continue; }
      const bi = ln.match(/^-\s+(.+?)\s*[（(](.+?)[)）]\s*$/);
      if (bi) out.treatment[out.treatment.length - 1].items.push({ name: stripMd(bi[1]), attr: bi[2].trim() });
      else {
        const b2 = ln.match(/^-\s+(.+)$/);
        if (b2) out.treatment[out.treatment.length - 1].items.push({ name: stripMd(b2[1]), attr: '' });
      }
    }
    out.treatment = out.treatment.filter(g => g.items.length);
  }
  return out;
}

// ---------- 解析 正确答案 (Layer3) ----------
function parseCorrect(md) {
  const out = { history: [], physical: [], aux: [], diagnosis: [], treatment: [] };
  const sec = {};
  const reSec = /^###\s*1\.(\d)\s+(.+)$/;
  let cur = null;
  for (const ln of md.split('\n')) {
    const m = ln.match(reSec);
    if (m) { cur = m[1]; sec[cur] = []; continue; }
    if (cur == null) continue;
    sec[cur].push(ln);
  }
  // 1.1 病史
  if (sec['1']) {
    for (const ln of sec['1']) {
      const m = ln.match(/^\d+\.\s+\*\*(.+?)\*\*\s*—\s*标准回复[：:]\s*(.+?)（(\d+)分）/);
      if (m) out.history.push({ q: stripMd(m[1]), std: stripMd(m[2]), score: +m[3], necessary: true });
    }
  }
  // 1.2 体格
  if (sec['2']) {
    for (const ln of sec['2']) {
      const m = ln.match(/^\d+\.\s+\*\*(.+?)\*\*\s*—\s*标准结果[：:]\s*(.+?)（(\d+)分）/);
      if (m) out.physical.push({ name: stripMd(m[1]), std: stripMd(m[2]), score: +m[3], necessary: true });
    }
  }
  // 1.3 辅助
  if (sec['3']) {
    let grp = '未分类';
    out.aux.push({ group: grp, items: [] });
    for (const ln of sec['3']) {
      const gb = ln.match(/^\*\*(.+?)\*\*\s*（\d+\s*项）/);
      if (gb) { grp = stripMd(gb[1]); out.aux.push({ group: grp, items: [] }); continue; }
      const m = ln.match(/^\d+\.\s+\*\*(.+?)\*\*\s*—\s*标准结果[：:]\s*(.+?)（(\d+)分）/);
      if (m) out.aux[out.aux.length - 1].items.push({ name: stripMd(m[1]), std: stripMd(m[2]), score: +m[3], necessary: true });
    }
    out.aux = out.aux.filter(g => g.items.length);
  }
  // 1.4 诊断
  if (sec['4']) {
    let cls = '未分类', item = null;
    for (const ln of sec['4']) {
      const cb = ln.match(/^\*\*【西医诊断\s*·\s*(.+?)】\*\*$/);
      if (cb) { cls = stripMd(cb[1]); continue; }
      const dm = ln.match(/^\d+\.\s+\*\*(.+?)\*\*\s*（(\d+)分）/);
      if (dm) {
        item = { name: stripMd(dm[1]), score: +dm[2], cls, synonyms: '', evidence: [] };
        out.diagnosis.push(item);
        continue;
      }
      if (!item) continue;
      const syn = ln.match(/^\s*-\s*同义诊断[：:]\s*(.+)$/);
      if (syn) { item.synonyms = stripMd(syn[1]); continue; }
      const evh = ln.match(/^\s*-\s*支撑依据（\d+\s*条）[：:]?\s*$/);
      if (evh) continue;
      const ev = ln.match(/^\s*-\s*\[([^\]]+)\]\s+(.+?)（(\d+)分）\s*$/);
      if (ev) {
        const src = stripMd(ev[1]);
        let rest = ev[2].trim();
        let itemName = '', content = rest;
        const dash = rest.indexOf(' - ');
        if (dash >= 0) { itemName = rest.slice(0, dash); content = rest.slice(dash + 3); }
        const ci = content.indexOf('：');
        const ci2 = content.indexOf(':');
        const idx = ci >= 0 ? ci : ci2;
        let sub = '', c2 = content;
        if (idx >= 0) { sub = content.slice(0, idx); c2 = content.slice(idx + 1); }
        else if (!itemName) { itemName = content; c2 = ''; }
        else { sub = content; c2 = ''; }
        item.evidence.push({ src, item: stripMd(itemName), sub: stripMd(sub), content: stripMd(c2), score: +ev[3] });
      }
    }
  }
  // 1.5 治疗
  if (sec['5']) {
    let grp = '未分类';
    out.treatment.push({ group: grp, items: [] });
    for (const ln of sec['5']) {
      const gb = ln.match(/^\*\*(.+?)\*\*\s*（(\d+)\s*项）/);
      if (gb) { grp = stripMd(gb[1]); out.treatment.push({ group: grp, items: [] }); continue; }
      const m = ln.match(/^\d+\.\s+\*\*(.+?)\*\*(?:\s*—\s*标准内容[：:]\s*(.+?))?\s*（(\d+)分）/);
      if (m) out.treatment[out.treatment.length - 1].items.push({ name: stripMd(m[1]), std: m[2] ? stripMd(m[2]) : '', score: +m[3], necessary: true });
    }
    out.treatment = out.treatment.filter(g => g.items.length);
  }
  return out;
}

// ---------- 从 raw json 建病史分类树 ----------
// 把 md 选项反馈里、raw 未归类的问答题按关键词归位到合适的一级/二级分类，
// 避免全部倒进「未分类/其他」形成 50 条的大杂烩。
function classifyLeftover(q) {
  if (/婚|育|月经|怀孕|生育/.test(q)) return { cat: '月经婚育史', sub: '婚育史' };
  if (/亲属|家族|直系|父母|兄弟姐妹|子女|遗传/.test(q)) return { cat: '家族史', sub: '家族史' };
  if (/饮食|吸烟|喝酒|酒|宠物|动物|昆虫|叮咬|作息|疫苗|出生地|老家|上学|文化|兴趣|爱好|职业|进食|胡萝卜|南瓜|橙子|服药|铋剂|铁剂|碳粉|中药|过敏/.test(q)) return { cat: '个人史', sub: '个人史' };
  if (/以前|既往|手术|诊断过|检查过|感染|寄生虫|淋病|尖锐湿疣|得过什么病|用药史|做过什么检查|检查结果|输过血|失血/.test(q)) return { cat: '既往史', sub: '既往患病史' };
  return { cat: '现病史', sub: '其他' };
}

function buildHistory(raw, opt, cor) {
  const inq = raw.getCaseInquiryData?.data?.inquiryCategories || [];
  const corH = {};
  cor.history.forEach(h => corH[norm(h.q)] = h);
  const optH = {};
  opt.history.forEach(h => optH[norm(h.q)] = h.reply);

  const categories = [];
  const catByName = {};
  function cat(name) {
    if (!catByName[name]) { const c = { category: name, subs: [] }; categories.push(c); catByName[name] = c; }
    return catByName[name];
  }
  function sub(c, name) {
    let s = c.subs.find(x => x.name === name);
    if (!s) { s = { name, items: [] }; c.subs.push(s); }
    return s;
  }

  const used = new Set();
  for (const c of inq) {
    const cc = cat(stripMd(c.name));
    for (const subCat of (c.explainCategories || [])) {
      const ss = sub(cc, stripMd(subCat.name));
      for (const ex of (subCat.explains || [])) {
        const qs = (c.inquiries || []).filter(iq => iq.inquiryExplainId === ex.id);
        for (const iq of qs) {
          const q = stripMd(iq.question);
          const cc2 = corH[norm(q)];
          ss.items.push({
            q, reply: optH[norm(q)] || stripMd(iq.answer),
            necessary: !!cc2, std: cc2 ? cc2.std : '', score: cc2 ? cc2.score : 0,
            explain: stripMd(subCat.name)
          });
          used.add(norm(q));
        }
      }
    }
  }
  // 兜底：把 md 选项反馈里但 raw 未归类的，按关键词归位到对应分类（不再堆进「未分类/其他」）
  const leftover = opt.history.filter(h => !used.has(norm(h.q)));
  for (const h of leftover) {
    const cl = classifyLeftover(h.q);
    const cc = cat(cl.cat);
    const ss = sub(cc, cl.sub);
    const cc2 = corH[norm(h.q)];
    ss.items.push({ q: h.q, reply: h.reply, necessary: !!cc2, std: cc2 ? cc2.std : '', score: cc2 ? cc2.score : 0, explain: cl.sub });
  }
  // 清理空分类
  return categories.filter(c => c.subs.some(s => s.items.length)).map(c => ({ ...c, subs: c.subs.filter(s => s.items.length) }));
}

// ---------- 从 raw json 建体格分支树 ----------
function buildPhysical(raw, opt, cor) {
  const data = raw.getPhysicalCheckData?.data || {};
  const checks = data.physicalChecks || [];
  const cats = data.physicalCheckCategories || [];
  const positions = data.positions || [];
  const tools = data.tools || [];

  const catMap = {};
  cats.forEach(c => catMap[c.id] = c.name);
  const toolMap = {};
  tools.forEach(t => toolMap[t.id] = t.name);

  const childToParent = {};
  const posName = {};
  positions.forEach(p => {
    posName[p.id] = p.name;
    (p.children || []).forEach(c => {
      posName[c.id] = c.name;
      childToParent[c.id] = p.name;
    });
  });

  const corP = {};
  cor.physical.forEach(p => corP[norm(p.name)] = p);
  const optP = {};
  opt.physical.forEach(g => g.items.forEach(it => optP[norm(it.name)] = it.result));

  const catGroups = {};
  const modelGroups = {};

  for (const it of checks) {
    const name = stripMd(it.name || it.explainName || '');
    if (!name) continue;
    const c = corP[norm(name)];
    const item = {
      name, result: it.result || optP[norm(name)] || '',
      necessary: !!c, std: c ? c.std : '', score: c ? c.score : 0,
      tool: toolMap[it.toolId] || '', position: posName[it.positionId] || ''
    };
    if (it.physicalCheckCategoryId && catMap[it.physicalCheckCategoryId]) {
      const cn = catMap[it.physicalCheckCategoryId];
      catGroups[cn] = catGroups[cn] || [];
      catGroups[cn].push(item);
    } else if (it.positionId) {
      const region = childToParent[it.positionId] || posName[it.positionId] || '其他部位';
      const part = posName[it.positionId] || '其他';
      modelGroups[region] = modelGroups[region] || {};
      modelGroups[region][part] = modelGroups[region][part] || [];
      modelGroups[region][part].push(item);
    }
  }

  const nodes = [];
  // 优先选项分类
  for (const cn of cats.map(c => c.name)) {
    if (catGroups[cn]) nodes.push({ name: cn, kind: 'cat', items: catGroups[cn] });
  }
  // 3D 人体模型
  if (Object.keys(modelGroups).length) {
    const modelSubs = [];
    for (const region of Object.keys(modelGroups).sort()) {
      const partSubs = [];
      for (const part of Object.keys(modelGroups[region]).sort()) {
        partSubs.push({ name: part, kind: 'part', items: modelGroups[region][part] });
      }
      modelSubs.push({ name: region, kind: 'region', subs: partSubs });
    }
    nodes.push({ name: '人体模型查体', kind: 'model', subs: modelSubs });
  }
  return nodes;
}

// ---------- 从 raw json 建辅助三级树 ----------
function buildAux(raw, opt, cor) {
  const cats = raw.getMedicalCheckData?.data?.medicalCheckCategories || [];
  const corA = {};
  cor.aux.forEach(g => g.items.forEach(it => corA[norm(it.name)] = it));
  const optA = {};
  opt.aux.forEach(g => g.items.forEach(it => optA[norm(it.name)] = it));

  function walk(nodes) {
    const out = [];
    for (const n of nodes || []) {
      if (n.medicalChecks && n.medicalChecks.length) {
        out.push({ name: stripMd(n.name), children: walk(n.medicalChecks) });
      } else {
        const c = corA[norm(n.name)];
        const o = optA[norm(n.name)] || {};
        out.push({
          name: stripMd(n.name), result: n.result || o.result || '',
          unit: n.unit || '', ref: n.referenceValue || o.ref || '',
          sig: n.clinicalSignificance || o.sig || '', cost: toCost(n.cost),
          necessary: !!c, std: c ? c.std : '', score: c ? c.score : 0,
          abbreviation: n.abbreviation || ''
        });
      }
    }
    return out;
  }
  return walk(cats);
}

// ---------- 加载诊断依据树 dump ----------
function loadDxDump(idx) {
  const candidates = fs.readdirSync(path.join(ROOT, 'recon')).filter(f => f === `dxdump_c${idx}.json`);
  if (!candidates.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'recon', candidates[0]), 'utf8')); }
  catch (e) { return null; }
}

function parseUiNode(text) {
  const s = stripMd(text || '');
  const ci = s.indexOf(':');
  const c2 = s.indexOf('：');
  const idx = ci >= 0 ? ci : c2;
  if (idx < 0) return { sub: '', item: s, content: '' };
  const left = s.slice(0, idx).trim();
  const content = s.slice(idx + 1).trim();
  const dash = left.indexOf(' - ');
  if (dash >= 0) return { sub: left.slice(0, dash).trim(), item: left.slice(dash + 3).trim(), content };
  return { sub: '', item: left, content };
}

function inferSrc(item, sub, physicalNames, auxNames) {
  const t = (item + ' ' + sub).replace(/\s+/g, '');
  if (physicalNames.has(norm(t))) return '体格检查';
  if (auxNames.has(norm(t))) return '辅助检查';
  // 常见影像/化验关键词
  if (/血常规|肝功能|肾功能|血脂|电解质|尿常规|大便常规|血糖|糖化|凝血|淀粉酶|心肌酶|内分泌|皮质醇|醛固酮|儿茶酚胺|肾素|血管紧张素|卧立位|血儿茶酚|24小时尿|尿蛋白|肌酐|尿素|尿酸|胆固醇|甘油三酯|CT|MRA|MRI|X线|超声|心电图|内镜|活检|穿刺/i.test(t)) return '辅助检查';
  if (/体温|脉搏|呼吸|血压|视诊|触诊|叩诊|听诊|反射|肌力|肌张力|共济|感觉|定向力|记忆力|计算力|理解判断力|饮水试验|Babinski|Oppenheim|Gordon|Hoffmann|腹壁反射|角膜反射|瞳孔|对光反射|视野|眼球运动|集合反射|视力|听力|嗅觉|鼻窦/i.test(t)) return '体格检查';
  return '病史采集';
}

function buildDiagnosis(raw, cor, idx) {
  // 从 raw 取体格/辅助叶子名，用于 uiNode 来源推断
  const physNames = new Set();
  (raw.getPhysicalCheckData?.data?.physicalChecks || []).forEach(p => {
    physNames.add(norm(p.name || p.explainName || ''));
  });
  const auxNames = new Set();
  function walkAux(nodes) {
    for (const n of nodes || []) {
      if (n.medicalChecks) walkAux(n.medicalChecks);
      else auxNames.add(norm(n.name || ''));
    }
  }
  walkAux(raw.getMedicalCheckData?.data?.medicalCheckCategories || []);

  const dxdump = loadDxDump(idx) || {};

  // 先用报告 necessary 建立 uiNode -> src 映射
  const srcMap = {};
  for (const dname of Object.keys(dxdump)) {
    for (const nec of (dxdump[dname].necessary || [])) {
      const m = nec.match(/^\[([^\]]+)\]\s*(.+)$/);
      if (!m) continue;
      const src = m[1];
      const rest = m[2].trim();
      srcMap[norm(rest)] = src;
    }
  }

  const out = [];
  for (const d of cor.diagnosis) {
    const dx = dxdump[d.name] || dxdump[Object.keys(dxdump).find(k => norm(k) === norm(d.name))];
    const matchedSet = new Set();
    const uiNodes = [];
    if (dx) {
      (dx.matched || []).forEach(x => matchedSet.add(norm(stripMd(x))));
      for (const txt of (dx.uiNodes || [])) {
        const parsed = parseUiNode(txt);
        const key = norm(stripMd(txt));
        const src = srcMap[key] || inferSrc(parsed.item, parsed.sub, physNames, auxNames);
        uiNodes.push({ text: stripMd(txt), src, sub: parsed.sub, item: parsed.item, content: parsed.content, support: matchedSet.has(key) });
      }
    }
    // 按 src 分组
    const bySrc = {};
    uiNodes.forEach(u => { (bySrc[u.src] = bySrc[u.src] || []).push(u); });
    out.push({
      name: d.name, cls: d.cls, score: d.score, synonyms: d.synonyms,
      evidence: d.evidence, uiNodes, bySrc, matchedCount: matchedSet.size
    });
  }
  return out;
}

// ---------- 合并治疗 + 场景标记（住院/门诊/急诊/转诊治疗） ----------
const TX_SCENES = ['住院', '门诊', '急诊', '转诊治疗'];
function buildTreatment(raw, opt, cor) {
  // 从 raw 取每个治疗项的场景标记
  const sceneMap = {};
  const tx = raw.getTreatmentData?.data;
  if (tx) {
    const cats = [...(tx.treatmentItemCategories || []), ...(tx.treatmentItemCategoryData || []).map(d => d)];
    for (const c of cats) for (const it of (c.treatmentItems || [])) {
      const scenes = [];
      if (it.isHospitalized) scenes.push('住院');
      if (it.isOutpatient) scenes.push('门诊');
      if (it.isEmergency) scenes.push('急诊');
      if (it.isTemporary) scenes.push('转诊治疗');
      if (scenes.length) sceneMap[norm(it.name)] = scenes;
    }
  }
  const corTgroups = cor.treatment;
  const optTmap = {};
  opt.treatment.forEach(g => g.items.forEach(it => optTmap[norm(it.name)] = it));
  let unknownScene = 0;
  // 「源数据没标场景」不等于「四个场景都适用」。这里仍给出全部场景以免丢选项，
  // 但必须打上 scenesUnknown：界面据此说明「未标注」，构建日志汇总待人工核对。
  const sceneOf = nm => {
    const s = sceneMap[norm(nm)];
    if (s && s.length) return { scenes: s, scenesUnknown: false };
    unknownScene++;
    return { scenes: TX_SCENES.slice(), scenesUnknown: true };
  };
  const treatment = corTgroups.map(g => ({
    group: g.group,
    items: g.items.map(it => ({
      name: it.name, attr: (optTmap[norm(it.name)] || {}).attr || '', necessary: true, std: it.std, score: it.score,
      ...sceneOf(it.name)
    }))
  }));
  opt.treatment.forEach(g => {
    const cg = corTgroups.find(c => c.group === g.group);
    if (cg) {
      const tg = treatment.find(t => t.group === g.group);
      g.items.forEach(it => {
        if (!cg.items.some(ci => norm(ci.name) === norm(it.name))) {
          tg.items.push({ name: it.name, attr: it.attr, necessary: false, std: '', score: 0, ...sceneOf(it.name) });
        }
      });
    } else {
      treatment.push({ group: g.group, items: g.items.map(it => ({ name: it.name, attr: it.attr, necessary: false, std: '', score: 0, ...sceneOf(it.name) })) });
    }
  });
  if (unknownScene) console.log(`    治疗场景未标注 ${unknownScene} 项：已按全部场景展示并标记 scenesUnknown，需人工核对`);
  // 真实爬取数据中不存在「病人处置」分类（处置由治疗方式闸门决定），丢弃答案数据误带的该组
  return treatment.filter(g => g.group !== '病人处置');
}

// ---------- 由现有权威源推导 4 板块增量（方案A） ----------
// 体格/辅助 取 sections 自带 result/ref/sig；诊断取 uiNodes；治疗取 raw 治疗原则。
// 病史采集保留 recon/incr_c*.json 的 live 爬取结果。
function flattenItems(nodes) {
  const out = [];
  for (const n of (nodes || [])) {
    if (n.items && n.items.length) out.push(...n.items);
    if (n.subs) out.push(...flattenItems(n.subs));
    if (n.children) out.push(...flattenItems(n.children));
    // 叶子节点（无子节点但有 name，如辅助三级树的末级项）→ 自身即一项
    else if (!n.subs && !n.items && n.name) out.push(n);
  }
  return out;
}

function deriveIncrements(raw, cor, opt, idx, sections, liveIncr) {
  const tabs = {};

  // 体格：检查记录
  {
    const items = flattenItems(sections.physical);
    const steps = items.map(it => {
      const fb = `检查记录\n${it.name}：${it.result || it.std || ''}`.trim();
      return { item: it.name, fullText: fb, deltaLen: (it.result || '').length, changed: !!(it.result || it.std) };
    });
    tabs['体格检查'] = { totalItems: items.length, changedCount: steps.filter(s => s.changed).length, steps, finalRight: steps.map(s => s.fullText).join('\n\n') };
  }

  // 辅助：检查结果
  {
    const stripTags = s => (s || '').replace(/<[^>]+>/g, '');
    const items = flattenItems(sections.aux);
    const steps = items.map(it => {
      const val = [it.result, it.unit, it.ref ? `参考值:${it.ref}` : '', it.sig ? `临床意义:${it.sig}` : ''].map(stripTags).filter(Boolean).join('  ');
      const fb = `检查结果\n${it.name}：${val}`.trim();
      return { item: it.name, fullText: fb, deltaLen: (it.result || '').length, changed: !!(it.result || it.ref || it.sig) };
    });
    tabs['辅助检查'] = { totalItems: items.length, changedCount: steps.filter(s => s.changed).length, steps, finalRight: steps.map(s => s.fullText).join('\n\n') };
  }

  // 诊断：依据列表
  {
    const steps = sections.diagnosis.map(d => {
      const lines = (d.uiNodes || []).map(u => `${u.src} - ${u.item}${u.sub ? (' - ' + u.sub) : ''}：${u.content} ${u.support ? '（支持）' : '（不支持）'}`);
      const fb = `依据列表\n${d.name}\n` + (lines.join('\n') || '（无依据树）');
      return { item: d.name, fullText: fb, deltaLen: fb.length, changed: true };
    });
    tabs['诊断'] = { totalItems: sections.diagnosis.length, changedCount: steps.length, steps, finalRight: steps.map(s => s.fullText).join('\n\n') };
  }

  // 治疗：治疗原则（raw 仅含整体原则，无逐项原则文本）
  {
    const tp = (raw.getTreatmentData?.data?.treatmentPrincipleItems || []).map(p => p.name);
    const items = flattenItems(sections.treatment);
    const principles = '治疗原则\n' + (tp.join('\n') || '（无）');
    const steps = items.map(it => ({ item: it.name, fullText: `治疗原则\n${it.name}（已选入治疗）\n${tp.join('\n')}`, deltaLen: 0, changed: true }));
    tabs['治疗'] = { totalItems: items.length, changedCount: steps.length, steps, finalRight: principles };
  }

  // 病史采集：保留 live 爬取
  if (liveIncr && liveIncr.tabs && liveIncr.tabs['病史采集']) {
    tabs['病史采集'] = liveIncr.tabs['病史采集'];
  }
  return { tabs };
}

// ---------- 解析官网右栏报告 ----------
function pickPanel(panels, sig) {
  let best = null;
  for (const p of (panels || [])) {
    if (sig(p) && (!best || p.length > best.length)) best = p;
  }
  return best;
}
function cleanReport(s) {
  return (s || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function parseReports(caseIdx) {
  const f = path.join(ROOT, 'recon', `reports_c${caseIdx}.json`);
  if (!fs.existsSync(f)) return null;
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  const rep = r.reports || {};
  const out = {};
  if (rep['病史采集']) {
    const p = pickPanel(rep['病史采集'].panels, t => t.includes('现病史'));
    if (p) out.history = cleanReport(p);
  }
  if (rep['体格检查']) {
    const p = pickPanel(rep['体格检查'].panels, t => t.includes('检查记录') && (t.includes('脉搏P') || t.includes('血压BP')));
    if (p) out.physical = cleanReport(p);
  }
  if (rep['辅助检查']) {
    const p = pickPanel(rep['辅助检查'].panels, t => t.includes('检查报告单'))
          || pickPanel(rep['辅助检查'].panels, t => t.includes('检查结果'));
    if (p) out.aux = cleanReport(p);
  }
  if (rep['诊断'] && rep['诊断'].rightDiv && rep['诊断'].rightDiv[0]) {
    out.diagnosis = cleanReport(rep['诊断'].rightDiv[0]);
  }
  if (rep['治疗']) {
    const prPanel = pickPanel(rep['治疗'].panels, t => t.includes('治疗原则') && t.length > 30);
    if (prPanel) {
      const ip = prPanel.indexOf('治疗计划');
      out.txPrinciples = cleanReport(ip > 0 ? prPanel.slice(0, ip) : prPanel);
      const planPanel = pickPanel(rep['治疗'].panels, t => t.startsWith('治疗计划') && t.includes('治疗项目'));
      if (planPanel) out.txPlan = cleanReport(planPanel);
      else if (ip > 0) out.txPlan = cleanReport(prPanel.slice(ip));
    }
  }
  return out;
}

// ---------- 主流程 ----------
const cases = [];
CASE_FILES.forEach((name, idx) => {
  const opt = parseOptions(readMd('选项反馈', name));
  const cor = parseCorrect(readMd('正确答案', name));

  const rawFile = RAW_BY_CASE.get(name);
  const raw = JSON.parse(fs.readFileSync(path.join(RAW_DIR, rawFile), 'utf8'));
  const meta = raw.meta || {};
  if ((meta.name || '').trim() !== name) {
    throw new Error(`病例名不符：${rawFile} 的 meta.name=「${meta.name}」，清单要求「${name}」——配对出错，拒绝继续混档`);
  }

  // 限制阈值（官网进度条真实语义，四个模块都有）
  //   standardCount   = 标准线：≤ 此值 → 绿色（标准内）
  //   reasonableCount = 合理线：standard < x ≤ reasonable → 橙色（超标准但不扣分）
  //   maxCount        = 上限：> reasonable 即开始扣分（红色）；max 为进度条满格/硬上限
  const iData = raw.getCaseInquiryData && raw.getCaseInquiryData.data;
  const pData = raw.getPhysicalCheckData && raw.getPhysicalCheckData.data;
  const mData = raw.getMedicalCheckData && raw.getMedicalCheckData.data;
  const tData = raw.getTreatmentData && raw.getTreatmentData.data;
  const lim = d => (d && d.maxCount != null)
    ? { standard: d.standardCount, reasonable: d.reasonableCount, max: d.maxCount } : null;
  const limits = {
    history: lim(iData),
    physical: lim(pData),
    aux: mData ? Object.assign({}, lim(mData), {
      costStandard: mData.standardCostCount,
      costReasonable: mData.reasonableCostCount,
      costMax: mData.maxCostCount
    }) : null,
    treatment: lim(tData)
  };

  const sections = {
    history: buildHistory(raw, opt, cor),
    physical: buildPhysical(raw, opt, cor),
    aux: buildAux(raw, opt, cor),
    diagnosis: buildDiagnosis(raw, cor, idx),
    treatment: buildTreatment(raw, opt, cor)
  };

  const reports = parseReports(idx) || {};

  // 增量数据：体格/辅助/诊断/治疗 由现有权威源推导（方案A）；病史采集保留 live 爬取
  const liveIncr = (() => {
    const incrFiles = fs.readdirSync(path.join(ROOT, 'recon')).filter(f => f.startsWith(`incr_c${idx}_`) && f.endsWith('.json'));
    if (!incrFiles.length) return null;
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'recon', incrFiles[0]), 'utf8')); } catch (e) { return null; }
  })();
  const increments = deriveIncrements(raw, cor, opt, idx, sections, liveIncr);

  // caseVersion 必须在对象成型后再算：摘要只覆盖影响计分的字段（条目键/必要性/分值/费用/阈值）
  const built = {
    idx, name: meta.name || name, dept: meta.dept || '', patient: meta.patient || '',
    gender: meta.gender || '', age: meta.age || '', sections, reports, increments, limits,
    // 每个模块的数据来自哪一份原始导出，留痕以便事后核对
    src: { file: rawFile, id: String(meta._id || meta.id || ''), pairedBy: 'meta.name' },
    caseVersion: null,
  };
  built.caseVersion = caseVersionOf(built);
  cases.push(built);
});

// 写出前用前端同一份契约自检：结构不合格就中止，绝不带着错数据发布
const problems = validateCases(cases);
const errors = problems.filter(p => p.level === 'error');
const warns = problems.filter(p => p.level === 'warn');
if (warns.length) {
  console.warn(`数据校验：${warns.length} 条警告`);
  warns.slice(0, 10).forEach(p => console.warn('  ! ' + p.msg));
}
if (errors.length) {
  console.error(`数据校验失败（${errors.length} 条），未写出 cases.json：`);
  errors.slice(0, 30).forEach(p => console.error('  ✗ ' + p.msg));
  if (errors.length > 30) console.error(`  ...共 ${errors.length} 条`);
  throw new Error('构建中止：生成的病例数据不符合前端契约，发布出去会静默误导训练结果');
}

fs.writeFileSync(path.join(OUT, 'cases.json'), JSON.stringify(cases, null, 1), 'utf8');
console.log(`cases.json 已写出 ${cases.length} 例，各例计分版本：`);
cases.forEach(c => console.log(`  #${c.idx} ${c.name} · ${c.caseVersion} · 必要项 ${necCount(c)}`));

// 诊断库
const dc = JSON.parse(fs.readFileSync(path.join(ROOT, 'diag_cache.json'), 'utf8'));
const dcOuter = dc.diagnosisItemData;
const dcInner = Array.isArray(dcOuter) ? dcOuter[0] : dcOuter;
const arr = (dcInner && dcInner.diagnosisItems) || [];
const diaglib = arr.map(d => ({ code: d.code || '', name: d.name || '' })).filter(d => d.name);
fs.writeFileSync(path.join(OUT, 'diaglib.json'), JSON.stringify(diaglib), 'utf8');

console.log('cases:', cases.length);
cases.forEach(c => {
  const s = c.sections;
  const hItems = s.history.reduce((a, cat) => a + cat.subs.reduce((b, sub) => b + sub.items.length, 0), 0);
  const countTree = nodes => nodes.reduce((a, n) => a + (n.children ? countTree(n.children) : 1), 0);
  console.log(`  ${c.name}: 病史${hItems} 体格节点${s.physical.length} 辅助叶子${countTree(s.aux)} 诊断${s.diagnosis.length} 治疗组${s.treatment.length}`);
});
console.log('diaglib:', diaglib.length);
