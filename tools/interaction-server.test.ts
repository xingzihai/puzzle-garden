/* eslint-disable max-lines */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Config } from '@pg/config';
import { exampleRequirements, exampleScheme } from '@pg/interaction/example';
import { GenerationError } from '@pg/interaction/generate';
import type { GenerationDiagnostics } from '@pg/interaction/generate';
import type { ReviewReport } from '@pg/interaction/review';
import { buildReviewReport } from '@pg/interaction/review-generate';
import { designConflictsFromWarnings } from '@pg/interaction/schema';
import { createSession as createSessionState, reduceSession } from '@pg/interaction/session';
import type { SessionState } from '@pg/interaction/session';
import { saveSession, writeArtifacts } from '@pg/interaction/store';
import type { ChatRequest } from '@pg/llm/schema';
import type { ChatClient, CompleteOptions } from '@pg/llm/client';

import {
  asSession,
  buildEvent,
  createConfirmedSession,
  createSession,
  createSessionId,
  fakeBuildStarter,
  getSession,
  openSse,
  parseJson,
  PNG_BYTES,
  postJson,
  requirementsWithQuestion,
  send,
  successEvents,
  waitForBuild,
  waitForSession,
  waitUntil,
  withServer,
} from './interaction-server-test-support.ts';
import type { StoredSession } from './interaction-server-test-support.ts';
import { createMockClient } from './interaction-server-mock.ts';
import { FAILURE_TEXT_LIMIT } from './interaction-server-diagnostics.ts';
import { parseInteractionServerArgs, runInteractionServerCli } from './interaction-server.ts';
import type { WebReviewBuilder } from './interaction-server-build.ts';
import { startInteractionServer } from './interaction-server-core.ts';
import type { InteractionServerOptions } from './interaction-server-core.ts';
import { SessionManager } from './interaction-server-session.ts';

function gate(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function passingReviewBuilder(): (input: Parameters<WebReviewBuilder>[0]) => ReviewReport {
  return ({ spec, result }) => {
    const report = buildReviewReport({
      spec,
      run: {
        runId: result.outcome.runId,
        designId: spec.schemeId,
        designRevision: spec.schemeRevision,
        status: 'succeeded',
        failure: null,
        delivered: true,
        stopReason: null,
        checkPassed: true,
        cells: 10,
        // 与 exampleSpec 的 12×10 footprint 对齐：accept 门槛要求客观测量全部 pass。
        bounds: [0, 1, 0, spec.counts.footprintX - 1, 8, spec.counts.footprintZ - 1],
        renders: result.renders.length,
      },
    });
    // 测试替身代表“逐条必须项已确认通过”的评审；真实生成器没有证据时会保持 unverified。
    return {
      ...report,
      verdict: {
        ...report.verdict,
        status: 'satisfied',
        musts: report.verdict.musts.map((must) => ({ ...must, status: 'met' as const })),
      },
      nextAction: { ...report.nextAction, kind: 'accept' },
      provenance: {
        version: 1,
        evidence: 'verified',
        specSha256: 'a'.repeat(64),
        archiveSha256: 'b'.repeat(64),
        verifiedMustIds: spec.musts.map((must) => must.id),
      },
    };
  };
}

/** 几何 / 客观测量全部通过，但没有 conformance 证据：musts 全部 unverified。 */
function rejectingReviewBuilder(): WebReviewBuilder {
  return ({ spec, result }) =>
    buildReviewReport({
      spec,
      run: {
        runId: result.outcome.runId,
        designId: spec.schemeId,
        designRevision: spec.schemeRevision,
        status: 'succeeded',
        failure: null,
        delivered: true,
        stopReason: null,
        checkPassed: true,
        cells: 10,
        // 闭区间：与 BuildSpec.counts 的 12 × 10 对齐，避免占地 undersized 干扰本用例。
        bounds: [0, 0, 0, spec.counts.footprintX - 1, 1, spec.counts.footprintZ - 1],
        renders: result.renders.length,
      },
    });
}

interface StoredReviewSession {
  readonly stage: string;
  readonly review: ReviewReport | null;
  readonly reviewWaivers?: readonly {
    readonly mustId: string;
    readonly designRevision: number;
    readonly by: string;
    readonly choice: string;
  }[];
  readonly build: { readonly status: string; readonly runId: string; readonly designRevision: number } | null;
  readonly designs: readonly {
    readonly meta: { readonly id: string; readonly revision: number; readonly status: string };
  }[];
}

function storedReviewSession(text: string): StoredReviewSession {
  return JSON.parse(text) as StoredReviewSession;
}

interface StoredFailureSession {
  readonly stage: string;
  readonly failure: {
    readonly stage: string;
    readonly code: string;
    readonly message: string;
  } | null;
}

/** 状态先进入内存、磁盘 save 稍后完成；测试按落盘结果轮询，避免时序竞争。 */
async function waitForStoredStage(root: string, id: string, stage: string): Promise<StoredFailureSession> {
  const deadline = Date.now() + 5000;
  let last = '';
  for (;;) {
    try {
      last = await readFile(join(root, id, 'session.json'), 'utf8');
      const parsed = JSON.parse(last) as StoredFailureSession;
      if (parsed.stage === stage) return parsed;
    } catch {
      // 文件可能尚未写入；继续轮询。
    }
    if (Date.now() >= deadline) throw new Error(`等待 session.json stage=${stage} 超时；最后内容：${last}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('页面静态资源包含 SSE 工作台 / 心跳 / 临时思考区', async () => {
  await withServer(exampleRequirements(), async (server) => {
    const page = await send(`${server.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.text, /id="workbench"/);
    assert.match(page.text, /id="thinkingPanel"/);
    assert.match(page.text, /id="workbenchHeartbeat"/);

    const app = await send(`${server.url}/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.headers['content-type'] ?? '', /text\/javascript/);
    assert.match(app.text, /new EventSource/);
    assert.match(app.text, /\/stream/);
    assert.match(app.text, /\/review-waiver/);
    assert.match(app.text, /豁免该必须项/);
    assert.match(app.text, /仍在工作/);
    assert.match(app.text, /contentPreview/);

    const css = await send(`${server.url}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.text, /\.workbench/);
    assert.match(css.text, /\.workbench-heartbeat/);
  });
});

test('生成协议：live 默认 content-json，mock 保持 tool', async () => {
  const liveRequests: ChatRequest[] = [];
  await withServer(
    exampleRequirements(),
    async (server) => {
      const created = await createSession(server);
      await waitForSession(server, created.id, (session) => session.status === 'waiting_decision');
      await postJson(`${server.url}/api/sessions/${created.id}/decision`, { action: 'exit' });
      await waitForSession(server, created.id, (session) => session.status === 'done');
    },
    { mode: 'live', requests: liveRequests },
  );
  const liveNarrative = liveRequests.find((request) => request.tools[0]?.function.name === 'submit_narrative');
  assert.ok(liveNarrative !== undefined);
  assert.deepEqual(liveNarrative.thinking, { type: 'enabled' });
  const liveIntent = liveRequests.find((request) => request.tools.length === 0);
  assert.ok(liveIntent !== undefined);
  assert.deepEqual(liveIntent.response_format, { type: 'json_object' });
  assert.deepEqual(liveIntent.thinking, { type: 'disabled' });
  assert.equal(
    liveRequests.some((request) => request.tools[0]?.function.name === 'submit_intent'),
    false,
  );

  const mockRequests: ChatRequest[] = [];
  await withServer(
    exampleRequirements(),
    async (server) => {
      const created = await createSession(server);
      await waitForSession(server, created.id, (session) => session.status === 'waiting_decision');
      await postJson(`${server.url}/api/sessions/${created.id}/decision`, { action: 'exit' });
      await waitForSession(server, created.id, (session) => session.status === 'done');
    },
    { mode: 'mock', requests: mockRequests },
  );
  const mockIntent = mockRequests.find((request) => request.tools[0]?.function.name === 'submit_intent');
  assert.ok(mockIntent !== undefined);
  assert.equal(
    mockRequests.some((request) => request.tools.length === 0),
    false,
  );
});

interface FailureDiagnosticsBody {
  readonly finishReason?: string;
  readonly content?: string;
  readonly reasoningContent?: string;
  readonly rawArguments?: readonly { readonly index: number; readonly text: string }[];
  readonly previous?: { readonly finishReason?: string } | null;
}

interface FailureBody {
  readonly stage?: string;
  readonly sessionId?: string;
  readonly code?: string;
  readonly message?: string;
  readonly repairFailed?: boolean;
  readonly diagnostics?: FailureDiagnosticsBody | null;
}

