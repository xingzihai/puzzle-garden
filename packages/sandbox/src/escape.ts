/**
 * 控制字符转义与宿主路径脱敏（SANDBOX-SPEC §5.3，F4）：child 写报告前对 console 文本与 error
 * 字段做一遍，宿主判 `protocol-error` 时对 stderr 片段也做控制字符转义。保证模型可见文本里没有
 * 裸控制字符（ANSI 转义、回车覆盖、双向控制符等），也不泄露宿主绝对路径与用户名。
 *
 * 保留 `\n` 与 `\t`（多行报错、缩进仍有意义）；其余 C0、DEL、C1、不可见格式字符与双向控制符
 * 转成可见的 `\u{XXXX}`。只做文本变换，不做截断与排序。
 */

/** 需要转义的控制字符：C0（去掉 \t \n）、DEL、C1、不可见格式字符、行 / 段分隔符、双向控制符。 */
const CONTROL =
  // eslint-disable-next-line no-control-regex -- 这个模块的职责就是匹配控制字符并把它们转义
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

/** 把不可见控制字符转成 `\u{XXXX}`；`\n` 与 `\t` 原样保留。 */
export function escapeControl(text: string): string {
  return text.replace(CONTROL, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}`;
  });
}

/** 匹配家目录下的用户名片段；用户名不含 `/` 与空白。 */
const HOME_USER = /\/home\/[^/\s]+/g;

/**
 * 去掉宿主绝对路径里的仓库根、`file://` 前缀与用户名。模型代码的帧是 `pg:building:`，本就不含
 * 路径，原样保留；宿主帧（geometry、child 自身）与任何 console 文本里的路径替换成 `<host>`。
 *
 * `repoRoot` 由调用方从 `import.meta.url` 推得（child-run），本函数保持纯文本变换、可单测。
 */
export function redactHostPaths(text: string, repoRoot: string): string {
  const root = repoRoot.endsWith('/') ? repoRoot.slice(0, -1) : repoRoot;
  return text
    .replaceAll(`file://${root}`, '<host>')
    .replaceAll(root, '<host>')
    .replaceAll('file://', '<host>')
    .replace(HOME_USER, '/home/<user>');
}

/** child 写报告前的单一文本出口：先转义控制字符，再脱敏宿主路径。 */
export function sanitizeText(text: string, repoRoot: string): string {
  return redactHostPaths(escapeControl(text), repoRoot);
}
