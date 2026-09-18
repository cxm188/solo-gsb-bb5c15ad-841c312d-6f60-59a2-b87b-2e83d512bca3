/**
 * 预指派（pre-assignment）：稿件 → 评审人的硬绑定关系。
 *
 * 用户可在稿件编辑区为每篇稿件指定 0..所需人数 位评审人；
 * 生成分派时这些关系作为**硬约束**与利益冲突、单人容量、每篇人数、
 * 同人不重复规则一起求解（见 solver.ts：预指派对在 ILP 中被强制取 1，
 * 剩余名额在预占后的残量问题上做可行性检验与目标优化）。
 *
 * 本模块负责在求解前对（可能引用了已删除对象、已产生冲突的）预指派关系
 * 做逐条校验。失效关系**保留在录入数据中**（不静默清除），由界面显式提示、
 * 用户逐条移除；只要存在任何失效/违规关系，求解器立即中止，绝不生成部分结果。
 */
import type { AppData, InfeasibleReason, PreassignmentIssue, PreassignmentIssueKind } from '../types'

/** 一条必须兑现的预指派（稿件 id, 评审人 id） */
export interface ForcedKey {
  paperId: string
  reviewerId: string
}

export interface PreassignmentAnalysis {
  /** 全部失效/违规关系（按种类、稿件、评审人稳定排序） */
  issues: PreassignmentIssue[]
  /** 无任何问题时：去重后的有效预指派，供求解器强制兑现 */
  forcedKeys: ForcedKey[]
}

const num0 = (v: unknown) => Math.max(0, Math.floor(Number.isFinite(v) ? (v as number) : 0))

/**
 * 分析原始录入数据中的全部预指派关系。
 *
 * 判定四种失效/违规（逐条列出具体稿件、评审人与原因）：
 *  1. preassigned-reviewer-missing：引用的评审人已不存在（或姓名为空被归一化过滤）；
 *  2. preassigned-conflict：该评审人已声明与该稿件存在利益冲突；
 *  3. preassigned-over-capacity：该评审人被预占的名额超过其容量；
 *  4. preassigned-over-quota：同一篇稿件预指派人数超过该稿需求名额。
 * 同一稿件内重复出现的评审人按一条计（重复项静默去重，不报错）。
 */
