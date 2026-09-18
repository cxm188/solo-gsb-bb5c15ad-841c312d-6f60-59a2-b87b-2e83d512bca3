import solver from 'javascript-lp-solver'
import { checkFeasibility } from './maxflow'
import { analyzePreassignments, issuesToReasons, type ForcedKey } from './preassign'
import type {
  AppData,
  AssignmentItem,
  AssignmentResult,
  AssignmentSuccess,
  InfeasibleReason,
  Paper,
  Reviewer,
  ReviewerLoad
} from '../types'

/** 标签规范化：去空白、去重，大小写不敏感保留首次写法 */
function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw) {
    const v = t.trim()
    if (!v) continue
    const key = v.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(v)
    }
  }
  return out
}

interface Normalized {
  papers: Paper[]
  reviewers: Reviewer[]
}

function normalize(rawData: AppData): Normalized {
  // 被归一化过滤掉的“姓名为空”评审人：其 id 上的预指派同样视为失效关系保留
  const blankNameIds = new Set(
    rawData.reviewers.filter((r) => r.name.trim().length === 0).map((r) => r.id)
  )

  const reviewers: Reviewer[] = rawData.reviewers
    .map((r) => ({
      ...r,
      name: r.name.trim(),
      tags: normalizeTags(r.tags),
      capacity: Math.max(0, Math.floor(Number.isFinite(r.capacity) ? r.capacity : 0)),
      conflictPaperIds: Array.from(new Set(r.conflictPaperIds))
    }))
    .filter((r) => r.name.length > 0)

  // 预指派在归一化时仅去重；**失效关系一律保留**（评审人已删除 / 空名），
  // 交由 analyzePreassignments 显式报告，由用户逐条移除。
  const papers: Paper[] = rawData.papers
    .map((p) => ({
      ...p,
      title: p.title.trim(),
      tags: normalizeTags(p.tags),
      reviewsRequired: Math.max(0, Math.floor(Number.isFinite(p.reviewsRequired) ? p.reviewsRequired : 0)),
      preassignedReviewerIds: Array.from(
        new Set((Array.isArray(p.preassignedReviewerIds) ? p.preassignedReviewerIds : []).filter((id) => !!id && !blankNameIds.has(id)))
      )
    }))
    .filter((p) => p.title.length > 0 && p.reviewsRequired > 0)

  return { papers, reviewers }
}

function hasConflict(paper: Paper, reviewer: Reviewer): boolean {
  return reviewer.conflictPaperIds.includes(paper.id)
}

function tagKey(t: string): string {
  return t.toLowerCase()
}

/** 稿件 i 与评审人 j 命中的共同主题标签 */
function matchedTagsOf(paper: Paper, reviewer: Reviewer): string[] {
  const rSet = new Set(reviewer.tags.map(tagKey))
  return paper.tags.filter((t) => rSet.has(tagKey(t)))
}

/**
 * 计算一份（可能未经归一化的）稿件与评审人命中的共同主题标签。
 * 复用求解器同一套标签归一化（去空白、大小写不敏感、保留稿件侧首次写法），
 * 供「分派互换」在结果层重算交换后的匹配情况，保证与生成结果口径一致。
 */
export function computeMatchedTags(paper: Paper, reviewer: Reviewer): string[] {
  return matchedTagsOf(
    { ...paper, tags: normalizeTags(paper.tags) },
    { ...reviewer, tags: normalizeTags(reviewer.tags) }
  )
}

/**
 * 硬约束评估结果。
 * 可行性、不可行原因与归一化后的输入一并返回，供分配主流程与缺席压力测试复用。
 */
export interface HardConstraintEvaluation {
  feasible: boolean
  reasons: InfeasibleReason[]
  papers: Paper[]
  reviewers: Reviewer[]
  /** eligible[i][j] = true 表示稿件 i 与评审人 j 无冲突 */
  eligible: boolean[][]
  demands: number[]
  capacities: number[]
  totalRequired: number
  /** 有效预指派（已通过全部逐条校验），求解时必须兑现 */
  forcedKeys: ForcedKey[]
  /** forced[i][j] = true 表示稿件 i 已预指派给评审人 j */
  forced: boolean[][]
  /** 扣除预指派后每篇稿件仍需补的名额 */
  residualDemands: number[]
  /** 扣除预指派后每位评审人的剩余容量 */
  residualCapacities: number[]
}

