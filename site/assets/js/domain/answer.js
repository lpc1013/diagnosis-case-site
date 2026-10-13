// 把「应用状态」投影成评分引擎要的「单份答卷」。
// 应用里 picked / diagMarks / diagClass / auxCheckCount 都按病例编号分层，
// 而引擎只看一份答卷；跳过这一层的直接后果是引擎读空——进度条和评分会一起归零。
'use strict';

export function caseAnswer(state, caseIdx) {
  const picked = (state.picked || {})[caseIdx] || {};
  return {
    picked,
    auxCheckCount: (state.auxCheckCount || {})[caseIdx] || 0,
    diagClass: (state.diagClass || {})[caseIdx] || {},
    diagMarks: (state.diagMarks || {})[caseIdx] || {},
  };
}
