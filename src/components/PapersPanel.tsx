import { useState } from 'react'
import type { Paper, PreassignmentIssue, Reviewer } from '../types'
import { createId } from '../storage'
import { TagInput } from './TagInput'

interface PapersPanelProps {
  papers: Paper[]
  reviewers: Reviewer[]
  onChange: (papers: Paper[]) => void
  conflictCountOf: (paperId: string) => number
  /** 当前数据下逐条校验出的失效/违规预指派（按稿件 id 归组） */
  preassignIssuesByPaper: Map<string, PreassignmentIssue[]>
}

const issueShort: Record<PreassignmentIssue['kind'], string> = {
  'preassigned-reviewer-missing': '评审人不存在',
  'preassigned-conflict': '存在利益冲突',
  'preassigned-over-capacity': '预占超过容量',
  'preassigned-over-quota': '超过本篇名额'
}

export function PapersPanel({ papers, reviewers, onChange, conflictCountOf, preassignIssuesByPaper }: PapersPanelProps) {
  const [openPreassign, setOpenPreassign] = useState<string | null>(null)

  const update = (id: string, patch: Partial<Paper>) =>
    onChange(papers.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  const remove = (id: string) => onChange(papers.filter((p) => p.id !== id))
  const add = () =>
    onChange([
      ...papers,
      { id: createId('paper'), title: `稿件 ${papers.length + 1}`, reviewsRequired: 2, tags: [], preassignedReviewerIds: [] }
    ])

  const reviewerById = new Map(reviewers.map((r) => [r.id, r]))

  const togglePreassign = (p: Paper, reviewerId: string) => {
    const current = p.preassignedReviewerIds ?? []
    const next = current.includes(reviewerId)
      ? current.filter((id) => id !== reviewerId)
      : [...current, reviewerId]
    update(p.id, { preassignedReviewerIds: next })
  }

  const totalPreassign = papers.reduce((n, p) => n + (p.preassignedReviewerIds?.length ?? 0), 0)
  const totalInvalid = preassignIssuesByPaper.size

  return (
    <section>
      <div className="panel-head">
        <h2>
          稿件（{papers.length}）
          {totalPreassign > 0 && (
            <span className={`preassign-head-count ${totalInvalid > 0 ? 'has-invalid' : ''}`}>
              📌 预指派 {totalPreassign} 条{totalInvalid > 0 ? ` · ${totalInvalid} 篇存在失效` : ''}
            </span>
          )}
        </h2>
        <button className="btn btn-primary" onClick={add}>
          ＋ 添加稿件
        </button>
      </div>

      {papers.length === 0 && <p className="empty-hint">还没有稿件，点击右上角「添加稿件」开始录入。</p>}

      <div className="card-list">
        {papers.map((p) => {
          const ids = p.preassignedReviewerIds ?? []
          const issues = preassignIssuesByPaper.get(p.id) ?? []
          const issueByReviewer = new Map(issues.map((x) => [x.reviewerId, x]))
          const atLimit = ids.length >= p.reviewsRequired
          return (
            <div className="card" key={p.id}>
              <div className="card-row">
                <input
                  className="input title-input"
                  value={p.title}
                  placeholder="稿件标题 / 编号"
                  onChange={(e) => update(p.id, { title: e.target.value })}
                />
                <label className="num-field">
                  需求评审数
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={p.reviewsRequired}
                    onChange={(e) => update(p.id, { reviewsRequired: Math.max(1, Number(e.target.value) || 1) })}
                  />
                </label>
                <button
                  className={`btn ${ids.length > 0 ? (issues.length > 0 ? 'btn-warn' : 'btn-preassign') : 'btn-ghost'}`}
                  onClick={() => setOpenPreassign(openPreassign === p.id ? null : p.id)}
                  title="预指派：生成分派时必须分派给这些评审人（硬约束）"
                >
                  📌 预指派（{ids.length}/{p.reviewsRequired}）
                </button>
                <button className="btn btn-ghost danger" onClick={() => remove(p.id)}>
                  删除
                </button>
              </div>
              <div className="card-row tags-row">
                <span className="field-label">主题标签</span>
                <TagInput tags={p.tags} onChange={(tags) => update(p.id, { tags })} placeholder="如：机器学习、NLP" />
              </div>
              {conflictCountOf(p.id) > 0 && (
                <div className="conflict-note">⚠ {conflictCountOf(p.id)} 位评审人已声明与该稿件存在利益冲突</div>
              )}

              {ids.length > 0 && (
                <div className="preassign-chips">
                  {ids.map((rid) => {
                    const issue = issueByReviewer.get(rid)
                    const rv = reviewerById.get(rid)
                    return (
                      <span
                        className={`preassign-chip ${issue ? 'preassign-chip--invalid' : ''}`}
                        key={rid}
                        title={issue?.message}
                      >
                        📌 {rv?.name ?? `已删除评审人 ${rid}`}
                        {issue && <em className="preassign-chip-issue">{issueShort[issue.kind]}</em>}
                        <button
                          type="button"
                          aria-label={`移除预指派 ${rv?.name ?? rid}`}
                          onClick={() => togglePreassign(p, rid)}
                        >
                          ×
                        </button>
                      </span>
                    )
                  })}
                </div>
              )}

              {issues.length > 0 && (
                <div className="preassign-issue-box">
                  <p className="preassign-issue-title">该稿件存在 {issues.length} 条失效/违规预指派，生成分派前请逐条移除或修正：</p>
                  <ul className="preassign-issue-list">
                    {issues.map((x, k) => (
                      <li key={`${x.reviewerId}-${k}`}>
                        <span className="preassign-issue-tag">{issueShort[x.kind]}</span>
                        {x.message}
                        <button className="btn btn-ghost danger preassign-issue-remove" onClick={() => togglePreassign(p, x.reviewerId)}>
                          移除该预指派
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {openPreassign === p.id && (
                <div className="conflict-box preassign-box">
                  <p className="conflict-box-title">
                    勾选生成分派时<strong>必须</strong>评阅本稿的评审人（0～{p.reviewsRequired} 位，硬约束）：
                  </p>
                  {reviewers.length === 0 ? (
                    <p className="empty-hint">暂无评审人可选，请先在「评审人 / 利益冲突」页录入。</p>
                  ) : (
                    <div className="conflict-options">
                      {reviewers.map((r) => {
                        const checked = ids.includes(r.id)
                        const conflicted = r.conflictPaperIds.includes(p.id)
                        const disabled = !checked && atLimit
                        return (
                          <label
                            key={r.id}
                            className={`conflict-option preassign-option ${conflicted ? 'is-conflicted' : ''} ${disabled ? 'is-disabled' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={disabled}
                              onChange={() => togglePreassign(p, r.id)}
                            />
                            <span>{r.name}</span>
                            {conflicted && <em className="tag-overlap-hint preassign-hint-conflict">利益冲突，不可预指派</em>}
                            {!conflicted && disabled && <em className="tag-overlap-hint">已达本篇 {p.reviewsRequired} 人名额</em>}
                          </label>
                        )
                      })}
                    </div>
                  )}
                  <p className="preassign-hint">
                    预指派与利益冲突、单人容量、每篇人数、同人不重复规则共同求解：引用的评审人被删除、产生利益冲突、
                    单人预占超过容量或同篇超过名额时，将在结果区列出具体原因且不会生成任何分派。
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
