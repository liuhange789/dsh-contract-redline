/**
 * 合同风险速查规则集（MVP）：通用规则 + 采购/服务专项 + 租赁专项。
 *
 * 只按预设规则定位条款、标注风险点，并给出预写的白话解释：
 * 不生成法律意见，不判断合同效力，不评价该不该签。
 *
 * @module dsh-contract-redline/rules
 */

/** 输出版本号，便于用户知道规则集是哪一版。 */
export const RULE_VERSION = '2026.11'

/** 固定免责声明，出现在每次结果里。 */
export const DISCLAIMER =
  '仅为条款位置与风险提示，不构成法律意见，不判断合同是否有效，不替代律师；重要合同请交由专业人士审阅。'

/** 条款正文过长时的摘录上限。 */
const EXCERPT_MAX = 90

/** 合同类型标签。 */
const TYPE_LABELS = {
  procurement: '采购 / 供货合同',
  lease: '租赁合同',
  service: '服务 / 委托合同',
  unknown: '未识别类型（按通用规则扫描）',
}

/**
 * 统计命中次数。
 * @param {string} text - 文本。
 * @param {RegExp} pattern - 全局正则。
 * @returns {number} 命中次数。
 */
function count(text, pattern) {
  const matches = text.match(pattern)
  return matches ? matches.length : 0
}

/**
 * 识别合同类型（关键词打分，取最高分）。
 * @param {string} text - 合同全文。
 * @returns {'procurement'|'lease'|'service'|'unknown'} 类型。
 */
export function detectContractType(text) {
  const lease = count(text, /租赁|出租|承租|押金|租金|租期|退租/g) * 2
  const procurement = count(text, /采购|供货|供应商|采购方|验收|质保|到货/g) * 2
  const service = count(text, /服务|委托|服务费|甲方委托|乙方提供服务/g)
  if (lease >= Math.max(procurement, service) && lease >= 4) return 'lease'
  if (procurement >= Math.max(lease, service) && procurement >= 4) return 'procurement'
  if (service >= 4) return 'service'
  return 'unknown'
}

/**
 * 把合同切成条款：优先按“第 X 条 / 【标题】/ 序号”分行，退化时按空行分段。
 * @param {string} text - 合同全文。
 * @returns {string[]} 条款文本。
 */
export function splitClauses(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n')
  const clauseMarker = /^(第[一二三四五六七八九十百零\d]+条|第[一二三四五六七八九十百零\d]+款|【[^】]{1,10}】|[一二三四五六七八九十]+、|\d+[.、]|（[一二三四五六七八九十]+）)/

  const blocks = []
  let current = null
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim()
    if (!line) {
      if (current && current.trim()) blocks.push(current.trim())
      current = null
      continue
    }
    if (clauseMarker.test(line)) {
      if (current && current.trim()) blocks.push(current.trim())
      current = line
    } else {
      current = current ? `${current}\n${line}` : line
    }
  }
  if (current && current.trim()) blocks.push(current.trim())

  if (blocks.length >= 3) return blocks

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map(part => part.trim())
    .filter(Boolean)
  return paragraphs.length >= 3 ? paragraphs : [normalized.trim()].filter(Boolean)
}

/**
 * 截取条款中命中位置附近的一段正文。
 * @param {string} segment - 条款文本。
 * @param {RegExp} pattern - 命中正则（不带 g 也可）。
 * @returns {string} 摘录，最多 EXCERPT_MAX 字。
 */
function excerptOf(segment, pattern) {
  const source = segment.replace(/\s+/g, ' ').trim()
  const plain = new RegExp(pattern.source, pattern.flags.replace('g', ''))
  const match = source.match(plain)
  if (!match) return source.slice(0, EXCERPT_MAX)
  const start = Math.max(0, match.index - 12)
  const end = Math.min(source.length, match.index + match[0].length + 40)
  const body = source.slice(start, end)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < source.length ? '…' : ''
  return `${prefix}${body}${suffix}`.slice(0, EXCERPT_MAX)
}

/**
 * 判断某个条款是否只把解除权给了一方。
 * @param {string} segment - 条款文本。
 * @returns {boolean} 是否单方解除。
 */