test('live 生成失败：failure.json 保留 raw diagnostics，且不写密钥 / 完整提示词', async () => {
  const base = createMockClient({ requirements: exampleRequirements() });
  const testKey = 'sk-test-failure-should-not-be-written';
  const promptSentinel = 'FULL-PROMPT-SENTINEL';
  const longContent = `模型正文不是合法 JSON\n${'x'.repeat(FAILURE_TEXT_LIMIT + 32)}`;
  const omitted = longContent.length - FAILURE_TEXT_LIMIT;
  const firstDiagnostics: GenerationDiagnostics = {
    finishReason: 'length',
    promptTokens: 3,
    completionTokens: 4,
    argumentChars: 5,
    argumentTruncated: true,
    content: '',
    rawArguments: [],
  };
  const diagnostics: GenerationDiagnostics & { readonly apiKey: string; readonly prompt: string } = {
    finishReason: 'stop',
    promptTokens: 11,
    completionTokens: 22,
    totalTokens: 33,
    argumentChars: 9,
    argumentTruncated: false,
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
    outputMode: 'content-json',
    thinking: 'thinking:disabled',
    contentChars: longContent.length,
    contentTruncated: false,
    reasoningChars: 6,
    reasoningPresent: true,
    rawArguments: [{ index: 0, text: '{"meta":' }],
    content: longContent,
    reasoningContent: '先核对需求。',
    previous: firstDiagnostics,
    apiKey: testKey,
    prompt: promptSentinel,
  };

  await withServer(
    exampleRequirements(),
    async (server, root) => {
      const created = await createSession(server);
      const failed = await waitForSession(server, created.id, (session) => session.status === 'error');
      assert.equal(failed.stage, 'error');
      assert.match(failed.error ?? '', /schema-invalid/);
      assert.match(failed.error ?? '', /设计意图不是合法 JSON/);
      assert.match(failed.error ?? '', /新建会话/);

      // 失败状态同时落进 session.json：重启后页面仍能看到“失败 + 原因”，而不是停在 design。
      const stored = await waitForStoredStage(root, created.id, 'error');
      assert.ok(stored.failure !== null);
      assert.equal(stored.failure.stage, 'design');
      assert.equal(stored.failure.code, 'schema-invalid');
      assert.match(stored.failure.message, /schema-invalid/);
      assert.match(stored.failure.message, /新建会话/);

      const text = await readFile(join(root, created.id, 'failure.json'), 'utf8');
      const failure = JSON.parse(text) as FailureBody;
      assert.equal(failure.stage, 'design');
      assert.equal(failure.sessionId, created.id);
      assert.equal(failure.code, 'schema-invalid');
      assert.equal(failure.message, '设计意图不是合法 JSON');
      assert.equal(failure.repairFailed, false);

      const saved = failure.diagnostics;
      assert.ok(saved !== null && saved !== undefined);
      assert.equal(saved.finishReason, 'stop');
      assert.equal(saved.previous?.finishReason, 'length');
      assert.deepEqual(saved.rawArguments, [{ index: 0, text: '{"meta":' }]);
      assert.equal(saved.reasoningContent, '先核对需求。');
      assert.ok((saved.content?.length ?? 0) < longContent.length);
      assert.match(saved.content ?? '', new RegExp(`\\[truncated ${String(omitted)} chars\\]$`));

      // 只写模型输出与生成诊断：env / key / prompt 即便挂在 diagnostics 上也不落盘。
      assert.equal(text.includes(testKey), false);
      assert.equal(text.includes(promptSentinel), false);
      assert.equal(text.includes(created.brief), false);
    },
    {
      mode: 'live',
      clientFactory: () => ({
        complete(request, options) {
          if (request.tools.length === 0 && request.response_format?.type === 'json_object') {
            return Promise.reject(
              new GenerationError('schema-invalid', '设计意图不是合法 JSON', undefined, diagnostics),
            );
          }
          return base.complete(request, options);
        },
      }),
    },
  );
});

test('服务重启后仍能读到失败会话与原因（stage=error）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pg-interaction-failure-restore-'));
  const failingFactory = (): ChatClient => {
    const base = createMockClient({ requirements: exampleRequirements() });
    return {
      complete(request: ChatRequest, options: CompleteOptions) {
        if (request.tools.length === 0 && request.response_format?.type === 'json_object') {
          return Promise.reject(
            new GenerationError('expand-invalid', 'DesignIntent 展开失败（requirement-reference）: 引用了不存在的需求'),
          );
        }
        return base.complete(request, options);
      },
    };
  };
  const options = (): InteractionServerOptions => ({
    mode: 'live',
    port: 0,
    sessionRoot: root,
    buildRunRoot: join(root, 'runs'),
    buildLog: () => undefined,
    clientFactory: failingFactory,
  });

  const first = await startInteractionServer(options());
  let id: string;
  try {
    const created = await createSession(first);
    id = created.id;
    await waitForSession(first, id, (session) => session.status === 'error');
    await waitForStoredStage(root, id, 'error');
  } finally {
    await first.close();
  }

  const second = await startInteractionServer(options());
  try {
    const restored = await getSession(second, id);
    assert.equal(restored.stage, 'error');
    assert.equal(restored.status, 'error');
    assert.match(restored.error ?? '', /expand-invalid/);
    assert.match(restored.error ?? '', /requirement-reference/);
    assert.match(restored.error ?? '', /新建会话/);
    assert.equal(restored.canStartBuild, false);
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SSE：快照 / question / stage / thinking / tool / file，思考不落盘，断开清理订阅', async () => {
  let subscribers = 0;
  let sawZero = false;
  await withServer(
    requirementsWithQuestion(),
    async (server, root) => {
      const id = await createSessionId(server);
      const sse = await openSse(`${server.url}/api/sessions/${id}/stream`);
      assert.equal(sse.status, 200);
      assert.match(sse.headers['content-type'] ?? '', /text\/event-stream/);
      assert.equal(sse.headers['cache-control'], 'no-store');
      await waitUntil(() => subscribers === 1);

      const snapshot = await sse.waitFor((event) => event.event === 'snapshot');
      assert.equal(snapshot.data['id'], id);
      assert.equal(snapshot.data['mode'], 'mock');

      const question = await sse.waitFor((event) => event.event === 'question');
      assert.equal(typeof question.data['text'], 'string');

      const waiting = await waitForSession(server, id, (session) => session.status === 'waiting_answers');
      assert.ok(waiting.questions.length > 0);
      const answers = waiting.questions.map((item) => ({
        questionId: item.id,
        answer: '从北侧村道进入，南侧保留看景开口。',
      }));
      const submitted = await postJson(`${server.url}/api/sessions/${id}/answers`, { answers });
      assert.equal(submitted.status, 200);

      const stage = await sse.waitFor(
        (event) => event.event === 'stage' && event.data['stage'] === 'intent' && event.data['status'] === 'start',
      );
      assert.equal(typeof stage.data['stage'], 'string');

      const thinking = await sse.waitFor((event) => event.event === 'thinking');
      const thinkingText = thinking.data['text'];
      assert.equal(typeof thinkingText, 'string');
      assert.ok(stringLength(thinkingText) > 0);
      assert.equal(Object.hasOwn(thinking.data, 'reasoning_content'), false);

      const tool = await sse.waitFor((event) => event.event === 'tool' && event.data['name'] === 'submit_intent');
      assert.equal(Object.hasOwn(tool.data, 'arguments'), false);

      const previewFile = await sse.waitFor((event) => event.event === 'file' && event.data['stage'] === 'preview');
      assert.match(String(previewFile.data['path']), /^preview\/.+\.svg$/);

      const decision = await waitForSession(server, id, (session) => session.status === 'waiting_decision');
      const confirmed = await postJson(`${server.url}/api/sessions/${id}/decision`, { action: 'confirm' });
      assert.equal(confirmed.status, 200);
      const done = await waitForSession(server, id, (session) => session.status === 'done');
      assert.ok(done.artifacts !== null);

      const artifactFile = await sse.waitFor((event) => event.event === 'file' && event.data['stage'] === 'artifacts');
      assert.match(String(artifactFile.data['path']), /\.(md|json)$/);

      const sessionText = await readFile(join(root, id, 'session.json'), 'utf8');
      assert.equal(sessionText.includes(String(thinkingText)), false);
      const designText = await readFile(done.artifacts.design, 'utf8');
      assert.equal(designText.includes(String(thinkingText)), false);
      if (done.artifacts.designIntent !== undefined) {
        const intentText = await readFile(done.artifacts.designIntent, 'utf8');
        assert.equal(intentText.includes(String(thinkingText)), false);
      }
      assert.equal(decision.revisions, done.revisions);

      await sse.close();
      await waitUntil(() => subscribers === 0);
      sawZero = true;
    },
    {
      mode: 'mock',
      onSubscriberCountChange: (_id, count) => {
        subscribers = count;
      },
    },
  );
  assert.equal(sawZero, true);
});

