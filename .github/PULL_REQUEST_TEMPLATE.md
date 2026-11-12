## 改了什么

<!-- 一句话说明；关联 issue 用 "Closes #123" -->

## 为什么

<!-- 问题 / 场景 / 设计取舍；大改动请链接 Discussion 或 issue -->

## 怎么验证

<!-- 命令、关键输出、截图；live 改动请附 mock / 离线重放结果 -->

- [ ] `npm run check`
- [ ] `npm run check:conformance`（涉及设计 / 构建 / 证据链时）
- [ ] 手动验证（写明命令）

## 检查清单

- [ ] 没有提交 `.env`、API key、私有网关地址或运行账本
- [ ] 没有提交 Minecraft jar、官方贴图、官方模型 JSON 或官方纹理渲染图
- [ ] 新增源文件有同名测试（或属于 `check-tests.ts` 的例外）
- [ ] 新增第三方代码 / 数据已更新 `THIRD_PARTY_NOTICES.md` 与 `assets/README.md`
- [ ] 文档已同步（命令 / 行为 / 限制有变化时）
- [ ] 我没有把“技术成功”写成“构建已接受”
