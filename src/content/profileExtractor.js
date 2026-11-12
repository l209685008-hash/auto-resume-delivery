(function (root) {
  "use strict";

  const DATE_RANGE = /(20\d{2})[.\-/年](\d{1,2})月?\s*(?:-|—|–|~|～|至|到)\s*(?:(20\d{2})[.\-/年](\d{1,2})月?|(至今|现在))/;
  const EDUCATION_RANGE = /((?:19|20)\d{2})(?:[.\-/年](\d{1,2})月?)?\s*(?:-|—|–|~|～|至|到)\s*((?:19|20)\d{2})(?:[.\-/年](\d{1,2})月?)?/;
  // 学历词表必须覆盖规则层用到的全部词，否则会出现“规则认高职、提取器读不到”的漂移。
  const DEGREE_WORDS = Object.freeze(["博士", "硕士", "研究生", "本科", "学士", "专升本", "专转本", "专接本", "大专", "专科", "高职", "中专", "中职", "职高", "技校", "高中", "初中", "小学"]);
  const DEGREE = new RegExp(DEGREE_WORDS.join("|"));
  const SCHOOL = /大学|学院|学校|中学|职校|技校/;
  const COMPANY = /公司|集团|商贸|科技|有限|工作室/;
  const EDUCATION_SELECTOR = "[data-education], .education-experience, .education-list, .edu-exp, .education, [class*='education-item'], .education-exp, .edu-experience";
  const EDUCATION_ROW_SELECTOR = "[data-education], [class*='education-item'], .education-list > li, .education-experience > li, .education-experience .experience-item, .education-exp .experience-item, .edu-exp .experience-item, .edu-experience .experience-item";
  const WORK_SELECTOR = "[data-work-entry], .work-experience-item, .work-exp-item, .work-list > li, .work-experience > li, [class*='work-item'], .work-experience .experience-item, .work-exp .experience-item";
  const CANDIDATE_ROOT = "[data-candidate-id], [data-geek-id], .candidate-card, .geek-card, .recommend-card-wrap";
  const JOB_CONTEXT = "[data-current-job], [data-job-id], .job-info, .job-card, .job-detail, .job-requirements";

  function textOf(element) {
    return String(element && (element.innerText || element.textContent) || "")
      .replace(/\r/g, "").replace(/[\t ]+/g, " ").trim();
  }

  function section(text, heading, nextHeadings) {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const start = lines.findIndex((line) => heading.test(line));
    if (start < 0) return "";
    const result = [];
    for (let index = start; index < lines.length; index += 1) {
      if (index > start && nextHeadings.test(lines[index])) break;
      result.push(lines[index]);
    }
    return result.join("\n");
  }

  function excludedRoots(card) {
    const identity = (element) => Array.from(new Set(["data-candidate-id", "data-geek-id"]
      .map((attribute) => (element.getAttribute(attribute) || "").trim()).filter(Boolean)));
    const ownIds = identity(card);
    const roots = Array.from(card.querySelectorAll(CANDIDATE_ROOT)).filter((element) => !element.closest(JOB_CONTEXT));
    // One anonymous marker chain is a normal recommendation-card wrapper.
    // Identified descendants must agree with the bound card; sibling chains are ambiguous.
    const anonymousChain = leafRows(roots).length === 1 &&
      (card.matches(".recommend-card-wrap") || ownIds.length === 1);
    const excluded = Array.from(card.querySelectorAll(JOB_CONTEXT)).concat(roots.filter((element) => {
      const ids = identity(element);
      return ids.length ? ownIds.length !== 1 || ids.some((id) => id !== ownIds[0]) : !anonymousChain;
    }));
    return excluded.filter((element) => !excluded.some((other) => other !== element && other.contains(element)));
  }

  function scopedElements(card, selector, excluded) {
    return Array.from(card.querySelectorAll(selector)).filter((element) =>
      !excluded.some((root) => root === element || root.contains(element)));
  }

  function scopedText(element, excluded) {
    if (!element || excluded.some((root) => root === element || root.contains(element))) return "";
    if (!excluded.some((root) => element.contains(root))) return textOf(element);
    // Keep original rendered text where possible, and rebuild only ancestors
    // of excluded subtrees so their text cannot re-enter through a fallback.
    return Array.from(element.childNodes).map((node) => {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return "";
      if (node.tagName === "BR") return "\n";
      const value = scopedText(node, excluded);
      const display = element.ownerDocument.defaultView.getComputedStyle(node).display;
      return display === "contents" || display.startsWith("inline") ? value : `\n${value}\n`;
    }).join("").replace(/\r/g, "").replace(/[\t ]+/g, " ").trim();
  }

  function leafRows(rows) {
    const unique = Array.from(new Set(rows));
    return unique.filter((row) => !unique.some((other) => other !== row && row.contains(other)));
  }

  function entryRows(declared, semantic) {
    const rows = leafRows(declared);
    return rows.concat(leafRows(semantic.filter((element) =>
      !rows.some((row) => row === element || row.contains(element) || element.contains(row)))));
  }

  function localRows(semantic, read) {
    const candidates = new Set(semantic);
    return Array.from(new Set(leafRows(semantic).map((row) => {
      let local = row;
      for (let parent = row.parentElement; candidates.has(parent) && !parent.matches(CANDIDATE_ROOT); parent = parent.parentElement) {
        // Preserve sibling qualifiers only within one dated local entry.
        const parentText = read(parent);
        const ranges = parentText.match(new RegExp(`${DATE_RANGE.source}|${EDUCATION_RANGE.source}`, "g")) || [];
        const addedText = parentText.replace(read(local), "");
        if (ranges.length !== 1 || COMPANY.test(addedText) || SCHOOL.test(addedText)) break;
        local = parent;
      }
      return local;
    })));
  }

  function educationRow(value) {
    return SCHOOL.test(value) && DEGREE.test(value) && (EDUCATION_RANGE.test(value) || DATE_RANGE.test(value));
  }

  // 摘要卡只写“本科 · 会计学”时没有学校也没有年份，结构化行匹配不到；
  // 卡片里的 span 还会拼成一整行，按整行判断会被“期望岗位”之类的词误伤。
  // 因此以学历词为中心截一段窗口，并只在窗口以岗位要求开头时才丢弃。
  const REQUIREMENT_SNIPPET = /^(?:任职要求|岗位要求|招聘要求|职位要求|学历要求)|以上学历|优先|不限/;

  // 独立成行的专业（“本科”一行、“会计学”一行）只在下一行确实像专业名时才合并，
  // 避免把“本科 / 财务会计”这种职位名当成专业。
  const MAJOR_ONLY_LINE = /(?:学|管理|专业)$/;

  function degreeSnippets(value) {
    const body = String(value || "");
    const snippets = [];
    let lastEnd = -1;
    for (const match of body.matchAll(new RegExp(DEGREE.source, "g"))) {
      if (match.index < lastEnd) continue;
      // 取值窗口必须限制在学历词所在的那一行内。否则向前回看会跨进上一行
      // （通常是姓名），再按换行截断时留下的恰恰是姓名，学历词被丢掉。
      const lineStart = body.lastIndexOf("\n", match.index - 1) + 1;
      const lineBreak = body.indexOf("\n", match.index);
      const lineEnd = lineBreak === -1 ? body.length : lineBreak;
      const line = body.slice(lineStart, lineEnd).trim();
      // 窗口限制在本行内，且只取学历词前后有限长度：整行当证据会把同一行里
      // 的工作关键词（“亚马逊”等）一起扣掉，导致关键词判定失效。
      let window = body.slice(Math.max(lineStart, match.index - 16),
        Math.min(lineEnd, match.index + match[0].length + 12)).trim();
      lastEnd = lineEnd;
      if (!window || REQUIREMENT_SNIPPET.test(window)) continue;
      // 整行只有学历词时，允许并上紧邻的下一行（“本科”换行写“会计学”）。
      const degreeOnly = line.replace(/[·•|｜,，、\s]/g, "") === match[0];
      if (degreeOnly && lineEnd < body.length) {
        // 块级元素之间会有空行，跳过空行后的第一条才算“紧邻的下一行”。
        const next = body.slice(lineEnd + 1).split("\n").map((item) => item.trim()).find(Boolean) || "";
        if (next && next.length <= 12 && MAJOR_ONLY_LINE.test(next) && !/公司|负责|职责|要求|经验/.test(next)) {
          window = `${window} ${next}`;
        }
      }
      snippets.push(window);
      if (snippets.length >= 3) break;
    }
    return snippets;
  }

  function parseWorkEntry(value) {
    const text = String(value || "");
    if (!text.trim()) return null;
    const ranges = Array.from(text.matchAll(new RegExp(DATE_RANGE.source, "g")));
    const match = ranges.length === 1 ? ranges[0] : null;
    const month = (year, number) => `${year}-${String(Number(number)).padStart(2, "0")}`;
    const before = match ? text.slice(0, match.index).trim() : text;
    const after = match ? text.slice(match.index + match[0].length).trim() : "";
    const lines = `${before}\n${after}`.split("\n").map((line) => line.trim()).filter(Boolean);
    const fields = lines.flatMap((line) => line.split(/\s*[·•|｜]\s*/)).map((part) => part.trim()).filter(Boolean);
    const headings = lines.slice(0, 4).join(" ");
    const kind = /实习/.test(headings) ? "internship" : /兼职|非全日制工作|part.?time/i.test(headings) ? "part-time" :
      /培训|课程|training/i.test(headings) ? "training" : "formal";
    const company = fields.find((line) => COMPANY.test(line) && line.length < 90) || "";
    const companyIndex = fields.indexOf(company);
    const inlineTitle = lines.some((line) => line.includes(company) && /[·•|｜]/.test(line)) ? fields[companyIndex + 1] : "";
    const title = inlineTitle && inlineTitle.length < 60 && !COMPANY.test(inlineTitle) ? inlineTitle : fields.find((line) => line !== company && line.length < 60 &&
      !/公司|集团|有限|负责|承担|职责|工作内容|^工作经历/.test(line) && /财务|会计|出纳|审计|税务/.test(line)) ||
      lines.find((line) => /^(?:职位|岗位|职务)\s*[:：]/.test(line)) || "";
    return {
      company,
      title,
      description: lines.join("\n"),
      start: match ? month(match[1], match[2]) : "",
      end: match ? match[5] ? "至今" : month(match[3], match[4]) : "",
      kind
    };
  }

  function parseWorkText(text) {
    const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
    const completeRows = lines.filter((line) => !/^工作经历$/.test(line));
    if (completeRows.length > 1 && completeRows.every((line) => {
      const match = line.match(DATE_RANGE);
      const entry = parseWorkEntry(line);
      return match && match.index === 0 && entry.company && entry.title;
    })) return completeRows.map(parseWorkEntry);
    const indexes = [];
    lines.forEach((line, index) => { if (DATE_RANGE.test(line)) indexes.push(index); });
    // With multiple date ranges, require real DOM entry boundaries rather than
    // borrowing a company or a responsibility from the neighbouring entry.
    if (indexes.length !== 1) return lines.length ? [parseWorkEntry(lines.join("\n"))] : [];
    return indexes.map((index, position) => {
      const start = position === 0 ? 0 : index;
      const end = position + 1 < indexes.length ? indexes[position + 1] : lines.length;
      return parseWorkEntry(lines.slice(start, end).join("\n"));
    }).filter(Boolean);
  }

  function extract(card, now = new Date()) {
    const excluded = excludedRoots(card);
    const read = (element) => scopedText(element, excluded);
    const text = read(card);
    const elements = scopedElements(card, "*", excluded);
    let educationRows = entryRows(scopedElements(card, EDUCATION_ROW_SELECTOR, excluded),
      localRows(elements.filter((element) => educationRow(read(element))), read));
    if (!educationRows.length) educationRows = leafRows(scopedElements(card, EDUCATION_SELECTOR, excluded));
    // 是否"已毕业"不参与筛选：只看本科专业是否财务相关，
    // 因此保留简历上的原始学历表述，不再因年份区间未满而抹掉"本科"等学历词。
    const educationSection = section(text, /^教育(?:经历|背景)/, /^(?:工作经历|项目经历|资格证书|专业技能|个人优势|求职意向|期望)/);
    const educationValues = educationRows.length ? educationRows.map(read)
      : educationSection ? [educationSection] : degreeSnippets(text);
    const education = educationValues
      .map((value) => String(value || "").trim()).filter(Boolean).join("；\n");
    const workText = section(text, /^工作经历/, /^(?:教育经历|项目经历|资格证书|专业技能|个人优势|求职意向|期望)/);
    const semanticWork = elements.filter((element) => {
      const value = read(element);
      return !SCHOOL.test(value) && Array.from(value.matchAll(new RegExp(DATE_RANGE.source, "g"))).length === 1 && COMPANY.test(value);
    });
    const workRows = entryRows(scopedElements(card, WORK_SELECTOR, excluded), localRows(semanticWork, read));
    const entries = workRows.length ? workRows.map(read).map(parseWorkEntry).filter(Boolean) : parseWorkText(workText);
    // 关键词只看工作与个人描述：教育行里的校名（如“广东外语外贸大学”）不能触发“外贸”。
    // 结构化行用 DOM 排除；文本回退的结果按片段扣除，避免校名重新混进关键词，
    // 又不会像按整行删除那样把同一行里的“亚马逊”一起删掉。
    const keywordText = educationRows.length
      ? scopedText(card, excluded.concat(educationRows))
      : educationValues.reduce((acc, value) => value ? acc.split(value).join(" ") : acc, text);
    return {
      text,
      keywordText,
      educationText: education,
      workEntries: entries
    };
  }

  const api = { extract, parseWorkText, parseWorkEntry, degreeWords: DEGREE_WORDS };
  root.BossFinanceProfile = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
