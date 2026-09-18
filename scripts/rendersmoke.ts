// 无浏览器环境下的渲染冒烟：桩掉浏览器 API 后 renderToString
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
}
;(globalThis as any).performance = { now: () => 0 }
;(globalThis as any).window = { confirm: () => false }

import React from 'react'
import { renderToString } from 'react-dom/server'
import App from '../src/App'
import { createSampleData } from '../src/sampleData'
import { solveAssignment, computeMatchedTags } from '../src/engine/solver'
import { ResultPanel } from '../src/components/ResultPanel'
import { PapersPanel } from '../src/components/PapersPanel'
import { buildExportPayload } from '../src/exporter'

// 初始空数据渲染
const html1 = renderToString(React.createElement(App))
if (!html1.includes('盲审分配台')) throw new Error('未渲染标题')
if (!html1.includes('生成分派')) throw new Error('未渲染生成按钮')
if (!html1.includes('还没有稿件')) throw new Error('空态提示异常')
console.log('✓ 空数据渲染成功，长度', html1.length)

// 写入示例数据后渲染（localStorage 初始值，落在"稿件"标签页）
store.set('blind-review-desk:data:v1', JSON.stringify(createSampleData()))
const html2 = renderToString(React.createElement(App))
if (!html2.includes('添加稿件')) throw new Error('稿件面板异常')
if (!html2.includes('面向大语言模型的高效微调方法')) throw new Error('示例稿件未渲染')
if (!html2.includes('机器学习')) throw new Error('稿件标签未渲染')
if (!html2.includes('利益冲突')) throw new Error('冲突入口未渲染')
console.log('✓ 示例数据渲染成功，长度', html2.length)

// 成功结果页：渲染分派互换工具
{
  const data = createSampleData()
  const solved = solveAssignment(data)
  if (!solved.feasible) throw new Error('示例数据应可生成可行方案')
  if (solved.objective.preassignedCount !== 2) throw new Error('示例数据含 2 条预指派（p2→Bob、p4→Dave）')
  const html3 = renderToString(
    React.createElement(ResultPanel, {
      data,
      result: solved,
      stale: false,
      onExport: () => {},
      onApplySwap: () => {}
    })
  )
  if (!html3.includes('分派互换')) throw new Error('分派互换工具未渲染')
  if (!html3.includes('请选择')) throw new Error('评审人选择器未渲染')
  if (!html3.includes('导出结果 JSON')) throw new Error('导出按钮未渲染')
  if (!html3.includes('预指派')) throw new Error('预指派徽章/统计未渲染')
  if (!html3.includes('来自预指派')) throw new Error('预指派统计未渲染')
  console.log('✓ 成功结果页（含分派互换、预指派标记）渲染成功，长度', html3.length)

  // 导出 JSON 必须标明哪些分派来自预指派
  const payload = buildExportPayload(data, solved)
  const preassignedRows = payload.assignments.filter((a) => a.preassigned)
  if (preassignedRows.length !== 2) throw new Error('导出应含 2 条 preassigned=true 分派')
  if (!preassignedRows.every((a) => a.paperId === 'paper_ml_002' || a.paperId === 'paper_sec_001')) {
    throw new Error('导出的预指派分派稿件不正确')
  }
  if (payload.summary.preassignedCount !== 2) throw new Error('导出 summary 缺 preassignedCount')
  console.log('✓ 导出 JSON 正确标注预指派分派')

  // 过期结果页：互换工具应暂停并提示
  const html4 = renderToString(
    React.createElement(ResultPanel, { data, result: solved, stale: true, onExport: () => {}, onApplySwap: () => {} })
  )
  if (html4.includes('分派互换（一换一）')) throw new Error('过期结果不应展示互换工具')
  if (!html4.includes('可能已过期')) throw new Error('过期提示未渲染')
  console.log('✓ 过期结果页暂停互换渲染成功')

  // 人工调整后：徽章与导出 JSON 需反映标记
  const adjusted = { ...solved, manuallyAdjusted: true as const, swapCount: 1 }
  const html5 = renderToString(
    React.createElement(ResultPanel, { data, result: adjusted, stale: false, onExport: () => {}, onApplySwap: () => {} })
  )
  if (!html5.includes('已人工调整')) throw new Error('已人工调整徽章未渲染')
  const adjustedPayload = buildExportPayload(data, adjusted)
  if (adjustedPayload.manuallyAdjusted !== true || adjustedPayload.swapCount !== 1) throw new Error('导出未反映人工调整标记')
  if (adjustedPayload.assignments.length !== solved.assignments.length) throw new Error('导出分派条数异常')
  if (adjustedPayload.assignments.filter((a) => a.preassigned).length !== 2) throw new Error('人工调整后导出仍须保留预指派标记')
  console.log('✓ 已人工调整徽章与导出标记正确')

  // 匹配标签计算在面板外可复用（互换重算口径）
  if (computeMatchedTags(data.papers[0], data.reviewers[0]).length < 0) throw new Error('匹配标签计算异常')
}

