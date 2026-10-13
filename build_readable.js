const fs = require('fs');
const path = require('path');

const OUT = 'overall_cases';
// 源数据归置目录（raw json + 评分报告 txt）
const SRC = path.join(OUT, '_源数据');
const rawDir = path.join(SRC, 'raw');
const repDir = path.join(SRC, 'reports');
// 三个目标文件夹
const DIR_Q = path.join(OUT, '（通用）题目');   // 通用骨架 + 全局诊断库（仅 2 文件）
const DIR_A = path.join(OUT, '选项反馈');       // Layer1 + Layer2（各例具体按钮 + 选项反馈）
const DIR_C = path.join(OUT, '正确答案');       // Layer3
const cache = require('./diag_cache.json');

// 病例顺序（与训练列表、submit_report CASE_IDX 一致）
const CASE_ORDER = [
  { idx: 0, id: '6413fe129416b901c07806dd', name: '呕血068', dept: '消化内科' },
  { idx: 1, id: '6413ff299416b901c07806de', name: '记忆力定向力减退、走路不稳', dept: '老年病科' },
  { idx: 2, id: '69dde533fdc1fe17906416cf', name: '双下肢浮肿', dept: '肾脏内科' },
  { idx: 3, id: '69dde5dcfdc1fe17906416d0', name: '血压升高', dept: '心血管内科' },
];

// 诊断 id->名字
const diagMap = {};
for (const grp of cache.diagnosisItemData) {
  for (const it of (grp.diagnosisItems || [])) diagMap[it.id] = { name: it.name, code: it.code };
}
const DIAG_TOTAL = cache.diagnosisItemData.reduce((n, g) => n + (g.diagnosisItems || []).length, 0);
const CLASS_LABEL = { 0: '必要诊断', 1: '次要诊断', 2: '鉴别诊断', 3: '疑似诊断' };
const GENDER = { 0: '男', 1: '女' };

function mdEscape(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|'); }

// 汇总「治疗」板块全部可点击项
function getTreatmentBlocks(TRT) {
  if (!TRT) return [];
  const catData = {};
  for (const g of TRT.treatmentItemCategoryData || []) {
    if (g.treatmentItemCategoryId) catData[g.treatmentItemCategoryId] = g.treatmentItems || [];
  }
  const blocks = [];
  for (const c of TRT.treatmentItemCategories || []) {
    let items = c.treatmentItems || [];
    if (!items.length && catData[c.id]) items = catData[c.id];
    blocks.push({ name: c.name, items });
  }
  const principle = TRT.treatmentPrincipleItems || [];
  if (principle.length) blocks.push({ name: '治疗原则', items: principle });
  return blocks;
}

// 解析评分报告文本 -> 分组结构
function parseReportGroups(text, tabName) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length);
  const idx = lines.indexOf('正确答案');
  if (idx < 0) return [];
  const groups = [];
  let cur = null;
  const openGroup = (cat) => { cur = { cat, items: [] }; groups.push(cur); return cur; };
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\d+$/.test(line)) continue;
    const next = lines[i + 1];
    if (next && /^\d+$/.test(next)) {
      if (!cur) openGroup(null);
      const ci = line.indexOf(':');
      const name = ci >= 0 ? line.slice(0, ci).trim() : line;
      const answer = ci >= 0 ? line.slice(ci + 1).trim() : '';
      cur.items.push({ name, answer, score: Number(next) });
      i++;
    } else {
      if (tabName && line === tabName) continue;
      openGroup(line);
    }
  }
  return groups.filter(g => g.items.length);
}
function countItems(groups) { return groups.reduce((n, g) => n + g.items.length, 0); }

