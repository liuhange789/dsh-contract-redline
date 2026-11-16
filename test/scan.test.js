import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DISCLAIMER,
  detectContractType,
  formatRiskReport,
  scanContract,
  splitClauses,
} from '../src/rules.js'
import { CLEAN_LEASE, LEASE, PROCUREMENT, SAMPLES, SERVICE } from './samples.js'

for (const sample of SAMPLES) {
  test(`命中预设风险点：${sample.name}`, () => {
    const result = scanContract(sample.text)
    assert.equal(result.contract_type, sample.type)
    assert.ok(result.clause_count >= 6, `条款切分过少：${result.clause_count}`)

    const ids = [...result.high_risk, ...result.unbalanced].map(item => item.id)
    for (const expected of sample.expected) {
      assert.ok(ids.includes(expected), `未命中预设风险点 ${expected}，实际：${ids.join(', ')}`)
    }
    for (const missing of sample.missing) {
      assert.ok(result.missing.includes(missing), `未识别缺失条款 ${missing}`)
    }
  })
}

for (const sample of SAMPLES) {
  test(`不输出法律意见：${sample.name}`, () => {
    const result = scanContract(sample.text)
    const report = formatRiskReport(result)
    const forbidden = /建议(你|您)?(签|不签)|不建议签|可以签|不能签|合同无效|该合同无效|违反法律|违法/
    assert.equal(forbidden.test(report), false, '报告里出现了“签不签 / 是否无效”这类判断')
    assert.equal(forbidden.test(JSON.stringify(result.high_risk)), false)
    assert.equal(forbidden.test(result.summary), false)
    assert.equal(result.disclaimer, DISCLAIMER)
  })
}

test('风险条目结构完整：标题、摘录、白话解释', () => {
  const result = scanContract(PROCUREMENT)
  for (const item of [...result.high_risk, ...result.unbalanced]) {
    assert.ok(item.clause.length > 0)
    assert.ok(item.excerpt.length > 0)
    assert.ok(item.excerpt.length <= 90, `摘录过长：${item.excerpt.length}`)
    assert.ok(item.reason.length > 10, '缺少白话解释')
  }
})

test('条款对等的合同不误报，且缺失项为空', () => {
  const result = scanContract(CLEAN_LEASE)
  assert.equal(result.contract_type, 'lease')
  assert.equal(result.high_risk.length, 0)
  assert.equal(result.unbalanced.length, 0)
  assert.deepEqual(result.missing, [])
  assert.match(result.summary, /未命中已收录的风险模式/)
})

test('维修条款不再被误判为“违约责任只约束一方”，租期也算期限条款', () => {
  const result = scanContract(LEASE)
  const unbalancedIds = result.unbalanced.map(item => item.id)
  assert.deepEqual(unbalancedIds, ['one-sided-termination'])
  assert.equal(result.missing.includes('合同期限与生效条件'), false)
  assert.deepEqual(result.missing, ['争议解决方式（仲裁或诉讼管辖）'])
})

test('类型识别与手动覆盖', () => {
  assert.equal(detectContractType(PROCUREMENT), 'procurement')
  assert.equal(detectContractType(LEASE), 'lease')
  assert.equal(detectContractType(SERVICE), 'service')
  assert.equal(scanContract(SERVICE, { contractType: 'procurement' }).contract_type, 'procurement')
})

test('条款切分按“第 X 条”分行', () => {
  const clauses = splitClauses(PROCUREMENT)
  assert.ok(clauses.length >= 8)
  assert.ok(clauses.some(clause => /^第一条/.test(clause.trim())), '应包含“第一条”作为独立条款')
})

test('文本过短直接报错，不猜结论', () => {
  assert.throws(() => scanContract('甲方乙方签个合同。'), /至少 80 个字符/)
})

test('报告按区块渲染，末尾带声明', () => {
  const report = formatRiskReport(scanContract(LEASE))
  assert.match(report, /【合同风险速查】/)
  assert.match(report, /高风险条款/)
  assert.match(report, /权利义务不对等/)
  assert.match(report, /关键条款缺失/)
  assert.match(report, /声明：/)
})