test('SSE：非 GET / 非 SSE / 未知会话返回 4xx', async () => {
  await withServer(exampleRequirements(), async (server) => {
    const id = await createSessionId(server);
    const nonSse = await send(`${server.url}/api/sessions/${id}/stream`);
    assert.equal(nonSse.status, 406);

    const post = await send(`${server.url}/api/sessions/${id}/stream`, { method: 'POST' });
    assert.equal(post.status, 405);

    const missing = await openSse(`${server.url}/api/sessions/ses-missing/stream`);
    assert.equal(missing.status, 404);
    await missing.close();

    await waitForSession(server, id, (session) => session.status === 'waiting_decision');
    await postJson(`${server.url}/api/sessions/${id}/decision`, { action: 'exit' });
    await waitForSession(server, id, (session) => session.status === 'done');
  });
});

function stringLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

test('mock 正常路径：创建 → 等待确认 → 预览 → 确认 → artifacts', async () => {
  await withServer(exampleRequirements(), async (server, root) => {
    const page = await send(`${server.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.text, /拼图花园 · 交互设计台/);
    assert.match(page.text, /mock · 离线/);
    assert.doesNotMatch(page.text, /\{\{MODE_LABEL\}\}/);

    const created = await createSession(server);
    assert.match(created.id, /^[a-z0-9][a-z0-9_-]{0,63}$/);
    assert.equal(created.mode, 'mock');

    const waiting = await waitForSession(server, created.id, (session) => session.status === 'waiting_decision');
    assert.equal(waiting.questions.length, 0);
    assert.equal(waiting.canExit, true);
    assert.equal(waiting.canStartBuild, false);
    assert.ok(waiting.summary !== null);
    assert.equal(waiting.summary.title, '稻田茶亭');
    assert.ok(waiting.previews.length >= 4);
    assert.ok(waiting.previews.some((preview) => preview.name === 'site.svg'));
    assert.ok(waiting.previews.some((preview) => preview.name === 'axon.svg'));
    assert.ok(waiting.previews.some((preview) => preview.name === 'materials.svg'));
    assert.ok(waiting.briefStats !== null);
    assert.ok(waiting.briefStats.designChars > 0);
    assert.ok(waiting.briefStats.taskChars > 0);

    const site = waiting.previews.find((preview) => preview.name === 'site.svg');
    assert.ok(site !== undefined);
    const preview = await send(`${server.url}${site.url}`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers['content-type'] ?? '', /image\/svg\+xml/);
    assert.match(preview.text.trimStart(), /^<svg/);
    assert.equal(preview.headers['cache-control'], 'no-store');

    const confirmed = await postJson(`${server.url}/api/sessions/${created.id}/decision`, { action: 'confirm' });
    assert.equal(confirmed.status, 200);
    const done = await waitForSession(server, created.id, (session) => session.status === 'done');
    assert.equal(done.confirmed, true);
    assert.equal(done.confirmedDesignRevision, 1);
    assert.equal(done.canStartBuild, false, 'mock 模式不可启动真实构建');
    assert.ok(done.artifacts !== null);
    assert.ok(done.artifacts.design.endsWith('design.md'));
    assert.ok(done.artifacts.task.endsWith('build-task.md'));
    assert.match(done.buildCommand, /npm run design:build/);

    const design = await readFile(done.artifacts.design, 'utf8');
    assert.match(design, /稻田茶亭/);
    const stored = JSON.parse(await readFile(join(root, created.id, 'session.json'), 'utf8')) as StoredSession;
    assert.equal(stored.stage, 'compile');
    assert.equal(stored.designs.length, 1);
    assert.equal(stored.designs[0]?.meta.status, 'confirmed');
  });
});

test('提问路径：回答问题后需求 revision+1 并继续生成方案', async () => {
  await withServer(requirementsWithQuestion(), async (server, root) => {
    const created = await createSession(server);
    const waiting = await waitForSession(server, created.id, (session) => session.status === 'waiting_answers');
    assert.equal(waiting.questions.length, 1);
    assert.match(waiting.questions[0]?.text ?? '', /入口/);

    const answers = waiting.questions.map((question) => ({
      questionId: question.id,
      answer: '从北侧村道进入，南侧保留看景开口。',
    }));
    const submitted = await postJson(`${server.url}/api/sessions/${created.id}/answers`, { answers });
    assert.equal(submitted.status, 200);

    const next = await waitForSession(server, created.id, (session) => session.status === 'waiting_decision');
    assert.equal(next.revisions, 1);
    const stored = JSON.parse(await readFile(join(root, created.id, 'session.json'), 'utf8')) as StoredSession;
    assert.equal(stored.requirements?.revision, 2);
    assert.equal(stored.questions.length, 1);

    await postJson(`${server.url}/api/sessions/${created.id}/decision`, { action: 'exit' });
    await waitForSession(server, created.id, (session) => session.status === 'done');
  });
});

test('修订路径：一次反馈生成 revision 2，旧版本保留', async () => {
  await withServer(exampleRequirements(), async (server, root) => {
    const created = await createSession(server);
    const first = await waitForSession(server, created.id, (session) => session.status === 'waiting_decision');
    assert.equal(first.revisions, 1);

    const revised = await postJson(`${server.url}/api/sessions/${created.id}/decision`, {
      action: 'revise',
      feedback: '屋檐再深一点，入口不要正对柜台。',
    });
    assert.equal(revised.status, 200);

    const second = await waitForSession(
      server,
      created.id,
      (session) => session.status === 'waiting_decision' && session.revisions === 2,
    );
    assert.equal(second.artifacts, null);
    assert.ok(second.summary?.concept.includes('网页 mock 修订'));

    const stored = JSON.parse(await readFile(join(root, created.id, 'session.json'), 'utf8')) as StoredSession;
    assert.equal(stored.designs.length, 2);
    const firstDesign = stored.designs[0];
    const secondDesign = stored.designs[1];
    assert.ok(firstDesign !== undefined);
    assert.ok(secondDesign !== undefined);
    assert.equal(firstDesign.meta.revision, 1);
    assert.equal(firstDesign.meta.status, 'superseded');
    assert.equal(secondDesign.meta.revision, 2);

    const confirmed = await postJson(`${server.url}/api/sessions/${created.id}/decision`, { action: 'confirm' });
    assert.equal(confirmed.status, 200);
    const done = await waitForSession(server, created.id, (session) => session.status === 'done');
    assert.ok(done.artifacts !== null);
  });
});

test('非法 JSON / 超大 body / 路径穿越 / 未知会话返回 4xx', async () => {
  await withServer(exampleRequirements(), async (server) => {
    const badJson = await send(`${server.url}/api/sessions`, { method: 'POST', body: '{bad' });
    assert.equal(badJson.status, 400);

    const oversized = await send(`${server.url}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({ brief: 'x'.repeat(1024 * 1024 + 16) }),
    });
    assert.equal(oversized.status, 413);

    const created = await createSession(server);
    const traversal = await send(`${server.url}/api/sessions/${created.id}/preview/..%2F..%2Fsecret.svg`);
    assert.equal(traversal.status, 400);
    await waitForSession(server, created.id, (session) => session.status === 'waiting_decision');
    await postJson(`${server.url}/api/sessions/${created.id}/decision`, { action: 'exit' });
    await waitForSession(server, created.id, (session) => session.status === 'done');

    const unknown = await send(`${server.url}/api/sessions/ses-missing`);
    assert.equal(unknown.status, 404);

    const badId = await send(`${server.url}/api/sessions/Bad_ID`);
    assert.equal(badId.status, 400);

    const badMethod = await send(`${server.url}/api/sessions`, { method: 'PATCH' });
    assert.equal(badMethod.status, 405);

    const unknownRoute = await send(`${server.url}/api/unknown`);
    assert.equal(unknownRoute.status, 404);

    const badDecision = await postJson(`${server.url}/api/sessions/abc/decision`, { action: 'confirm' });
    assert.equal(badDecision.status, 404);
  });
});