export function analyzePreassignments(rawData: AppData): PreassignmentAnalysis {
  const reviewerById = new Map(rawData.reviewers.map((r) => [r.id, r]))
  const conflictCountByReviewer = new Map<string, Set<string>>()
  for (const r of rawData.reviewers) {
    conflictCountByReviewer.set(r.id, new Set(r.conflictPaperIds))
  }

  // 每篇稿件去重后的预指派（保留首次出现顺序）。
  // 与 solver 的 normalize 口径一致：空白标题 / 需求为 0 的稿件本身不参与求解，
  // 其预指派关系保留在数据中但不参与校验，避免“无效稿件”阻断其它稿件生成。
  const perPaper = rawData.papers
    .filter((p) => p.title.trim().length > 0 && num0(p.reviewsRequired) > 0)
    .map((p) => ({
      paper: p,
      demand: num0(p.reviewsRequired),
      ids: Array.from(new Set(Array.isArray(p.preassignedReviewerIds) ? p.preassignedReviewerIds : []))
    }))

  // 每位评审人被有效稿件预占的名额
  const preassignCount = new Map<string, number>()
  for (const { ids } of perPaper) {
    for (const rid of ids) {
      const r = reviewerById.get(rid)
      if (r && r.name.trim()) preassignCount.set(rid, (preassignCount.get(rid) ?? 0) + 1)
    }
  }

  const paperLabel = (title: string, fallback: string) => (title.trim() ? `《${title.trim()}》` : `稿件 ${fallback}`)
  const reviewerLabel = (id: string) => {
    const name = reviewerById.get(id)?.name.trim()
    return name ? name : `已删除评审人 ${id}`
  }

  const build = (
    kind: PreassignmentIssueKind,
    paperId: string,
    reviewerId: string,
    message: string,
    extra?: { count: number; limit: number }
  ): PreassignmentIssue => ({
    kind,
    paperId,
    reviewerId,
    message,
    preassignedCount: extra?.count,
    limit: extra?.limit
  })

  // 按种类分桶收集，保证展示顺序稳定：不存在 → 冲突 → 超容量 → 超名额
  const buckets: Record<PreassignmentIssueKind, PreassignmentIssue[]> = {
    'preassigned-reviewer-missing': [],
    'preassigned-conflict': [],
    'preassigned-over-capacity': [],
    'preassigned-over-quota': []
  }

  for (const { paper, demand, ids } of perPaper) {
    // 超过该稿名额的部分：按录入顺序取末尾的多余关系，逐条提示“具体稿件/评审人”
    const excessFrom = ids.length > demand ? demand : ids.length
    ids.forEach((rid, k) => {
      const reviewer = reviewerById.get(rid)
      if (!reviewer || !reviewer.name.trim()) {
        buckets['preassigned-reviewer-missing'].push(
          build(
            'preassigned-reviewer-missing',
            paper.id,
            rid,
            `${paperLabel(paper.title, paper.id)} 的预指派评审人「${reviewerLabel(rid)}」不存在（可能已被删除）。请在稿件编辑区移除该失效预指派后重新生成。`
          )
        )
        return
      }
      if (conflictCountByReviewer.get(rid)?.has(paper.id)) {
        buckets['preassigned-conflict'].push(
          build(
            'preassigned-conflict',
            paper.id,
            rid,
            `${paperLabel(paper.title, paper.id)} 的预指派评审人「${reviewerLabel(rid)}」已声明与该稿件存在利益冲突，硬约束彼此矛盾。请移除该预指派或解除对应利益冲突。`
          )
        )
      }
      const cap = num0(reviewer.capacity)
      const occupied = preassignCount.get(rid) ?? 0
      if (occupied > cap) {
        buckets['preassigned-over-capacity'].push(
          build(
            'preassigned-over-capacity',
            paper.id,
            rid,
            `${paperLabel(paper.title, paper.id)} 预指派给「${reviewerLabel(rid)}」，但该评审人被 ${occupied} 篇稿件预指派，已超过其容量 ${cap}。请减少对该评审人的预指派或提高其容量。`,
            { count: occupied, limit: cap }
          )
        )
      }
      if (k >= excessFrom) {
        buckets['preassigned-over-quota'].push(
          build(
            'preassigned-over-quota',
            paper.id,
            rid,
            `${paperLabel(paper.title, paper.id)} 共预指派 ${ids.length} 位评审人，但仅需 ${demand} 位（多出 ${ids.length - demand} 个预指派名额）。请移除「${reviewerLabel(rid)}」等多余预指派，或调大需求评审数。`,
            { count: ids.length, limit: demand }
          )
        )
      }
    })
  }

  const issues = [
    ...buckets['preassigned-reviewer-missing'],
    ...buckets['preassigned-conflict'],
    ...buckets['preassigned-over-capacity'],
    ...buckets['preassigned-over-quota']
  ]

  // 仅在全部关系有效时才产出强制集合（存在任何问题时求解器中止，不会用到它）
  const forcedKeys: ForcedKey[] =
    issues.length > 0
      ? []
      : perPaper.flatMap(({ paper, ids }) => ids.map((reviewerId) => ({ paperId: paper.id, reviewerId })))

  return { issues, forcedKeys }
}

/** 将预指派失效关系包装为求解失败原因（与其它不可行原因同构，供结果区逐条展示） */
export function issuesToReasons(issues: PreassignmentIssue[]): InfeasibleReason[] {
  return issues.map((issue) => ({ kind: issue.kind, message: issue.message, issue }))
}