/**
 * 仅评估硬约束（冲突 / 容量 / 人数 / 预指派），不做任何目标优化、不改变输入数据。
 * 缺席压力测试把某位评审人容量改为 0 后调用本函数，即“使用既有硬约束可行性逻辑重新判定”。
 */
export function evaluateHardConstraints(rawData: AppData): HardConstraintEvaluation {
  // ---- 预指派逐条校验（引用不存在 / 利益冲突 / 超容量 / 超名额）----
  // 存在任何失效或违规关系都直接中止：不得进入优化，绝不生成部分结果。
  // 注意：仍完成归一化以便调用方（缺席压力测试）拿到有效的稿件/评审人列表做诊断。
  const preassign = analyzePreassignments(rawData)
  const { papers, reviewers } = normalize(rawData)
  if (preassign.issues.length > 0) {
    return {
      feasible: false,
      reasons: issuesToReasons(preassign.issues),
      papers,
      reviewers,
      eligible: papers.map((p) => reviewers.map((r) => !hasConflict(p, r))),
      demands: papers.map((p) => p.reviewsRequired),
      capacities: reviewers.map((r) => r.capacity),
      totalRequired: papers.reduce((a, p) => a + p.reviewsRequired, 0),
      forcedKeys: [],
      forced: papers.map(() => reviewers.map(() => false)),
      residualDemands: papers.map((p) => p.reviewsRequired),
      residualCapacities: reviewers.map((r) => r.capacity)
    }
  }

  const P = papers.length
  const R = reviewers.length
  const reasons: InfeasibleReason[] = []

  // ---- 退化情形 ----
  if (P === 0) {
    return {
      feasible: false,
      reasons: [{ kind: 'paper-eligible', message: '没有需要分配的有效稿件（请至少录入一篇需要评审的稿件）。' }],
      papers,
      reviewers,
      eligible: [],
      demands: [],
      capacities: reviewers.map((r) => r.capacity),
      totalRequired: 0,
      forcedKeys: [],
      forced: [],
      residualDemands: [],
      residualCapacities: reviewers.map((r) => r.capacity)
    }
  }
  if (R === 0) {
    reasons.push({
      kind: 'global-capacity',
      message: `尚未录入任何评审人，${papers.reduce((a, p) => a + p.reviewsRequired, 0)} 个评审名额无人承担。`
    })
    return {
      feasible: false,
      reasons,
      papers,
      reviewers,
      eligible: papers.map(() => []),
      demands: papers.map((p) => p.reviewsRequired),
      capacities: [],
      totalRequired: papers.reduce((a, p) => a + p.reviewsRequired, 0),
      forcedKeys: [],
      forced: papers.map(() => []),
      residualDemands: papers.map((p) => p.reviewsRequired),
      residualCapacities: []
    }
  }

  // ---- 冲突矩阵与预指派矩阵 ----
  const eligible: boolean[][] = papers.map((p) => reviewers.map((r) => !hasConflict(p, r)))
  const forced: boolean[][] = Array.from({ length: P }, () => Array<boolean>(R).fill(false))
  const paperIndex = new Map(papers.map((p, i) => [p.id, i]))
  const reviewerIndex = new Map(reviewers.map((r, j) => [r.id, j]))
  for (const k of preassign.forcedKeys) {
    const i = paperIndex.get(k.paperId)
    const j = reviewerIndex.get(k.reviewerId)
    if (i === undefined || j === undefined) continue // 理论不会：已通过逐条校验
    forced[i][j] = true
  }

  const demands = papers.map((p) => p.reviewsRequired)
  const capacities = reviewers.map((r) => r.capacity)
  const totalRequired = demands.reduce((a, b) => a + b, 0)

  // 预指派先无条件占掉对应名额：残量问题只需把剩余名额在“非预指派边”上分配
  const forcedPerPaper = forced.map((row) => row.filter(Boolean).length)
  const forcedPerReviewer = reviewers.map((_, j) => forced.reduce((n, row) => n + (row[j] ? 1 : 0), 0))
  const residualDemands = demands.map((d, i) => d - forcedPerPaper[i])
  const residualCapacities = capacities.map((c, j) => c - forcedPerReviewer[j])

  // 残量网络中稿件 i 不能再走已被预指派占用的边（同人不重复：预指派者已评该稿）
  const residualEligible: boolean[][] = eligible.map((row, i) =>
    row.map((ok, j) => ok && !forced[i][j])
  )

  // ---- 原因 1（最具体）：单篇稿件剩余可补人数不足 ----
  const perPaperFailures: InfeasibleReason[] = []
  for (let i = 0; i < P; i++) {
    const avail = residualEligible[i].filter(Boolean).length
    if (residualDemands[i] > 0 && avail < residualDemands[i]) {
      perPaperFailures.push({
        kind: 'paper-eligible',
        paperIds: [papers[i].id],
        message:
          `《${papers[i].title}》需要 ${demands[i]} 位评审人` +
          (forcedPerPaper[i] > 0 ? `（其中 ${forcedPerPaper[i]} 位来自预指派）` : '') +
          `，但剩余无利益冲突、且未被预指派占用的评审人仅 ${avail} 位，无法补足 ${residualDemands[i]} 个剩余名额（缺口 ${residualDemands[i] - avail}）。`
      })
    }
  }

  // ---- 全局容量（残量：预指派占用名额已从两侧同时扣除，总额等价）----
  const totalCapacity = capacities.reduce((a, b) => a + b, 0)
  if (totalCapacity < totalRequired) {
    reasons.push({
      kind: 'global-capacity',
      reviewerIds: reviewers.map((r) => r.id),
      message: `全部稿件共需 ${totalRequired} 个评审名额，而 ${R} 位评审人的容量合计仅 ${totalCapacity}（缺口 ${totalRequired - totalCapacity}）。请增加评审人或提高容量。`
    })
  }

  // ---- 最大流可行性检验（残量问题） ----
  const feas = checkFeasibility({
    demands: residualDemands,
    capacities: residualCapacities,
    eligible: residualEligible
  })

  if (!feas.feasible && reasons.length === 0 && perPaperFailures.length === 0) {
    // 组合性瓶颈（广义 Hall 条件违反），在扣除预指派后的残量问题上定位：
    // 取残量网源侧可达稿件集合 Z，令 Y 为与 Z 中任一稿件无冲突且未被这些稿件预指派占用的全部评审人。
    const Zidx = feas.sourceReachablePapers.filter((i) => residualDemands[i] > 0)
    const Zset = Zidx.map((i) => papers[i])
    const Yidx: number[] = []
    for (let j = 0; j < R; j++) {
      if (Zidx.some((i) => residualEligible[i][j])) Yidx.push(j)
    }
    const Yset = Yidx.map((j) => reviewers[j])
    const demandZ = Zidx.reduce((a, i) => a + residualDemands[i], 0)
    let capY = 0
    for (const j of Yidx) {
      const degree = Zidx.reduce((n, i) => n + (residualEligible[i][j] ? 1 : 0), 0)
      capY += Math.min(residualCapacities[j], degree)
    }
    const forcedCount = forcedPerPaper.reduce((a, b) => a + b, 0)
    reasons.push({
      kind: 'subset-bottleneck',
      paperIds: Zset.map((p) => p.id),
      reviewerIds: Yset.map((r) => r.id),
      deficit: demandZ - capY,
      message:
        `存在一组 ${Zset.length} 篇稿件，其可选评审人范围相互重叠、形成容量瓶颈：它们在预指派之外共需补足 ${demandZ} 个名额，` +
        `而 ${Yset.length} 位无冲突的评审人对这组稿件至多能再承担 ${capY} 个名额（缺口 ${demandZ - capY}，已计入每位评审人对同一篇稿件至多评一次）。\n` +
        `瓶颈稿件：${Zset.map((p) => `《${p.title}》`).join('、')}；\n` +
        `可选评审人：${Yset.length ? Yset.map((r) => r.name).join('、') : '（无，全部存在利益冲突或已被预指派占用）'}。\n` +
        (forcedCount > 0 ? `当前共有 ${forcedCount} 条预指派作为硬约束已先行占用名额。\n` : '') +
        `建议：为这些稿件补充评审人、解除部分冲突、调整预指派或提高相关评审人容量。`
    })
  }

  return {
    feasible: feas.feasible,
    reasons: feas.feasible ? [] : [...perPaperFailures, ...reasons],
    papers,
    reviewers,
    eligible,
    demands,
    capacities,
    totalRequired,
    forcedKeys: preassign.forcedKeys,
    forced,
    residualDemands,
    residualCapacities
  }
}

