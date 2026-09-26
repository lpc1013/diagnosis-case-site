// 闸门脚本：校验某病例的诊断依据树是否「必要证据全部命中」
// 用法：node check_dxdump.js <CASE_IDX>
// 退出码 0 = 全部诊断 matched>=necessary（闸门通过）；1 = 存在未达标诊断
const fs = require('fs');
const idx = process.argv[2];
if(!idx){ console.log('用法: node check_dxdump.js <CASE_IDX>'); process.exit(2); }
const f = `recon/dxdump_c${idx}.json`;
if(!fs.existsSync(f)){ console.log('NO dxdump file:', f, '（需 DUMP_DIAG=1 跑过 fill_case.js）'); process.exit(1); }
const acc = JSON.parse(fs.readFileSync(f, 'utf8'));
let allOk = true;
for(const [diag, d] of Object.entries(acc)){
  const nec = (d.necessary || []).length;
  const mat = (d.matched || []).length;
  const ok = mat >= nec;            // 允许 matched>=necessary（多余命中无害）
  if(!ok) allOk = false;
  console.log(`  ${ok ? '✔' : '✘'} ${diag}  matched=${mat}/${nec}`);
}
console.log(allOk
  ? `>>> case${idx} 诊断依据树全部 matched>=necessary，闸门通过 ✔`
  : `>>> case${idx} 存在未达标诊断，闸门失败 ✘`);
process.exit(allOk ? 0 : 1);
