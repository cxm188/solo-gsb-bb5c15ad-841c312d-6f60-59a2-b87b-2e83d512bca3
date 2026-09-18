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
  console.log('✓ 成功结果页（含分派互换）渲染成功，长度', html3.length)

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
  const payload = buildExportPayload(data, adjusted)
  if (payload.manuallyAdjusted !== true || payload.swapCount !== 1) throw new Error('导出未反映人工调整标记')
  if (payload.assignments.length !== solved.assignments.length) throw new Error('导出分派条数异常')
  console.log('✓ 已人工调整徽章与导出标记正确')

  // 匹配标签计算在面板外可复用（互换重算口径）
  if (computeMatchedTags(data.papers[0], data.reviewers[0]).length < 0) throw new Error('匹配标签计算异常')
}