test('构建：确认后启动，事件映射成 turns / currentAction，PNG 可下载且非法路径 404', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  await withServer(
    exampleRequirements(),
    async (server) => {
      const confirmed = await createConfirmedSession(server);
      assert.equal(confirmed.canStartBuild, true);
      assert.equal(confirmed.confirmedDesignRevision, 1);
      const tooExpensive = await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, { maxCny: 4 });
      assert.equal(tooExpensive.status, 400);
      assert.equal(fake.calls.length, 0);

      const started = await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      assert.equal(started.status, 202);
      assert.deepEqual(parseJson(started.text), { status: 'running' });

      const build = await waitForBuild(server, confirmed.id, (value) => value.status === 'done');
      assert.equal(build.turns, 1);
      assert.match(build.currentAction, /构建完成/);
      const texts = build.events.map((event) => event.text);
      for (const text of ['第 1 轮开始', '调用 write_code', '检查：ok', '渲染 2 张', '已提交']) {
        assert.ok(texts.includes(text), `缺少事件文本：${text}`);
      }
      assert.ok(build.events.length <= 50);
      assert.equal(build.costCny, 0.12);
      assert.deepEqual(
        build.renders.map((render) => render.name),
        ['axon.png', 'plan.png'],
      );
      assert.equal(build.delivery?.codeVersion, 1);
      assert.ok(typeof build.runDir === 'string' && build.runDir.endsWith('run-fake-1'));

      const session = await getSession(server, confirmed.id);
      assert.equal(session.build.status, 'done');

      const render = build.renders.find((item) => item.name === 'axon.png');
      assert.ok(render !== undefined);
      const download = await send(`${server.url}${render.downloadUrl}`);
      assert.equal(download.status, 200);
      assert.match(download.headers['content-type'] ?? '', /image\/png/);
      assert.equal(download.headers['content-disposition'], 'attachment; filename="axon.png"');
      assert.ok(download.buffer.equals(PNG_BYTES));

      const traversal = await send(`${server.url}/api/sessions/${confirmed.id}/build/renders/..%2F..%2Fsecret.png`);
      assert.equal(traversal.status, 404);
      const missing = await send(`${server.url}/api/sessions/${confirmed.id}/build/renders/missing.png`);
      assert.equal(missing.status, 404);
      const invalid = await send(`${server.url}/api/sessions/${confirmed.id}/build/renders/Bad.png`);
      assert.equal(invalid.status, 404);
    },
    { mode: 'live', buildStarter: fake.starter },
  );
});

test('未确认会话不能启动构建，且不调用 starter', async () => {
  const fake = fakeBuildStarter();
  await withServer(
    exampleRequirements(),
    async (server) => {
      const created = await createSession(server);
      const rejected = await postJson(`${server.url}/api/sessions/${created.id}/build`, {});
      assert.equal(rejected.status, 409);
      assert.equal(fake.calls.length, 0);

      await waitForSession(server, created.id, (session) => session.status === 'waiting_decision');
      await postJson(`${server.url}/api/sessions/${created.id}/decision`, { action: 'exit' });
      await waitForSession(server, created.id, (session) => session.status === 'done');
    },
    { mode: 'live', buildStarter: fake.starter },
  );
});

test('mock 模式拒绝构建且不调用 starter', async () => {
  const fake = fakeBuildStarter();
  await withServer(
    exampleRequirements(),
    async (server) => {
      const confirmed = await createConfirmedSession(server);
      const rejected = await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      assert.equal(rejected.status, 409);
      const rejectedBody = parseJson(rejected.text);
      assert.ok(typeof rejectedBody === 'object' && rejectedBody !== null);
      const rejectedError = (rejectedBody as Record<string, unknown>)['error'];
      assert.ok(typeof rejectedError === 'string');
      assert.match(rejectedError, /mock 模式/);
      assert.equal(fake.calls.length, 0);
    },
    { mode: 'mock', buildStarter: fake.starter },
  );
});

test('同一会话进行中的构建返回 409', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeBuildStarter({
    events: [buildEvent('turn.start', 1, { elapsedMs: 0, spentCny: 0 }, 0)],
    gate,
  });
  await withServer(
    exampleRequirements(),
    async (server) => {
      const confirmed = await createConfirmedSession(server);
      const first = await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      assert.equal(first.status, 202);
      const second = await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      assert.equal(second.status, 409);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fake.calls.length, 1);

      release();
      const build = await waitForBuild(server, confirmed.id, (value) => value.status === 'done');
      assert.equal(build.turns, 1);
    },
    { mode: 'live', buildStarter: fake.starter },
  );
});

test('run.end 停止原因映射成 failed，并保留轮数 / 花费', async () => {
  const fake = fakeBuildStarter({
    events: [
      buildEvent(
        'run.end',
        3,
        {
          stopReason: 'max-turns',
          totals: {
            turns: 3,
            requests: 3,
            attempts: 3,
            promptTokens: 3,
            hitTokens: null,
            missTokens: null,
            completionTokens: 3,
            reasoningTokens: 0,
            costCny: 0.5,
            wallMs: 300,
            images: 0,
            imageBytes: 0,
          },
        },
        0,
      ),
    ],
    outcome: { stopReason: 'max-turns', delivery: null, costCny: 0.5, turns: 3 },
    pngNames: [],
  });
  await withServer(
    exampleRequirements(),
    async (server) => {
      const confirmed = await createConfirmedSession(server);
      await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      const build = await waitForBuild(server, confirmed.id, (value) => value.status === 'failed');
      assert.equal(build.turns, 3);
      assert.equal(build.costCny, 0.5);
      assert.equal(build.stopReason, 'max-turns');
      assert.match(build.error ?? '', /max-turns/);
      assert.deepEqual(build.renders, []);

      const session = await waitForSession(
        server,
        confirmed.id,
        (value) => value.stage === 'compile' && value.build.status === 'failed',
      );
      assert.equal(session.review, null);
      assert.equal(session.reviewError, null);
    },
    { mode: 'live', buildStarter: fake.starter },
  );
});

test('服务重启后从磁盘恢复已确认会话，并可继续启动构建', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pg-interaction-restore-'));
  const fake = fakeBuildStarter({ events: successEvents() });
  const options = (): InteractionServerOptions => ({
    mode: 'live',
    port: 0,
    sessionRoot: root,
    buildRunRoot: join(root, 'runs'),
    buildLog: () => undefined,
    clientFactory: () => createMockClient({ requirements: exampleRequirements() }),
    buildStarter: fake.starter,
  });

  const first = await startInteractionServer(options());
  const confirmed: { id: string } = { id: '' };
  try {
    const session = await createConfirmedSession(first);
    confirmed.id = session.id;
  } finally {
    await first.close();
  }

  const second = await startInteractionServer(options());
  try {
    const restored = await getSession(second, confirmed.id);
    assert.equal(restored.confirmed, true);
    assert.equal(restored.status, 'done');
    assert.ok(restored.artifacts !== null);
    assert.ok(restored.summary !== null);
    assert.ok(restored.previews.length > 0);
    assert.equal(restored.build.status, 'idle');

    const started = await postJson(`${second.url}/api/sessions/${confirmed.id}/build`, {});
    assert.equal(started.status, 202);
    const build = await waitForBuild(second, confirmed.id, (value) => value.status === 'done');
    assert.equal(build.turns, 1);
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('构建完成生成评审：post-review / review / decisionKind；自定义评审不能绕过 accept 重验', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  await withServer(
    exampleRequirements(),
    async (server, root) => {
      const confirmed = await createConfirmedSession(server);
      const started = await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      assert.equal(started.status, 202);

      const reviewed = await waitForSession(
        server,
        confirmed.id,
        (session) =>
          session.stage === 'post-review' &&
          session.status === 'done' &&
          (session.review !== null || session.reviewError !== null),
      );
      assert.equal(reviewed.build.status, 'done');
      assert.ok(reviewed.review !== null);
      assert.equal(reviewed.review.buildRunId, 'run-fake-1');
      assert.equal(reviewed.review.designVersion.revision, 1);
      assert.equal(reviewed.reviewStale, false);
      assert.equal(reviewed.reviewError, null);
      assert.equal(reviewed.decisionKind, null);

      const stored = storedReviewSession(await readFile(join(root, confirmed.id, 'session.json'), 'utf8'));
      assert.equal(stored.stage, 'post-review');
      assert.ok(stored.review !== null);
      assert.equal(stored.build?.status, 'succeeded');

      const accepted = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'accept',
      });
      assert.equal(accepted.status, 409);
      const body = parseJson(accepted.text) as { readonly error?: unknown };
      assert.match(String(body.error), /spec \/ archive \/ evidence/);

      const final = await getSession(server, confirmed.id);
      assert.equal(final.stage, 'post-review');
      assert.equal(final.decisionKind, null);
      assert.ok(final.review !== null);
      const storedAfter = storedReviewSession(await readFile(join(root, confirmed.id, 'session.json'), 'utf8'));
      assert.equal(storedAfter.stage, 'post-review');
    },
    { mode: 'live', buildStarter: fake.starter, reviewBuilder: passingReviewBuilder() },
  );
});