/** 只有 Word 折行、没有“第 X 条”标记的租赁合同。 */
const UNNUMBERED_LEASE = `房屋租赁合同
出租方（甲方）：某物业管理公司
承租方（乙方）：某设计工作室
甲方将位于某园区的 302 室出租给乙方作办公使用
建筑面积 120 平方米
租期自 2026 年 1 月 1 日起至 2026 年 12 月 31 日止
月租金 6000 元
押金为三个月租金用于担保乙方履行本合同义务
租赁期内房屋及附属设施的维修更换由承租方负责并承担全部费用
出租方有权提前解除本合同承租方不得提前退租
租赁期满前一个月双方均未提出异议的本合同自动续期一年
租赁期满前一个月双方均未提出异议的本合同再次自动续期一年
本合同一式两份双方各执一份
本合同未尽事宜由双方另行协商`

/** 单方解除：甲方有权解除；乙方无权解除。 */
const ONE_SIDED_EXIT = `租赁合同
甲方（出租方）：某物业公司
乙方（承租方）：某工作室
第一条 甲方将房屋出租给乙方使用，租期一年，月租金 5000 元。
第二条 甲方有权解除本合同；乙方无权解除。
第三条 本合同自双方签字之日起生效。`

/** 单边违约金：甲方有责任，乙方明确免责。 */
const ONE_SIDED_PENALTY = `采购合同
甲方（采购方）：某商贸公司
乙方（供应商）：某材料厂
第一条 甲方向乙方采购包装材料，合同金额 10 万元。
第二条 甲方逾期付款的，按每日 1% 支付违约金；乙方逾期交货的，不承担任何违约责任。
第三条 本合同自双方签字之日起生效，有效期一年。`

/** 劳动合同（含工服押金、工资），不应判成租赁。 */
const LABOR_CONTRACT = `劳动合同
用人单位：某餐饮公司
劳动者：张某
第一条 工作内容
劳动者负责门店日常服务工作，月工资 5000 元。
第二条 押金
用人单位收取工服押金 500 元，离职时工资结清。
第三条 社会保险
用人单位依法为劳动者缴纳社保。
第四条 合同期限
本合同期限自 2026 年 1 月 1 日起至 2027 年 12 月 31 日止。`

/** 混合合同：设备租赁 + 维护服务。 */
const LEASE_WITH_SERVICE = `设备租赁及维护服务合同
出租方（甲方）：某设备公司
承租方（乙方）：某工厂
第一条 租赁设备
甲方向乙方出租注塑机一台，租期十二个月，月租金 8000 元，押金为两个月租金。
第二条 维护服务
甲方为乙方提供设备维护服务，服务费每月 1000 元。
第三条 服务标准
乙方对维护服务进行验收，验收标准为符合甲方要求。
第四条 付款
乙方按月支付租金及服务费，逾期按日万分之五支付违约金。
第五条 合同期限
本合同有效期一年，自双方签字之日起生效。`

/** 争议解决只有“友好协商”，没有管辖载体。 */
const FRIENDLY_ONLY = `服务合同
甲方（委托方）：某公司
乙方（服务方）：某工作室
第一条 乙方为甲方提供设计服务。
第二条 服务费 30000 元，甲方应于合同签订后一次性全额支付。
第三条 争议解决
因本合同产生的争议，双方应友好协商解决；协商不成的，另行协商。
第四条 合同期限
本合同有效期一年，自双方签字之日起生效。`

/** 同一句同时命中“责任过宽”与“维修全压一方”，摘录相同。 */
const REPAIR_DUPLICATE = `租赁合同
出租方（甲方）：某物业公司
承租方（乙方）：某工作室
第一条 甲方将房屋出租给乙方使用，租期一年。
第二条 月租金 5000 元，押金为一个月租金。
第三条 本合同自双方签字之日起生效。
第四条 维修、更换由承租方负责并承担全部费用。
第五条 争议由双方协商解决。`

/** 未识别类型：展位使用协议（含押金、验收）。 */
const BOOTH_AGREEMENT = `展位使用协议
甲方（主办方）：某展览公司
乙方（参展方）：某商贸公司
第一条 乙方使用甲方提供的展位一个，使用费 5000 元。
第二条 押金 1000 元，用于保证展位设施完好。
第三条 展位设施验收标准为符合甲方要求。
第四条 使用期限自 2026 年 3 月 1 日起至 2026 年 3 月 5 日止。`

