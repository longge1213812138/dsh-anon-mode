/**
 * 匿名模式（Anon mode）Host 插件。
 *
 * 作用：在系统提示词组装完成（waterfall 最终结果）后，移除或替换带品牌的身份文本，
 * 让模型看到的是通用 AI 助手身份。只改提示词文本，不触碰工具、技能、计划模式、
 * 子代理、压缩、会话等任何功能。
 *
 * 处理对象：
 * - harness:identity        —— "You are an AI agent powered by DeepSeek Harness."
 * - deployment:persona-prefix —— 各 preset 自带的英文身份句，统一替换为匿名身份
 * - harness:source / app:web-surface —— 指向 DSH 安装目录与 Web GUI 的段落
 * - 同名 runtime context（user 角色快照里的 checkout / GUI URL 提示）
 * - context:file-reference  —— `@` 文件引用说明段，替换为等义改写 FILE_REFERENCE_ANON
 *                              （保留 @ 前缀、相对/绝对路径、目录斜杠、读取前先 read、
 *                               @"..." 引号这些原意，只换措辞）
 *
 * 例外：minimal preset 的 persona 声明了 `complete: true`，其文本会在本 waterfall
 * 之后被强制恢复；但它的原句本身是中性的软件工程师身份，不含品牌。
 */

/** 匿名身份句；不含任何品牌名，也不引用 {{model}} 之类的模板变量。 */
const ANON_IDENTITY = '你是一名 AI 助手，专注于准确理解用户需求，并高质量完成任务。';

/** 需要整段丢弃的品牌提示词段。 */
const BRAND_SECTIONS = new Set(['harness:identity', 'harness:source', 'app:web-surface']);

/** 各 preset 用来声明身份的前缀段名，统一替换为匿名身份。 */
const PERSONA_PREFIX = 'deployment:persona-prefix';

/** 需要整条丢弃的品牌 runtime context。 */
const BRAND_CONTEXTS = new Set(['harness:source', 'app:web-surface']);

/** `@` 文件引用说明段的段名（由 dsh-file-reference-local 注册）。 */
const FILE_REFERENCE_SECTION = 'context:file-reference';

/**
 * FILE_REFERENCE_PROMPT 的等义改写（FILE_REFERENCE_ANON）。
 *
 * 原文：
 *   "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths
 *    resolve from the workspace root; absolute paths identify files or directories on
 *    the host. A trailing slash marks a directory: list it when its contents matter.
 *    Anything else is a file: use the read tool when its contents are needed, and do
 *    not claim to have inspected it before reading. @\"...\" quotes a path containing
 *    spaces."
 *
 * 语义对照（逐条保留，只换措辞）：
 *   - @ 前缀 + 用户显式引用   → 以 @ 开头的文本是用户显式引用的路径
 *   - 相对路径 / 绝对路径      → 相对路径按工作区根解析；绝对路径指向本机任意位置
 *   - 结尾斜杠 = 目录，需列出  → 以斜杠结尾表示目录，关心内容时列出它
 *   - 其余 = 文件，先 read     → 其他情况是文件，需要内容时调用 read 工具，
 *                                未读之前不得声称已查看
 *   - @"..." 用于含空格的路径  → 含空格的路径写成 @"..."
 *
 * 不引用 {{...}} 模板变量（未注册变量会让组装硬失败）。
 */
const FILE_REFERENCE_ANON = [
  '以 @ 开头的文本是用户显式引用的路径。',
  '相对路径以工作区根为基准解析；绝对路径指向本机上的文件或目录。',
  '路径以斜杠结尾表示目录：需要了解其内容时列出该目录。',
  '其余情况表示文件：需要其内容时使用 read 工具，在读取之前不得声称已经查看过。',
  '@\"...\" 用于引用包含空格的路径。',
].join(' ');

export const name = 'anon-mode';

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.on(
    'system-prompt/assemble',
    async (_assembly, _context, next) => {
      const assembly = await next();
      const sections = [];
      for (const section of assembly.sections) {
        if (BRAND_SECTIONS.has(section.name)) continue;
        if (section.name === PERSONA_PREFIX) {
          sections.push({ ...section, text: ANON_IDENTITY });
          continue;
        }
        if (section.name === FILE_REFERENCE_SECTION) {
          // 该段文本由函数求值：没有 read 工具时为空字符串（空段会被渲染丢弃），
          // 此时保持为空，避免凭空注入一段本不该出现的说明。
          sections.push({
            ...section,
            text: typeof section.text === 'string' && section.text.length > 0
              ? FILE_REFERENCE_ANON
              : section.text,
          });
          continue;
        }
        sections.push(section);
      }
      const contexts = assembly.contexts.filter((entry) => !BRAND_CONTEXTS.has(entry.name));
      return { ...assembly, sections, contexts };
    },
    { prepend: true },
  );
}