/**
 * 核心入口：执行盲审分配。
 *
 * 硬约束（全部必须满足，否则不可行）:
 *  1. 预指派：用户在稿件上指定的评审人必须分派（求解前逐条校验，失效即整体失败）；
 *  2. 利益冲突：声明冲突的稿件-评审人对绝不分配；
 *  3. 容量：每位评审人承担稿件数不超过 capacity；
 *  4. 人数：每篇稿件恰好得到 reviewsRequired 位互不相同的评审人。
 *
 * 优化目标（硬约束满足后）:
 *  第一优先 最大化稿件主题标签与评审人擅长标签的匹配数；
 *  第二优先 最小化评审人最大负载（负载均衡）。
 */
export function solveAssignment(rawData: AppData): AssignmentResult {
  // ---- 硬约束可行性（与缺席压力测试共用同一套判定逻辑） ----
  const hc = evaluateHardConstraints(rawData)
  if (!hc.feasible) {
    return { feasible: false, reasons: hc.reasons }
  }

  // ---- 硬约束可行：用整数规划做目标优化（预指派对强制取 1） ----
  return optimize(
    hc.papers,
    hc.reviewers,
    hc.eligible,
    hc.demands,
    hc.totalRequired,
    hc.forced,
    hc.forcedKeys
  )
}

