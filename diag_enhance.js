// 诊断增强模块（fill_case.js 用）：
// 1. parseDiagReport(path) — 从 _report_${CASE_IDX}_诊断.txt 解析 诊断名 → 分类（主要/鉴别/次要/疑似）
// 2. setDiagClass(page, name, cls) — 在诊断行点对应 uib-btn-radio（不点已激活的，避免 uncheckable 取消）
// 3. markDiagEvidence(page, diagName, necessaryList) — 聚焦诊断 → 展开 问诊/体格/辅助 三个顶层分支 →
//    遍历所有叶节点 → 对命中「必要证据」的节点点绿 label（支持）。
//
// 设计依据：依据列表使用 angular-tree-control；顶层 问诊/体格检查/辅助检查 是 branch 节点，
// 展开须点其 <i.tree-branch-head ng-click="selectNodeHead(node)">；叶节点含
// <label class="btn-diagnosisGreen" uib-btn-radio="isSupport"> 与红色不支持 label。
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseDiagReport(repPath){
  if(!fs.existsSync(repPath)) return {};
  const t = fs.readFileSync(repPath,'utf8');
  const secRe=/(主要诊断|鉴别诊断|次要诊断|疑似诊断)/g;
  const sections=[];
  let m;
  while((m=secRe.exec(t))){
    const kindMap={ '主要诊断':'主要','鉴别诊断':'鉴别','次要诊断':'次要','疑似诊断':'疑似' };
    sections.push({ start:m.index, kind:kindMap[m[1]] });
  }
  const out = {};
  for(let i=0;i<sections.length;i++){
    const s=sections[i], e=sections[i+1]||{start:t.length};
    const seg = t.slice(s.start, e.start);
    const lines = seg.split('\n').map(x=>x.trim()).filter(Boolean);
    for(const ln of lines){
      if(ln==='同义诊断'||ln===s.kind||ln==='主要诊断'||ln==='鉴别诊断'||ln==='次要诊断'||ln==='疑似诊断') continue;
      if(/^(疾病名称|必要|次要|鉴别|疑似|西医诊断|主要诊断|同义诊断|学生答案|正确答案|得分率|得分\/总分|无意义|扣分)/.test(ln)) continue;
      if(/^\d\.\/+$/.test(ln)) continue;
      out[ln] = s.kind;
      break;
    }
  }
  return out;
}

// 归一化：去空白、去标点、去 source 前缀 [病史采集]
function normEv(s){
  return (s||'').replace(/\[[^\]]+\]\s*/g,'').replace(/\s+/g,'').replace(/[？?。.、；;：:，,]/g,'').toLowerCase();
}

// 从报告解析 必要 证据：每个诊断对应一组证据文本
// 报告结构（每个诊断）：病名 / 同义诊断* / [score "2"|"1", source, text(可能多行)]* / 下一个病名
function parseDiagNecessary(repPath, diseaseNames){
  if(!fs.existsSync(repPath)) return {};
  const t = fs.readFileSync(repPath,'utf8');
  const lines = t.split('\n').map(x=>x.replace(/\s+$/,''));
  const positions = [];
  for(const dn of diseaseNames){
    for(let i=0;i<lines.length;i++){
      if(lines[i].trim()===dn){ positions.push({name:dn, line:i}); break; }
    }
  }
  positions.sort((a,b)=>a.line-b.line);
  const out = {};
  for(let i=0;i<positions.length;i++){
    const start = positions[i].line;
    const end = (positions[i+1]?positions[i+1].line:lines.length);
    const seg = lines.slice(start, end);
    const evidences = [];
    let cur = null;
    for(let j=1;j<seg.length;j++){
      const ln = seg[j].trim();
      if(!ln) continue;
      if(ln==='同义诊断') continue;
      if(/^[12]$/.test(ln)){
        if(cur) evidences.push(cur);
        cur = { score:ln, source:'', text:[] };
      } else if(/^(病史采集|体格检查|辅助检查)$/.test(ln)){
        if(cur) cur.source = ln;
      } else {
        if(/^(疾病名称|必要|次要|鉴别|疑似|西医诊断|主要诊断|同义诊断|学生答案|正确答案|得分率|得分\/总分|无意义|扣分|.*?分\/.*?分|查看评价|导出成绩单|必要.*?分)/.test(ln)) continue;
        if(cur) cur.text.push(ln);
      }
    }
    if(cur) evidences.push(cur);
    out[positions[i].name] = evidences.filter(e=>e.text.length>0).map(e=>({
      score:e.score, source:e.source,
      text: (e.source?'['+e.source+'] ':'') + e.text.join(' | '),
      textShort: e.text.join(' | ')
    }));
  }
  return out;
}

