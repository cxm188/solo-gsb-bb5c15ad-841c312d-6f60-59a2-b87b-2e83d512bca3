import type { AppData, AssignmentResult } from '../types'
import type { SwapCandidate } from '../engine/swap'
import { SwapTool } from './SwapTool'

interface ResultPanelProps {
  data: AppData
  result: AssignmentResult | null
  /** 当前结果是否因录入数据变化而已过期（过期时不允许互换） */
  stale: boolean
  onExport: () => void
  onApplySwap: (candidate: SwapCandidate) => void
}

const kindLabel: Record<string, string> = {
  'global-capacity': '全局容量不足',
  'paper-eligible': '单篇稿件可分配人数不足',
  'subset-bottleneck': '组合性瓶颈（局部容量不足）',
  'preassigned-reviewer-missing': '预指派引用不存在',
  'preassigned-conflict': '预指派含利益冲突',
  'preassigned-over-capacity': '预指派单人预占超过容量',
  'preassigned-over-quota': '预指派同篇超过名额'
}

const isPreassignKind = (kind: string) => kind.startsWith('preassigned-')

export function ResultPanel({ data, result, stale, onExport, onApplySwap }: ResultPanelProps) {
  if (!result) {
    return (
      <section className="result-empty">
        <p>点击页面顶部的「▶ 生成分派」按钮，系统将在浏览器本地完成整数规划求解。</p>
        <ul>
          <li>
            <strong>硬约束</strong>：预指派（稿件编辑区指定的评审人必须分派）、利益冲突回避、评审人容量上限、
            每篇稿件所需评审人数、同篇评审人不重复，均须全部满足；预指派失效（引用不存在 / 利益冲突 /
            超容量 / 超名额）时会列出具体稿件、评审人与原因，且不生成任何分派；
          </li>
          <li>
            <strong>优化目标</strong>：先最大化主题标签匹配，再最小化评审人最大负载（负载均衡）。
          </li>
        </ul>
      </section>
    )
  }

  if (!result.feasible) {
    const preassignReasons = result.reasons.filter((r) => isPreassignKind(r.kind))
    const otherReasons = result.reasons.filter((r) => !isPreassignKind(r.kind))
    const paperMap = new Map(data.papers.map((p) => [p.id, p]))
    const reviewerMap = new Map(data.reviewers.map((r) => [r.id, r]))
    return (
      <section>
        <div className="result-banner result-banner--fail">
          <h2>✕ 无法生成可行分配</h2>
          <p>
            {preassignReasons.length > 0
              ? '存在失效或违规的预指派关系。按要求已中止求解，未生成任何分派（不会产生部分结果）。请逐条处理后重新生成：'
              : '以下硬约束无法同时满足，请按提示调整数据后重新生成：'}
          </p>
        </div>
        {preassignReasons.length > 0 && (
          <div className="reason-list preassign-fail-list">
            {preassignReasons.map((r, i) => {
              const issue = r.issue
              const paper = issue ? paperMap.get(issue.paperId) : undefined
              const reviewer = issue ? reviewerMap.get(issue.reviewerId) : undefined
              return (
                <div className="reason-card preassign-fail-card" key={`pa-${i}`}>
                  <span className="reason-kind">{kindLabel[r.kind] ?? r.kind}</span>
                  <div className="preassign-fail-ids">
                    <span className="preassign-fail-paper">📄 {paper ? `《${paper.title || issue!.paperId}》` : `稿件 ${issue?.paperId ?? ''}`}</span>
                    <span className="preassign-fail-arrow">→</span>
                    <span className="preassign-fail-reviewer">
                      👤 {reviewer?.name ?? `评审人 ${issue?.reviewerId ?? ''}`}
                    </span>
                  </div>
                  <p className="reason-message">{r.message}</p>
                </div>
              )
            })}
          </div>
        )}
        {otherReasons.length > 0 && (
          <div className="reason-list">
            {otherReasons.map((r, i) => (
              <div className="reason-card" key={i}>
                <span className="reason-kind">{kindLabel[r.kind] ?? r.kind}</span>
                <p className="reason-message">{r.message}</p>
              </div>
            ))}
          </div>
        )}
        {preassignReasons.length > 0 && (
          <p className="preassign-fail-hint">
            提示：失效关系仍保留在「稿件」页对应稿件的「📌 预指派」列表中（已标红），可在该处逐条移除；
            修改稿件需求或评审人容量/利益冲突后，关系会重新生效。
          </p>
        )}
      </section>
    )
  }

  const reviewerMap = new Map(data.reviewers.map((r) => [r.id, r]))
  const byPaper = new Map<string, typeof result.assignments>()
  for (const a of result.assignments) {
    const list = byPaper.get(a.paperId) ?? []
    list.push(a)
    byPaper.set(a.paperId, list)
  }

  const { totalRequired, totalAssigned, topicMatches, maxLoad, preassignedCount } = result.objective

  return (
    <section>
      <div className="result-banner result-banner--ok">
        <h2>
          ✓ 分配完成
          {result.manuallyAdjusted && (
            <span className="manual-badge" title={`已通过「分派互换」人工调整 ${result.swapCount ?? 0} 次；录入数据未改动`}>
              ✎ 已人工调整
            </span>
          )}
        </h2>
        <div className="stat-row">
          <div className="stat">
            <strong>{totalAssigned}/{totalRequired}</strong>
            <span>分配名额</span>
          </div>
          <div className="stat">
            <strong>{topicMatches}</strong>
            <span>主题匹配数</span>
          </div>
          <div className="stat">
            <strong>{maxLoad}</strong>
            <span>评审人最大负载</span>
          </div>
          <div className="stat">
            <strong className={preassignedCount > 0 ? 'stat-amber' : undefined}>{preassignedCount}</strong>
            <span>来自预指派</span>
          </div>
        </div>
        <button className="btn btn-primary" onClick={onExport}>
          ⬇ 导出结果 JSON
        </button>
      </div>

      {stale ? (
        <div className="stress-stale-banner">
          ⚠ 录入数据在生成本结果后已变化，当前分派<strong>可能已过期</strong>。
          为避免在过期方案上误改派，「分派互换」已暂停；请点击页面顶部「▶ 生成分派」刷新结果后再操作。
        </div>
      ) : (
        <SwapTool data={data} result={result} onApply={onApplySwap} />
      )}

      <h3 className="subhead">逐稿分配明细</h3>
      <div className="card-list">
        {data.papers
          .filter((p) => p.reviewsRequired > 0)
          .map((p) => {
            const items = byPaper.get(p.id) ?? []
            return (
              <div className="card assignment-card" key={p.id}>
                <div className="assignment-title">
                  <span className="paper-title">{p.title || p.id}</span>
                  <span className="muted">
                    需 {p.reviewsRequired} 人 · 已分配 {items.length} 人
                  </span>
                  <div className="mini-tags">
                    {p.tags.map((t) => (
                      <span className="mini-tag mini-tag--blue" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="assignee-list">
                  {items.map((a) => {
                    const rv = reviewerMap.get(a.reviewerId)
                    return (
                      <div className={`assignee ${a.topicMatched ? 'is-match' : 'is-nomatch'}`} key={a.reviewerId}>
                        <span className="assignee-name">{rv?.name ?? a.reviewerId}</span>
                        {a.preassigned ? (
                          <span className="badge badge-preassigned" title="该分派来自稿件编辑区的预指派（硬约束）">
                            📌 预指派
                          </span>
                        ) : a.topicMatched ? (
                          <span className="badge badge-match">主题匹配</span>
                        ) : (
                          <span className="badge badge-nomatch">无直接匹配</span>
                        )}
                        {a.matchedTags.length > 0 && (
                          <div className="mini-tags">
                            {a.matchedTags.map((t) => (
                              <span className="mini-tag mini-tag--green" key={t}>
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
      </div>

      <h3 className="subhead">评审人负载</h3>
      <div className="load-list">
        {result.loads.map((l) => {
          const rv = reviewerMap.get(l.reviewerId)
          const pct = l.capacity > 0 ? Math.round((l.assigned / l.capacity) * 100) : 0
          return (
            <div className="load-row" key={l.reviewerId}>
              <span className="load-name" title={rv?.name}>
                {rv?.name ?? l.reviewerId}
              </span>
              <div className="load-bar">
                <div
                  className={`load-fill ${pct >= 100 ? 'full' : pct >= 70 ? 'high' : ''}`}
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </div>
              <span className="load-num">
                {l.assigned}/{l.capacity}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