function isOneSidedTermination(segment) {
  const parties = ['甲方', '乙方', '出租方', '承租方', '采购方', '供应商', '服务方', '委托方']
    .filter(party => segment.includes(party))
  if (parties.length < 2) {
    return /(有权|可以|可)[^。；\n]{0,8}(单方|随时)[^。；\n]{0,8}(解除|终止)/.test(segment)
  }
  const granted = parties.filter(party => new RegExp(
    `${party}[^。；\\n]{0,18}(有权|可以|可)[^。；\\n]{0,10}(解除|终止)`,
  ).test(segment))
  return granted.length === 1 && /(解除|终止)/.test(segment)
}

/**
 * 判断条款里的付款时间是否只写了模糊表述。
 * @param {string} segment - 条款文本。
 * @returns {boolean} 是否缺少明确期限。
 */
function isVaguePaymentTerm(segment) {
  if (!/(支付|付款|结算)/.test(segment)) return false
  if (/\d+\s*(日|天|个工作日|周|个月)/.test(segment)) return false
  return /(另行协商|视情况|尽快|适时|双方另行|收到发票后|验收合格后)[^。；\n]{0,12}(支付|付款|结算)/.test(segment)
}

/**
 * 判断验收条款是否只有“符合要求 / 甲方认可”这类不可量化表述。
 * @param {string} segment - 条款文本。
 * @returns {boolean} 是否不可量化。
 */
function isVagueAcceptance(segment) {
  if (!/验收/.test(segment)) return false
  if (/(\d+|%|合格率|抽检|检测报告|参数|型号|清单|样品|技术标准|国标|行业标准)/.test(segment)) return false
  return /(符合|满足)[^。；\n]{0,10}(要求|需要)|(甲方|采购方)[^。；\n]{0,6}(认可|确认|满意)/.test(segment)
}

/** 通用高风险规则（所有合同适用）。 */
const GENERAL_HIGH_RISK = [
  {
    id: 'jurisdiction-one-sided',
    title: '管辖地固定在单方所在地',
    pattern: /(甲方|乙方|出卖方|买受方|出租方|承租方|供应商|采购方|服务方|委托方)\s*所在地[^。；\n]{0,25}(人民法院|法院|仲裁委员会|仲裁)/,
    reason: '出问题要去对方所在地起诉或仲裁，差旅和时间成本可能比争议金额还高；签字前确认这个城市对你是否方便。',
  },
  {
    id: 'auto-renew',
    title: '自动续约 / 自动顺延',
    pattern: /自动(续约|续期|延期|顺延|延长)/,
    reason: '到期不主动提出异议就自动续期，容易错过退出窗口、被动多承担一期费用。',
  },
  {
    id: 'unlimited-liability',
    title: '责任表述过宽（全部 / 一切损失）',
    pattern: /承担(全部|一切|所有)[^。；\n]{0,6}(损失|责任|费用|后果)|无限连带/,
    reason: '“全部损失”“一切责任”没有上限，赔偿范围可能超出合同金额，需要约定可预见且封顶的责任。',
  },
  {
    id: 'one-sided-change',
    title: '单方变更权 / 最终解释权',
    pattern: /(有权|可以)[^。；\n]{0,10}(变更|调整)[^。；\n]{0,12}(价格|费用|条款|内容|标准)|最终解释权/,
    reason: '对方可以单方面改价格或条款，你签完只承担结果；这类权利通常应改为双方书面确认。',
  },
]

/** 采购 / 供货 / 服务合同专项高风险。 */
const PROCUREMENT_HIGH_RISK = [
  {
    id: 'vague-payment-term',
    title: '付款时间没有明确期限',
    pattern: /(支付|付款|结算)/,
    evaluate: isVaguePaymentTerm,
    reason: '只写“验收合格后支付”“另行协商”，没有具体天数，对方可以无限期拖款；应写明账期（如验收后 30 日内）。',
  },
  {
    id: 'vague-acceptance',
    title: '验收标准不可量化',
    pattern: /验收/,
    evaluate: isVagueAcceptance,
    reason: '“符合甲方要求”“甲方认可”没有客观标准，验收是否通过完全由对方判断，尾款和质保责任容易被卡住。',
  },
  {
    id: 'full-prepayment',
    title: '要求一次性全额预付',
    pattern: /(一次性|全额|预付|先付)[^。；\n]{0,12}(支付|付款|付清|货款)/,
    reason: '钱先付完、对方再履约，一旦对方延期或跑路，追回成本很高；通常应分期并把尾款与验收挂钩。',
  },
]

