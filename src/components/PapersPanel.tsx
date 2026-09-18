import type { Paper } from '../types'
import { createId } from '../storage'
import { TagInput } from './TagInput'

interface PapersPanelProps {
  papers: Paper[]
  onChange: (papers: Paper[]) => void
  conflictCountOf: (paperId: string) => number
}

export function PapersPanel({ papers, onChange, conflictCountOf }: PapersPanelProps) {
  const update = (id: string, patch: Partial<Paper>) =>
    onChange(papers.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  const remove = (id: string) => onChange(papers.filter((p) => p.id !== id))
  const add = () =>
    onChange([
      ...papers,
      { id: createId('paper'), title: `稿件 ${papers.length + 1}`, reviewsRequired: 2, tags: [] }
    ])

  return (
    <section>
      <div className="panel-head">
        <h2>稿件（{papers.length}）</h2>
        <button className="btn btn-primary" onClick={add}>
          ＋ 添加稿件
        </button>
      </div>

      {papers.length === 0 && <p className="empty-hint">还没有稿件，点击右上角「添加稿件」开始录入。</p>}

      <div className="card-list">
        {papers.map((p) => (
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
          </div>
        ))}
      </div>
    </section>
  )
}