test('评审有未验证 must：accept 返回 409，保持 post-review', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  await withServer(
    exampleRequirements(),
    async (server, root) => {
      const confirmed = await createConfirmedSession(server);
      await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      const reviewed = await waitForSession(
        server,
        confirmed.id,
        (session) =>
          session.stage === 'post-review' &&
          session.status === 'done' &&
          (session.review !== null || session.reviewError !== null),
      );
      assert.ok(reviewed.review !== null);
      assert.ok(reviewed.review.verdict.musts.some((must) => must.status !== 'met' && must.status !== 'waived'));

      const rejected = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'accept',
      });
      assert.equal(rejected.status, 409);
      const body = parseJson(rejected.text) as { readonly error?: unknown };
      assert.match(String(body.error), /必须项|spec \/ archive \/ evidence/);

      const after = await getSession(server, confirmed.id);
      assert.equal(after.stage, 'post-review');
      const stored = storedReviewSession(await readFile(join(root, confirmed.id, 'session.json'), 'utf8'));
      assert.equal(stored.stage, 'post-review');
    },
    { mode: 'live', buildStarter: fake.starter, reviewBuilder: rejectingReviewBuilder() },
  );
});

test('评审未验证 must：无证据时逐条 POST /review-waiver 仍不能 accept，reviewWaivers 落盘', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  await withServer(
    exampleRequirements(),
    async (server, root) => {
      const confirmed = await createConfirmedSession(server);
      await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      const reviewed = await waitForSession(
        server,
        confirmed.id,
        (session) =>
          session.stage === 'post-review' &&
          session.status === 'done' &&
          (session.review !== null || session.reviewError !== null),
      );
      assert.ok(reviewed.review !== null);
      const blocking = reviewed.review.verdict.musts.filter(
        (must) => must.status !== 'met' && must.status !== 'waived',
      );
      assert.ok(blocking.length > 0);
      assert.equal(reviewed.review.verdict.status, 'partial');
      assert.equal(reviewed.review.nextAction.kind, 'ask-user');

      const unknown = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-waiver`, {
        mustId: 'must-does-not-exist',
        choice: '豁免',
      });
      assert.equal(unknown.status, 409);
      const unknownBody = parseJson(unknown.text) as { readonly error?: unknown };
      assert.match(String(unknownBody.error), /没有必须项/);

      for (const must of blocking) {
        const waived = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-waiver`, {
          mustId: must.requirementId,
          choice: '离线测试豁免',
          note: 'HTTP 测试确认',
        });
        assert.equal(waived.status, 200);
        const snapshot = asSession(parseJson(waived.text));
        assert.equal(snapshot.stage, 'post-review');
        assert.ok(snapshot.review !== null);
        const entry = snapshot.review.verdict.musts.find((candidate) => candidate.requirementId === must.requirementId);
        assert.equal(entry?.status, 'waived');
        assert.ok(entry);
        assert.ok(entry.waiver);
        assert.equal(entry.waiver.choice, '离线测试豁免');
        assert.equal(entry.waiver.designRevision, 1);
      }

      const afterWaivers = await getSession(server, confirmed.id);
      assert.equal(afterWaivers.stage, 'post-review');
      assert.ok(afterWaivers.review !== null);
      // 没有绑定证据：即使全部 unverified must 被显式豁免，也不能 accept。
      assert.equal(afterWaivers.review.verdict.status, 'partial');
      assert.equal(afterWaivers.review.nextAction.kind, 'ask-user');

      const storedBeforeAccept = storedReviewSession(await readFile(join(root, confirmed.id, 'session.json'), 'utf8'));
      assert.equal(storedBeforeAccept.reviewWaivers?.length, blocking.length);
      assert.equal(
        storedBeforeAccept.reviewWaivers.every((waiver) => waiver.designRevision === 1 && waiver.by === 'user'),
        true,
      );
      assert.equal(
        storedBeforeAccept.review?.verdict.musts.every((must) => must.status === 'waived' || must.status === 'met'),
        true,
      );

      const accepted = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'accept',
      });
      assert.equal(accepted.status, 409);
      const acceptedBody = parseJson(accepted.text) as { readonly error?: unknown };
      assert.match(String(acceptedBody.error), /provenance|spec \/ archive \/ evidence/);
      const afterReject = await getSession(server, confirmed.id);
      assert.equal(afterReject.stage, 'post-review');

      const stored = storedReviewSession(await readFile(join(root, confirmed.id, 'session.json'), 'utf8'));
      assert.equal(stored.stage, 'post-review');
      assert.equal(stored.reviewWaivers?.length, blocking.length);
      assert.equal(stored.review?.verdict.status, 'partial');
      assert.equal(stored.review.nextAction.kind, 'ask-user');
    },
    { mode: 'live', buildStarter: fake.starter, reviewBuilder: rejectingReviewBuilder() },
  );
});

test('Web manager：冲突菜单 ask 由 chooseConflict 解除并继续，不挂起', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pg-web-conflict-ask-'));
  try {
    const conflict = designConflictsFromWarnings([
      { code: 'furniture-dropped', message: '柜台被丢弃', path: 'furniture.f-counter' },
    ])[0];
    assert.ok(conflict);
    let seeded = createSessionState('ses-web-conflict-ask');
    seeded = reduceSession(seeded, { kind: 'recordRequirements', graph: exampleRequirements() });
    seeded = reduceSession(seeded, { kind: 'skipClarify' });
    seeded = reduceSession(seeded, { kind: 'proposeDesign', scheme: exampleScheme(), conflicts: [conflict] });
    seeded = reduceSession(seeded, { kind: 'recordCheck', designRevision: 1, passed: true, issues: [] });
    assert.equal(seeded.stage, 'review');

    const manager = new SessionManager({
      mode: 'mock',
      sessionRoot: root,
      clientFactory: () => ({ complete: () => new Promise<never>(() => undefined) }),
      buildLog: () => undefined,
    });
    const id = manager.create('冲突菜单实际 ask');
    interface RunningRecord {
      state: SessionState | null;
      status: string;
      pendingDecision: { readonly kind: string; readonly conflictId?: string | null } | null;
    }
    const sessions = (manager as unknown as { sessions: Map<string, RunningRecord> }).sessions;
    const record = sessions.get(id);
    assert.ok(record);
    // create 会立刻跑一次空状态对话；等它写入 intake 并卡在 pending client 后再换成种子状态。
    await waitUntil(() => record.state?.stage === 'intake');
    record.state = { ...seeded, sessionId: id };
    record.status = 'thinking';
    const runPromise = (manager as unknown as { run(record: RunningRecord, resume?: SessionState): Promise<void> }).run(
      record,
      { ...seeded, sessionId: id },
    );

    await waitUntil(() => record.pendingDecision?.conflictId === conflict.id);
    const snapshot = await manager.chooseConflict(id, { conflictId: conflict.id, optionId: 'accept-drop' });
    assert.equal(snapshot.status, 'thinking');
    await waitUntil(
      () => record.state?.designConflicts?.[0]?.status === 'resolved' && record.pendingDecision?.kind === 'review',
    );
    assert.equal(record.status, 'waiting_decision');
    const stateAfterChoice = record.state as SessionState | null;
    assert.equal(stateAfterChoice?.designConflicts?.[0]?.status, 'resolved');

    manager.decide(id, { action: 'exit' });
    await runPromise;
    const finalState = record.state as SessionState | null;
    assert.equal(finalState?.stage, 'review');
    const stored = JSON.parse(await readFile(join(root, id, 'session.json'), 'utf8')) as {
      readonly stage: string;
      readonly designConflicts?: readonly { readonly status: string }[];
    };
    assert.equal(stored.stage, 'review');
    assert.equal(stored.designConflicts?.[0]?.status, 'resolved');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('评审 verdict/nextAction 不合格：即使 must 全 met，accept 仍 409', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  const strictBuilder: WebReviewBuilder = (input) => {
    const report = passingReviewBuilder()(input);
    return {
      ...report,
      verdict: { ...report.verdict, status: 'partial' },
      nextAction: { ...report.nextAction, kind: 'targeted-revision' },
    };
  };
  await withServer(
    exampleRequirements(),
    async (server) => {
      const confirmed = await createConfirmedSession(server);
      await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      await waitForSession(
        server,
        confirmed.id,
        (session) =>
          session.stage === 'post-review' &&
          session.status === 'done' &&
          (session.review !== null || session.reviewError !== null),
      );
      const rejected = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'accept',
      });
      assert.equal(rejected.status, 409);
      const body = parseJson(rejected.text) as { readonly error?: unknown };
      assert.match(String(body.error), /verdict=partial|spec \/ archive \/ evidence/);
      assert.match(String(body.error), /nextAction=targeted-revision|spec \/ archive \/ evidence/);
      const after = await getSession(server, confirmed.id);
      assert.equal(after.stage, 'post-review');
    },
    { mode: 'live', buildStarter: fake.starter, reviewBuilder: strictBuilder },
  );
});