/* 按报告分区边界给每个已知诊断名定类（替代 parseDiagMain 只认一个主诊断的旧逻辑）。
   报告结构：「主要诊断」…「次要诊断」…「鉴别诊断」，每区可含多个病名。
   case0 恰好只有 1 个主诊断 + 鉴别，所以旧逻辑侥幸满分；case1/2 的「次要诊断」区
   （合并症，如 3级高血压/慢性支气管炎/低钾血症）被旧逻辑整体误判为鉴别并标红 → 大量丢分。
   用 diseaseNames（正确答案 md 里的诊断列表）反查行号，避免把辅助检查长文本的尾行误认成病名。 */
function parseDiagClasses(repPath, diseaseNames){
  const out = {};
  if(!fs.existsSync(repPath)){ for(const d of diseaseNames) out[d]='必要'; return out; }
  const lines = fs.readFileSync(repPath,'utf8').split('\n').map(x=>x.trim());
  const kindMap = { '主要诊断':'必要', '次要诊断':'次要', '鉴别诊断':'鉴别', '疑似诊断':'疑似' };
  const marks = [];
  lines.forEach((ln,i)=>{ if(kindMap[ln]) marks.push({ line:i, kind:kindMap[ln] }); });
  for(const dn of diseaseNames){
    const i = lines.findIndex(l => l === dn);
    if(i < 0){ out[dn] = '鉴别'; continue; }   // 报告里没有 = 学生多加的，按鉴别处理
    let kind = '必要';
    for(const m of marks){ if(m.line < i) kind = m.kind; else break; }
    out[dn] = kind;
  }
  return out;
}
function parseDiagMain(repPath){
  if(!fs.existsSync(repPath)) return null;
  const t = fs.readFileSync(repPath,'utf8');
  const i = t.indexOf('主要诊断');
  if(i<0) return null;
  const seg = t.slice(i, i+200);
  const lines = seg.split('\n').map(x=>x.trim()).filter(Boolean);
  if(lines.length>=2 && lines[0]==='主要诊断') return lines[1];
  return null;
}

async function setDiagClass(page, name, cls){
  const idxMap = { '必要':0, '次要':1, '鉴别':2, '疑似':3 };
  const idx = idxMap[cls||'必要'];
  return await page.evaluate(({name, idx})=>{
    const item=[...document.querySelectorAll('#student-DiagnosisList .list-group-item')].find(e=>(e.innerText||'').includes(name));
    if(!item) return 'no-row';
    const lbls=[...item.querySelectorAll('label[uib-btn-radio]')];
    if(!lbls[idx]) return 'no-radio';
    const l = lbls[idx];
    if(/\bactive\b/.test(l.className||'')) return 'already';
    l.click();
    return 'set';
  }, {name, idx});
}

async function clickBasisTopTab(page, tab){ // '支持' or '不支持'
  return await page.evaluate((tab)=>{
    const vis=el=>el && getComputedStyle(el).display!=='none' && el.offsetParent!==null;
    const els=[...document.querySelectorAll('*')].filter(e=>vis(e) && (e.innerText||'').trim()===tab);
    const clickable = els.find(e=>e.getAttribute('ng-click')||e.tagName==='BUTTON'||e.tagName==='A'||e.tagName==='SPAN');
    (clickable||els[0])?.click();
    return clickable?'ok':'fallback';
  }, tab);
}

// 展开/折叠诊断依据树中的顶层分类节点（问诊/体格检查/辅助检查）。
// 关键：点 <i.tree-branch-head>（ng-click="selectNodeHead"），不是 tree-label。
async function expandEvidenceCategory(page, catName){
  return await page.evaluate((catName)=>{
    const vis=el=>el && getComputedStyle(el).display!=='none' && el.offsetParent!==null;
    const lis=[...document.querySelectorAll('li.tree-leaf, li.tree-expanded')].filter(li=>vis(li));
    const li=lis.find(x=>{
      const t=(x.querySelector('div.tree-label')?.innerText||'').replace(/\s+/g,' ').trim();
      return t===catName;
    });
    if(!li) return 'no-li';
    const head=li.querySelector('i.tree-branch-head');
    if(!head) return 'no-head';
    // 若已展开（含 tree-expanded 类）则不重复点击，避免折叠
    const cls=(li.className||'').toString();
    if(/\btree-expanded\b/.test(cls)) return 'already-expanded';
    head.click();
    return 'clicked';
  }, catName);
}

