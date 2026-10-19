/**
 * strip-comments.mjs —— 剥注释（通用技能测试的共用件，零依赖）
 *
 * 存在理由（架构审计 F5 · 2026-10-16）：「技能目录不含项目物」守卫若连注释一起扫，
 * 那么「修掉硬编码后在注释里说明『此前此处硬编码本仓 X』」这件事本身就会让门禁变红 ——
 * 修复动作与守卫互锁，于是没人敢留下解释（「注释里的不算」是硬要求）。
 * 而**字符串字面量里的项目物必须保留**：那正是会进用户可见输出的形态，是要拦的对象。
 *
 * 为什么自带实现而不是依赖现成 parser：零外部依赖是本技能的硬约束（宿主无 js-yaml
 * 也要能跑），测试件同理。本函数是**词法级**近似（块注释 + 行注释 + 字符串/模板串
 * + **正则字面量**），对本技能代码足够。
 *
 * ⚠ 正则字面量必须单独识别，否则守卫**恒红**（2026-10-16 实测踩到）：
 *   形如 `/[A-Za-z]:[\\/][^\s'"()[\]{}<>]+/g` 的正则里同时含 `'` 与 `"`，若不识别正则，
 *   词法器会把 `'` 当成字符串起点一路找配对引号，**状态从此错位**，其后的真注释
 *   全都当代码 —— 于是「本该剥掉的注释」被判成「可执行字符串里的项目物」。
 *   这类错位会让守卫报出一堆假红，或（更糟）在别的文件上错位到恰好放过真违规。
 *   故此处按「前一个有效字符」判定 `/` 是正则起点还是除号（标准启发式）。
 */
export function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  // `/` 之前出现这些字符时，本 `/` 是正则起点而非除号（标准启发式）
  const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n'])
  /** 扫一个正则字面量（含字符类 `[...]`），返回结束后的下标。 */
  const scanRegex = (start) => {
    let j = start + 1
    let inClass = false
    while (j < n) {
      const ch = src[j]
      if (ch === '\\') { j += 2; continue }
      if (ch === '\n') break // 正则不该跨行；越界则视为非正则，交给调用方回退
      if (ch === '[') inClass = true
      else if (ch === ']') inClass = false
      else if (ch === '/' && !inClass) {
        j++
        while (j < n && /[a-z]/.test(src[j])) j++ // 吞掉 gimsuy 标志
        return j
      }
      j++
    }
    return -1
  }
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    // 字符串 / 模板串：内容整体保留（其内的项目物仍需判红）
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      let j = i + 1
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === quote) break
        j++
      }
      out += src.slice(i, Math.min(j + 1, n))
      i = j + 1
      continue
    }
    // 正则字面量：整体保留（内容当代码，误报可接受，漏报风险更低）
    if (c === '/' && c2 !== '/' && c2 !== '*') {
      // 往前找最后一个非空白字符，判断这是正则起点还是除号
      let k = out.length - 1
      while (k >= 0 && /\s/.test(out[k])) k--
      const prev = k >= 0 ? out[k] : '\n'
      if (REGEX_PREV.has(prev)) {
        const end = scanRegex(i)
        if (end !== -1) {
          out += src.slice(i, end)
          i = end
          continue
        }
      }
    }
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      out += ' '
      continue
    }
    if (c === '/' && c2 === '/') {
      const end = src.indexOf('\n', i)
      i = end === -1 ? n : end
      out += ' '
      continue
    }
    out += c
    i++
  }
  return out
}