test('评审 mustsTruncated=true：即使 satisfied / accept / must 全 met，accept 仍 409', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  const truncatedBuilder: WebReviewBuilder = (input) => {
    const report = passingReviewBuilder()(input);
    return {
      ...report,
      verdict: { ...report.verdict, mustsTruncated: true },
      nextAction: { ...report.nextAction, kind: 'accept' },
    };
  };
  await withServer(
    exampleRequirements(),
    async (server) => {
      const confirmed = await createConfirmedSession(server);
      await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      await waitForSession(
        server,
        confirmed.id,
        (session) =>
          session.stage === 'post-review' &&
          session.status === 'done' &&
          (session.review !== null || session.reviewError !== null),
      );
      const rejected = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'accept',
      });
      assert.equal(rejected.status, 409);
      const body = parseJson(rejected.text) as { readonly error?: unknown };
      assert.match(String(body.error), /mustsTruncated|spec \/ archive \/ evidence/);
      const after = await getSession(server, confirmed.id);
      assert.equal(after.stage, 'post-review');
    },
    { mode: 'live', buildStarter: fake.starter, reviewBuilder: truncatedBuilder },
  );
});

test('构建完成先落盘 post-review：评审生成期间前端仍可轮询', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeBuildStarter({ events: successEvents() });
  const reviewBuilder: WebReviewBuilder = async (input) => {
    await gate;
    return passingReviewBuilder()(input);
  };
  await withServer(
    exampleRequirements(),
    async (server) => {
      const confirmed = await createConfirmedSession(server);
      const started = await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      assert.equal(started.status, 202);

      const pending = await waitForSession(
        server,
        confirmed.id,
        (session) => session.stage === 'post-review' && session.review === null && session.status === 'done',
      );
      assert.equal(pending.reviewError, null);

      release();
      const reviewed = await waitForSession(server, confirmed.id, (session) => session.review !== null);
      assert.ok(reviewed.review !== null);
      assert.equal(reviewed.reviewError, null);
    },
    { mode: 'live', buildStarter: fake.starter, reviewBuilder },
  );
});

test('评审定向修改：生成 revision 2、旧版本保留，并可确认写 artifacts', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  const reviewBuilder = passingReviewBuilder();
  await withServer(
    exampleRequirements(),
    async (server, root) => {
      const confirmed = await createConfirmedSession(server);
      await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      // finishBuild 先落盘 post-review，再异步生成 review；review 为 null 时 review-decision 会返回 409。
      await waitForSession(
        server,
        confirmed.id,
        (session) => session.stage === 'post-review' && session.review !== null,
      );

      const decision = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'targeted-revision',
        instructions: '屋檐再深一点，入口不要正对柜台。',
      });
      assert.equal(decision.status, 200);
      assert.equal(asSession(parseJson(decision.text)).stage, 'revise');

      // 定向修改先切 review 阶段，再异步生成新摘要；等摘要落盘后再断言，避免高负载下读到最后一次旧快照。
      const revised = await waitForSession(
        server,
        confirmed.id,
        (session) =>
          session.stage === 'review' &&
          session.status === 'waiting_decision' &&
          session.revisions === 2 &&
          session.summary?.concept.includes('网页 mock 修订') === true,
      );
      assert.equal(revised.review, null);
      assert.equal(revised.decisionKind, 'review');
      assert.ok(revised.summary?.concept.includes('网页 mock 修订'));
      // 新 revision 不能继续显示上一版 artifacts / 构建结果。
      assert.equal(revised.artifacts, null);
      assert.equal(revised.briefStats, null);
      assert.equal(revised.confirmed, false);
      assert.equal(revised.confirmedDesignRevision, 1);
      assert.equal(revised.build.status, 'idle');
      assert.equal(revised.canStartBuild, false);
      assert.equal(revised.canExit, false);

      const staleBuild = await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      assert.equal(staleBuild.status, 409);
      assert.equal(fake.calls.length, 1);

      const stored = storedReviewSession(await readFile(join(root, confirmed.id, 'session.json'), 'utf8'));
      assert.equal(stored.stage, 'review');
      assert.equal(stored.designs.length, 2);
      assert.equal(stored.designs[0]?.meta.revision, 1);
      assert.equal(stored.designs.at(0)?.meta.status, 'superseded');
      assert.equal(stored.designs[1]?.meta.revision, 2);

      const confirmedAgain = await postJson(`${server.url}/api/sessions/${confirmed.id}/decision`, {
        action: 'confirm',
      });
      assert.equal(confirmedAgain.status, 200);
      const done = await waitForSession(
        server,
        confirmed.id,
        (session) => session.stage === 'compile' && session.status === 'done' && session.artifacts !== null,
      );
      assert.equal(done.revisions, 2);
      assert.equal(done.confirmed, true);
      assert.equal(done.build.status, 'idle');

      const rebuilt = await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      assert.equal(rebuilt.status, 202);
      const rebuiltDone = await waitForBuild(server, confirmed.id, (value) => value.status === 'done');
      assert.equal(rebuiltDone.delivery?.codeVersion, 1);
    },
    { mode: 'live', buildStarter: fake.starter, reviewBuilder },
  );
});

test('评审后 revision 可在 review 阶段再次修改并确认', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  const reviewBuilder = passingReviewBuilder();
  await withServer(
    exampleRequirements(),
    async (server) => {
      const confirmed = await createConfirmedSession(server);
      await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      // 与上面的定向修改用例同因：finishBuild 先落 post-review，review 仍可能为 null（此时 review-decision 返回 409）。
      await waitForSession(
        server,
        confirmed.id,
        (session) => session.stage === 'post-review' && session.review !== null,
      );
      await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'targeted-revision',
        instructions: '屋檐再深一点。',
      });
      await waitForSession(
        server,
        confirmed.id,
        (session) => session.stage === 'review' && session.revisions === 2 && session.status === 'waiting_decision',
      );

      const reviseAgain = await postJson(`${server.url}/api/sessions/${confirmed.id}/decision`, {
        action: 'revise',
        feedback: '入口再向东移一格。',
      });
      assert.equal(reviseAgain.status, 200);
      const third = await waitForSession(
        server,
        confirmed.id,
        (session) => session.stage === 'review' && session.revisions === 3 && session.status === 'waiting_decision',
      );
      assert.equal(third.decisionKind, 'review');
      assert.equal(third.review, null);

      const confirmedAgain = await postJson(`${server.url}/api/sessions/${confirmed.id}/decision`, {
        action: 'confirm',
      });
      assert.equal(confirmedAgain.status, 200);
      const done = await waitForSession(
        server,
        confirmed.id,
        (session) => session.stage === 'compile' && session.status === 'done' && session.artifacts !== null,
      );
      assert.equal(done.revisions, 3);
      assert.equal(done.confirmed, true);
    },
    { mode: 'live', buildStarter: fake.starter, reviewBuilder },
  );
});

test('未到 post-review 调用 review-decision 返回 409', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  await withServer(
    exampleRequirements(),
    async (server) => {
      const confirmed = await createConfirmedSession(server);
      const rejected = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'accept',
      });
      assert.equal(rejected.status, 409);
      const body = parseJson(rejected.text) as { readonly error?: unknown };
      assert.equal(typeof body.error, 'string');
      assert.match(String(body.error), /评审/);
      assert.equal(fake.calls.length, 0);
    },
    { mode: 'live', buildStarter: fake.starter },
  );
});

test('评审 builder 抛错：构建仍 done，reviewError 非空且不能接受', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  const reviewBuilder: WebReviewBuilder = () => {
    throw new Error('模拟评审读取失败');
  };
  await withServer(
    exampleRequirements(),
    async (server, root) => {
      const confirmed = await createConfirmedSession(server);
      await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      const reviewed = await waitForSession(
        server,
        confirmed.id,
        (session) =>
          session.stage === 'post-review' &&
          session.status === 'done' &&
          session.build.status === 'done' &&
          (session.review !== null || session.reviewError !== null),
      );
      assert.equal(reviewed.build.status, 'done');
      assert.equal(reviewed.review, null);
      assert.match(reviewed.reviewError ?? '', /模拟评审读取失败/);

      const stored = storedReviewSession(await readFile(join(root, confirmed.id, 'session.json'), 'utf8'));
      assert.equal(stored.stage, 'post-review');
      assert.equal(stored.review, null);

      const rejected = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'accept',
      });
      assert.equal(rejected.status, 409);
    },
    { mode: 'live', buildStarter: fake.starter, reviewBuilder },
  );
});