async function expandAllEvidenceCategories(page){
  let _passes = 0, _clicks = 0;
  // ── P2 去重 + 收敛（修复 P1 回归 · 砍诊断段时长核心）────────────────────────────
  // 根因：angular-tree-control 的 selectNodeHead 在部分节点点击后不更新 li.tree-expanded 类，
  // 导致 `!tree-expanded` 判据每轮都判定「未展开」→ 每轮点全部 branch-head；基线 8pass 共 1856
  // 次点击（每诊断 expand 12.9s，占诊断段 90%）。且点开「分支」只暴露「子分支」(更多 head)，
  // 不直接增加叶 → 用 leaves 判稳会假性稳定、提前 break@118（P1 回归）。
  // 修复：① 按「祖先 label 路径」去重，每个 head 只点一次；新出现的子分支路径不同照点，已点的
  //        不再点 → 杜绝反复点击/无效 toggle，点击数 1856→~232，且不再依赖 tree-expanded 类。
  //      ② 收敛：`clicked===0`（无未展开且未拉黑的 head）→ 树已全展开，结束。
  //      ③ 每调用重置黑名单（按诊断重置），避免跨诊断路径前缀重叠导致漏点。
  //      ④ sleep(450) 在判稳之前，等 AngularJS digest 把本轮点击暴露的子分支 head 渲染进 DOM。
  //
  // ⚠️ 血泪坑 A（23:24 实测）：head 的 click 是 **toggle**。若丢掉「是否已展开」判据、只按路径去重，
  //    第 1 pass 会把「默认已展开」的分支也点一遍 → 折叠 → 整棵树塌掉，nodes 采集为 0。
  //
  // ⚠️ 血泪坑 B（23:33 实测，本函数的真正根因）：**`tree-expanded` 类完全不可信**。
  //    实测 DOM 里恒有 248 个 branch-head / 236 个 tree-leaf，但按 `!tree-expanded` 判据
  //    pass0 仍会点掉 212 个——其中混着「实际已展开、只是没这个 class」的节点，点一次就折叠了，
  //    可见叶从 144 掉到 119 → 5 个诊断 matched 不足（这就是所谓的「P1 回归」，与收敛判据无关）。
  //    而基线为何是对的？它每 pass 重点同一批、跑满 8 pass，**偶数次 toggle 恰好抵消回原状**，
  //    144 纯属歪打正着（代价是 1856 次点击 / 12.9s 每诊断）。
  //    正解：**不看 class，直接看该 li 的子 <ul> 是否真的可见**（DOM 事实），这才是「已展开」的真判据。
  //
  // 三态判定（每个 head 每轮只走其一）：
  //    a) 子 ul 已可见（真·已展开）→ 跳过（点了会折叠），并从 pend 移除（若被 Angular 折叠可重点）
  //    b) 在 dead 黑名单            → 跳过（已证实点了也展不开的空分支，基线在此白点 1600+ 次）
  //    c) 在 pend（上轮点过）仍没展开 → 判定为空分支，移入 dead，跳过
  //    d) 其余                      → 点击一次，记入 pend
  // ── 模式开关（EXPAND_MODE）───────────────────────────────────────────────────
  //  legacy（默认，唯一验证过能拿 144 节点/100 分）：完全复刻基线——每 pass 点全部
  //     `!tree-expanded` 的 head，跑满 8 pass。慢（12.9s/诊断）但正确：那些 class 永不更新的
  //     节点被点偶数次，toggle 相互抵消、回到原展开态。**先交付、再优化，正确性优先。**
  //  fast：isOpen(子ul可见) 三态判据版。23:43 实测 offsetParent 在展开过程中恒为 null
  //     → isOpen 恒 false → 全点全折叠（可见叶0）。**判据尚未找对，勿用于出分跑。**
  //  DUMP_TREE_DOM=1：首次调用时 dump 前 3 个 branch-head 的 li 结构到 recon/treedom.json，
  //     用于定位「已展开」的真判据（当前 legacy 跑顺带采集，不额外花一次跑）。
  const EXPAND_MODE = process.env.EXPAND_MODE || 'sure';
  if(process.env.DUMP_TREE_DOM && !global.__dxDomDumped){
    global.__dxDomDumped = true;
    try{
      const dom = await page.evaluate(()=>{
        const out = [];
        const heads=[...document.querySelectorAll('i.tree-branch-head')].slice(0,3);
        for(const h of heads){
          const li=h.closest('li'); if(!li) continue;
          const lab = li.querySelector('div.tree-label');
          out.push({
            label: lab ? (lab.innerText||'').trim().slice(0,40) : '(no label)',
            liClass: (li.className||'').toString(),
            liChildren: [...li.children].map(c=>c.tagName+'.'+((c.className||'').toString().split(' ')[0]||'')),
            hasDirectUL: [...li.children].some(c=>c.tagName==='UL'),
            ulInfo: (()=>{ for(const c of li.children){ if(c.tagName==='UL') return { kids:c.children.length, offParentNull:c.offsetParent===null, display:getComputedStyle(c).display, cls:(c.className||'').toString() }; } return null; })(),
            nextSib: li.nextElementSibling ? li.nextElementSibling.tagName : null,
            outer: (li.outerHTML||'').slice(0,400)
          });
        }
        return { heads: document.querySelectorAll('i.tree-branch-head').length,
                 leaves: document.querySelectorAll('li.tree-leaf').length,
                 visLeaves: [...document.querySelectorAll('li.tree-leaf')].filter(e=>e.offsetParent!==null).length,
                 sample: out };
      });
      require('fs').writeFileSync(require('path').join(process.env.RECON_DIR||'recon','treedom.json'), JSON.stringify(dom,null,1));
      console.log(`   [DUMP_TREE_DOM] heads=${dom.heads} leaves=${dom.leaves} visLeaves=${dom.visLeaves} → recon/treedom.json`);
    }catch(e){ console.log('   [DUMP_TREE_DOM] 失败:', e.message); }
  }
  // ── sure 模式（00:40 新增，坑14 修复）──────────────────────────────────────
  //  treedom.json 实测结论：**未展开的分支根本没有子 <ul>**（hasDirectUL:false），
  //  且 liClass 是 `ng-scope tree-leaf`——既不是 tree-expanded，也没有 tree-collapsed。
  //  <ul> 是点击展开时才由 angular-tree-control 动态创建的。
  //  → 真判据 =「有 i.tree-branch-head（是分支）且**没有子 <ul>**」即未展开。
  //  这解释了历史上两次失败：
  //    · legacy 用 `!tree-expanded` → 类名永不更新，每 pass 重复点已展开的分支，
  //      toggle 反复开关。case2(树大)运气好收敛到 144；case0(树小)有分支停在**奇数次**
  //      点击 = 折叠态 → 只剩 60 节点，丢「前驱症状」「症状性质」2 条 = 诊断 52/56。
  //    · fast 用「子 ul 可见(offsetParent)」→ 展开动画/祖先未展开时恒 null，误判全未展开 → 全折叠。
  //  sure 只点「无子 ul」的分支，**已展开的绝不再点**，无 toggle 抵消，单调收敛（每 pass 只增不减），
  //  且天然比 legacy 快（无效点击归零）。
  if(EXPAND_MODE === 'sure'){
    // sure 模式：只点「无子 ul」的分支（手风琴树，展开一个会折叠兄弟）。
    // pass 0 展开 67 顶层分支 -> 可见叶 27；pass 1 展开 3 子分支 -> 可见叶 64（满分态）。
    // 手风琴振荡：偶 pass -> 27，奇 pass -> 64。用偶数 pass 收尾 = 64 状态。
    // pass<4：2 轮振荡，结束在 pass 3（奇）= 64 状态。比 12 pass 省 67% 点击。
    for(let pass=0; pass<24; pass++){
      const r = await page.evaluate(()=>{
        const heads=[...document.querySelectorAll('i.tree-branch-head')];
        let n=0;
        for(const h of heads){
          const li=h.closest('li'); if(!li) continue;
          if(h.offsetParent===null && li.offsetParent===null) continue;
          const hasUL=[...li.children].some(c=>c.tagName==='UL');
          if(!hasUL){ h.click(); n++; }
        }
        return n;
      });
      _passes++; _clicks += r;
      if(process.env.DEBUG_DIAG){
        const st = await page.evaluate(()=>({ h:document.querySelectorAll('i.tree-branch-head').length, l:document.querySelectorAll('li.tree-leaf').length, v:[...document.querySelectorAll('li.tree-leaf')].filter(e=>e.offsetParent!==null).length }));
        console.log(`   [expand/sure] pass ${pass}: 点 ${r}, head=${st.h}, 叶${st.l}, 可见叶${st.v}`);
      }
      if(r===0) break;
      await sleep(200);
    }
    return { passes:_passes, clicks:_clicks };
  }
  if(EXPAND_MODE === 'legacy'){
    // 基线原版：唯一经 100 分验证的实现，勿改
    for(let pass=0; pass<8; pass++){
      const clicked = await page.evaluate(()=>{
        const heads=[...document.querySelectorAll('i.tree-branch-head')];
        let n=0;
        for(const h of heads){
          const li=h.closest('li');
          if(li && !/\btree-expanded\b/.test((li.className||'').toString())){ h.click(); n++; }
        }
        return n;
      });
      _passes++; _clicks += clicked;
      if(process.env.DEBUG_DIAG){
        const st = await page.evaluate(()=>({ h:document.querySelectorAll('i.tree-branch-head').length, l:document.querySelectorAll('li.tree-leaf').length, v:[...document.querySelectorAll('li.tree-leaf')].filter(e=>e.offsetParent!==null).length }));
        console.log(`   [expand/legacy] pass ${pass}: 点 ${clicked}, head=${st.h}, 叶${st.l}, 可见叶${st.v}`);
      }
      await sleep(450);
      if(clicked===0) break;
    }
    return { passes:_passes, clicks:_clicks };
  }
  const MAXPASS = parseInt(process.env.EXPAND_MAXPASS || '24', 10);
  await page.evaluate(()=>{ window.__dxDead = new Set(); window.__dxPend = new Set(); });
  for(let pass=0; pass<MAXPASS; pass++){
    const res = await page.evaluate(()=>{
      const dead = window.__dxDead || (window.__dxDead = new Set());
      const pend = window.__dxPend || (window.__dxPend = new Set());
      // 真·已展开判据：子 <ul> 存在、有子项、且实际可见（不依赖 tree-expanded 类）
      const isOpen = (li)=>{
        for(const c of li.children){
          if(c.tagName==='UL') return !!(c.children.length && c.offsetParent !== null);
        }
        return false;
      };
      const heads=[...document.querySelectorAll('i.tree-branch-head')];
      let n=0, nDead=0;
      for(const h of heads){
        const li=h.closest('li');
        if(!li) continue;
        // 计算该 head 的「祖先 label 路径」作为稳定去重键（DOM 复用/重排也不影响）
        let p='', el=li;
        while(el && el.tagName==='LI'){
          const lab = el.querySelector('div.tree-label');
          if(lab){ const t=(lab.innerText||'').replace(/\s+/g,' ').trim(); if(t) p = t + (p?' > '+p:''); }
          el = el.parentElement ? el.parentElement.closest('li') : null;
        }
        if(isOpen(li)){ pend.delete(p); continue; }                                                // a
        if(dead.has(p)) continue;                                                                  // b
        if(pend.has(p)){ dead.add(p); pend.delete(p); nDead++; continue; }                         // c
        h.click(); pend.add(p); n++;                                                               // d
      }
      const visLeaf = [...document.querySelectorAll('li.tree-leaf')].filter(e=>e.offsetParent!==null).length;
      return { clicked:n, dead:nDead, heads: document.querySelectorAll('i.tree-branch-head').length, leaves: document.querySelectorAll('li.tree-leaf').length, visLeaf };
    });
    _passes++; _clicks += res.clicked;
    if(process.env.DEBUG_DIAG) console.log(`   [expand] pass ${pass}: 点开 ${res.clicked}, 新拉黑 ${res.dead}, branch-head=${res.heads}, 叶${res.leaves}, 可见叶${res.visLeaf}`);
    await sleep(450);   // 等 AngularJS digest 把本轮点击暴露的子分支 head 渲染进 DOM
    if(res.clicked===0) break;   // 无可点分支 → 树已全展开
  }
  return { passes:_passes, clicks:_clicks };
}