/** 租赁合同专项高风险。 */
const LEASE_HIGH_RISK = [
  {
    id: 'deposit-no-refund',
    title: '押金没有约定退还条件',
    pattern: /(押金|保证金)/,
    evaluate: segment => /(押金|保证金)/.test(segment) && !/(退还|返还|退回)/.test(segment),
    reason: '只写收多少押金、不写什么条件下退、多久退，退租时容易以“房屋损耗”等理由被全部扣留。',
  },
  {
    id: 'repair-one-sided',
    title: '维修责任全压给一方',
    pattern: /(维修|修缮|修理)/,
    evaluate: segment => {
      if (!/(维修|修缮|修理)/.test(segment)) return false
      const hasTenant = /(承租方|乙方)/.test(segment)
      const hasLandlord = /(出租方|甲方)/.test(segment)
      if (hasTenant !== hasLandlord) return true
      if (!hasTenant && !hasLandlord) return false
      const bearers = ['出租方', '承租方', '甲方', '乙方'].filter(party => new RegExp(
        `${party}[^。；\\n]{0,15}(承担|负责|应)[^。；\\n]{0,10}(维修|修缮|修理)`,
      ).test(segment))
      return bearers.length === 1
    },
    reason: '房屋主体、管道、电器等维修责任不区分归属，全部压给一方时，一次大修就可能超过押金。',
  },
]

/** 权利义务不对等规则。 */
const UNBALANCED_RULES = [
  {
    id: 'one-sided-termination',
    title: '只有一方可以解除 / 提前终止',
    pattern: /(解除|终止)/,
    evaluate: isOneSidedTermination,
    appliesTo: ['procurement', 'lease', 'service', 'unknown'],
    reason: '对方可以随时抽身，你却没有对应权利；应争取对等的提前通知期和解约条件。',
  },
  {
    id: 'one-sided-liability',
    title: '违约责任只约束一方',
    pattern: /(违约金|赔偿|罚款|违约责任)/,
    evaluate: segment => {
      if (!/(违约金|赔偿|罚款|违约责任)/.test(segment)) return false
      const penalized = ['乙方', '承租方', '供应商', '服务方'].filter(party => segment.includes(party))
      const other = ['甲方', '出租方', '采购方', '委托方'].filter(party => segment.includes(party))
      if (!penalized.length) return false
      return !other.length
    },
    appliesTo: ['procurement', 'lease', 'service', 'unknown'],
    reason: '条款只列一方的违约金和赔偿责任，另一方违约没有对应后果，出了事很难追责。',
  },
]

/** 关键条款缺失检查（按合同类型）。 */
const MISSING_RULES = [
  {
    id: 'missing-dispute',
    label: '争议解决方式（仲裁或诉讼管辖）',
    keywords: /争议[^。；\n]{0,10}(解决|处理)|仲裁|人民法院|诉讼/,
    appliesTo: ['procurement', 'lease', 'service', 'unknown'],
  },
  {
    id: 'missing-term',
    label: '合同期限与生效条件',
    keywords: /有效期|合同期限|租期|租赁期|自[^。；\n]{0,24}(生效|起)|生效日期|终止日期/,
    appliesTo: ['procurement', 'lease', 'service', 'unknown'],
  },
  {
    id: 'missing-payment',
    label: '付款条件与账期',
    keywords: /付款|支付|结算|账期/,
    appliesTo: ['procurement', 'service'],
  },
  {
    id: 'missing-acceptance',
    label: '验收标准与流程',
    keywords: /验收/,
    appliesTo: ['procurement', 'service'],
  },
  {
    id: 'missing-ip',
    label: '知识产权 / 成果归属',
    keywords: /知识产权|著作权|成果归属|专利|商标/,
    appliesTo: ['procurement', 'service'],
  },
  {
    id: 'missing-deposit',
    label: '押金及退还条件',
    keywords: /押金|保证金/,
    appliesTo: ['lease'],
  },
  {
    id: 'missing-repair',
    label: '维修责任划分',
    keywords: /维修|修缮|修理/,
    appliesTo: ['lease'],
  },
  {
    id: 'missing-early-exit',
    label: '提前解约条款',
    keywords: /提前[^。；\n]{0,6}(解除|终止|退租)/,
    appliesTo: ['lease'],
  },
]

/**
 * 选取适用于当前合同类型的规则。
 * @param {object[]} rules - 规则数组。
 * @param {string} type - 合同类型。
 * @returns {object[]} 适用规则。
 */
function rulesFor(rules, type) {
  return rules.filter(rule => !rule.appliesTo || rule.appliesTo.includes(type))
}

