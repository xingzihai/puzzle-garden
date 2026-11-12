import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertTaskPath, extractTaskBody } from './task-body.ts';

const DEV_DIR = fileURLToPath(new URL('../../../assets/v02/benchmark/tasks/dev/', import.meta.url));
const devFiles = readdirSync(DEV_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();

describe('extractTaskBody', () => {
  it('6 道 dev 题都只保留标题与一至四节，去掉元信息块与五、六节', () => {
    assert.equal(devFiles.length, 6);
    for (const file of devFiles) {
      const md = readFileSync(`${DEV_DIR}${file}`, 'utf8');
      const body = extractTaskBody(md);
      assert.equal(body.sections.map((s) => s.numeral).join(''), '一二三四', file);
      for (const n of ['一', '二', '三', '四']) {
        assert.ok(body.text.includes(`## ${n}、`), `${file} 缺少第 ${n} 节`);
      }
      assert.ok(!body.text.includes('## 五、'), `${file} 不应含第五节`);
      assert.ok(!body.text.includes('## 六、'), `${file} 不应含第六节`);
      assert.ok(!body.text.includes('set_checklist'), `${file} 不应含 v0.2 工具`);
      assert.ok(!body.text.includes('task_id'), `${file} 不应含元信息引用块`);
      assert.ok(body.text.startsWith('# '), `${file} 应以标题开头`);
      for (const section of body.sections) {
        assert.ok(section.body.trim() !== '', `${file} 第 ${section.numeral} 节为空`);
      }
    }
  });

  it('正文确定：同输入逐字节相同', () => {
    const md = readFileSync(`${DEV_DIR}${devFiles[0] ?? ''}`, 'utf8');
    assert.equal(extractTaskBody(md).text, extractTaskBody(md).text);
  });

  it('缺任一必需节时报错，且指名缺了哪节', () => {
    const md = ['# 测试题', '## 一、must', '甲', '## 二、forbidden', '乙', '## 四、风格', '丁'].join('\n');
    assert.throws(() => extractTaskBody(md), /缺少必需章节：## 三、/);
  });

  it('缺标题时报错', () => {
    assert.throws(
      () => extractTaskBody('## 一、must\n甲\n## 二、forbidden\n乙\n## 三、x\n丙\n## 四、y\n丁'),
      /一级标题/,
    );
  });

  it('第五节不存在时截到文件末尾，仍只含四节', () => {
    const md = ['# 题', '## 一、must', 'a', '## 二、forbidden', 'b', '## 三、尺寸', 'c', '## 四、风格', 'd'].join('\n');
    const body = extractTaskBody(md);
    assert.equal(body.sections.length, 4);
    assert.ok(body.text.includes('## 四、风格'));
    assert.equal(body.text, `${md}\n`);
  });
});

describe('assertTaskPath', () => {
  it('普通路径通过，密封题路径报错', () => {
    assert.doesNotThrow(() => {
      assertTaskPath('/tmp/tasks/dev/f1.md');
    });
    assert.throws(() => {
      assertTaskPath('/x/benchmark/sealed/content/a.md');
    }, /sealed/);
  });
});
