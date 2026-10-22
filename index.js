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
        sections.push(section);
      }
      const contexts = assembly.contexts.filter((entry) => !BRAND_CONTEXTS.has(entry.name));
      return { ...assembly, sections, contexts };
    },
    { prepend: true },
  );
}