/* ------------------------------ 整数规划优化 ------------------------------ */

interface PhaseSolution {
  feasible: boolean
  /** 最优主题匹配数 */
  matches: number
  /** 求解器原始结果，用于读取变量取值 */
  raw: Record<string, number>
}

/**
 * 阶段模型：在“每位评审人负载 ≤ capLimit（缺省取自身容量）”下最大化主题匹配数。
 *
 * 约束矩阵是带容量二部图（b-匹配 / 运输问题）的节点-关联阵，全幺模：
 * LP 松弛的顶点解天然为整数，javascript-lp-solver 无需真正分支即可快速求得 0/1 最优解。
 *
 * 预指派对通过 min: 1 约束强制取 1（可行性检验已保证它们不冲突、不超容量、不超名额）。
 */
function runPhase(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  demands: number[],
  totalRequired: number,
  capLimit: number | null,
  forced: boolean[][]
): PhaseSolution {
  const P = papers.length
  const R = reviewers.length

  const model: {
    optimize: string
    opType: 'max'
    constraints: Record<string, Record<string, number>>
    variables: Record<string, Record<string, number>>
    binaries: Record<string, 1>
  } = {
    optimize: 'objective',
    opType: 'max',
    constraints: {},
    variables: {},
    binaries: {}
  }

  papers.forEach((_, i) => {
    model.constraints[`paper_${i}`] = { equal: demands[i] }
  })
  // 每位评审人被预指派预占的名额：收紧最大负载 L 时必须为预指派保留名额，
  // 即非预指派分派至多 L - 预占数；同时不能超过真实容量。
  const forcedByReviewer = reviewers.map((_, j) => forced.reduce((n, row) => n + (row[j] ? 1 : 0), 0))
  reviewers.forEach((r, j) => {
    // capLimit=null：真实容量；否则非预指派分派至多 L − 预占数（仍不超过真实容量）
    const cap =
      capLimit === null ? r.capacity : Math.max(forcedByReviewer[j], Math.min(r.capacity, capLimit) - forcedByReviewer[j])
    model.constraints[`reviewer_${j}`] = { max: cap }
  })

  for (let i = 0; i < P; i++) {
    for (let j = 0; j < R; j++) {
      if (!eligible[i][j]) continue // 冲突对不生成变量 —— 硬约束：利益冲突
      const varName = `x_${i}_${j}`
      const matched = matchedTagsOf(papers[i], reviewers[j]).length > 0
      model.binaries[varName] = 1
      model.variables[varName] = {
        [`paper_${i}`]: 1,
        [`reviewer_${j}`]: 1,
        objective: matched ? 1 : 0
      }
      if (forced[i][j]) {
        // 预指派硬约束：该变量必须取 1
        const forceName = `force_${i}_${j}`
        model.constraints[forceName] = { min: 1 }
        model.variables[varName][forceName] = 1
      }
    }
  }

  const res = solver.Solve(model as never) as Record<string, number | boolean>

  // 以实际取到 1 的变量数为准判定可行性（兼容求解器对 infeasible 返回 -0 的行为）
  let chosen = 0
  for (const v of Object.keys(model.variables)) {
    if (Math.round((res[v] as number) ?? 0) === 1) chosen++
  }
  const feasible = chosen === totalRequired && res.feasible !== false
  return { feasible, matches: feasible ? Math.round((res.result as number) ?? 0) : 0, raw: res as unknown as Record<string, number> }
}