// 预指派失效：结果区必须列出具体稿件、评审人与原因，且不产生分派
{
  const badData = {
    papers: [
      { id: 'px', title: '问题稿件', reviewsRequired: 2, tags: [], preassignedReviewerIds: ['gone', 'rev_conflict'] }
    ],
    reviewers: [{ id: 'rev_conflict', name: '冲突者', tags: [], capacity: 3, conflictPaperIds: ['px'] }]
  }
  const solved = solveAssignment(badData)
  if (solved.feasible) throw new Error('含失效预指派时不应成功')
  const html = renderToString(
    React.createElement(ResultPanel, { data: badData, result: solved, stale: false, onExport: () => {}, onApplySwap: () => {} })
  )
  if (!html.includes('无法生成可行分配')) throw new Error('失败横幅未渲染')
  if (!html.includes('问题稿件')) throw new Error('未列出具体稿件')
  if (!html.includes('gone')) throw new Error('未列出失效评审人 id')
  if (!html.includes('冲突者')) throw new Error('未列出冲突评审人')
  if (!html.includes('不会产生部分结果') && !html.includes('未生成任何分派')) throw new Error('未声明不生成部分结果')
  console.log('✓ 预指派失效结果页（逐条稿件/评审人/原因）渲染成功')
}

// 稿件编辑区：预指派入口、计数与失效提示渲染
{
  const papersData = {
    papers: [
      { id: 'p1', title: '稿件一', reviewsRequired: 2, tags: [], preassignedReviewerIds: ['r1', 'ghost'] },
      { id: 'p2', title: '稿件二', reviewsRequired: 1, tags: [] }
    ],
    reviewers: [{ id: 'r1', name: '评审甲', tags: [], capacity: 2, conflictPaperIds: [] }]
  }
  const solved = solveAssignment(papersData)
  const issues = !solved.feasible ? solved.reasons.map((r) => r.issue).filter(Boolean) : []
  const map = new Map<string, typeof issues>()
  for (const it of issues as NonNullable<(typeof issues)[number]>[]) {
    const list = map.get(it.paperId) ?? []
    list.push(it)
    map.set(it.paperId, list)
  }
  const html = renderToString(
    React.createElement(PapersPanel, {
      papers: papersData.papers,
      reviewers: papersData.reviewers,
      onChange: () => {},
      conflictCountOf: () => 0,
      preassignIssuesByPaper: map
    })
  )
  // SSR 会在文本与每个表达式之间插入 <!-- --> 注释
  if (!/预指派（<!-- -->2<!-- -->\/<!-- -->2<!-- -->）/.test(html)) throw new Error('预指派按钮计数未渲染（含失效关系，应保留计数）')
  if (!html.includes('ghost')) throw new Error('失效评审人未在预指派列表中保留显示')
  if (!html.includes('失效')) throw new Error('失效预指派显式提示未渲染')
  if (!html.includes('移除')) throw new Error('逐条移除入口未渲染')
  console.log('✓ 稿件编辑区预指派（含失效保留与提示）渲染成功')
}
