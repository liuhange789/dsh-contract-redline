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
