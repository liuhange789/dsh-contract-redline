/**
 * Host 侧入口：注册一个 `contract_scan` 工具。
 *
 * 纯规则扫描，不调用模型、不联网、不写文件；输出是风险清单，不是法律意见。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { DISCLAIMER, formatRiskReport, scanContract } from '../rules.js'

export const name = 'contract-redline'
export const inject = ['tools']

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    clause: { type: 'string' },
    excerpt: { type: 'string' },
    reason: { type: 'string' },
    occurrences: { type: 'number' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contract_type: { type: 'string' },
    contract_type_label: { type: 'string' },
    contract_types: { type: 'array', items: { type: 'string' } },
    clause_count: { type: 'number' },
    rule_version: { type: 'string' },
    high_risk: { type: 'array', items: FINDING_SCHEMA },
    unbalanced: { type: 'array', items: FINDING_SCHEMA },
    missing: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    disclaimer: { type: 'string' },
  },
}

function renderScan(args, value) {
  return [{ type: 'text', text: value.report }]
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'contract_scan',
      description:
        'Scan pasted contract text (procurement / supply, lease, service / commission) with a fixed rule set and return a risk checklist: high-risk clauses, one-sided or unbalanced obligations, and missing key clauses. Each finding carries the clause title, a short excerpt and a plain-language reason. This is not legal advice: it does not judge whether the contract is valid, whether to sign it, or replace a lawyer, and it makes no network calls. Requires at least 80 characters of contract text.',
      parameters: {
        text: {
          type: 'string',
          description: '合同全文（纯文本，直接粘贴；不做 OCR）。至少 80 个字符。',
        },
        contract_type: {
          type: 'string',
          enum: ['auto', 'procurement', 'lease', 'service'],
          description: '可选。合同类型；默认 auto 按关键词自动识别，识别不准时可手动指定。',
        },
      },
      output: {
        schema: { ...OUTPUT_SCHEMA, properties: { ...OUTPUT_SCHEMA.properties, report: { type: 'string' } } },
        render: renderScan,
      },
      execute(args) {
        const result = scanContract(args.text, {
          contractType: args.contract_type,
        })
        return {
          ...result,
          report: formatRiskReport(result),
          disclaimer: DISCLAIMER,
        }
      },
    }),
  )
}
