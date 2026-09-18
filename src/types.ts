/** 领域数据模型 */

export interface Paper {
  id: string
  title: string
  /** 该稿件需要的评审人数 */
  reviewsRequired: number
  /** 主题标签 */
  tags: string[]
  /**
   * 预指派评审人 id 列表（硬约束）：生成分派时这些评审人必须评阅本稿。
   * 可选字段，旧数据缺省视为空列表；允许暂时引用失效对象（评审人已删除等），
   * 失效关系由界面与求解器显式报告，不在这里静默清除。
   */
  preassignedReviewerIds?: string[]
}

export interface Reviewer {
  id: string
  name: string
  /** 擅长标签 */
  tags: string[]
  /** 最多承担的稿件数（容量） */
  capacity: number
  /** 声明利益冲突的稿件 id */
  conflictPaperIds: string[]
}

export interface AppData {
  papers: Paper[]
  reviewers: Reviewer[]
}

/** 单篇稿件的一条分配结果 */
export interface AssignmentItem {
  paperId: string
  reviewerId: string
  /** 是否命中至少一个共同主题标签 */
  topicMatched: boolean
  /** 命中的共同标签 */
  matchedTags: string[]
  /** 是否来自用户预指派（预指派关系作为硬约束被求解器兑现） */
  preassigned: boolean
}

/** 评审人在结果中的负载信息 */
export interface ReviewerLoad {
  reviewerId: string
  assigned: number
  capacity: number
}

/** 预指派关系的失效/违规种类（求解前逐条校验） */
export type PreassignmentIssueKind =
  | 'preassigned-reviewer-missing'
  | 'preassigned-conflict'
  | 'preassigned-over-capacity'
  | 'preassigned-over-quota'

/** 一条失效或违规的预指派关系 */
export interface PreassignmentIssue {
  kind: PreassignmentIssueKind
  paperId: string
  reviewerId: string
  /** 人类可读的具体原因（含稿件名/评审人名，失效对象回退为其 id） */
  message: string
  /** over-capacity 时该评审人被预占的名额数 / 容量；over-quota 时本稿预指数 / 需求名额 */
  preassignedCount?: number
  limit?: number
}

export type InfeasibleKind =
  | PreassignmentIssueKind
  | 'global-capacity'
  | 'paper-eligible'
  | 'subset-bottleneck'

export interface InfeasibleReason {
  kind: InfeasibleKind
  message: string
  /** paper-eligible: 对应稿件 id 列表 */
  paperIds?: string[]
  /** subset-bottleneck / global-capacity: 瓶颈涉及的评审人 id 列表 */
  reviewerIds?: string[]
  /** subset-bottleneck 时: 缺口数量 */
  deficit?: number
  /** kind 为预指派类时：对应的结构化失效关系（稿件/评审人/原因） */
  issue?: PreassignmentIssue
}

export interface AssignmentSuccess {
  feasible: true
  assignments: AssignmentItem[]
  loads: ReviewerLoad[]
  objective: {
    topicMatches: number
    maxLoad: number
    totalAssigned: number
    totalRequired: number
    /** 其中来自预指派硬约束的分派条数 */
    preassignedCount: number
  }
  /** 是否经过「分派互换」人工调整（重新生成分派后清空） */
  manuallyAdjusted?: boolean
  /** 累计执行的一换一互换次数（仅用于展示与导出追溯） */
  swapCount?: number
}

export interface AssignmentFailure {
  feasible: false
  reasons: InfeasibleReason[]
}

export type AssignmentResult = AssignmentSuccess | AssignmentFailure

/* ------------------------- 评审人缺席压力测试 ------------------------- */

/** 缺席场景中的“可选评审人瓶颈”见证条目 */
export interface StressBottleneckReviewer {
  reviewerId: string
  /** 评审人自身容量 */
  capacity: number
  /** 在受影响稿件组内可评（无利益冲突）的稿件数 */
  eligiblePaperCount: number
  /** 对该稿件组至多能承担的名额 = min(容量, 组内可评稿件数) */
  capacityForGroup: number
}

/** 缺席场景中的受影响稿件 */
export interface StressAffectedPaper {
  paperId: string
  /** 该稿件所需评审人数 */
  required: number
  /** 缺席后仍可分配（无冲突且容量 > 0）的评审人数 */
  available: number
  /** 该稿件自身的名额缺口（available < required 时 > 0；否则为 0，表示仅参与组合性瓶颈） */
  shortfall: number
}

/** 单个评审人完全缺席（容量置 0）的模拟结果 */
export interface StressScenario {
  reviewerId: string
  /** 该评审人被抽走的原容量 */
  capacity: number
  feasible: boolean
  /** 人类可读结论 */
  message: string
  /** —— 不可行时的结构化诊断（可行时缺省） —— */
  /** 受影响稿件（Hall 缺陷稿件组，单篇不足者在前） */
  affectedPapers?: StressAffectedPaper[]
  /** 组合性瓶颈名额缺口（广义 Hall 紧见证：组需求 - 可选评审人至多承担量） */
  deficit?: number
  /** 缺席后全局剩余总容量相对总需求的缺口（可能为 0，此时缺口纯为组合性瓶颈） */
  globalDeficit?: number
  /** 缺席后剩余总容量 */
  remainingCapacity?: number
  /** 可选评审人瓶颈（Hall 见证评审人集合） */
  bottleneckReviewers?: StressBottleneckReviewer[]
}

export interface StressTestReport {
  /** 运行时录入数据指纹；数据变化后与当前指纹不一致即标记过期 */
  fingerprint: string
  runAt: string
  /** 参与模拟的评审人数（容量 > 0） */
  testedReviewerCount: number
  totalRequired: number
  totalCapacity: number
  feasibleCount: number
  infeasibleCount: number
  scenarios: StressScenario[]
}