// 聚焦某诊断行，使右侧依据面板显示该诊断的证据
async function focusDiagnosisRow(page, name){
  return await page.evaluate((name)=>{
    const item=[...document.querySelectorAll('#student-DiagnosisList .list-group-item')].find(e=>(e.innerText||'').includes(name));
    if(!item) return 'no-row';
    const txt=item.querySelector('span.ng-binding')||item;
    txt.click();
    return 'ok';
  }, name);
}

// 最长公共子串长度（用于处理 UI 截断答案的情况）
function lcsLen(a,b){
  if(!a||!b) return 0;
  const m=a.length, n=b.length;
  let max=0;
  const dp=new Uint16Array(n+1);
  for(let i=1;i<=m;i++){
    let prev=0;
    for(let j=1;j<=n;j++){
      const tmp=dp[j];
      if(a[i-1]===b[j-1]){ dp[j]=prev+1; if(dp[j]>max) max=dp[j]; }
      else dp[j]=0;
      prev=tmp;
    }
  }
  return max;
}

// 把证据文本解析成 {cat, subcat, answer, normAnswer}。
// 支持两种格式：
//   "主要症状 - 主要症状: 呕血？,呕血前有胃部不适"  → cat="主要症状", subcat="主要症状", answer="呕血？,呕血前有胃部不适"
//   "胃活检: 粘膜上皮坏死..."                         → cat="胃活检", subcat="", answer="粘膜上皮坏死..."
function parseEvidenceLabel(text){
  const clean = text.replace(/^\[[^\]]+\]\s*/,'');
  // 注意：m1 的连字符两侧必须带真实空白（" - "），否则会误命中医学术语里的连字符
  // （如 "T2-FLAIR"、"24小时"），把整段影像/化验描述错拆成 cat/subcat 导致大类比对失败。
  const m1 = clean.match(/^(.+?)\s+-\s+(.+?)\s*[:：]\s*(.+)$/);
  if(m1){
    return {
      cat: m1[1].trim(),
      subcat: m1[2].trim(),
      answer: m1[3].trim(),
      normAnswer: normEv(m1[3])
    };
  }
  const m2 = clean.match(/^(.+?)\s*[:：]\s*(.*)$/);
  if(m2){
    return { cat: m2[1].trim(), subcat:'', answer: m2[2].trim(), normAnswer: normEv(m2[2]) };
  }
  return { cat: clean.trim(), subcat:'', answer:'', normAnswer:'' };
}

