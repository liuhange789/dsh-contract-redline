// src/host/index.js
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/rules.js
var RULE_VERSION = "2026.11";
var DISCLAIMER = "\u4EC5\u4E3A\u6761\u6B3E\u4F4D\u7F6E\u4E0E\u98CE\u9669\u63D0\u793A\uFF0C\u4E0D\u6784\u6210\u6CD5\u5F8B\u610F\u89C1\uFF0C\u4E0D\u5224\u65AD\u5408\u540C\u662F\u5426\u6709\u6548\uFF0C\u4E0D\u66FF\u4EE3\u5F8B\u5E08\uFF1B\u91CD\u8981\u5408\u540C\u8BF7\u4EA4\u7531\u4E13\u4E1A\u4EBA\u58EB\u5BA1\u9605\u3002";
var EXCERPT_MAX = 90;
var TYPE_LABELS = {
  procurement: "\u91C7\u8D2D / \u4F9B\u8D27\u5408\u540C",
  lease: "\u79DF\u8D41\u5408\u540C",
  service: "\u670D\u52A1 / \u59D4\u6258\u5408\u540C",
  unknown: "\u672A\u8BC6\u522B\u7C7B\u578B\uFF08\u6309\u901A\u7528\u89C4\u5219\u626B\u63CF\uFF09"
};
function count(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}
function detectContractTypes(text) {
  const source = String(text ?? "");
  if (/劳动合同|用人单位|劳动者|工资|社保/.test(source)) {
    return { primary: "unknown", types: ["unknown"] };
  }
  const leaseCore = /租赁|租期|租金/.test(source);
  const lease = count(source, /租赁|出租|承租|押金|租金|租期|退租/g) * 2;
  const procurement = count(source, /采购|供货|供应商|采购方|验收|质保|到货/g) * 2;
  const service = count(source, /服务|委托|服务费|甲方委托|乙方提供服务/g);
  let primary = "unknown";
  if (leaseCore && lease >= Math.max(procurement, service) && lease >= 4) primary = "lease";
  else if (procurement >= Math.max(lease, service) && procurement >= 4) primary = "procurement";
  else if (service >= 4) primary = "service";
  if (primary === "unknown") return { primary, types: ["unknown"] };
  const extras = [];
  if (primary !== "lease" && leaseCore && lease >= 4) extras.push("lease");
  if (primary !== "procurement" && procurement >= 4 && count(source, /采购|供货|供应商|采购方|质保|到货/g) >= 2) {
    extras.push("procurement");
  }
  if (primary !== "service" && service >= 4 && count(source, /服务|委托/g) >= 2) {
    extras.push("service");
  }
  return { primary, types: [primary, ...extras] };
}
function splitBySentence(text) {
  const units = text.split(/(?<=[。；])|\n+/).map((unit) => unit.trim()).filter(Boolean);
  const chunks = [];
  let buffer = "";
  let sentences = 0;
  for (const unit of units) {
    const joined = buffer ? `${buffer}${unit}` : unit;
    if (buffer && (sentences >= 4 || joined.length > 300)) {
      chunks.push(buffer);
      buffer = unit;
      sentences = 1;
      continue;
    }
    buffer = joined;
    sentences += 1;
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}
function splitClauses(text) {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
  const clauseMarker = /^(第[一二三四五六七八九十百零\d]+条|第[一二三四五六七八九十百零\d]+款|【[^】]{1,10}】|[一二三四五六七八九十]+、|\d+[.、]|（[一二三四五六七八九十]+）)/;
  const blocks = [];
  let current = null;
  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      if (current && current.trim()) blocks.push(current.trim());
      current = null;
      continue;
    }
    if (clauseMarker.test(line)) {
      if (current && current.trim()) blocks.push(current.trim());
      current = line;
    } else {
      current = current ? `${current}
${line}` : line;
    }
  }
  if (current && current.trim()) blocks.push(current.trim());
  if (blocks.length >= 3) return blocks;
  const paragraphs = normalized.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length >= 3) return paragraphs;
  return splitBySentence(normalized);
}
function excerptOf(segment, pattern) {
  const source = segment.replace(/\s+/g, " ").trim();
  const plain = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  const match = source.match(plain);
  if (!match) return source.slice(0, EXCERPT_MAX);
  const start = Math.max(0, match.index - 12);
  const end = Math.min(source.length, match.index + match[0].length + 40);
  const body = source.slice(start, end);
  const prefix = start > 0 ? "\u2026" : "";
  const suffix = end < source.length ? "\u2026" : "";
  return `${prefix}${body}${suffix}`.slice(0, EXCERPT_MAX);
}
var PARTIES = ["\u7532\u65B9", "\u4E59\u65B9", "\u51FA\u79DF\u65B9", "\u627F\u79DF\u65B9", "\u91C7\u8D2D\u65B9", "\u4F9B\u5E94\u5546", "\u670D\u52A1\u65B9", "\u59D4\u6258\u65B9"];
function partyWindows(subclause) {
  const occurrences = [];
  for (const party of PARTIES) {
    let index = subclause.indexOf(party);
    while (index !== -1) {
      occurrences.push({ party, index });
      index = subclause.indexOf(party, index + party.length);
    }
  }
  occurrences.sort((a, b) => a.index - b.index);
  return occurrences.map((occurrence, i) => ({
    party: occurrence.party,
    text: subclause.slice(occurrence.index, i + 1 < occurrences.length ? occurrences[i + 1].index : void 0)
  }));
}
function isOneSidedTermination(segment) {
  const subclauses = String(segment).split(/[。；\n]/).map((part) => part.trim()).filter(Boolean);
  const mentioned = /* @__PURE__ */ new Set();
  const granted = /* @__PURE__ */ new Set();
  const denied = /* @__PURE__ */ new Set();
  for (const subclause of subclauses) {
    const states = /* @__PURE__ */ new Map();
    for (const window of partyWindows(subclause)) {
      mentioned.add(window.party);
      const state = states.get(window.party) ?? { granted: false, denied: false };
      if (/(无权|不得|不能)[^。；\n]{0,10}(解除|终止|退租)/.test(window.text)) state.denied = true;
      if (/(有权|可以|可)[^。；\n]{0,10}(解除|终止|退租)/.test(window.text)) state.granted = true;
      states.set(window.party, state);
    }
    const balanced = /(双方|均|各自)[^。；\n]{0,6}(有权|可以|可)[^。；\n]{0,8}(解除|终止|退租)/.test(subclause);
    for (const [party, state] of states) {
      if (state.denied) denied.add(party);
      else if (state.granted || balanced) granted.add(party);
    }
  }
  if (granted.size === 1 && (mentioned.size >= 2 || denied.size > 0)) return true;
  return /(有权|可以|可)[^。；\n]{0,8}(单方|随时)[^。；\n]{0,8}(解除|终止)/.test(segment);
}
function isVaguePaymentTerm(segment) {
  if (!/(支付|付款|结算)/.test(segment)) return false;
  if (/\d+\s*(日|天|个工作日|周|个月)/.test(segment)) return false;
  return /(另行协商|视情况|尽快|适时|双方另行|收到发票后|验收合格后)[^。；\n]{0,12}(支付|付款|结算)/.test(segment);
}
function isVagueAcceptance(segment) {
  if (!/验收/.test(segment)) return false;
  if (/(\d+|%|合格率|抽检|检测报告|参数|型号|清单|样品|技术标准|国标|行业标准)/.test(segment)) return false;
  return /(符合|满足)[^。；\n]{0,10}(要求|需要)|(甲方|采购方)[^。；\n]{0,6}(认可|确认|满意)/.test(segment);
}
var GENERAL_HIGH_RISK = [
  {
    id: "jurisdiction-one-sided",
    title: "\u7BA1\u8F96\u5730\u56FA\u5B9A\u5728\u5355\u65B9\u6240\u5728\u5730",
    pattern: /(甲方|乙方|出卖方|买受方|出租方|承租方|供应商|采购方|服务方|委托方)\s*所在地[^。；\n]{0,25}(人民法院|法院|仲裁委员会|仲裁)/,
    reason: "\u51FA\u95EE\u9898\u8981\u53BB\u5BF9\u65B9\u6240\u5728\u5730\u8D77\u8BC9\u6216\u4EF2\u88C1\uFF0C\u5DEE\u65C5\u548C\u65F6\u95F4\u6210\u672C\u53EF\u80FD\u6BD4\u4E89\u8BAE\u91D1\u989D\u8FD8\u9AD8\uFF1B\u7B7E\u5B57\u524D\u786E\u8BA4\u8FD9\u4E2A\u57CE\u5E02\u5BF9\u4F60\u662F\u5426\u65B9\u4FBF\u3002"
  },
  {
    id: "auto-renew",
    title: "\u81EA\u52A8\u7EED\u7EA6 / \u81EA\u52A8\u987A\u5EF6",
    pattern: /自动(续约|续期|延期|顺延|延长)/,
    reason: "\u5230\u671F\u4E0D\u4E3B\u52A8\u63D0\u51FA\u5F02\u8BAE\u5C31\u81EA\u52A8\u7EED\u671F\uFF0C\u5BB9\u6613\u9519\u8FC7\u9000\u51FA\u7A97\u53E3\u3001\u88AB\u52A8\u591A\u627F\u62C5\u4E00\u671F\u8D39\u7528\u3002"
  },
  {
    id: "unlimited-liability",
    title: "\u8D23\u4EFB\u8868\u8FF0\u8FC7\u5BBD\uFF08\u5168\u90E8 / \u4E00\u5207\u635F\u5931\uFF09",
    pattern: /承担(全部|一切|所有)[^。；\n]{0,6}(损失|责任|费用|后果)|无限连带/,
    reason: "\u201C\u5168\u90E8\u635F\u5931\u201D\u201C\u4E00\u5207\u8D23\u4EFB\u201D\u6CA1\u6709\u4E0A\u9650\uFF0C\u8D54\u507F\u8303\u56F4\u53EF\u80FD\u8D85\u51FA\u5408\u540C\u91D1\u989D\uFF0C\u9700\u8981\u7EA6\u5B9A\u53EF\u9884\u89C1\u4E14\u5C01\u9876\u7684\u8D23\u4EFB\u3002"
  },
  {
    id: "one-sided-change",
    title: "\u5355\u65B9\u53D8\u66F4\u6743 / \u6700\u7EC8\u89E3\u91CA\u6743",
    pattern: /(有权|可以)[^。；\n]{0,10}(变更|调整)[^。；\n]{0,12}(价格|费用|条款|内容|标准)|最终解释权/,
    reason: "\u5BF9\u65B9\u53EF\u4EE5\u5355\u65B9\u9762\u6539\u4EF7\u683C\u6216\u6761\u6B3E\uFF0C\u4F60\u7B7E\u5B8C\u53EA\u627F\u62C5\u7ED3\u679C\uFF1B\u8FD9\u7C7B\u6743\u5229\u901A\u5E38\u5E94\u6539\u4E3A\u53CC\u65B9\u4E66\u9762\u786E\u8BA4\u3002"
  }
];
var PROCUREMENT_HIGH_RISK = [
  {
    id: "vague-payment-term",
    title: "\u4ED8\u6B3E\u65F6\u95F4\u6CA1\u6709\u660E\u786E\u671F\u9650",
    pattern: /(支付|付款|结算)/,
    evaluate: isVaguePaymentTerm,
    reason: "\u53EA\u5199\u201C\u9A8C\u6536\u5408\u683C\u540E\u652F\u4ED8\u201D\u201C\u53E6\u884C\u534F\u5546\u201D\uFF0C\u6CA1\u6709\u5177\u4F53\u5929\u6570\uFF0C\u5BF9\u65B9\u53EF\u4EE5\u65E0\u9650\u671F\u62D6\u6B3E\uFF1B\u5E94\u5199\u660E\u8D26\u671F\uFF08\u5982\u9A8C\u6536\u540E 30 \u65E5\u5185\uFF09\u3002"
  },
  {
    id: "vague-acceptance",
    title: "\u9A8C\u6536\u6807\u51C6\u4E0D\u53EF\u91CF\u5316",
    pattern: /验收/,
    evaluate: isVagueAcceptance,
    reason: "\u201C\u7B26\u5408\u7532\u65B9\u8981\u6C42\u201D\u201C\u7532\u65B9\u8BA4\u53EF\u201D\u6CA1\u6709\u5BA2\u89C2\u6807\u51C6\uFF0C\u9A8C\u6536\u662F\u5426\u901A\u8FC7\u5B8C\u5168\u7531\u5BF9\u65B9\u5224\u65AD\uFF0C\u5C3E\u6B3E\u548C\u8D28\u4FDD\u8D23\u4EFB\u5BB9\u6613\u88AB\u5361\u4F4F\u3002"
  },
  {
    id: "full-prepayment",
    title: "\u8981\u6C42\u4E00\u6B21\u6027\u5168\u989D\u9884\u4ED8",
    pattern: /(一次性|全额|预付|先付)[^。；\n]{0,12}(支付|付款|付清|货款)/,
    reason: "\u94B1\u5148\u4ED8\u5B8C\u3001\u5BF9\u65B9\u518D\u5C65\u7EA6\uFF0C\u4E00\u65E6\u5BF9\u65B9\u5EF6\u671F\u6216\u8DD1\u8DEF\uFF0C\u8FFD\u56DE\u6210\u672C\u5F88\u9AD8\uFF1B\u901A\u5E38\u5E94\u5206\u671F\u5E76\u628A\u5C3E\u6B3E\u4E0E\u9A8C\u6536\u6302\u94A9\u3002"
  }
];
var LEASE_HIGH_RISK = [
  {
    id: "deposit-no-refund",
    title: "\u62BC\u91D1\u6CA1\u6709\u7EA6\u5B9A\u9000\u8FD8\u6761\u4EF6",
    pattern: /(押金|保证金)/,
    evaluate: (segment) => /(押金|保证金)/.test(segment) && !/(退还|返还|退回)/.test(segment),
    reason: "\u53EA\u5199\u6536\u591A\u5C11\u62BC\u91D1\u3001\u4E0D\u5199\u4EC0\u4E48\u6761\u4EF6\u4E0B\u9000\u3001\u591A\u4E45\u9000\uFF0C\u9000\u79DF\u65F6\u5BB9\u6613\u4EE5\u201C\u623F\u5C4B\u635F\u8017\u201D\u7B49\u7406\u7531\u88AB\u5168\u90E8\u6263\u7559\u3002"
  },
  {
    id: "repair-one-sided",
    title: "\u7EF4\u4FEE\u8D23\u4EFB\u5168\u538B\u7ED9\u4E00\u65B9",
    pattern: /(维修|修缮|修理)/,
    evaluate: (segment) => {
      if (!/(维修|修缮|修理)/.test(segment)) return false;
      const hasTenant = /(承租方|乙方)/.test(segment);
      const hasLandlord = /(出租方|甲方)/.test(segment);
      if (hasTenant !== hasLandlord) return true;
      if (!hasTenant && !hasLandlord) return false;
      const bearers = ["\u51FA\u79DF\u65B9", "\u627F\u79DF\u65B9", "\u7532\u65B9", "\u4E59\u65B9"].filter((party) => new RegExp(
        `${party}[^\u3002\uFF1B\\n]{0,15}(\u627F\u62C5|\u8D1F\u8D23|\u5E94)[^\u3002\uFF1B\\n]{0,10}(\u7EF4\u4FEE|\u4FEE\u7F2E|\u4FEE\u7406)`
      ).test(segment));
      return bearers.length === 1;
    },
    reason: "\u623F\u5C4B\u4E3B\u4F53\u3001\u7BA1\u9053\u3001\u7535\u5668\u7B49\u7EF4\u4FEE\u8D23\u4EFB\u4E0D\u533A\u5206\u5F52\u5C5E\uFF0C\u5168\u90E8\u538B\u7ED9\u4E00\u65B9\u65F6\uFF0C\u4E00\u6B21\u5927\u4FEE\u5C31\u53EF\u80FD\u8D85\u8FC7\u62BC\u91D1\u3002"
  }
];
var UNBALANCED_RULES = [
  {
    id: "one-sided-termination",
    title: "\u53EA\u6709\u4E00\u65B9\u53EF\u4EE5\u89E3\u9664 / \u63D0\u524D\u7EC8\u6B62",
    pattern: /(解除|终止)/,
    evaluate: isOneSidedTermination,
    appliesTo: ["procurement", "lease", "service", "unknown"],
    reason: "\u5BF9\u65B9\u53EF\u4EE5\u968F\u65F6\u62BD\u8EAB\uFF0C\u4F60\u5374\u6CA1\u6709\u5BF9\u5E94\u6743\u5229\uFF1B\u5E94\u4E89\u53D6\u5BF9\u7B49\u7684\u63D0\u524D\u901A\u77E5\u671F\u548C\u89E3\u7EA6\u6761\u4EF6\u3002"
  },
  {
    id: "one-sided-liability",
    title: "\u8FDD\u7EA6\u8D23\u4EFB\u53EA\u7EA6\u675F\u4E00\u65B9",
    pattern: /(违约金|赔偿|罚款|违约责任)/,
    evaluate: (segment) => {
      if (!/(违约金|赔偿|罚款|违约责任)/.test(segment)) return false;
      const subclauses = String(segment).split(/[。；\n]/).map((part) => part.trim()).filter(Boolean);
      const mentioned = /* @__PURE__ */ new Set();
      const liable = /* @__PURE__ */ new Set();
      const exempt = /* @__PURE__ */ new Set();
      for (const subclause of subclauses) {
        for (const party of PARTIES) {
          if (!subclause.includes(party)) continue;
          mentioned.add(party);
          if (new RegExp(`${party}[^\u3002\uFF1B\\n]{0,20}(\u4E0D\u627F\u62C5|\u4E0D\u8D1F\u8D23|\u514D\u4E8E|\u65E0\u9700|\u65E0\u987B|\u4E0D\u652F\u4ED8)[^\u3002\uFF1B\\n]{0,12}(\u8FDD\u7EA6\u91D1|\u8D54\u507F\u8D23\u4EFB|\u8D23\u4EFB|\u7F5A\u6B3E)`).test(subclause)) {
            exempt.add(party);
            continue;
          }
          if (new RegExp(`${party}[^\u3002\uFF1B\\n]{0,10}(\u5E94|\u987B|\u9700|\u903E\u671F|\u672A|\u8FDD\u7EA6|\u6309)[^\u3002\uFF1B\\n]{0,40}(\u8FDD\u7EA6\u91D1|\u8D54\u507F|\u7F5A\u6B3E|\u8FDD\u7EA6\u8D23\u4EFB)`).test(subclause)) {
            liable.add(party);
          }
        }
      }
      if (liable.size !== 1) return false;
      if (mentioned.size >= 2) return true;
      return exempt.size === 0;
    },
    appliesTo: ["procurement", "lease", "service", "unknown"],
    reason: "\u6761\u6B3E\u53EA\u5217\u4E00\u65B9\u7684\u8FDD\u7EA6\u91D1\u548C\u8D54\u507F\u8D23\u4EFB\uFF0C\u53E6\u4E00\u65B9\u8FDD\u7EA6\u6CA1\u6709\u5BF9\u5E94\u540E\u679C\uFF0C\u51FA\u4E86\u4E8B\u5F88\u96BE\u8FFD\u8D23\u3002"
  }
];
var MISSING_RULES = [
  {
    id: "missing-dispute",
    label: "\u4E89\u8BAE\u89E3\u51B3\u65B9\u5F0F\uFF08\u4EF2\u88C1\u6216\u8BC9\u8BBC\u7BA1\u8F96\uFF09",
    keywords: /仲裁|仲裁委员会|人民法院|法院|诉讼/,
    appliesTo: ["procurement", "lease", "service", "unknown"]
  },
  {
    id: "missing-term",
    label: "\u5408\u540C\u671F\u9650\u4E0E\u751F\u6548\u6761\u4EF6",
    keywords: /有效期|合同期限|租期|租赁期|自[^。；\n]{0,24}(生效|起)|生效日期|终止日期/,
    appliesTo: ["procurement", "lease", "service", "unknown"]
  },
  {
    id: "missing-payment",
    label: "\u4ED8\u6B3E\u6761\u4EF6\u4E0E\u8D26\u671F",
    keywords: /付款|支付|结算|账期/,
    appliesTo: ["procurement", "service"]
  },
  {
    id: "missing-acceptance",
    label: "\u9A8C\u6536\u6807\u51C6\u4E0E\u6D41\u7A0B",
    keywords: /验收/,
    appliesTo: ["procurement", "service"]
  },
  {
    id: "missing-ip",
    label: "\u77E5\u8BC6\u4EA7\u6743 / \u6210\u679C\u5F52\u5C5E",
    keywords: /知识产权|著作权|成果归属|专利|商标/,
    appliesTo: ["procurement", "service"]
  },
  {
    id: "missing-deposit",
    label: "\u62BC\u91D1\u53CA\u9000\u8FD8\u6761\u4EF6",
    keywords: /押金|保证金/,
    appliesTo: ["lease"]
  },
  {
    id: "missing-repair",
    label: "\u7EF4\u4FEE\u8D23\u4EFB\u5212\u5206",
    keywords: /维修|修缮|修理/,
    appliesTo: ["lease"]
  },
  {
    id: "missing-early-exit",
    label: "\u63D0\u524D\u89E3\u7EA6\u6761\u6B3E",
    keywords: /提前[^。；\n]{0,6}(解除|终止|退租)/,
    appliesTo: ["lease"]
  }
];
function rulesFor(rules, types) {
  return rules.filter((rule) => !rule.appliesTo || rule.appliesTo.some((type) => types.includes(type)));
}
function findingKey(excerpt) {
  return excerpt.replace(/^…/, "").replace(/^第[一二三四五六七八九十百零\d]+条\s*/, "").trim();
}
var RULE_PRIORITY = {
  "repair-one-sided": 5,
  "deposit-no-refund": 4,
  "vague-acceptance": 3,
  "vague-payment-term": 3,
  "one-sided-termination": 3,
  "one-sided-liability": 3,
  "unlimited-liability": 0
};
function scanContract(text, options = {}) {
  const source = String(text ?? "");
  if (source.trim().length < 80) {
    throw new Error("\u5408\u540C\u6587\u672C\u592A\u77ED\uFF1A\u8BF7\u7C98\u8D34\u5B8C\u6574\u6761\u6B3E\u6B63\u6587\uFF08\u81F3\u5C11 80 \u4E2A\u5B57\u7B26\uFF09\u3002");
  }
  const clauses = splitClauses(source);
  const requested = options.contractType;
  const typeInfo = requested && requested !== "auto" ? { primary: requested, types: [requested] } : detectContractTypes(source);
  const type = typeInfo.primary;
  const applicableTypes = typeInfo.types;
  const candidates = [];
  const seen = /* @__PURE__ */ new Map();
  const collect = (rules, bucket) => {
    for (const rule of rules) {
      const hits = [];
      clauses.forEach((clause, index) => {
        let hitCount = 0;
        if (rule.evaluate) {
          hitCount = rule.evaluate(clause) ? 1 : 0;
        } else {
          const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
          hitCount = count(clause, new RegExp(rule.pattern.source, flags));
        }
        if (hitCount > 0) {
          hits.push({ clauseIndex: index, excerpt: excerptOf(clause, rule.pattern), count: hitCount });
        }
      });
      if (!hits.length) continue;
      const occurrences = hits.reduce((sum, hit) => sum + hit.count, 0);
      const item = {
        id: rule.id,
        clause: rule.title,
        excerpt: hits[0].excerpt,
        reason: rule.reason
      };
      if (occurrences > 1) item.occurrences = occurrences;
      const priority = RULE_PRIORITY[rule.id] ?? 1;
      const key = `${hits[0].clauseIndex}|${findingKey(item.excerpt)}`;
      const existing = seen.get(key);
      if (existing === void 0) {
        seen.set(key, candidates.length);
        candidates.push({ bucket, item, priority });
      } else if (priority > candidates[existing].priority) {
        candidates[existing] = { bucket, item, priority };
      }
    }
  };
  const highRiskRules = [
    ...GENERAL_HIGH_RISK,
    ...applicableTypes.includes("procurement") || applicableTypes.includes("service") ? PROCUREMENT_HIGH_RISK : [],
    ...applicableTypes.includes("lease") ? LEASE_HIGH_RISK : []
  ];
  collect(highRiskRules, "high_risk");
  collect(rulesFor(UNBALANCED_RULES, applicableTypes), "unbalanced");
  const highRisk = candidates.filter((candidate) => candidate.bucket === "high_risk").map((candidate) => candidate.item);
  const unbalanced = candidates.filter((candidate) => candidate.bucket === "unbalanced").map((candidate) => candidate.item);
  const missing = MISSING_RULES.filter((rule) => rule.appliesTo.some((t) => applicableTypes.includes(t))).filter((rule) => !rule.keywords.test(source)).map((rule) => rule.label);
  const summary = buildOneLiner(type, clauses.length, highRisk.length, unbalanced.length, missing.length);
  return {
    contract_type: type,
    contract_type_label: TYPE_LABELS[type],
    contract_types: applicableTypes,
    clause_count: clauses.length,
    rule_version: RULE_VERSION,
    high_risk: highRisk,
    unbalanced,
    missing,
    summary,
    disclaimer: DISCLAIMER
  };
}
function buildOneLiner(type, clauseCount, highCount, unbalancedCount, missingCount) {
  const label = TYPE_LABELS[type];
  if (highCount + unbalancedCount + missingCount === 0) {
    return `\u6309 ${RULE_VERSION} \u89C4\u5219\u96C6\u626B\u63CF ${clauseCount} \u6761\u6761\u6B3E\uFF08${label}\uFF09\uFF0C\u672A\u547D\u4E2D\u5DF2\u6536\u5F55\u7684\u98CE\u9669\u6A21\u5F0F\uFF1B\u4ECD\u9700\u4EBA\u5DE5\u6838\u5BF9\u672A\u6536\u5F55\u7684\u884C\u4E1A\u7279\u6B8A\u6761\u6B3E\u3002`;
  }
  return `\u6309 ${RULE_VERSION} \u89C4\u5219\u96C6\u626B\u63CF ${clauseCount} \u6761\u6761\u6B3E\uFF08${label}\uFF09\uFF1A\u9AD8\u98CE\u9669 ${highCount} \u5904\u3001\u6743\u5229\u4E49\u52A1\u4E0D\u5BF9\u7B49 ${unbalancedCount} \u5904\u3001\u5173\u952E\u6761\u6B3E\u7F3A\u5931 ${missingCount} \u9879\u3002\u53EF\u5148\u5C31\u6807\u8BB0\u9879\u9010\u6761\u5411\u5BF9\u65B9\u786E\u8BA4\uFF0C\u518D\u51B3\u5B9A\u7B7E\u7F72\u6216\u9001\u5F8B\u5E08\u5BA1\u9605\u3002`;
}
function formatRiskReport(result) {
  const lines = [
    "\u3010\u5408\u540C\u98CE\u9669\u901F\u67E5\u3011",
    `\u8BC6\u522B\u7C7B\u578B\uFF1A${result.contract_type_label}\uFF5C\u6761\u6B3E ${result.clause_count} \u6761\uFF5C\u89C4\u5219\u96C6 ${result.rule_version}`,
    result.summary,
    ""
  ];
  const renderItems = (title, items) => {
    lines.push(`${title}\uFF08${items.length}\uFF09`);
    if (items.length === 0) {
      lines.push("  - \u65E0");
    } else {
      items.forEach((item, index) => {
        lines.push(`  ${index + 1}. ${item.clause}`);
        lines.push(`     \u6761\u6B3E\uFF1A${item.excerpt}`);
        lines.push(`     \u4E3A\u4EC0\u4E48\uFF1A${item.reason}`);
      });
    }
    lines.push("");
  };
  renderItems("\u9AD8\u98CE\u9669\u6761\u6B3E", result.high_risk);
  renderItems("\u6743\u5229\u4E49\u52A1\u4E0D\u5BF9\u7B49", result.unbalanced);
  lines.push(`\u5173\u952E\u6761\u6B3E\u7F3A\u5931\uFF08${result.missing.length}\uFF09`);
  lines.push(result.missing.length === 0 ? "  - \u65E0" : result.missing.map((item) => `  - ${item}`).join("\n"));
  lines.push("");
  lines.push(`\u58F0\u660E\uFF1A${result.disclaimer}`);
  return lines.join("\n");
}

