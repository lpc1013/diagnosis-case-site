// 病例与原始数据文件的配对：必须由文件内容（meta.name / meta._id）决定。
// 按目录枚举顺序 + 下标配对是隐性假设：新增一份导出、换一个文件系统、
// 甚至只是读取顺序不同，就会把 A 例的标准答案接到 B 例的结构上——
// 而构建照样成功，页面照样能跑，只有内容是错的。
'use strict';

export function matchRawFiles(caseNames, entries) {
  const errors = [];
  const byName = new Map();
  const byId = new Map();
  for (const e of entries) {
    if (!e.name) { errors.push(`原始数据缺少 meta.name：${e.file}`); continue; }
    const n = e.name.trim();
    if (byName.has(n)) errors.push(`两份原始数据是同名病例「${n}」：${byName.get(n)} 与 ${e.file}`);
    else byName.set(n, e.file);
    if (e.id) {
      if (byId.has(e.id)) errors.push(`两份原始数据共用病例 ID ${e.id}：${byId.get(e.id)} 与 ${e.file}`);
      else byId.set(e.id, e.file);
    }
  }
  const map = new Map();
  const missing = [];
  for (const cn of caseNames) {
    const f = byName.get(String(cn).trim());
    if (!f) { missing.push(cn); continue; }
    map.set(cn, f);
  }
  if (missing.length) {
    errors.push(`找不到这些病例的原始数据：${missing.join('、')}（源目录现有：${[...byName.keys()].join('、') || '空'}）`);
  }
  const unused = [...byName.keys()].filter(n => !caseNames.some(c => String(c).trim() === n));
  if (unused.length) errors.push(`原始数据里有清单之外的病例，请确认是否漏改 CASE_FILES：${unused.join('、')}`);
  return { map, errors };
}