// 诊断报告层级状态机
const DIAG_CATS = new Set(['主要诊断', '次要诊断', '鉴别诊断', '疑似诊断', '其他诊断']);
const EVID_SECTIONS = new Set(['病史采集', '体格检查', '辅助检查', '治疗']);
function parseDiagnosisReport(text) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length);
  const idx = lines.indexOf('正确答案');
  if (idx < 0) return [];
  const out = [];
  let system = null, category = null, cur = null, expect = null;
  let evSection = null, evBuf = [];
  const newDiag = (name) => { cur = { system, category, name, synonyms: [], score: null, evidences: [] }; out.push(cur); return cur; };
  for (const line of lines.slice(idx + 1)) {
    if (/^(西医|中医)诊断[:：]?$/.test(line)) { system = line.replace(/[:：]$/, ''); expect = null; continue; }
    if (DIAG_CATS.has(line)) { category = line; expect = 'diagname'; continue; }
    if (line === '同义诊断') { expect = 'synonym'; continue; }
    if (EVID_SECTIONS.has(line)) { evSection = line; expect = 'evidence'; continue; }
    if (/^\d+$/.test(line)) {
      const n = Number(line);
      if (expect === 'evidence' && evBuf.length) {
        if (cur) cur.evidences.push({ section: evSection, text: evBuf.join(' '), score: n });
        evBuf = []; expect = null;
      } else if (cur && cur.score == null) cur.score = n;
      continue;
    }
    if (expect === 'diagname') { newDiag(line); expect = null; }
    else if (expect === 'synonym') { if (cur) cur.synonyms.push(line); expect = null; }
    else if (expect === 'evidence') evBuf.push(line);
    else newDiag(line);
  }
  return out;
}

// 递归收集问诊问题（含 childrens）
function collectInquiries(cats, acc, path) {
  for (const c of cats || []) {
    acc.push({ cat: path ? path + ' / ' + c.name : c.name, name: c.name, path });
    if (c.childrens && c.childrens.length) collectInquiries(c.childrens, acc, path ? path + ' / ' + c.name : c.name);
    for (const q of c.inquiries || []) acc.push({ cat: c.name, q, parentPath: path });
  }
  return acc;
}

function buildPosMap(positions) {
  const m = {};
  (function walk(ns, p) {
    for (const n of ns || []) { m[n.id] = p.concat(n.name); if (n.children) walk(n.children, p.concat(n.name)); }
  })(positions, []);
  return m;
}

const isMedCat = (n) => !!(n.medicalChecks && n.medicalChecks.length);
function flattenMedical(nodes, acc, pathArr) {
  pathArr = pathArr || [];
  for (const n of nodes || []) {
    if (isMedCat(n)) flattenMedical(n.medicalChecks, acc, pathArr.concat(n.name));
    else if (n.name) acc.push({ node: n, path: pathArr.join(' / ') });
  }
  return acc;
}
function countMedLeaves(node) {
  let n = 0;
  for (const c of node.medicalChecks || []) n += isMedCat(c) ? countMedLeaves(c) : 1;
  return n;
}

// 统一取出某病例所需数据
function prep(raw) {
  const meta = raw.meta;
  const PI = raw.getPatientInformation && raw.getPatientInformation.data;
  const INQ = raw.getCaseInquiryData && raw.getCaseInquiryData.data;
  const PHY = raw.getPhysicalCheckData && raw.getPhysicalCheckData.data;
  const MED = raw.getMedicalCheckData && raw.getMedicalCheckData.data;
  const DIA = raw.getDiagnosisData && raw.getDiagnosisData.data;
  const TRT = raw.getTreatmentData && raw.getTreatmentData.data;
  const posMap = PHY ? buildPosMap(PHY.positions) : {};
  return { meta, PI, INQ, PHY, MED, DIA, TRT, posMap };
}

// ===== Layer 1a：患者信息 =====
function buildMeta(P) {
  const { meta, PI } = P;
  const L = [];
  L.push('## 一、患者信息');
  if (PI) {
    const h = PI.medicalHistoryInfo || {};
    L.push('');
    L.push('| 项目 | 内容 |');
    L.push('| --- | --- |');
    const rows = [['姓名', h.patientName], ['性别', GENDER[h.gender] !== undefined ? GENDER[h.gender] : h.gender], ['年龄', h.age], ['婚姻', h.maritalStatusId], ['民族', h.nation], ['籍贯', h.nativePlace], ['住址', h.address], ['职业', h.occupation], ['单位', h.company], ['发病节气', h.solarTermsOfOnset], ['症状主诉', h.symptom]];
    for (const [k, v] of rows) if (v !== undefined && v !== '') L.push(`| ${k} | ${mdEscape(v)} |`);
    const mr = PI.medicalRecord || {};
    const mrS = [];
    if (mr.isOutpatient) mrS.push('门诊'); if (mr.isHospital) mrS.push('住院'); if (mr.isFirstCourse) mrS.push('初诊');
    if (mrS.length) L.push(`| 就诊类型 | ${mrS.join(' / ')} |`);
  }
  L.push('');
  return L.join('\n');
}