// src/host/index.js
var name = "contract-redline";
var inject = ["tools"];
var FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    clause: { type: "string" },
    excerpt: { type: "string" },
    reason: { type: "string" },
    occurrences: { type: "number" }
  }
};
var OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    contract_type: { type: "string" },
    contract_type_label: { type: "string" },
    contract_types: { type: "array", items: { type: "string" } },
    clause_count: { type: "number" },
    rule_version: { type: "string" },
    high_risk: { type: "array", items: FINDING_SCHEMA },
    unbalanced: { type: "array", items: FINDING_SCHEMA },
    missing: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    disclaimer: { type: "string" }
  }
};
function renderScan(args, value) {
  return [{ type: "text", text: value.report }];
}
function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "contract_scan",
      description: "Scan pasted contract text (procurement / supply, lease, service / commission) with a fixed rule set and return a risk checklist: high-risk clauses, one-sided or unbalanced obligations, and missing key clauses. Each finding carries the clause title, a short excerpt and a plain-language reason. This is not legal advice: it does not judge whether the contract is valid, whether to sign it, or replace a lawyer, and it makes no network calls. Requires at least 80 characters of contract text.",
      parameters: {
        text: {
          type: "string",
          description: "\u5408\u540C\u5168\u6587\uFF08\u7EAF\u6587\u672C\uFF0C\u76F4\u63A5\u7C98\u8D34\uFF1B\u4E0D\u505A OCR\uFF09\u3002\u81F3\u5C11 80 \u4E2A\u5B57\u7B26\u3002"
        },
        contract_type: {
          type: "string",
          enum: ["auto", "procurement", "lease", "service"],
          description: "\u53EF\u9009\u3002\u5408\u540C\u7C7B\u578B\uFF1B\u9ED8\u8BA4 auto \u6309\u5173\u952E\u8BCD\u81EA\u52A8\u8BC6\u522B\uFF0C\u8BC6\u522B\u4E0D\u51C6\u65F6\u53EF\u624B\u52A8\u6307\u5B9A\u3002"
        }
      },
      output: {
        schema: { ...OUTPUT_SCHEMA, properties: { ...OUTPUT_SCHEMA.properties, report: { type: "string" } } },
        render: renderScan
      },
      execute(args) {
        const result = scanContract(args.text, {
          contractType: args.contract_type
        });
        return {
          ...result,
          report: formatRiskReport(result),
          disclaimer: DISCLAIMER
        };
      }
    })
  );
}
export {
  apply,
  inject,
  name
};