function parseSolution(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  raw: Record<string, number>,
  forced: boolean[][]
): AssignmentItem[] {
  const P = papers.length
  const R = reviewers.length
  const assignments: AssignmentItem[] = []
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < R; j++) {
      if (!eligible[i][j]) continue
      if (Math.round(raw[`x_${i}_${j}`] ?? 0) !== 1) continue
      const matched = matchedTagsOf(papers[i], reviewers[j])
      assignments.push({
        paperId: papers[i].id,
        reviewerId: reviewers[j].id,
        topicMatched: matched.length > 0,
        matchedTags: matched,
        preassigned: forced[i][j]
      })
    }
  }
  return assignments.sort((a, b) => a.paperId.localeCompare(b.paperId) || a.reviewerId.localeCompare(b.reviewerId))
}

function buildSuccess(
  reviewers: Reviewer[],
  assignments: AssignmentItem[],
  totalRequired: number
): AssignmentSuccess {
  const counts = new Map<string, number>()
  for (const a of assignments) counts.set(a.reviewerId, (counts.get(a.reviewerId) ?? 0) + 1)
  const loads: ReviewerLoad[] = reviewers.map((r) => ({
    reviewerId: r.id,
    assigned: counts.get(r.id) ?? 0,
    capacity: r.capacity
  }))

  return {
    feasible: true,
    assignments: [...assignments].sort((a, b) => a.paperId.localeCompare(b.paperId) || a.reviewerId.localeCompare(b.reviewerId)),
    loads,
    objective: {
      topicMatches: assignments.filter((a) => a.topicMatched).length,
      maxLoad: Math.max(0, ...loads.map((l) => l.assigned)),
      totalAssigned: assignments.length,
      totalRequired,
      preassignedCount: assignments.filter((a) => a.preassigned).length
    }
  }
}