test('服务重启后从 session.json 恢复 post-review 评审', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pg-interaction-review-restore-'));
  const fake = fakeBuildStarter({ events: successEvents() });
  const options = (): InteractionServerOptions => ({
    mode: 'live',
    port: 0,
    sessionRoot: root,
    buildRunRoot: join(root, 'runs'),
    buildLog: () => undefined,
    clientFactory: () => createMockClient({ requirements: exampleRequirements() }),
    buildStarter: fake.starter,
  });

  const first = await startInteractionServer(options());
  let id: string;
  try {
    const confirmed = await createConfirmedSession(first);
    id = confirmed.id;
    await postJson(`${first.url}/api/sessions/${id}/build`, {});
    await waitForSession(first, id, (session) => session.stage === 'post-review' && session.review !== null);
  } finally {
    await first.close();
  }

  const second = await startInteractionServer(options());
  try {
    const restored = await getSession(second, id);
    assert.equal(restored.stage, 'post-review');
    assert.equal(restored.status, 'done');
    assert.equal(restored.reviewError, null);
    assert.ok(restored.review !== null);
    assert.equal(restored.review.buildRunId, 'run-fake-1');
    assert.equal(restored.build.status, 'idle');
    assert.ok(restored.artifacts !== null);
    assert.ok(restored.previews.length > 0);
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('post-review + review=null：重启时从 run/review.json 恢复，不返回 404', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pg-interaction-review-recover-'));
  const options = (): InteractionServerOptions => ({
    mode: 'live',
    port: 0,
    sessionRoot: root,
    buildRunRoot: join(root, 'runs'),
    buildLog: () => undefined,
    clientFactory: () => createMockClient({ requirements: exampleRequirements() }),
  });
  const first = await startInteractionServer(options());
  let id: string;
  try {
    const confirmed = await createConfirmedSession(first);
    id = confirmed.id;
    const stored = JSON.parse(await readFile(join(root, id, 'session.json'), 'utf8')) as SessionState;
    const spec = stored.brief?.spec;
    assert.ok(spec !== undefined);
    const runId = 'run-recovered';
    const report = buildReviewReport({
      spec,
      run: {
        runId,
        designId: spec.schemeId,
        designRevision: spec.schemeRevision,
        status: 'succeeded',
        failure: null,
        delivered: true,
        stopReason: null,
        checkPassed: true,
        cells: 10,
        bounds: [0, 0, 0, 11, 8, 9],
        renders: 1,
      },
    });
    const runDir = join(root, 'runs', runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'review.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await saveSession(
      {
        ...stored,
        stage: 'post-review',
        build: {
          runId,
          designId: spec.schemeId,
          designRevision: spec.schemeRevision,
          status: 'succeeded',
          failure: null,
        },
        review: null,
      },
      { root },
    );
  } finally {
    await first.close();
  }

  const second = await startInteractionServer(options());
  try {
    const restored = await getSession(second, id);
    assert.equal(restored.stage, 'post-review');
    assert.equal(restored.status, 'done');
    assert.ok(restored.review !== null);
    assert.equal(restored.review.buildRunId, 'run-recovered');
    assert.equal(restored.reviewStale, false);
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('accept：重验失败时返回 409，不写入 accept 状态', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  let acceptWrites = 0;
  await withServer(
    exampleRequirements(),
    async (server, root) => {
      const confirmed = await createConfirmedSession(server);
      await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      await waitForSession(server, confirmed.id, (session) => session.review !== null);

      const response = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'accept',
      });
      assert.equal(response.status, 409);
      assert.equal(acceptWrites, 0, '重验失败不能写入 accept 状态');

      const stored = storedReviewSession(await readFile(join(root, confirmed.id, 'session.json'), 'utf8'));
      assert.equal(stored.stage, 'post-review');
    },
    {
      mode: 'live',
      buildStarter: fake.starter,
      reviewBuilder: passingReviewBuilder(),
      sessionWriter: async (state, options) => {
        if (state.stage === 'accept') acceptWrites += 1;
        return saveSession(state, options);
      },
    },
  );
});

test('评审最终 save 完成前 accept 看不到半成品 review；可见后仍重验工件', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  const reviewSaveStarted = gate();
  const reviewSaveGate = gate();
  let blockReviewSave = false;
  await withServer(
    exampleRequirements(),
    async (server) => {
      const confirmed = await createConfirmedSession(server);
      blockReviewSave = true;
      await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      await reviewSaveStarted.promise;

      const pending = await getSession(server, confirmed.id);
      assert.equal(pending.stage, 'post-review');
      assert.equal(pending.review, null);
      const rejected = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'accept',
      });
      assert.equal(rejected.status, 409);

      reviewSaveGate.release();
      const reviewed = await waitForSession(server, confirmed.id, (session) => session.review !== null);
      assert.equal(reviewed.status, 'done');
      const accepted = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'accept',
      });
      // 测试替身没有真实 spec/archive/evidence：即使 review 已可见也必须 409。
      assert.equal(accepted.status, 409);
      assert.equal((await getSession(server, confirmed.id)).stage, 'post-review');
    },
    {
      mode: 'live',
      buildStarter: fake.starter,
      reviewBuilder: passingReviewBuilder(),
      sessionWriter: async (state, options) => {
        if (blockReviewSave && state.stage === 'post-review' && state.review !== null) {
          reviewSaveStarted.release();
          await reviewSaveGate.promise;
        }
        return saveSession(state, options);
      },
    },
  );
});

test('确认 revision 时并发构建被拒绝，不会用旧 artifacts', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  const artifactsStarted = gate();
  const artifactsGate = gate();
  let blockArtifacts = false;
  await withServer(
    exampleRequirements(),
    async (server) => {
      const confirmed = await createConfirmedSession(server);
      await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      await waitForSession(server, confirmed.id, (session) => session.review !== null);
      await waitForBuild(server, confirmed.id, (build) => build.status === 'done');

      await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'targeted-revision',
        instructions: '屋檐再深一点。',
      });
      await waitForSession(
        server,
        confirmed.id,
        (session) => session.stage === 'review' && session.revisions === 2 && session.status === 'waiting_decision',
      );

      blockArtifacts = true;
      const confirm = await postJson(`${server.url}/api/sessions/${confirmed.id}/decision`, { action: 'confirm' });
      assert.equal(confirm.status, 200);
      await artifactsStarted.promise;

      const during = await getSession(server, confirmed.id);
      assert.equal(during.artifacts, null);
      assert.equal(during.confirmed, false);
      const rejected = await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      assert.equal(rejected.status, 409);
      assert.equal(fake.calls.length, 1);

      artifactsGate.release();
      const done = await waitForSession(
        server,
        confirmed.id,
        (session) => session.stage === 'compile' && session.status === 'done' && session.artifacts !== null,
      );
      assert.equal(done.confirmedDesignRevision, 2);
      assert.equal(done.confirmed, true);
      const artifacts = done.artifacts;
      assert.ok(artifacts !== null);
      const spec = JSON.parse(await readFile(artifacts.spec, 'utf8')) as { readonly schemeRevision?: unknown };
      assert.equal(spec.schemeRevision, 2);

      const rebuilt = await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      assert.equal(rebuilt.status, 202);
      await waitForBuild(server, confirmed.id, (build) => build.status === 'done');
    },
    {
      mode: 'live',
      buildStarter: fake.starter,
      reviewBuilder: passingReviewBuilder(),
      artifactWriter: async (dir, brief, intent) => {
        if (blockArtifacts) {
          artifactsStarted.release();
          await artifactsGate.promise;
        }
        return writeArtifacts(dir, brief, intent);
      },
    },
  );
});

test('构建预算：maxCostCny 作为默认上限，body 超出时 clamp', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  await withServer(
    exampleRequirements(),
    async (server) => {
      const confirmed = await createConfirmedSession(server);
      const first = await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      assert.equal(first.status, 202);
      await waitUntil(() => fake.calls.length === 1);
      assert.equal(fake.calls[0]?.maxCny, 1);
      await waitForBuild(server, confirmed.id, (build) => build.status === 'done');

      // 构建完成后 stage 是 post-review，要再测 body 上限需新确认一个会话。
      const another = await createConfirmedSession(server);
      const zero = await postJson(`${server.url}/api/sessions/${another.id}/build`, { maxCny: 0 });
      assert.equal(zero.status, 400);
      const body = parseJson(zero.text) as { readonly error?: unknown };
      assert.match(String(body.error), /大于 0/);

      const second = await postJson(`${server.url}/api/sessions/${another.id}/build`, { maxCny: 2 });
      assert.equal(second.status, 202);
      await waitUntil(() => fake.calls.length === 2);
      assert.equal(fake.calls[1]?.maxCny, 1);
    },
    { mode: 'live', buildStarter: fake.starter, maxCostCny: 1 },
  );
});

