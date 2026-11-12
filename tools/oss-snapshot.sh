#!/bin/sh
# 从前私有仓库切出一份可公开的快照，并把它初始化成一条干净的单提交历史。
#
# 为什么不是 `git filter-repo` 重写原仓库：
#   已推送的 127 个提交里有第三方付费课程的逐字转写（assets/v02/tutorial）、
#   个人扫描件（assets/v02/sketches）、30MB 内部语料、内部跑章记录与决策文档。
#   这些必须从历史里消失，而不是"当前树删掉"。重写 215 个提交的校验成本高于重建，
#   而 0.3.0-beta 的研究原型并不值得把这 215 条提交作为公开史。
#   私有仓原样保留（改名归档），考古需求不受影响。
#
# 用法：
#   tools/oss-snapshot.sh [输出目录]        # 默认 .work/oss-public（仓库内，已被 gitignore）
#
# 这个脚本只读原仓库、只在输出目录里写入。不 push、不改远端、不动当前工作树。

set -eu

SOURCE=$(cd "$(dirname "$0")/.." && pwd)
TARGET=${1:-"$SOURCE/.work/oss-public"}

log() { printf '  %s\n' "$1"; }
die() { printf '错误：%s\n' "$1" >&2; exit 1; }

[ -d "$SOURCE/.git" ] || die "找不到仓库：$SOURCE"
case "$(cd "$SOURCE" && pwd)" in
  "$(cd "$(dirname "$TARGET")" 2>/dev/null && pwd)"*) : ;;
esac

printf '\n== 1/5 检查源仓库状态 ==\n'
dirty=$(git -C "$SOURCE" status --porcelain | wc -l | tr -d ' ')
if [ "$dirty" != "0" ]; then
  die "源仓库有 $dirty 处未提交改动。先提交或 stash，避免快照内容与预期不符。"
fi
log "工作树干净"

[ -e "$TARGET" ] && die "输出目录已存在：$TARGET（先自行确认并删除）"
log "输出目录：$TARGET"

printf '\n== 2/5 导出 HEAD 快照（不含 .git 与任何被忽略的运行数据）==\n'
mkdir -p "$TARGET"
# git archive 只导出已提交内容，天然排除 .env / .work / node_modules / graphify-out。
git -C "$SOURCE" archive --format=tar HEAD | tar -x -C "$TARGET"
log "已导出 $(find "$TARGET" -type f | wc -l | tr -d ' ') 个文件"

printf '\n== 3/5 公开前断言 ==\n'
fail=0
check_absent() {
  if [ -e "$TARGET/$1" ]; then
    printf '    ✗ 不应存在：%s\n' "$1" >&2
    fail=1
  fi
}
check_present() {
  if [ ! -e "$TARGET/$1" ]; then
    printf '    ✗ 缺失：%s\n' "$1" >&2
    fail=1
  fi
}
for p in .env .env.sol .git .work graphify-out node_modules; do check_absent "$p"; done
for p in LICENSE NOTICE README.md SECURITY.md CONTRIBUTING.md \
         CODE_OF_CONDUCT.md CHANGELOG.md THIRD_PARTY_NOTICES.md \
         package.json package-lock.json .github/workflows/check.yml \
         docs/mc-visual/fallback-room-iso.png; do check_present "$p"; done
for p in assets/v02/tutorial assets/v02/corpus assets/v02/sketches docs/runs; do check_absent "$p"; done
if ls "$TARGET"/docs/mc-visual/official-*.png >/dev/null 2>&1; then
  printf '    ✗ 仍有 Mojang 贴图衍生图\n' >&2
  fail=1
fi
# 本机路径与凭据形状
if grep -rIl --exclude-dir=.github "/home/${USER:-nobody}" "$TARGET" >/dev/null 2>&1; then
  printf '    ✗ 快照里出现本机绝对路径\n' >&2
  fail=1
fi
if grep -rIlE "sk-[A-Za-z0-9_-]{20,}" "$TARGET" 2>/dev/null | grep -v '\.test\.ts$' | grep -q .; then
  printf '    ✗ 快照里出现疑似密钥（测试夹具以外）\n' >&2
  fail=1
fi
[ "$fail" = "0" ] || die "公开前断言失败，已停止（快照保留在 $TARGET 供排查）"
log "全部通过"

printf '\n== 4/5 初始化一条干净的单提交历史 ==\n'
cd "$TARGET"
git init -q -b main
git config user.useConfigOnly false
VERSION=$(node -e "process.stdout.write(require('./package.json').version)")
git add -A
git -c user.name="$(git -C "$SOURCE" config user.name || echo 'puzzle-garden')" \
    -c user.email="$(git -C "$SOURCE" config user.email || echo 'noreply@example.invalid')" \
    commit -q -m "Puzzle Garden ${VERSION}

一句自然语言需求 → 可施工的体素建筑。
From one sentence to a buildable voxel building.

第一次公开发布。此前的开发历史保留在私有归档仓库中。"
git tag "v${VERSION}"
log "提交数：$(git rev-list --count HEAD)；tag：$(git describe --tags --always)"

printf '\n== 5/5 交付检查 ==\n'
printf '    体积：%s（.git %s）\n' \
  "$(du -sh "$TARGET" | cut -f1)" "$(du -sh "$TARGET/.git" | cut -f1)"
printf '    下一步（都需要你手动执行）：\n'
printf '      cd %s && npm ci && npm run check\n' "$TARGET"
printf '      在 GitHub 建空仓库后：git remote add origin <url> && git push -u origin main --tags\n'
printf '      ⚠ 推送前先把 GitHub 仓库设置（Private vulnerability reporting / Discussions /\n'
printf '        Dependabot / Secret scanning / 分支保护）配好，最后再切换可见性。\n\n'