function optimize(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  demands: number[],
  totalRequired: number,
  forced: boolean[][],
  forcedKeys: ForcedKey[]
): AssignmentSuccess {
  const R = reviewers.length

  // 阶段一：真实容量下最大化主题匹配数，得到最优匹配数 M*（预指派对强制取 1）
  const phase1 = runPhase(papers, reviewers, eligible, demands, totalRequired, null, forced)

  // 理论上最大流已保证可行；求解器异常时退回贪心可行解
  if (!phase1.feasible) {
    return greedyFallback(papers, reviewers, eligible, demands, totalRequired, forced)
  }
  const bestMatches = phase1.matches
  let bestRaw = phase1.raw

  // 阶段二：在不损失任何主题匹配（匹配数仍为 M*）的前提下，二分最小化最大负载 L。
  // 上界直接取阶段一解的最大负载，下界取总名额按人均摊的向上取整。
  const phase1Items = parseSolution(papers, reviewers, eligible, phase1.raw, forced)
  const phase1Counts = new Map<string, number>()
  for (const a of phase1Items) phase1Counts.set(a.reviewerId, (phase1Counts.get(a.reviewerId) ?? 0) + 1)
  const upperL = Math.max(1, ...reviewers.map((r) => phase1Counts.get(r.id) ?? 0))
  let lo = Math.max(1, Math.ceil(totalRequired / R))
  let hi = upperL

  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const r = runPhase(papers, reviewers, eligible, demands, totalRequired, mid, forced)
    if (r.feasible && r.matches === bestMatches) {
      hi = mid
      bestRaw = r.raw
    } else {
      lo = mid + 1
    }
  }

  const assignments = parseSolution(papers, reviewers, eligible, bestRaw, forced)
  const present = new Set(assignments.map((a) => `${a.paperId}|${a.reviewerId}`))
  if (
    assignments.length !== totalRequired ||
    forcedKeys.some((k) => !present.has(`${k.paperId}|${k.reviewerId}`))
  ) {
    // 数量不符或有预指派未兑现：回退贪心（最大流已保证可行解存在）
    return greedyFallback(papers, reviewers, eligible, demands, totalRequired, forced)
  }
  return buildSuccess(reviewers, assignments, totalRequired)
}

/** 求解器异常时的兜底：先无条件放置全部预指派，再按主题匹配优先、当前负载最低贪心补足（最大流已保证存在可行解） */
function greedyFallback(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  demands: number[],
  totalRequired: number,
  forced: boolean[][]
): AssignmentSuccess {
  const assigned = new Map<string, number>(reviewers.map((r) => [r.id, 0]))
  const assignments: AssignmentItem[] = []
  const placed = new Set<string>()

  // 1) 预指派先落位（可行性检验已保证不冲突、不超容量、不超名额）
  for (let i = 0; i < papers.length; i++) {
    for (let j = 0; j < reviewers.length; j++) {
      if (!forced[i][j]) continue
      const matched = matchedTagsOf(papers[i], reviewers[j])
      assignments.push({
        paperId: papers[i].id,
        reviewerId: reviewers[j].id,
        topicMatched: matched.length > 0,
        matchedTags: matched,
        preassigned: true
      })
      assigned.set(reviewers[j].id, (assigned.get(reviewers[j].id) ?? 0) + 1)
      placed.add(`${i}|${j}`)
    }
  }

  // 2) 剩余名额贪心补足（排除已落位的预指派对，避免同人重复）
  const ordered = papers
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.reviewsRequired - a.p.reviewsRequired)
  for (const { p, i } of ordered) {
    const choices = reviewers
      .map((r, j) => ({ r, j, matched: matchedTagsOf(p, r) }))
      .filter(({ j }) => eligible[i][j] && !placed.has(`${i}|${j}`))
      .sort((a, b) => {
        if ((a.matched.length > 0 ? 1 : 0) !== (b.matched.length > 0 ? 1 : 0)) return b.matched.length - a.matched.length
        return (assigned.get(a.r.id) ?? 0) - (assigned.get(b.r.id) ?? 0)
      })
    const stillNeed = demands[i] - forced[i].filter(Boolean).length
    for (let k = 0; k < stillNeed; k++) {
      const pick = choices[k]
      if (!pick) break
      assigned.set(pick.r.id, (assigned.get(pick.r.id) ?? 0) + 1)
      assignments.push({
        paperId: p.id,
        reviewerId: pick.r.id,
        topicMatched: pick.matched.length > 0,
        matchedTags: pick.matched,
        preassigned: false
      })
    }
  }

  return buildSuccess(reviewers, assignments, totalRequired)
}