test('buildMaxCny 显式覆盖 maxCostCny', async () => {
  const fake = fakeBuildStarter({ events: successEvents() });
  await withServer(
    exampleRequirements(),
    async (server) => {
      const confirmed = await createConfirmedSession(server);
      const started = await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      assert.equal(started.status, 202);
      await waitUntil(() => fake.calls.length === 1);
      assert.equal(fake.calls[0]?.maxCny, 0.75);
      // 等构建收尾再删临时目录；否则 fake starter 还在写 events.jsonl，rm 会偶发 ENOTEMPTY。
      await waitForBuild(server, confirmed.id, (build) => build.status === 'done');
    },
    { mode: 'live', buildStarter: fake.starter, maxCostCny: 2, buildMaxCny: 0.75 },
  );
});

test('评审失败后可 POST /review-retry 恢复；伪造通过评审 accept 仍 409', async () => {
  let attempts = 0;
  const specPaths: (string | undefined)[] = [];
  const reviewBuilder: WebReviewBuilder = (input) => {
    attempts += 1;
    specPaths.push(input.specPath);
    if (attempts === 1) throw new Error('模拟评审读取失败');
    return passingReviewBuilder()(input);
  };
  const fake = fakeBuildStarter({ events: successEvents() });
  await withServer(
    exampleRequirements(),
    async (server, root) => {
      const confirmed = await createConfirmedSession(server);
      await postJson(`${server.url}/api/sessions/${confirmed.id}/build`, {});
      await waitForSession(
        server,
        confirmed.id,
        (session) =>
          session.stage === 'post-review' &&
          session.status === 'done' &&
          session.review === null &&
          session.reviewError !== null,
      );

      const retried = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-retry`, {});
      assert.equal(retried.status, 200);
      const session = asSession(parseJson(retried.text));
      assert.equal(session.reviewError, null);
      assert.ok(session.review !== null);
      assert.equal(session.review.buildRunId, 'run-fake-1');

      const expectedSpecPath = join(root, confirmed.id, 'build-spec.json');
      assert.deepEqual(specPaths, [expectedSpecPath, expectedSpecPath]);

      const stored = storedReviewSession(await readFile(join(root, confirmed.id, 'session.json'), 'utf8'));
      assert.ok(stored.review !== null);
      const accepted = await postJson(`${server.url}/api/sessions/${confirmed.id}/review-decision`, {
        action: 'accept',
      });
      assert.equal(accepted.status, 409);
      assert.equal((await getSession(server, confirmed.id)).stage, 'post-review');
    },
    { mode: 'live', buildStarter: fake.starter, reviewBuilder },
  );
});

test('live CLI：PG_MAX_RUN_COST_CNY 传入 buildMaxCny', async () => {
  const config: Config = {
    llm: { baseUrl: 'http://127.0.0.1:1', apiKey: 'not-used', model: 'deepseek-flash', timeoutMs: 1000 },
    maxRunCostCny: 1.25,
    liveConfirm: true,
  };
  let captured: InteractionServerOptions | undefined;
  const code = await runInteractionServerCli(['--live'], {
    io: { stdout: () => undefined, stderr: () => undefined },
    loadConfig: () => config,
    createLiveClient: () => ({
      complete: () => Promise.reject(new Error('测试不应调用底层 client')),
    }),
    startServer: (options) => {
      captured = options;
      return Promise.resolve({
        server: createServer(),
        port: 0,
        url: 'http://127.0.0.1:0',
        close: () => Promise.resolve(),
      });
    },
    waitForStop: () => Promise.resolve(),
  });
  assert.equal(code, 0);
  assert.equal(captured?.buildMaxCny, 1.25);
});

test('--live 未确认返回 2，且不创建 client / 不启动服务', async () => {
  const out: string[] = [];
  const err: string[] = [];
  let clientCreated = false;
  let serverStarted = false;
  const config: Config = {
    llm: { baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'deepseek-flash', timeoutMs: 1000 },
    maxRunCostCny: 0,
    liveConfirm: false,
  };
  const code = await runInteractionServerCli(['--live'], {
    io: {
      stdout: (line) => {
        out.push(line);
      },
      stderr: (line) => {
        err.push(line);
      },
    },
    loadConfig: () => config,
    createLiveClient: () => {
      clientCreated = true;
      throw new Error('未确认时不应创建 live client');
    },
    startServer: () => {
      serverStarted = true;
      throw new Error('未确认时不应启动服务');
    },
  });
  assert.equal(code, 2);
  assert.equal(clientCreated, false);
  assert.equal(serverStarted, false);
  assert.equal(out.length, 0);
  assert.ok(err.some((line) => line.includes('PG_LIVE_CONFIRM=1')));
});

test('参数解析：默认端口 / session root / 互斥模式', () => {
  assert.deepEqual(parseInteractionServerArgs(['--mock']), {
    mode: 'mock',
    port: 4174,
    sessionRoot: '.work/sessions/web',
    open: false,
    designMode: 'intent',
  });
  assert.deepEqual(
    parseInteractionServerArgs(['--live', '--port', '5000', '--session-root', '/tmp/x', '--open', '--legacy-scheme']),
    {
      mode: 'live',
      port: 5000,
      sessionRoot: '/tmp/x',
      open: true,
      designMode: 'legacy',
    },
  );
  assert.deepEqual(parseInteractionServerArgs([]), {
    mode: 'live',
    port: 4174,
    sessionRoot: '.work/sessions/web',
    open: false,
    designMode: 'intent',
  });
  assert.throws(() => parseInteractionServerArgs(['--mock', '--live']), /只能选一个/);
  assert.throws(() => parseInteractionServerArgs(['--mock', '--port', 'x']), /--port/);
  assert.throws(() => parseInteractionServerArgs(['--mock', '--wat']), /不认识的参数/);
});

test('本机服务拒绝 DNS rebinding：Host 非回环返回 421，不读会话', async () => {
  await withServer(exampleRequirements(), async (server) => {
    const rebound = await send(`${server.url}/api/sessions`, { headers: { Host: 'evil.example' } });
    assert.equal(rebound.status, 421);
    assert.match(rebound.text, /evil\.example/);

    const wrongPort = await send(`${server.url}/`, { headers: { Host: '127.0.0.1:1' } });
    assert.equal(wrongPort.status, 421);

    // 回环地址与 localhost 都放行（端口必须是本次监听的端口）。
    assert.equal((await send(`${server.url}/`)).status, 200);
    assert.equal((await send(`${server.url}/`, { headers: { Host: `localhost:${String(server.port)}` } })).status, 200);
    assert.equal((await send(`${server.url}/`, { headers: { Host: `127.0.0.1:${String(server.port)}` } })).status, 200);
  });
});

test('跨站请求伪造：带外部 Origin 的写请求返回 403，同源与无 Origin 放行', async () => {
  await withServer(exampleRequirements(), async (server) => {
    const forged = await send(`${server.url}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({ brief: '外部页面伪造的请求' }),
      headers: { Origin: 'http://evil.example' },
    });
    assert.equal(forged.status, 403);
    assert.match(forged.text, /跨站/);

    const sameOrigin = await send(`${server.url}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({ brief: '同源页面' }),
      headers: { Origin: server.url },
    });
    assert.equal(sameOrigin.status, 201);

    // curl / 测试客户端不发 Origin：明确放行，避免把命令行用法堵死。
    const noOrigin = await postJson(`${server.url}/api/sessions`, { brief: '命令行客户端' });
    assert.equal(noOrigin.status, 201);
  });
});

test('写请求必须是 JSON：text/plain 与表单类型返回 415', async () => {
  await withServer(exampleRequirements(), async (server) => {
    const plain = await send(`${server.url}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({ brief: '伪装成文本的简单请求' }),
      headers: { 'Content-Type': 'text/plain' },
    });
    assert.equal(plain.status, 415);

    const form = await send(`${server.url}/api/sessions`, {
      method: 'POST',
      body: 'brief=x',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(form.status, 415);

    // 静态资源是 GET，不受这条限制影响。
    assert.equal((await send(`${server.url}/`)).status, 200);
  });
});