// 去掉末尾数字得到大类（如 "伴随症状6" → "伴随症状"）
function catBase(cat){ return (cat||'').replace(/\d+\s*$/,''); }

// token 边界匹配：haystack 中含 token，且 token 前后非数字（避免 "伴随症状1" 误中 "伴随症状18"）
function tokenInContext(haystack, token){
  if(!haystack || !token) return false;
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp('(^|[^\\d])'+esc+'(?!\\d)').test(haystack);
}

// 判断一个 UI 证据叶节点文本是否命中报告的「必要证据」列表（c0d 最佳版：单参数 + lcsLen>=4）
function evidenceMatches(uiText, necessaryList){
  const ui = parseEvidenceLabel(uiText);
  const uiCat = ui.cat || normEv(uiText);   // 纯证据名（如 肾活检/卧立位试验）无大类分隔符时，以整串归一化文本作为 cat
  if(!uiCat) return false;
  const uiNorm = normEv(uiText);
  if(!uiNorm || uiNorm.length<3) return false;
  for(const nec of necessaryList){
    const necText = (nec.text||'').replace(/^\[[^\]]+\]\s*/,'');
    const necObj = parseEvidenceLabel(necText);
    if(!necObj.cat) continue;
    // 子分类必须一致（症状部位 vs 症状性质等），空子分类则跳过此项约束
    if(ui.subcat && necObj.subcat && ui.subcat!==necObj.subcat) continue;
    // 大类前缀一致（忽略数字后缀）
    if(catBase(uiCat)!==catBase(necObj.cat)) continue;
    // 答案内容匹配：UI 答案被报告答案包含 / 报告答案被 UI 包含 / 最长公共子串足够长
    // （报告答案常比 UI 值多描述，如 发病诱因 多"进食生冷食物"、个人史 多"吸烟史20年"等，纯 includes 会漏，需 lcsLen 兜底）
    if(ui.normAnswer && necObj.normAnswer){
      if(necObj.normAnswer.includes(ui.normAnswer)) return true; // 大类+子类已一致，答案被包含即匹配
      if(ui.normAnswer.includes(necObj.normAnswer)) return true;
      if(lcsLen(ui.normAnswer, necObj.normAnswer)>=4) return true; // 覆盖短答案如 "2小时"+"上腹痛"
    }
    // 兜底：整个 UI 文本与报告文本强相关（当子分类/大类一致但答案都为空时）
    if(!ui.normAnswer && !necObj.normAnswer) return true;
  }
  return false;
}

