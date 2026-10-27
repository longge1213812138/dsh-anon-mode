# dsh-anon-mode

DSH（DeepSeek Harness）的**匿名模式** Host 插件：把模型系统提示词里的品牌身份替换为通用 AI 助手身份，其余能力完全不变。

- 只改系统提示词**文本**，不触碰工具、技能、计划模式、子代理、上下文压缩、会话存储。
- 不动 UI 标题、日志、网络请求、工具名 —— 因此「匿名 ≠ 隐身」，见 [已知边界](#已知边界)。
- 纯 JS，无依赖、无构建步骤。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [实现原理](#实现原理)
- [三层实现](#三层实现)
- [文件说明](#文件说明)
- [安装](#安装)
- [验证](#验证)
- [卸载与回滚](#卸载与回滚)
- [已知边界](#已知边界)
- [设计取舍](#设计取舍)

---

## 它解决什么问题

DSH 默认会在每个模型步骤的系统提示词里注入若干带品牌的身份与环境文本，例如：

| 来源段 | 典型文本 |
|---|---|
| `harness:identity` | `You are an AI agent powered by DeepSeek Harness.` |
| `deployment:persona-prefix` | `You are a coding agent powered by the {{model}} model.` |
| `harness:source` | 关于「DSH 实现代码 checkout 在哪」的说明段 |
| `app:web-surface` | 关于「你正通过 DSH Web GUI 交互」的说明段 |
| 同名 runtime context | `Current DeepSeek Harness implementation checkout: "..."`、`Current DeepSeek Harness Web GUI URL: "..."` |

此外还替换一条**不带品牌但带来源特征**的段落：

| 来源段 | 处理 |
|---|---|
| `context:file-reference` | `@` 文件引用说明段，换成逐条等义的改写 `FILE_REFERENCE_ANON`（见[第 3 层第 ④ 条](#第-3-层运行时改写indexjs)） |

本插件把品牌段落替换为一句中性身份：

> 你是一名 AI 助手，专注于准确理解用户需求，并高质量完成任务。

这句话刻意**不含品牌名**，也**不含 `{{model}}` 之类的模板变量** —— 后者若未注册会导致提示词组装直接抛错（DSH 对未知变量是硬失败）。

---

## 实现原理

### 1. 先看 DSH 的提示词组装链路

系统提示词由 `@deepseek-ai/dsh-system-prompt` 在每个模型步骤组装，链路是：

```
注册的 sections（全局层 + agent 作用域层，同名时作用域层遮蔽全局层）
        │  按 order 升序、同 order 按名称排序
        ▼
   assembly = { sections, contexts, tools, variables }
        │
        ▼
ctx.waterfall('system-prompt/assemble', assembly, context, () => assembly)
        │   ← 所有插件在这里可以改写最终结果
        ▼
   返回值权威（除非存在 complete: true 段，见下文）
        │
        ▼
   renderPrompt：插值 {{var}}、丢弃空段、空行连接
        │
        ▼
   system 角色消息（历史中的第 0 号节点或最新系统节点）
```

几个关键事实：

1. **sections 和 contexts 是两条独立通道**。sections 变成提示词正文；contexts 变成模型历史里带来源的 **user 角色快照**。所以只删 sections 不够，`harness:source` 和 `app:web-surface` 在两条通道里各有一份。
2. **段有名字，名字就是稳定的接入点**。品牌内容集中在 `harness:identity`、`harness:source`、`app:web-surface` 三个段；身份前缀统一走 `deployment:persona-prefix`。
3. **agent preset 会遮蔽部署级 persona**。preset 挂载 `@deepseek-ai/dsh-persona`，在 **agent 作用域**注册同名 `deployment:persona-prefix` 段，按「作用域遮蔽全局」的规则顶掉 `dsh-system-prompt` 行配置出来的部署级默认值。
4. **waterfall 是最后一道闸**，返回什么就渲染什么。

### 2. 为什么光改配置不够

两条路各自只能盖住一部分：

- **配置**（`includeHarnessIdentity: false`、`personaPrefix`）只能影响**全局层**。它改不动 preset 在 agent 作用域注册的那份 persona —— 而 `standard` / `cordis` 等 preset 恰恰都自带 `You are a coding agent powered by the {{model}} model.`
- **停用 `harness-dev-context` 行**能一次去掉 `harness:source`、`app:web-surface` 的段和两条 context，但它依赖「行 id / 插件名」匹配得上。

所以本插件采用**配置 + 停用 + 运行时兜底**三层：

- 配置层负责「默认就干净」；
- 停用层负责「整块品牌说明不再注册」；
- 运行时层负责「不管谁在上游注册了什么身份前缀，最终结果都必须是匿名句」。

第三层不是冗余：即使前两层因 DSH 版本升级、preset 调整或多层 patch 覆盖而失效，最终文本仍然被改写。

---

## 三层实现

### 第 1 层：配置覆盖（`cordis.patch.yml`）

```yaml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: true
    personaPrefix: '你是一名 AI 助手，专注于准确理解用户需求，并高质量完成任务。'
    personaSuffix: ''
```

- `includeHarnessIdentity: false` —— 关掉 order 为 −1000 的固定开场白 `You are an AI agent powered by DeepSeek Harness.`。这是官方为「部署方自带完整提示词」提供的开关。
- `personaPrefix` —— 把部署级 persona 前缀（web 层原本是 `You are a coding agent powered by the {{model}} model.`）换成匿名句。
- `personaSuffix: ''` —— 后缀留空，渲染时被丢弃。
- `includeRuntimeContext: true` —— 保留运行时上下文能力，只让第 2 层去掉其中的品牌条目。

> **按 id 覆盖会整体替换该行的 `config`**，所以字段必须写全。这里四个字段即为该插件支持的全部字段，其余保持默认。

### 第 2 层：停用来源段插件（`cordis.patch.yml`）

```yaml
- id: harness-dev-context
  name: '@deepseek-ai/dsh-harness-dev-context'
  disabled: true
```

`dsh-harness-dev-context` 这一个插件同时注册：

- 段 `harness:source`（「运行时上下文会给出 DSH 实现 checkout」的说明）
- 段 `app:web-surface`（「你正通过 DSH Web GUI 交互，URL 见运行时上下文」的说明）
- runtime context `harness:source`：`Current DeepSeek Harness implementation checkout: ...`
- runtime context `app:web-surface`：`Current DeepSeek Harness Web GUI URL: ...`

停用它，四条内容一次性消失，且不需要逐个猜文本。

### 第 3 层：运行时改写（`index.js`）

```js
export function apply(ctx) {
  ctx.on(
    'system-prompt/assemble',
    async (_assembly, _context, next) => {
      const assembly = await next();                        // ① 先拿上游（含 preset）的最终结果
      const sections = [];
      for (const section of assembly.sections) {
        if (BRAND_SECTIONS.has(section.name)) continue;      // ② 整段丢弃品牌段
        if (section.name === PERSONA_PREFIX) {               // ③ 身份前缀换成匿名句
          sections.push({ ...section, text: ANON_IDENTITY });
          continue;
        }
        if (section.name === FILE_REFERENCE_SECTION) {       // ④ 文件引用说明换成等义改写
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
      const contexts = assembly.contexts.filter(              // ⑤ 丢弃同名品牌 context
        (entry) => !BRAND_CONTEXTS.has(entry.name),
      );
      return { ...assembly, sections, contexts };
    },
    { prepend: true },                                       // ⑥ 排到最外层
  );
}
```

逐步解释：

**① `await next()` —— 必须在下游之后再改。** waterfall 的监听器是「外层先跑，`next()` 调用内层」，最后一个 `next` 是内置实现。所以 `await next()` 拿到的是**所有其他插件（包括 preset 的 `dsh-persona`）处理完**的 assembly。这正是能盖住 agent 作用域 persona 的原因。

**② `BRAND_SECTIONS` 整段丢弃。** 集合为 `harness:identity`、`harness:source`、`app:web-surface`。即使第 1、2 层没生效（例如将来 DSH 改了默认值或行 id），这些段也进不了最终提示词。

**③ 前缀段替换而非删除。** `deployment:persona-prefix` 不丢弃，只把 `text` 换成匿名句，其余字段（`name`、插值设置）用展开保留。这样匿名身份仍然占据原本的位置，不会因为「段被删光」导致提示词开头空掉。

**④ `context:file-reference` 换成等义改写。** 这条段由 `dsh-file-reference-local` 注册，内容是 `@` 文件引用的使用说明（不含品牌名，但措辞是固定的产品文案）。处理方式与 ③ 相同：**保留段名、顺序与 `interpolate` 设置，只替换 `text`**。替换文本 `FILE_REFERENCE_ANON` 逐条保留原意 —— `@` 前缀、相对路径按工作区根解析、绝对路径指向本机、结尾斜杠表示目录且需列出、其余是文件且需先 `read` 再断言、`@"..."` 用于含空格路径。

> 注意该段的 `text` 是**求值后的字符串**：当 agent 没有 `read` 工具时，上游把它求值为空字符串，渲染时整段被丢弃。所以这里加了一道长度判断 —— 空文本保持为空，避免凭空注入一段本不该出现的说明。

**⑤ contexts 单独过滤。** 这两条是 user 角色快照，不走 sections 通道，必须单独清。否则模型仍会看到 checkout 路径与 GUI URL。

**⑥ `{ prepend: true }` 决定顺序。** Cordis 注册监听器时 `prepend` 会 `unshift` 到列表头，成为**最外层** —— 先于其他监听器执行，因此最后拿到结果、最后改写。

**返回新对象而非原地修改。** `return { ...assembly, sections, contexts }` 避免污染上游可能复用或缓存的对象。

**生命周期。** 监听器通过 `ctx.on` 注册在当前插件的 fiber 上，插件停用或卸载时自动移除，无需手写清理函数。

### `context:file-reference` 的等义改写

`FILE_REFERENCE_ANON` 是 `dsh-file-reference` 导出的 `FILE_REFERENCE_PROMPT` 的**逐条等义改写**，不是删段：

| 原意 | 原文 | 改写后 |
|---|---|---|
| `@` 前缀且为显式引用 | Tokens prefixed with `@` are paths the user explicitly referenced. | 以 `@` 开头的文本是用户显式引用的路径。 |
| 相对路径 / 绝对路径 | Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. | 相对路径以工作区根为基准解析；绝对路径指向本机上的文件或目录。 |
| 结尾斜杠 = 目录，需列出 | A trailing slash marks a directory: list it when its contents matter. | 路径以斜杠结尾表示目录：需要了解其内容时列出该目录。 |
| 其余 = 文件，先 `read` | Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. | 其余情况表示文件：需要其内容时使用 read 工具，在读取之前不得声称已经查看过。 |
| `@"..."` 引号 | `@"..."` quotes a path containing spaces. | `@"..."` 用于引用包含空格的路径。 |

改写文本同样**不含 `{{...}}` 变量**、不改段名、不改 `order`、不改 `interpolate`，因此提示词结构与其他能力完全不受影响。

### 为什么 `minimal` preset 是例外

`minimal` preset 的 persona 声明了 `complete: true`。按 `dsh-system-prompt` 的规则，**在 waterfall 返回之后**，那个 complete 段会被强制恢复为唯一的提示词段 —— 也就是说它绕过了第 3 层。

但它本身是 `You are a helpful software engineer assistant.`，中性无品牌，因此不构成泄漏。本插件**不**尝试处理它（去动它需要替换 preset 配置，收益与风险不成比例）。

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `package.json` | 包标识；`dsh.bundle.patch` 声明补丁入口；`exports` 导出 `./locale/*.json` 与 `./icon` 供插件管理器读取展示元信息；`files` 决定发布时打包哪些文件 |
| `cordis.patch.yml` | bundle 补丁层：覆盖 `system-prompt` 行、停用 `harness-dev-context` 行、插入本插件 |
| `index.js` | Host 插件本体；`system-prompt/assemble` waterfall 改写逻辑 |
| `locale/zh.json` | 插件管理器展示的中文标题与描述 |
| `locale/en.json` | 同上，英文 |
| `icon.svg` | 插件图标（SVG，605 字节，远低于 256 KiB 上限） |

```
dsh-anon-mode/
├── package.json
├── cordis.patch.yml
├── index.js
├── icon.svg
├── locale/
│   ├── en.json
│   └── zh.json
└── README.md
```

这是一个 **Host-only bundle**：没有 `dependencies`、没有安装脚本、没有构建步骤，克隆下来即可被 DSH 加载。

> **关于包名**：本包名为 `@local/dsh-anon-mode`，`@local/` 是 DSH 生态里表示"本地自建包"的惯例前缀，不算已注册的 npm scope。
> 若你想换成自己的 scope，需要**同时**改两处，否则 DSH 加载时会找不到模块：
> ① `package.json` 的 `name`；② `cordis.patch.yml` 中 `insert` 里那一行的 `name`。
> 另外，profile 的 `dependencies` 键名与 `dsh.profile.bundles` 里的条目也要跟着改。

---

## 安装

> 前置：DSH 用 **profile** 组织配置。下文以 web profile 为例，路径形如 `<DSH_HOME>/profiles/web`。

### 方式 A：插件管理器（推荐）

1. 打开 DSH Web GUI → 设置 → 插件。
2. 安装本仓库：填仓库地址（`github:<owner>/<repo>`），或指向本地克隆目录的绝对路径。
3. 启用后**重启 DSH**，让新 bundle 参与组合。

安装器会替你完成：往 `dsh.profile.bundles` 追加本包、写 `dependencies`、跑 `pnpm install`、建 `node_modules` 条目。

### 方式 B：手工 link

1. 在 profile 的 `package.json` 中加依赖：

   ```json
   "@local/dsh-anon-mode": "link:<本仓库克隆的绝对路径>"
   ```

2. 在 `dsh.profile.bundles` 数组**末尾**追加：

   ```json
   "@local/dsh-anon-mode"
   ```

3. 在 profile 目录执行 `pnpm install`（DSH 未运行时）。
4. 重启 DSH。

### 顺序要求

**本包在 `dsh.profile.bundles` 中必须排在 `@deepseek-ai/dsh-web-app` 之后（通常就是数组末尾）。**

补丁层按 bundles 数组顺序依次应用，后者覆盖前者。本包的 patch 需要覆盖 `@deepseek-ai/dsh-web-app` 层设下的 `personaPrefix`；若排在其前面，就会被 web 层反过来覆盖，第 1 层失效。

即便排错，第 3 层的运行时改写仍然生效 —— 但没理由依赖兜底。

---

## 验证

### 快速判断

新开一个会话（**不要用安装前就存在的旧会话**，原因见[已知边界](#已知边界)），然后看模型收到的系统提示词：

- 首段应为 `你是一名 AI 助手，专注于准确理解用户需求，并高质量完成任务。`
- 全文不应出现 `DeepSeek Harness`、`You are a coding agent powered by`、`Current DeepSeek Harness implementation checkout`、`You are interacting with the user through`

### 从会话日志自查（只读）

DSH 把每个事件写进 `<DSH_HOME>/sessions/<工作区>/session-<id>/session.v4.jsonl.zstd`（zstd 分帧）。取出其中 `system/message` 事件的正文，检查上面几个串即可：

```bash
# 任一能读 zstd 的环境；把 <file> 换成你的 session 日志
zstd -dc <file> | grep -c 'DeepSeek Harness'   # 期望 0
```

### 插件管理器侧

设置 → 插件 中应能看到标题「匿名模式 / Anonymous Mode」、上述描述与图标，且状态为已启用、无诊断报错。

---

## 卸载与回滚

本插件的全部改动只落在 **profile 的三处**，按逆序拆即可。**任何一层单独失效都不会让 DSH 起不来** —— 最坏情况也只是回到带品牌的提示词。

### 改动清单

| 位置 | 改了什么 | 回滚动作 |
|---|---|---|
| `profiles/<name>/package.json` → `dependencies` | 新增本包一行 | 删这一行 |
| `profiles/<name>/package.json` → `dsh.profile.bundles` | 数组追加本包 | 删这一项 |
| `profiles/<name>/node_modules/@local/dsh-anon-mode` | 软链（junction）或目录 | 删除 |
| `profiles/<name>/pnpm-lock.yaml` | install 写入的 link 条目 | 可忽略 |
| `profiles/<name>/cordis.patch.yml` | **未被修改** | 无需处理 |

关键点：**本插件以 bundle 方式安装，不写 profile 的 `cordis.patch.yml`。** 回滚时不必去那个文件里找残留，改了反而可能弄坏别的插件配置。

### 方案 A：设置页卸载（推荐）

1. 打开 DSH Web GUI → 设置 → 插件。
2. 找到「匿名模式 / Anonymous Mode」。
3. 移除 / 卸载该 bundle。
4. 重启 DSH。

这条路会同时清理 `package.json`、`pnpm-lock.yaml` 与 `node_modules` 条目，不用手改 JSON，也就不存在改坏 JSON 的风险。

### 方案 B：手工回滚（设置页不可用，但 DSH 能启动）

**B0. 先备份** —— 回滚前把 `package.json` 复制一份，方案 C 的"整份替换"就有据可依：

```powershell
Copy-Item "<DSH_HOME>\profiles\<name>\package.json" "<DSH_HOME>\profiles\<name>\package.json.bak"
```

**B1. 改 `package.json`** —— 只删两行，注意保持 JSON 逗号合法：

```json
"@local/dsh-anon-mode": "link:<本仓库克隆的绝对路径>"
```

```json
"@local/dsh-anon-mode"
```

删完后应是这个形状（其余字段原样保留）：

```json
{
  "dependencies": {
    "...": "..."
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "..."
      ]
    }
  }
}
```

**B2. 删软链或目录**

先看一眼它是什么（确认删的是 link 而不是源码）：

```powershell
Get-Item "<DSH_HOME>\profiles\<name>\node_modules\@local\dsh-anon-mode" -Force |
  Select-Object Attributes, LinkType, Target
```

`LinkType` 为 `Junction` / `SymbolicLink`、`Target` 指向你克隆本仓库的目录，说明是软链 —— **删软链不会删源码**。然后：

```powershell
Remove-Item -Recurse -Force "<DSH_HOME>\profiles\<name>\node_modules\@local\dsh-anon-mode"
```

**B3. 重启 DSH**，再新开会话确认系统提示词首段回到 `You are an AI agent powered by DeepSeek Harness.`，且 `harness:source` / `app:web-surface` 相关内容重新出现。

**B4. lock 文件残留（通常不用管）**

`pnpm-lock.yaml` 会留下一条指向已删目录的条目，本身无害，DSH 启动不读它。**只有当**日后 `pnpm install` 报错时才需要清理，且必须在 DSH **未运行**时执行：

```powershell
pnpm install --lockfile-only
```

### 方案 C：DSH 起不来时的自救

严格说本插件**不会**让 DSH 起不来：它不跑构建、不改 profile patch、运行期失败只影响提示词文本。但如果你同时动过别的插件，或改 `package.json` 时改掉了逗号：

1. 用**记事本**打开 `profiles/<name>/package.json`，先把 JSON 修好。
2. 若已改到无法修复，用 B0 的备份覆盖；没有备份就整份替换成一个只含必需依赖的最小合法版本。
3. 若现有 profile 彻底不可用，可先用另一个 profile 启动（启动参数指定 `--profile <另一个>`），进去后再修原 profile。
4. DSH 能起来之后，回到方案 B 收尾。

### 回滚后验证

```powershell
# 除 pnpm-lock.yaml 外，profile 里不应再有本包残留
Select-String -Path "<DSH_HOME>\profiles\<name>\package.json" -Pattern "anon-mode"
```

- 新开会话，首段恢复为 `You are an AI agent powered by DeepSeek Harness.`
- 设置 → 插件 中不再出现「匿名模式」

> **旧会话不受影响。** 回滚不改动已写入历史的 system 节点，旧会话可能仍持有匿名版提示词；只有新会话才会用回原始文本。这与安装时的行为对称（见[已知边界](#已知边界) 第 1 条）。

---

## 已知边界

如实列出，避免误判「装了就等于隐身」：

1. **旧会话历史不会追溯清理。** 安装前已落盘的 system 节点与 runtime context 快照仍留在该会话历史里，模型这一轮仍可能读到。新开会话、或压缩历史之后才是干净的。
2. **`minimal` preset 例外。** 它用 `complete: true` 在 waterfall 之后强制恢复自身 persona，本插件改不到（文本本身无品牌，见上文）。
3. **只影响系统提示词。** UI 标题栏、日志文件、网络请求、`deepseek` 命名的工具与包名、会话目录名等系统层内容仍会暴露品牌。**匿名 ≠ 隐身。**
4. **其他全局插件注入的内容不受影响**（如风格注入类插件）。本插件只处理身份与环境段落。
5. **依赖内部段名。** `harness:identity` / `harness:source` / `app:web-surface` / `deployment:persona-prefix` / `context:file-reference` 是 DSH 的内部标识，不是公开 API。DSH 升级后请重新验证一次；若段名变动，第 1、2 层通常仍有效，第 3 层需同步更新 `BRAND_SECTIONS` / `FILE_REFERENCE_SECTION`。
6. **`includeRuntimeContext: true` 是刻意保留的。** 只让第 2 层精确去掉两条品牌 context，其他插件的运行时上下文照旧工作。
7. **`context:file-reference` 是上位替换，不是删除。** 段仍在、位置仍在、`interpolate` 仍在，只是文本换成了等义措辞；`@` 引用在 UI 侧的补全与路径语法不受影响（那段逻辑在 `dsh-file-reference` / `dsh-file-reference-local`，不在提示词里）。若上游以后改写了这段原文的语义，`FILE_REFERENCE_ANON` 需要跟着复核。

---

## 设计取舍

| 选择 | 理由 |
|---|---|
| 用 waterfall 兜底，而不是只写配置 | preset 在 agent 作用域注册 persona，配置改不到；waterfall 拿到的是所有层的最终结果 |
| 保留 `deployment:persona-prefix` 段、只换文本 | 删段会造成提示词开头空缺；换文本保持原有位置与排序行为 |
| 匿名句不含 `{{...}}` | 未注册变量会让组装硬失败，宁可静态文本 |
| 停用整个 `harness-dev-context` 插件 | 一次性去掉 2 段 + 2 条 context，避免逐条猜文本 |
| `context:file-reference` 换文本而非删段 | 这段承载 `@` 引用的使用约定，删掉会削弱模型对路径引用的正确处理；等义改写既避开固定文案，又保留全部行为约束 |
| 不处理 `minimal` preset | 它绕过 waterfall 且本身无品牌，改动代价大于收益 |
| 无依赖、无构建 | 降低与 DSH 版本的耦合；克隆即可加载 |