/**
 * 对一份合同执行规则扫描。
 * @param {string} text - 合同全文。
 * @param {{ contractType?: 'auto'|'procurement'|'lease'|'service' }} [options] - 可选类型覆盖。
 * @returns {object} 风险清单。
 */
export function scanContract(text, options = {}) {
  const source = String(text ?? '')
  if (source.trim().length < 80) {
    throw new Error('合同文本太短：请粘贴完整条款正文（至少 80 个字符）。')
  }
  const clauses = splitClauses(source)
  const requested = options.contractType
  const type = requested && requested !== 'auto' ? requested : detectContractType(source)

  const highRisk = []
  const unbalanced = []

  const collect = (rules, bucket) => {
    for (const rule of rules) {
      for (const clause of clauses) {
        const matched = rule.evaluate ? rule.evaluate(clause) : new RegExp(rule.pattern.source, rule.pattern.flags).test(clause)
        if (!matched) continue
        bucket.push({
          id: rule.id,
          clause: rule.title,
          excerpt: excerptOf(clause, rule.pattern),
          reason: rule.reason,
        })
        break
      }
    }
  }

  const appliesTo = type === 'unknown' ? ['procurement', 'lease', 'service'] : [type]
  const highRiskRules = [
    ...GENERAL_HIGH_RISK,
    ...(appliesTo.includes('procurement') || appliesTo.includes('service') ? PROCUREMENT_HIGH_RISK : []),
    ...(appliesTo.includes('lease') ? LEASE_HIGH_RISK : []),
  ]
  collect(highRiskRules, highRisk)
  collect(rulesFor(UNBALANCED_RULES, type), unbalanced)

  const missing = MISSING_RULES
    .filter(rule => rule.appliesTo.includes(type))
    .filter(rule => !rule.keywords.test(source))
    .map(rule => rule.label)

  const summary = buildOneLiner(type, clauses.length, highRisk.length, unbalanced.length, missing.length)

  return {
    contract_type: type,
    contract_type_label: TYPE_LABELS[type],
    clause_count: clauses.length,
    rule_version: RULE_VERSION,
    high_risk: highRisk,
    unbalanced,
    missing,
    summary,
    disclaimer: DISCLAIMER,
  }
}

/**
 * 一句话总结：只报数量与下一步动作，不评价该不该签。
 * @param {string} type - 合同类型。
 * @param {number} clauseCount - 条款数。
 * @param {number} highCount - 高风险数。
 * @param {number} unbalancedCount - 不对等条款数。
 * @param {number} missingCount - 缺失项数。
 * @returns {string} 总结句。
 */
function buildOneLiner(type, clauseCount, highCount, unbalancedCount, missingCount) {
  const label = TYPE_LABELS[type]
  if (highCount + unbalancedCount + missingCount === 0) {
    return `按 ${RULE_VERSION} 规则集扫描 ${clauseCount} 条条款（${label}），未命中已收录的风险模式；仍需人工核对未收录的行业特殊条款。`
  }
  return `按 ${RULE_VERSION} 规则集扫描 ${clauseCount} 条条款（${label}）：高风险 ${highCount} 处、权利义务不对等 ${unbalancedCount} 处、关键条款缺失 ${missingCount} 项。可先就标记项逐条向对方确认，再决定签署或送律师审阅。`
}

/**
 * 渲染为会话里可直接阅读的风险清单文本。
 * @param {object} result - {@link scanContract} 的返回值。
 * @returns {string} 文本报告。
 */
export function formatRiskReport(result) {
  const lines = [
    '【合同风险速查】',
    `识别类型：${result.contract_type_label}｜条款 ${result.clause_count} 条｜规则集 ${result.rule_version}`,
    result.summary,
    '',
  ]

  const renderItems = (title, items) => {
    lines.push(`${title}（${items.length}）`)
    if (items.length === 0) {
      lines.push('  - 无')
    } else {
      items.forEach((item, index) => {
        lines.push(`  ${index + 1}. ${item.clause}`)
        lines.push(`     条款：${item.excerpt}`)
        lines.push(`     为什么：${item.reason}`)
      })
    }
    lines.push('')
  }

  renderItems('高风险条款', result.high_risk)
  renderItems('权利义务不对等', result.unbalanced)
  lines.push(`关键条款缺失（${result.missing.length}）`)
  lines.push(result.missing.length === 0 ? '  - 无' : result.missing.map(item => `  - ${item}`).join('\n'))
  lines.push('')
  lines.push(`声明：${result.disclaimer}`)
  return lines.join('\n')
}