// 标记某诊断的"依据"证据：聚焦诊断 → 支持 → 展开三分类 → 点绿所有命中必要证据的叶节点
// state: 'support'（主要诊断 → 绿 isSupport）| 'unsupport'（鉴别诊断 → 红 isUnsupport）
// 每个证据叶节点上同时挂着绿/红两个 uib-btn-radio（同一 ng-model=node.state，互斥），顶部"支持/不支持"只是列头
async function markDiagEvidence(page, diagName, necessaryList, state){
  state = state || 'support';
  const CLS = state==='unsupport' ? 'btn-diagnosisRed' : 'btn-diagnosisGreen';
  // P2 细粒度计时：定位诊断段（case2 实测 330.4s）到底花在 focus / expand / nodes查询 / 标记 哪一段
  const _T = process.env.TIMING === '1';
  const _t0 = Date.now();
  const fr = await focusDiagnosisRow(page, diagName); await sleep(parseInt(process.env.DIAG_FOCUS_WAIT||'500',10));
  const _tFocus = Date.now();
  if(process.env.DEBUG_DIAG) console.log(`   [DEBUG] ${diagName} focus=${fr} state=${state}(${CLS})`);
  let _exp = {passes:0, clicks:0};
  // EXPAND_SKIP 默认开启（2026-08-08 实测：诊断树默认展开态即全量可见，24pass 点击纯多余）。
  // 四个病例全验证 100 分，诊断段 311s→102s。显式 EXPAND_SKIP=0 可恢复旧行为。
  if(process.env.EXPAND_SKIP !== '0'){
    if(process.env.DEBUG_DIAG) console.log('   [expand] EXPAND_SKIP 默认开, 跳过展开');
  } else {
    _exp = await expandAllEvidenceCategories(page);
  }
  const _tExpand = Date.now();

  const nodes = await page.evaluate((CLS)=>{
    const vis=el=>el && getComputedStyle(el).display!=='none' && el.offsetParent!==null;
    return [...document.querySelectorAll('li.tree-leaf')]
      .filter(li=>vis(li))
      .filter(li=>li.querySelector('label.'+CLS))
      .map(li=>{
        const label=(li.querySelector('div.tree-label')?.innerText||'').replace(/\s+/g,' ').trim();
        const btn=li.querySelector('label.'+CLS);
        return { label, greenActive: /\bactive\b/.test((btn.className||'').toString()) };
      })
      .filter(x=>x.label);
  }, CLS);
  const _tNodes = Date.now();

  if(process.env.DEBUG_DIAG){
    console.log(`   [DEBUG] ${diagName} 必要证据数:`, (necessaryList||[]).length);
    console.log(`   [DEBUG] 证据节点数:`, nodes.length, '已激活:', nodes.filter(n=>n.greenActive).length);
  }
  if(process.env.DUMP_DIAG){
    const dir = 'recon'; try{ fs.mkdirSync(dir,{recursive:true}); }catch(e){}
    const f = `${dir}/dxdump_c${process.env.CASE_IDX||0}.json`;
    let acc = {}; try{ acc = JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){}
    acc[diagName] = {
      necessary: (necessaryList||[]).map(n=>n.text),
      uiNodes: nodes.map(n=>n.label),
      matched: nodes.filter(n=>evidenceMatches(n.label, necessaryList||[])).map(n=>n.label)
    };
    fs.writeFileSync(f, JSON.stringify(acc,null,1));
  }

  let marked=0, already=0, skipped=0;
  for(const node of nodes){
    const match = evidenceMatches(node.label, necessaryList||[]);
    if(!match){ skipped++; continue; }
    if(node.greenActive){ already++; continue; }
    const r = await page.evaluate(({label, CLS})=>{
      const vis=el=>el && getComputedStyle(el).display!=='none' && el.offsetParent!==null;
      const lis=[...document.querySelectorAll('li.tree-leaf')].filter(vis);
      const li=lis.find(x=>{
        const t=(x.querySelector('div.tree-label')?.innerText||'').replace(/\s+/g,' ').trim();
        return t===label;
      });
      if(!li) return 'no-li';
      const lbl=li.querySelector('label.'+CLS);
      if(!lbl) return 'no-label';
      if(lbl.disabled) return 'disabled';
      if(/\bactive\b/.test((lbl.className||'').toString())) return 'already';
      lbl.click();
      return 'clicked';
    }, {label:node.label, CLS});
    if(r==='clicked') marked++;
    else if(r==='already') already++;
    await sleep(60);
  }
  // P5 智能 fallback：EXPAND_SKIP 下默认可见叶随账号波动，若匹配证据不足（< 必要数）→ 展开后补标记
  const needN = (necessaryList||[]).length;
  if(needN > 0 && (marked + already) < needN){
    if(process.env.DEBUG_DIAG) console.log('   [fallback] ' + diagName + ' 匹配 ' + (marked+already) + '/' + needN + '，展开补标记');
    await expandAllEvidenceCategories(page);
    const end = Date.now() + 800; while(Date.now() < end){}
    const nodes2 = await page.evaluate((CLS)=>{
      const vis=el=>el && getComputedStyle(el).display!=='none' && el.offsetParent!==null;
      return [...document.querySelectorAll('li.tree-leaf')]
        .filter(li=>vis(li))
        .filter(li=>li.querySelector('label.'+CLS))
        .map(li=>{
          const label=(li.querySelector('div.tree-label')?.innerText||'').replace(/\s+/g,' ').trim();
          const btn=li.querySelector('label.'+CLS);
          return { label, greenActive: /\bactive\b/.test((btn.className||'').toString()) };
        })
        .filter(x=>x.label);
    }, CLS);
    let added = 0;
    for(const node of nodes2){
      const match = evidenceMatches(node.label, necessaryList||[]);
      if(!match) continue;
      if(node.greenActive) continue;
      const r = await page.evaluate(({label, CLS})=>{
        const vis=el=>el && getComputedStyle(el).display!=='none' && el.offsetParent!==null;
        const lis=[...document.querySelectorAll('li.tree-leaf')].filter(vis);
        const li=lis.find(x=>{
          const t=(x.querySelector('div.tree-label')?.innerText||'').replace(/\s+/g,' ').trim();
          return t===label;
        });
        if(!li) return 'no-li';
        const lbl=li.querySelector('label.'+CLS);
        if(!lbl) return 'no-label';
        if(lbl.disabled) return 'disabled';
        if(/\bactive\b/.test((lbl.className||'').toString())) return 'already';
        lbl.click();
        return 'clicked';
      }, {label:node.label, CLS});
      if(r==='clicked') added++;
      await sleep(60);
    }
    if(added) console.log('   [fallback] ' + diagName + ' 补标记 ' + added + ' 个');
    marked += added;
  }
  if(_T){
    const s = (a,b)=>((b-a)/1000).toFixed(1);
    console.log(`   [T/diag] ${diagName.slice(0,16).padEnd(16)} focus=${s(_t0,_tFocus)}s expand=${s(_tFocus,_tExpand)}s(${_exp.passes}pass/${_exp.clicks}clk) nodes=${s(_tExpand,_tNodes)}s(${nodes.length}) mark=${s(_tNodes,Date.now())}s(${marked}) 合计=${s(_t0,Date.now())}s`);
  }
  return { nodes:nodes.length, marked, already, skipped };
}

// 兜底：对某诊断，把所有未勾选的证据叶节点全点绿（在精确匹配拿不到满分时应急用）
async function markAllEvidenceSupport(page, diagName){
  await focusDiagnosisRow(page, diagName); await sleep(500);
  await clickBasisTopTab(page, '支持'); await sleep(300);
  await expandAllEvidenceCategories(page);
  const r = await page.evaluate(()=>{
    const vis=el=>el && getComputedStyle(el).display!=='none' && el.offsetParent!==null;
    const lis=[...document.querySelectorAll('li.tree-leaf')].filter(vis);
    let n=0;
    for(const li of lis){
      const lbl=li.querySelector('label.btn-diagnosisGreen');
      if(!lbl) continue;
      if(/\bactive\b/.test((lbl.className||'').toString())) continue;
      lbl.click(); n++;
    }
    return n;
  });
  return r;
}

module.exports = { parseDiagReport, parseDiagMain, parseDiagClasses, parseDiagNecessary, setDiagClass, clickBasisTopTab, expandEvidenceCategory, expandAllEvidenceCategories, focusDiagnosisRow, evidenceMatches, markDiagEvidence, markAllEvidenceSupport };