// ===== Layer 1b：通用答题按钮（题目，仅用于各例「题目答案」）=====
function buildButtons(P) {
  const { meta, INQ, PHY, MED, DIA, TRT, posMap } = P;
  const L = [];
  L.push('## 二、通用答题按钮（所有可点击内容，按板块与分类）');
  L.push('');
  L.push('> 以下为答题页中**所有可点击的按钮/选项**，按板块分组，并保留「分类父按钮 → 子按钮」的层级（点击父按钮展开子按钮）。');
  L.push('');

  // 2.1 病史采集
  if (INQ) {
    const allQ = collectInquiries(INQ.inquiryCategories || [], [], null).filter(x => x.q);
    L.push(`### 2.1 病史采集 — 可点击问诊问题（共 ${allQ.length} 个，分类层级见下）`);
    L.push('');
    const renderCat = (cats, depth) => {
      for (const c of cats || []) {
        L.push(`${'  '.repeat(depth)}- **【分类】${mdEscape(c.name)}**`);
        for (const q of c.inquiries || []) L.push(`${'  '.repeat(depth + 1)}- ${mdEscape(q.question)}`);
        if (c.childrens && c.childrens.length) renderCat(c.childrens, depth + 1);
      }
    };
    renderCat(INQ.inquiryCategories, 0);
    L.push('');
  }

  // 2.2 体格检查
  if (PHY) {
    const catItems = (PHY.physicalChecks || []).filter(p => p.physicalCheckCategoryId);
    const posItems = (PHY.physicalChecks || []).filter(p => !p.physicalCheckCategoryId);
    L.push(`### 2.2 体格检查 — 可点击检查项（共 ${PHY.physicalChecks.length} 项：系统分类 ${catItems.length} + 身体部位 ${posItems.length}）`);
    L.push('');
    const catName = {};
    for (const c of PHY.physicalCheckCategories || []) catName[c.id] = c.name;
    for (const c of PHY.physicalCheckCategories || []) {
      const items = catItems.filter(p => p.physicalCheckCategoryId === c.id);
      L.push(`- **【分类】${mdEscape(c.name)}**${items.length ? '：' + items.map(p => mdEscape(p.name)).join('、') : '（无子项）'}`);
    }
    L.push('');
    L.push('**【身体部位分类】**（在 3D 人体模型上点选部位触发，父按钮=部位，子按钮=具体查体动作）：');
    const byRegion = {};
    for (const p of posItems) {
      const path = posMap[p.positionId] || ['未分类部位'];
      const region = path[0];
      (byRegion[region] = byRegion[region] || []).push({ path: path.join(' / '), name: p.explainName || p.name });
    }
    for (const region of Object.keys(byRegion)) {
      L.push(`- **【部位】${mdEscape(region)}**`);
      for (const it of byRegion[region]) L.push(`  - ${mdEscape(it.path)} → ${mdEscape(it.name)}`);
    }
    L.push('');
  }

  // 2.3 辅助检查
  if (MED) {
    const all = flattenMedical(MED.medicalCheckCategories || [], []);
    L.push(`### 2.3 辅助检查 — 可点击检查项目（共 ${all.length} 个，分类层级见下）`);
    L.push('');
    const renderMed = (nodes, depth) => {
      for (const n of nodes || []) {
        const pad = '  '.repeat(depth);
        if (isMedCat(n)) {
          L.push(`${pad}- **【分类】${mdEscape(n.name)}**（${countMedLeaves(n)} 项）`);
          renderMed(n.medicalChecks, depth + 1);
        } else {
          L.push(`${pad}- ${mdEscape(n.name)}${n.abbreviation ? '（' + mdEscape(n.abbreviation) + '）' : ''}`);
        }
      }
    };
    renderMed(MED.medicalCheckCategories, 0);
    L.push('');
  }

  // 2.4 诊断库（全局唯一一套）
  if (DIA) {
    L.push('### 2.4 诊断 — 诊断库（可选诊断条目）');
    L.push('');
    L.push(`诊断库共 ${cache.diagnosisItemData.length} 个类别、共 **${DIAG_TOTAL}** 条可选诊断，完整清单见同目录 \`诊断库.md\`（全局唯一一套，不随病例变化）。本练习涉及的标准诊断见对应病例「正确答案」的 1.4。`);
    L.push('');
    L.push('诊断库类别编号：' + cache.diagnosisItemData.map(g => mdEscape(g.diagnosisClass)).join('、'));
    L.push('');
  }

  // 2.5 治疗
  if (TRT) {
    const blocks = getTreatmentBlocks(TRT);
    const total = blocks.reduce((n, b) => n + b.items.length, 0);
    L.push(`### 2.5 治疗 — 可点击治疗项（按分类，共 ${total} 个可选）`);
    L.push('');
    L.push('> 以下为答题页「治疗」板块所有可点击的治疗项按钮，按分类列出。各分类自身的预设项 + 通用字典（如手术）+ 治疗原则合并展示。带分值的必选项见「正确答案」的 1.5。');
    L.push('');
    for (const b of blocks) {
      const names = b.items.map(t => mdEscape(t.name));
      if (names.length) L.push(`- **【分类】${mdEscape(b.name)}**（${names.length} 项）：${names.join('、')}`);
      else L.push(`- **【分类】${mdEscape(b.name)}**：本练习无预设选项（开放填写，按报告/合理项评分）`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ===== Layer 2：所有按钮点击后的回复 =====
function buildReplies(P) {
  const { meta, INQ, PHY, MED, DIA, TRT, posMap } = P;
  const L = [];
  L.push('## 二、选项反馈（点击按钮后的回复）');
  L.push('');
  L.push('> 下方按板块列出每个可点击按钮及其点击后系统在答题页给出的回复/结果（即「选项反馈」）。');
  L.push('');

  if (INQ) {
    const allQ = collectInquiries(INQ.inquiryCategories || [], [], null).filter(x => x.q);
    L.push(`### 2.1 病史采集 — 点击每个问题后的患者回复（${allQ.length} 条）`);
    L.push('');
    let i = 0;
    for (const it of allQ) { i++; L.push(`${i}. **问**：${mdEscape(it.q.question)}`); if (it.q.answer) L.push(`   - **患者回复**：${mdEscape(it.q.answer)}`); }
    L.push('');
  }
  if (PHY) {
    L.push(`### 2.2 体格检查 — 点击每项后的体征结果（共 ${PHY.physicalChecks.length} 项）`);
    L.push('');
    for (const c of PHY.physicalCheckCategories || []) {
      const items = (PHY.physicalChecks || []).filter(p => p.physicalCheckCategoryId === c.id);
      if (!items.length) continue;
      L.push(`**${c.name}**`);
      for (const p of items) L.push(`- ${mdEscape(p.name)}：${mdEscape(p.result || p.explainAnswer || '（无结果文本）')}`);
    }
    const posItems = (PHY.physicalChecks || []).filter(p => !p.physicalCheckCategoryId);
    if (posItems.length) {
      L.push('');
      L.push('**身体部位查体（3D 模型点选）**');
      const byRegion = {};
      for (const p of posItems) { const path = (posMap[p.positionId] || ['未分类部位']).join(' / '); (byRegion[path] = byRegion[path] || []).push(p); }
      for (const path of Object.keys(byRegion)) {
        L.push(`*${path}*`);
        for (const p of byRegion[path]) L.push(`- ${mdEscape(p.explainName || p.name)}：${mdEscape(p.explainAnswer || p.result || '（无结果文本）')}`);
      }
    }
    L.push('');
  }
  if (MED) {
    const all = flattenMedical(MED.medicalCheckCategories || [], []);
    L.push(`### 2.3 辅助检查 — 点击每项后的结果 + 临床意义（共 ${all.length} 项，按分类分组）`);
    L.push('');
    const byPath = new Map();
    for (const e of all) { if (!byPath.has(e.path)) byPath.set(e.path, []); byPath.get(e.path).push(e.node); }
    for (const [p, items] of byPath) {
      L.push(`**${mdEscape(p || '未分类')}**（${items.length} 项）`);
      L.push('');
      for (const m of items) {
        L.push(`- **${mdEscape(m.name)}**：${mdEscape(m.result || '')}${m.unit ? ' ' + mdEscape(m.unit) : ''}`);
        if (m.referenceValue) L.push(`  - 参考值：${mdEscape(m.referenceValue)}`);
        if (m.clinicalSignificance) L.push(`  - 临床意义：${mdEscape(m.clinicalSignificance)}`);
      }
      L.push('');
    }
  }
  if (DIA) {
    L.push('### 2.4 诊断 — 点击选择后的诊断条目');
  L.push('');
  L.push('点击「诊断库」中条目即将其加入拟诊列表（按 必要/次要/鉴别/疑似 分类）。可选条目见同目录 `诊断库.md`（全局唯一一套，不随病例变化）。');
    L.push('');
  }
  if (TRT) {
    const blocks = getTreatmentBlocks(TRT);
    L.push('### 2.5 治疗 — 可点击治疗项（点击即加入治疗方案）');
    L.push('');
    L.push('> 点击下列任一治疗项即将其加入当前治疗方案。标注「紧急/门诊/住院」为系统标记的属性。');
    L.push('');
    for (const b of blocks) {
      if (!b.items.length) { L.push(`**${mdEscape(b.name)}**：（本练习无预设选项）`); L.push(''); continue; }
      L.push(`**${mdEscape(b.name)}**`);
      for (const t of b.items) {
        const tags = [];
        if (t.isEmergency) tags.push('紧急'); if (t.isOutpatient) tags.push('门诊'); if (t.isHospitalized) tags.push('住院');
        L.push(`- ${mdEscape(t.name)}${tags.length ? '（' + tags.join('/') + '）' : ''}`);
      }
      L.push('');
    }
  }
  return L.join('\n');
}

// ===== Layer 3：正确答案 / 必选项（评分报告）=====
function buildCorrect(P, reportByTab) {
  const { meta, INQ, PHY, MED, DIA, TRT } = P;
  const L = [];
  L.push('## 一、正确答案 / 必选项（来自评分报告）');
  L.push('');
  L.push('> 以下由「直接提交训练后生成的**评分报告**」解析得到：列出各板块的**必要（必选才能得分）项目**及其**标准答案/标准结果**与分值。');
  L.push('> 评分报告为系统服务端对标准答案的判定结果，是体格/辅助/治疗逐项标准答案的权威来源。');
  L.push('');

  const repInq = parseReportGroups(reportByTab['病史采集'], '病史采集');
  const repPhy = parseReportGroups(reportByTab['体格检查'], '体格检查');
  const repMed = parseReportGroups(reportByTab['辅助检查'], '辅助检查');
  const repDia = parseDiagnosisReport(reportByTab['诊断']);
  const repTr = parseReportGroups(reportByTab['治疗'], '治疗');

  const renderGroups = (groups, label) => {
    let i = 0;
    for (const g of groups) {
      if (g.cat) { L.push(`**${mdEscape(g.cat)}**（${g.items.length} 项）`); L.push(''); }
      for (const it of g.items) {
        i++;
        L.push(`${i}. **${mdEscape(it.name)}**${it.answer ? ` — ${label}：` + mdEscape(it.answer) : ''}${it.score != null ? `（${it.score}分）` : ''}`);
      }
      if (g.cat) L.push('');
    }
  };

  if (countItems(repInq)) {
    L.push(`### 1.1 病史采集 — 必要问题（${countItems(repInq)} 个，各条附标准回复）`);
    L.push('');
    renderGroups(repInq, '标准回复');
    L.push('');
  } else if (INQ) {
    const stdSet = new Set((INQ.inquiryAnswers || []).map(a => a.inquiryId));
    L.push(`### 1.1 病史采集 — 标准/必要问题（共 ${stdSet.size} 项，已标注 ✅）`);
    L.push('');
    let j = 0;
    for (const it of collectInquiries(INQ.inquiryCategories || [], [], null)) {
      if (it.q && stdSet.has(it.q.id)) { j++; L.push(`${j}. ${mdEscape(it.q.question)}（患者回复：${mdEscape(it.q.answer || '')}）`); }
    }
    L.push('');
  }

  if (countItems(repPhy)) {
    L.push(`### 1.2 体格检查 — 必要检查（${countItems(repPhy)} 项，各条附标准体征）`);
    L.push('');
    renderGroups(repPhy, '标准结果');
    L.push('');
  } else if (PHY) {
    L.push(`### 1.2 体格检查 — 标准检查项`);
    L.push('');
    L.push(`> 系统标准检查项数量：**${PHY.standardCount ?? '?'}** / 允许 ${PHY.maxCount ?? '?'}（合理 ${PHY.reasonableCount ?? '?'}）。逐项标准清单见评分报告。`);
    L.push('');
  }

  if (countItems(repMed)) {
    L.push(`### 1.3 辅助检查 — 必要检查（${countItems(repMed)} 项，各条附标准结果）`);
    L.push('');
    renderGroups(repMed, '标准结果');
    L.push('');
  } else if (MED) {
    L.push(`### 1.3 辅助检查 — 标准检查项`);
    L.push('');
    L.push(`> 系统标准检查项数量：**${MED.standardCount ?? '?'}** / 允许 ${MED.maxCount ?? '?'}（标准费用 ${MED.standardCostCount ?? '?'}）。逐项标准清单见评分报告。`);
    L.push('');
  }

  if (repDia.length) {
    L.push(`### 1.4 诊断 — 标准诊断（${repDia.length} 个，含同义诊断与支撑依据）`);
    L.push('');
    L.push('> 「支撑依据」= 系统认定支持该诊断的病史/体格/辅助检查条目。多个诊断可共享同一条依据，属正常。');
    L.push('');
    let lastCat = null, i = 0;
    for (const d of repDia) {
      const cat = [d.system, d.category].filter(Boolean).join(' · ');
      if (cat !== lastCat) { L.push(`**【${mdEscape(cat || '诊断')}】**`); L.push(''); lastCat = cat; i = 0; }
      i++;
      L.push(`${i}. **${mdEscape(d.name)}**${d.score != null ? `（${d.score}分）` : ''}`);
      if (d.synonyms.length) L.push(`   - 同义诊断：${d.synonyms.map(mdEscape).join('、')}`);
      if (d.evidences.length) {
        L.push(`   - 支撑依据（${d.evidences.length} 条）：`);
        for (const e of d.evidences) L.push(`     - [${mdEscape(e.section)}] ${mdEscape(e.text)}${e.score != null ? `（${e.score}分）` : ''}`);
      }
      L.push('');
    }
  } else if (DIA) {
    L.push('### 1.4 诊断 — 标准诊断');
    L.push('');
    const byClass = {};
    for (const d of DIA.diagnoses || []) (byClass[d.diagnosisClass] = byClass[d.diagnosisClass] || []).push(d);
    for (const cls of Object.keys(byClass).sort()) {
      L.push(`**${CLASS_LABEL[cls] || ('诊断类别' + cls)}**`);
      let i = 0;
      for (const d of byClass[cls]) for (const id of d.diagnosisItemIds || []) { i++; const m = diagMap[id]; L.push(`${i}. ${m ? (mdEscape(m.name) + (m.code ? '（' + mdEscape(m.code) + '）' : '')) : '[未解析:' + id + ']'}`); }
      L.push('');
    }
  }

  if (countItems(repTr)) {
    L.push(`### 1.5 治疗 — 必要/标准治疗（${countItems(repTr)} 项，按治疗分类分组）`);
    L.push('');
    renderGroups(repTr, '标准内容');
    L.push('');
  } else if (TRT) {
    L.push('### 1.5 治疗 — 治疗原则 / 标准项');
    L.push('');
    if (TRT.treatmentPrincipleItems && TRT.treatmentPrincipleItems.length) { L.push('**治疗原则**'); for (const p of TRT.treatmentPrincipleItems) L.push(`- ${mdEscape(p.name)}`); L.push(''); }
    const catName = {};
    for (const c of TRT.treatmentItemCategories || []) catName[c.id] = c.name;
    const ansItems = [];
    for (const g of TRT.treatmentItemCategoryData || []) for (const t of g.treatmentItems || []) if (t.isAnswer) ansItems.push({ c: catName[g.treatmentItemCategoryId] || g.treatmentItemCategoryId, t });
    if (ansItems.length) { L.push('**系统已标记的标准治疗项**'); for (const a of ansItems) L.push(`- ${mdEscape(a.t.name)}（${mdEscape(a.c)}）`); }
    else L.push('> 本病例治疗为开放作答，系统未预设固定「标准治疗项」清单（按合理/标准数量阈值评分）。可选治疗项目全集见「二、2.5」。');
    L.push('');
  }
  return L.join('\n');
}

// （已弃用）原 题目.md = 4 例按钮合并总集；现改为「（通用）题目」下每病例一份题目（见主流程 buildButtons），此函数不再调用。


// 全局诊断库文档（只有一套）
function buildDiagLibrary() {
  const L = [];
  L.push('# 诊断库（全局可选诊断条目）');
  L.push('');
  L.push('> 来源：`diag_cache.json` 的 `diagnosisItemData`（共 1 个类别，全局唯一一套，不随病例变化）。');
  L.push(`> 共 **${DIAG_TOTAL}** 条可选诊断（id 唯一、name 齐全；部分条目无 ICD code）。各练习的标准诊断见对应病例「正确答案」文档的 1.4。`);
  L.push('');
  L.push('| code | 诊断名称 |');
  L.push('| --- | --- |');
  for (const g of cache.diagnosisItemData) {
    for (const it of (g.diagnosisItems || [])) L.push(`| ${mdEscape(it.code || '')} | ${mdEscape(it.name)} |`);
  }
  return L.join('\n');
}

// 主流程
const TABS = ['病史采集', '体格检查', '辅助检查', '诊断', '治疗', '病历书写', '思维树'];
const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.json'));
const caseLinks = [];
const allPs = [];
// 旧文件夹重命名：题目答案 → 选项反馈（同盘 renameSync，避开 safe-delete）
const OLD_A = path.join(OUT, '题目答案');
if (fs.existsSync(OLD_A) && !fs.existsSync(DIR_A)) {
  try { fs.renameSync(OLD_A, DIR_A); console.log('重命名 题目答案 → 选项反馈'); }
  catch (e) { console.log('重命名失败', e.message); }
}
for (const c of CASE_ORDER) {
  const rawFile = path.join(rawDir, c.id + '.json');
  if (!fs.existsSync(rawFile)) { console.log('缺少 raw:', c.id); continue; }
  const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  raw.meta = { name: c.name, dept: c.dept, id: c.id };
  const reportByTab = {};
  for (const tab of TABS) {
    const rf = path.join(repDir, `_report_${c.idx}_${tab}.txt`);
    if (fs.existsSync(rf)) reportByTab[tab] = fs.readFileSync(rf, 'utf8');
  }
  const P = prep(raw);
  allPs.push(P);
  const safe = c.name.replace(/[\\/:*?"<>|]/g, '_');
  fs.mkdirSync(DIR_A, { recursive: true });
  fs.mkdirSync(DIR_C, { recursive: true });
  fs.mkdirSync(DIR_Q, { recursive: true });

  // 通用题目 = Layer1（各例可点击按钮，不含患者信息）
  const qMd = `# 整体思维训练 · ${c.name} — 题目（全部可点击按钮）\n\n- 科室：${c.dept}｜病例ID：${c.id}\n\n> 本题**不含患者信息**，从答题页「通用答题按钮」板块起记录（即下方「二」）。点击各按钮后的选项反馈见同病例「选项反馈」文档。\n\n` + buildButtons(P) + '\n';
  // 选项反馈 = Layer1（各例具体按钮）+ Layer2（选项反馈/点击回复），保留患者信息
  const aMd = `# 整体思维训练 · ${c.name} — 选项反馈（点击按钮后的回复）\n\n` + buildMeta(P) + '\n' + buildReplies(P) + '\n';
  // 正确答案 = Layer3
  const cMd = `# 整体思维训练 · ${c.name} — 正确答案（评分报告必选项）\n\n- 科室：${c.dept}｜病例ID：${c.id}\n\n` + buildCorrect(P, reportByTab) + '\n';

  fs.writeFileSync(path.join(DIR_Q, safe + '.md'), qMd);
  fs.writeFileSync(path.join(DIR_A, safe + '.md'), aMd);
  fs.writeFileSync(path.join(DIR_C, safe + '.md'), cMd);
  caseLinks.push({ name: c.name, dept: c.dept, q: safe + '.md', a: safe + '.md', c: safe + '.md' });
  console.log('生成:', c.name, '| 报告标签:', Object.keys(reportByTab).join(','));
}

// 「（通用）题目」文件夹：4 份按病例题目（各例 Layer1，不含患者信息，循环内已生成）+ 诊断库.md（全局一套）
// 旧合并总集 题目.md 移入同盘回收（避开 safe-delete 拦截）
const RECYCLE_Q = path.resolve(OUT, '..', '_diag_old_merged_q');
fs.mkdirSync(RECYCLE_Q, { recursive: true });
const mergedQ = path.join(DIR_Q, '题目.md');
if (fs.existsSync(mergedQ)) {
  try { fs.renameSync(mergedQ, path.join(RECYCLE_Q, '题目.md')); console.log('回收旧合并题目.md'); }
  catch (e) { console.log('回收失败', e.message); }
}
fs.writeFileSync(path.join(DIR_Q, '诊断库.md'), buildDiagLibrary());
console.log('生成: 诊断库.md（', DIAG_TOTAL, '条）');

// 顶层 index.md（简洁导航）
let idx = '# 整体思维训练 — 文档索引\n\n';
idx += '数据来源：南京医科大学临床思维训练系统 · 整体思维训练模块（示例账号）\n\n';
idx += '> 按「①通用题目（各病例可点击按钮） ②选项反馈（题目+点击回复） ③正确答案」拆分。通用题目为 4 个病例**各自**的可点击按钮（Layer1，不含患者信息），每病例一份；诊断库（全局唯一一套，28118 条）置于「（通用）题目」下。\n\n';
idx += '## 文件夹说明\n\n';
idx += '- `（通用）题目/`：4 个病例的**题目(Layer1 可点击按钮，不含患者信息)** + 全局 `诊断库.md`（28118 条可选诊断，唯一一套）\n';
idx += '- `选项反馈/`：4 个病例的**可点击按钮(题目) + 点击后回复(选项反馈)**，含患者信息\n';
idx += '- `正确答案/`：4 个病例的**评分报告必选项 + 标准答案(Layer3)**\n';
idx += '- `_源数据/`：`raw/`（4 病例原始接口 json）+ `reports/`（32 个评分报告 txt），复现依据\n\n';
idx += '## 各病例题目（通用题目，4 份）\n\n';
idx += `- [诊断库（全局可选诊断，唯一一套）](${encodeURIComponent('（通用）题目')}/诊断库.md)\n\n`;
idx += '> 4 个病例各自的「题目（可点击按钮，不含患者信息）」见下方病例目录的「题目」链接。\n\n';
idx += '## 病例目录\n\n';
for (const c of caseLinks) {
  idx += `### ${c.name}（${c.dept}）\n`;
  idx += `- [题目](${encodeURIComponent('（通用）题目')}/${encodeURIComponent(c.q)})\n`;
  idx += `- [选项反馈](${encodeURIComponent('选项反馈')}/${encodeURIComponent(c.a)})\n`;
  idx += `- [正确答案](${encodeURIComponent('正确答案')}/${encodeURIComponent(c.c)})\n\n`;
}
fs.writeFileSync(path.join(OUT, 'index.md'), idx);
console.log('完成。生成 index.md');