test('回归：无编号合同按句子兜底切分，重复命中记录 occurrences', () => {
  const result = scanContract(UNNUMBERED_LEASE)
  const clauses = splitClauses(UNNUMBERED_LEASE)
  assert.equal(result.contract_type, 'lease')
  assert.ok(clauses.length >= 4, `无编号合同切分过少：${clauses.length}`)
  assert.equal(result.clause_count, clauses.length)
  const autoRenew = result.high_risk.find(item => item.id === 'auto-renew')
  assert.ok(autoRenew, '未命中自动续期')
  assert.equal(autoRenew.occurrences, 2)
})

test('回归：单方解除按子句判主体，不跨句拼接成对等', () => {
  const result = scanContract(ONE_SIDED_EXIT)
  const ids = result.unbalanced.map(item => item.id)
  assert.ok(ids.includes('one-sided-termination'), `未命中单方解除，实际：${ids.join(', ')}`)
})

test('回归：单边违约金按被施加义务 / 免责表述判断', () => {
  const result = scanContract(ONE_SIDED_PENALTY)
  const ids = result.unbalanced.map(item => item.id)
  assert.ok(ids.includes('one-sided-liability'), `未命中单边违约金，实际：${ids.join(', ')}`)
})

test('回归：劳动合同不判为租赁，也不套租赁专项规则', () => {
  assert.equal(detectContractType(LABOR_CONTRACT), 'unknown')
  const result = scanContract(LABOR_CONTRACT)
  assert.equal(result.contract_type, 'unknown')
  assert.deepEqual(result.contract_types, ['unknown'])
  for (const id of ['deposit-no-refund', 'repair-one-sided']) {
    assert.ok(!result.high_risk.some(item => item.id === id), `误报租赁专项规则 ${id}`)
  }
  for (const label of ['押金及退还条件', '维修责任划分', '提前解约条款']) {
    assert.ok(!result.missing.includes(label), `误报缺失项 ${label}`)
  }
})

test('回归：混合合同按主类型 + 附加类型并集跑专项规则', () => {
  const result = scanContract(LEASE_WITH_SERVICE)
  assert.equal(result.contract_type, 'lease')
  assert.deepEqual(result.contract_types, ['lease', 'service'])
  assert.ok(
    result.high_risk.some(item => item.id === 'vague-acceptance'),
    '混合合同漏报服务专项的验收标准问题',
  )
})

test('回归：只有“友好协商”而无管辖载体时，报争议解决缺失', () => {
  const result = scanContract(FRIENDLY_ONLY)
  assert.ok(
    result.missing.includes('争议解决方式（仲裁或诉讼管辖）'),
    `未报争议解决缺失，实际：${result.missing.join('、')}`,
  )
})

test('回归：未知类型只跑通用规则与两项基础缺失，不套专项规则', () => {
  const result = scanContract(BOOTH_AGREEMENT)
  assert.equal(result.contract_type, 'unknown')
  assert.deepEqual(result.contract_types, ['unknown'])
  assert.ok(!result.high_risk.some(item => item.id === 'deposit-no-refund'), 'unknown 类型误报押金规则')
  assert.ok(!result.high_risk.some(item => item.id === 'vague-acceptance'), 'unknown 类型误报验收规则')
  assert.ok(!result.missing.includes('押金及退还条件'), 'unknown 类型误报押金缺失')
  assert.ok(result.missing.includes('争议解决方式（仲裁或诉讼管辖）'))
})

test('回归：同一句同摘录去重，repair-one-sided 优先于 unlimited-liability', () => {
  const result = scanContract(REPAIR_DUPLICATE)
  const ids = result.high_risk.map(item => item.id)
  assert.ok(ids.includes('repair-one-sided'), '未保留更具体的维修规则')
  assert.ok(!ids.includes('unlimited-liability'), '同一句重复报了责任过宽')
})

test('回归：“承担全部费用”不再被误报为责任无上限（实测回归）', () => {
  const text = [
    '第一条 乙方应按甲方要求提供服务，服务内容以双方确认的清单为准。',
    '第二条 乙方应承担全部费用，包括但不限于差旅与材料支出。',
    '第三条 甲方所在地人民法院管辖，双方均可提前 30 日书面解除。',
    '第四条 任何一方违约的，按合同金额 10% 支付违约金。',
  ].join('\n')
  const result = scanContract(text)
  assert.ok(!result.high_risk.some(item => item.id === 'unlimited-liability'))
})
