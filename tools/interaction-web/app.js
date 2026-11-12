const refs = {
  modePill: document.getElementById('modePill'),
  sessionId: document.getElementById('sessionId'),
  stageLabel: document.getElementById('stageLabel'),
  statusText: document.getElementById('statusText'),
  errorBanner: document.getElementById('errorBanner'),
  messageList: document.getElementById('messageList'),
  emptyConversation: document.getElementById('emptyConversation'),
  workbench: document.getElementById('workbench'),
  streamState: document.getElementById('streamState'),
  workbenchStage: document.getElementById('workbenchStage'),
  workbenchDetail: document.getElementById('workbenchDetail'),
  workbenchClock: document.getElementById('workbenchClock'),
  workbenchHeartbeat: document.getElementById('workbenchHeartbeat'),
  stagePulse: document.getElementById('stagePulse'),
  thinkingPanel: document.getElementById('thinkingPanel'),
  thinkingSummary: document.getElementById('thinkingSummary'),
  thinkingText: document.getElementById('thinkingText'),
  contentPanel: document.getElementById('contentPanel'),
  contentSummary: document.getElementById('contentSummary'),
  contentText: document.getElementById('contentText'),
  progressLog: document.getElementById('progressLog'),
  composer: document.getElementById('composer'),
  briefForm: document.getElementById('briefForm'),
  briefInput: document.getElementById('briefInput'),
  composerError: document.getElementById('composerError'),
  startButton: document.getElementById('startButton'),
  questionPanel: document.getElementById('questionPanel'),
  questionFields: document.getElementById('questionFields'),
  answerError: document.getElementById('answerError'),
  submitAnswers: document.getElementById('submitAnswers'),
  decisionPanel: document.getElementById('decisionPanel'),
  decisionHint: document.getElementById('decisionHint'),
  decisionIssues: document.getElementById('decisionIssues'),
  conflictChoices: document.getElementById('conflictChoices'),
  feedbackInput: document.getElementById('feedbackInput'),
  decisionError: document.getElementById('decisionError'),
  confirmButton: document.getElementById('confirmButton'),
  reviseButton: document.getElementById('reviseButton'),
  exitButton: document.getElementById('exitButton'),
  newSessionButton: document.getElementById('newSessionButton'),
  schemePanel: document.querySelector('.scheme-panel'),
  schemeEmpty: document.getElementById('schemeEmpty'),
  schemeBody: document.getElementById('schemeBody'),
  revisionLabel: document.getElementById('revisionLabel'),
  schemeKicker: document.getElementById('schemeKicker'),
  schemeTitle: document.getElementById('schemeTitle'),
  schemeConcept: document.getElementById('schemeConcept'),
  scopeValue: document.getElementById('scopeValue'),
  roomsValue: document.getElementById('roomsValue'),
  decisionsValue: document.getElementById('decisionsValue'),
  mustsList: document.getElementById('mustsList'),
  openList: document.getElementById('openList'),
  previewCount: document.getElementById('previewCount'),
  previewGallery: document.getElementById('previewGallery'),
  previewMeta: document.getElementById('previewMeta'),
  briefStats: document.getElementById('briefStats'),
  gatesList: document.getElementById('gatesList'),
  artifactsPanel: document.getElementById('artifactsPanel'),
  artifactPaths: document.getElementById('artifactPaths'),
  buildCommand: document.getElementById('buildCommand'),
  buildStartButton: document.getElementById('buildStartButton'),
  buildNote: document.getElementById('buildNote'),
  buildPanel: document.getElementById('buildPanel'),
  buildStatus: document.getElementById('buildStatus'),
  buildTurns: document.getElementById('buildTurns'),
  buildAction: document.getElementById('buildAction'),
  buildCost: document.getElementById('buildCost'),
  buildError: document.getElementById('buildError'),
  buildLog: document.getElementById('buildLog'),
  buildDelivery: document.getElementById('buildDelivery'),
  buildDeliveryText: document.getElementById('buildDeliveryText'),
  buildRenders: document.getElementById('buildRenders'),
  reviewPanel: document.getElementById('reviewPanel'),
  reviewStatus: document.getElementById('reviewStatus'),
  reviewMeta: document.getElementById('reviewMeta'),
  reviewError: document.getElementById('reviewError'),
  reviewRetryButton: document.getElementById('reviewRetryButton'),
  reviewBody: document.getElementById('reviewBody'),
  reviewNextAction: document.getElementById('reviewNextAction'),
  reviewObjectiveNotes: document.getElementById('reviewObjectiveNotes'),
  reviewMeasurements: document.getElementById('reviewMeasurements'),
  reviewMusts: document.getElementById('reviewMusts'),
  reviewDefects: document.getElementById('reviewDefects'),
  reviewVisualVerdict: document.getElementById('reviewVisualVerdict'),
  reviewVisualNote: document.getElementById('reviewVisualNote'),
  reviewVisualLists: document.getElementById('reviewVisualLists'),
  reviewStrengthsGroup: document.getElementById('reviewStrengthsGroup'),
  reviewWeaknessesGroup: document.getElementById('reviewWeaknessesGroup'),
  reviewNotesGroup: document.getElementById('reviewNotesGroup'),
  reviewStrengths: document.getElementById('reviewStrengths'),
  reviewWeaknesses: document.getElementById('reviewWeaknesses'),
  reviewNotes: document.getElementById('reviewNotes'),
  reviewActions: document.getElementById('reviewActions'),
  reviewStageHint: document.getElementById('reviewStageHint'),
  reviewInlineError: document.getElementById('reviewInlineError'),
  reviewButtons: document.getElementById('reviewButtons'),
  reviewAcceptButton: document.getElementById('reviewAcceptButton'),
  reviewTargetedButton: document.getElementById('reviewTargetedButton'),
  reviewRedesignButton: document.getElementById('reviewRedesignButton'),
  reviewEditor: document.getElementById('reviewEditor'),
  reviewInstructions: document.getElementById('reviewInstructions'),
  reviewSubmitButton: document.getElementById('reviewSubmitButton'),
  reviewCancelButton: document.getElementById('reviewCancelButton'),
  reviewHint: document.getElementById('reviewHint'),
};

const STATUS_LABEL = {
  idle: '等待输入需求',
  thinking: '思考中…',
  waiting_answers: '等待回答',
  waiting_decision: '等待确认',
  done: '已完成',
  error: '出错',
};

const STAGE_LABEL = {
  intake: '接收需求',
  understand: '解析需求',
  clarify: '澄清问题',
  design: '生成方案',
  check: '确定性检查',
  review: '待确认',
  revise: '定向修订',
  confirm: '已确认',
  compile: '编译简报',
  build: '构建',
  'post-review': '构建后评审',
  accept: '验收',
  'targeted-revision': '定点修改',
  redesign: '重新设计',
};

const PROGRESS_STAGE_LABEL = {
  requirements: '解析需求',
  intent: '生成方案',
  repair: '修复方案',
  expand: '展开方案',
  lint: '确定性检查',
  preview: '生成预览',
  artifacts: '写出文件',
  review: '等待确认',
  session: '会话',
};

const STREAM_LABEL = {
  idle: '未连接',
  connecting: '连接中…',
  open: '实时',
  reconnecting: '重连中…',
  closed: '已断开',
  unavailable: '轮询模式',
};

const PROGRESS_KINDS = ['stage', 'thinking', 'content', 'tool', 'patch', 'file', 'question', 'error'];

const PROGRESS_KIND_LABEL = {
  stage: '阶段',
  tool: '工具',
  patch: '修复',
  file: '文件',
  question: '提问',
  error: '错误',
};

const ARTIFACT_KEYS = ['design', 'task', 'spec', 'gates', 'promptMeta'];

const BUILD_STATUS_LABEL = {
  idle: '待启动',
  running: '构建中',
  done: '已完成',
  failed: '失败',
};

const REVIEW_STATUS_LABEL = {
  satisfied: '通过',
  partial: '部分通过',
  'not-satisfied': '未通过',
};

const MEASUREMENT_STATUS_LABEL = {
  pass: '通过',
  fail: '未通过',
  'not-checked': '未检查',
};

const MUST_STATUS_LABEL = {
  met: '已满足',
  'not-met': '未满足',
  unverified: '未验证',
  waived: '用户已豁免',
};

const DEFECT_SEVERITY_LABEL = {
  blocker: '阻塞',
  major: '主要',
  minor: '次要',
};

const DEFECT_CATEGORY_LABEL = {
  design: '设计',
  construction: '施工',
  preference: '偏好',
  capability: '能力',
};

const VISUAL_VERDICT_LABEL = {
  pass: '通过',
  partial: '部分通过',
  fail: '未通过',
  'not-reviewed': '未接入看图评审',
};

const NEXT_ACTION_LABEL = {
  accept: '接受结果',
  'targeted-revision': '按评审定向修改',
  redesign: '重新设计',
  'ask-user': '等待你决定',
};

const state = {
  sessionId: null,
  snapshot: null,
  busy: false,
  pollTimer: null,
  pollFailures: 0,
  networkError: null,
  renderedMessages: 0,
  questionKey: '',
  questionInputs: new Map(),
  decisionKey: '',
  previewKey: '',
  buildLogKey: '',
  buildRenderKey: '',
  reviewKey: '',
  reviewMode: null,
  reviewSubmitting: null,
  wasConfirmed: false,
  stream: null,
  streamOpen: false,
  streamState: 'idle',
  streamAttempts: 0,
  reconnectTimer: null,
  lastEventAt: null,
  lastProgressSeq: 0,
  progress: [],
  progressStage: null,
  liveDetail: '',
  stageStartedAt: null,
  thinkingChars: 0,
  contentChars: 0,
  thinkingText: '',
  contentText: '',
  progressLogKey: '',
  lastStatus: null,
  refreshTimer: null,
};

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function show(element, visible) {
  element.hidden = !visible;
}

function setText(element, value) {
  element.textContent = value;
}

function setError(element, message) {
  element.textContent = message;
  element.hidden = message === '';
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError('无法连接本地服务，请确认 design:web 仍在运行。', 0);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      payload !== null && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status);
  }
  return payload;
}

function statusLabel(snapshot) {
  if (snapshot.status === 'done' && !snapshot.confirmed) return '已结束（未确认）';
  return STATUS_LABEL[snapshot.status] ?? snapshot.status;
}

function setBusy(busy) {
  state.busy = busy;
  syncControls();
}

function syncControls() {
  const snapshot = state.snapshot;
  const waiting = snapshot?.status === 'waiting_decision';
  const buildStatus = snapshot?.build?.status ?? 'idle';
  const canStartBuild = snapshot?.canStartBuild === true;
  const buildDisabled = state.busy || !canStartBuild || buildStatus === 'running';
  refs.startButton.disabled = state.busy || state.sessionId !== null;
  refs.startButton.textContent = state.busy && state.sessionId === null ? '创建中…' : '开始设计';
  refs.submitAnswers.disabled = state.busy;
  refs.confirmButton.disabled =
    state.busy || !waiting || snapshot?.decisionKind !== 'review' || hasOpenBlockingConflict(snapshot);
  refs.reviseButton.disabled = state.busy || !waiting;
  refs.exitButton.disabled = state.busy || snapshot?.canExit !== true;
  refs.feedbackInput.disabled = state.busy || !waiting;
  refs.buildStartButton.disabled = buildDisabled;
  refs.buildStartButton.textContent =
    buildStatus === 'running' ? '构建中…' : buildStatus === 'done' ? '构建完成' : '开始构建';
  syncReviewControls();
}

function hasOpenBlockingConflict(snapshot) {
  const conflicts = Array.isArray(snapshot?.conflicts) ? snapshot.conflicts : [];
  return conflicts.some(
    (conflict) => isRecord(conflict) && conflict.severity === 'blocking' && conflict.status !== 'resolved',
  );
}

function reviewReport() {
  const review = state.snapshot?.review;
  return isRecord(review) ? review : null;
}

function canDecideReview() {
  const snapshot = state.snapshot;
  return snapshot !== null && snapshot.stage === 'post-review' && reviewReport() !== null;
}

/**
 * 与 server 的 reviewAcceptBlockers 对齐：只有 verdict=satisfied、nextAction=accept、
 * 未截断，且全部可见 must 为 met 或绑定当前 revision 的用户 waived 才允许接受。
 */
function reviewAcceptEligible(report = reviewReport()) {
  if (report === null) return false;
  const verdict = isRecord(report.verdict) ? report.verdict : null;
  if (verdict === null || reviewText(verdict.status) !== 'satisfied') return false;
  if (verdict.mustsTruncated === true) return false;
  const nextAction = isRecord(report.nextAction) ? report.nextAction : null;
  if (nextAction === null || reviewText(nextAction.kind) !== 'accept') return false;

  const design = isRecord(report.designVersion) ? report.designVersion : null;
  const revision = typeof design?.revision === 'number' ? design.revision : null;
  const musts = Array.isArray(verdict.musts) ? verdict.musts : [];
  return musts.every((must) => {
    if (!isRecord(must)) return false;
    const status = reviewText(must.status);
    if (status === 'met') return true;
    if (status !== 'waived') return false;
    const waiver = isRecord(must.waiver) ? must.waiver : null;
    if (waiver === null || revision === null) return false;
    return (
      reviewText(waiver.by) === 'user' &&
      reviewText(waiver.mustId) === reviewText(must.requirementId) &&
      waiver.designRevision === revision
    );
  });
}

function syncReviewControls() {
  const allowed = canDecideReview() && !state.busy;
  const eligible = allowed && reviewAcceptEligible();
  refs.reviewAcceptButton.disabled = !eligible || state.reviewSubmitting !== null;
  refs.reviewAcceptButton.title = eligible
    ? ''
    : '评审未达到接受门槛：需要 verdict=satisfied、nextAction=accept，且必须项全部 met 或绑定当前 revision 的用户豁免。';
  refs.reviewTargetedButton.disabled = !allowed || state.reviewSubmitting !== null;
  refs.reviewRedesignButton.disabled = !allowed || state.reviewSubmitting !== null;
  refs.reviewRetryButton.disabled = state.busy;
  refs.reviewAcceptButton.textContent = state.reviewSubmitting === 'accept' ? '接受中…' : '接受结果';
  show(refs.reviewEditor, state.reviewMode !== null);
  refs.reviewInstructions.disabled = !allowed || state.reviewSubmitting !== null;
  refs.reviewCancelButton.disabled = state.busy;
  refs.reviewSubmitButton.textContent =
    state.reviewSubmitting === 'targeted-revision' || state.reviewSubmitting === 'redesign'
      ? '提交中…'
      : state.reviewMode === 'redesign'
        ? '提交重新设计'
        : '提交定向修改';
  refs.reviewSubmitButton.disabled =
    !allowed || state.reviewSubmitting !== null || refs.reviewInstructions.value.trim() === '';
}

function stopPolling() {
  if (state.pollTimer !== null) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function schedulePoll(delay = state.streamOpen ? 2500 : 700) {
  stopPolling();
  if (state.sessionId === null) return;
  state.pollTimer = setTimeout(() => {
    state.pollTimer = null;
    void tick();
  }, delay);
}

async function tick() {
  const ok = await refresh();
  const snapshot = state.snapshot;
  const terminal = snapshot !== null && (snapshot.status === 'done' || snapshot.status === 'error');
  const buildRunning = snapshot?.build?.status === 'running';
  const awaitingReview =
    snapshot !== null &&
    snapshot.stage === 'post-review' &&
    !isRecord(snapshot.review) &&
    !(typeof snapshot.reviewError === 'string' && snapshot.reviewError.trim() !== '');
  if (ok && state.sessionId !== null && (!terminal || buildRunning || awaitingReview)) schedulePoll();
}

async function refresh() {
  const id = state.sessionId;
  if (id === null) return false;
  try {
    const data = await request(`/api/sessions/${encodeURIComponent(id)}`);
    if (!isRecord(data) || data.id !== id) throw new ApiError('服务端返回了不匹配的会话。', 500);
    state.networkError = null;
    state.pollFailures = 0;
    applySnapshot(data);
    return true;
  } catch (error) {
    if (state.sessionId !== id) return false;
    state.pollFailures += 1;
    state.networkError = `刷新失败：${error instanceof Error ? error.message : String(error)}`;
    renderErrorBanner();
    if (error instanceof ApiError && error.status === 404) {
      stopPolling();
      disconnectStream();
    }
    return error instanceof ApiError && error.status === 404 ? false : state.pollFailures < 3;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applySnapshot(data) {
  state.snapshot = data;
  state.sessionId = data.id;
  render();
}

function renderErrorBanner() {
  const message = state.snapshot?.error ?? state.networkError ?? '';
  setError(refs.errorBanner, message);
}

function renderStreamState() {
  refs.streamState.dataset.state = state.streamState;
  setText(refs.streamState, STREAM_LABEL[state.streamState] ?? state.streamState);
}

function setStreamState(next) {
  state.streamState = next;
  renderStreamState();
  renderWorkbenchTiming();
}

function disconnectStream() {
  if (state.reconnectTimer !== null) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  const source = state.stream;
  state.stream = null;
  state.streamOpen = false;
  if (source !== null) source.close();
  setStreamState(state.sessionId === null ? 'idle' : 'closed');
}

function scheduleReconnect() {
  if (state.sessionId === null || state.reconnectTimer !== null) return;
  const attempt = state.streamAttempts;
  state.streamAttempts = Math.min(attempt + 1, 5);
  const delay = Math.min(1000 * 2 ** attempt, 10_000);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.sessionId !== null) connectStream();
  }, delay);
}

function connectStream() {
  const id = state.sessionId;
  if (id === null) return;
  disconnectStream();
  if (typeof EventSource === 'undefined') {
    state.streamOpen = false;
    setStreamState('unavailable');
    return;
  }
  setStreamState('connecting');
  const source = new EventSource(`/api/sessions/${encodeURIComponent(id)}/stream`);
  state.stream = source;
  source.addEventListener('snapshot', (event) => {
    handleSnapshotEvent(event, source);
  });
  for (const kind of PROGRESS_KINDS) {
    source.addEventListener(kind, (event) => {
      handleProgressEvent(event, kind, source);
    });
  }
  source.onopen = () => {
    if (state.stream !== source) return;
    state.streamOpen = true;
    state.streamAttempts = 0;
    state.lastEventAt = Date.now();
    setStreamState('open');
    schedulePoll();
  };
  source.onerror = () => {
    if (state.stream !== source) return;
    state.streamOpen = false;
    if (source.readyState === EventSource.CLOSED) {
      state.stream = null;
      setStreamState('reconnecting');
      scheduleReconnect();
    } else {
      setStreamState('reconnecting');
    }
  };
}

function parseEventData(event) {
  if (typeof event.data !== 'string') return null;
  try {
    const parsed = JSON.parse(event.data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function handleSnapshotEvent(event, source) {
  if (state.stream !== source) return;
  const data = parseEventData(event);
  if (data === null || typeof data.id !== 'string' || data.id !== state.sessionId) return;
  if (typeof data.progressSeq === 'number' && data.progressSeq < state.lastProgressSeq) {
    resetProgressState();
  }
  state.lastEventAt = Date.now();
  state.streamOpen = true;
  setStreamState('open');
  applySnapshot(data);
  schedulePoll();
}

function handleProgressEvent(event, kind, source) {
  if (state.stream !== source) return;
  const data = parseEventData(event);
  if (data === null || typeof data.seq !== 'number' || typeof data.kind !== 'string') return;
  if (data.seq <= state.lastProgressSeq) return;
  state.lastProgressSeq = data.seq;
  state.lastEventAt = Date.now();
  state.progress.push(data);
  if (state.progress.length > 200) state.progress.splice(0, state.progress.length - 200);
  applyProgressEvent(data, kind);
  renderWorkbench();
  if (data.kind === 'question' || data.kind === 'error' || (data.kind === 'stage' && data.status === 'done')) {
    scheduleRefreshSoon();
  }
}

function applyProgressEvent(event, eventName) {
  const kind = typeof event.kind === 'string' && event.kind !== '' ? event.kind : eventName;
  const stage = typeof event.stage === 'string' && event.stage !== '' ? event.stage : 'session';
  const status = typeof event.status === 'string' ? event.status : '';
  const detail = typeof event.detail === 'string' ? event.detail : '';
  if (kind === 'stage') {
    state.progressStage = { stage, status, detail, at: Date.now() };
    if (status === 'start') {
      state.stageStartedAt = Date.now();
      state.liveDetail = '';
    }
    if (detail !== '') state.liveDetail = detail;
    return;
  }
  if (kind === 'thinking') {
    const text = typeof event.text === 'string' ? event.text : '';
    appendThinking(text);
    state.liveDetail = '正在思考…';
    return;
  }
  if (kind === 'content') {
    const text = typeof event.text === 'string' ? event.text : '';
    appendContent(text);
    state.liveDetail = '正在接收结构化正文…';
    return;
  }
  if (kind === 'tool') {
    const name = typeof event.name === 'string' && event.name !== '' ? event.name : '工具';
    const statusText = status === 'start' ? '开始' : status === 'done' ? '完成' : '生成参数中';
    state.liveDetail = `调用 ${name} · ${statusText}`;
    return;
  }
  if (kind === 'patch') {
    const path = typeof event.path === 'string' ? event.path : '未知路径';
    const op = typeof event.op === 'string' ? event.op : 'replace';
    state.liveDetail = `应用修复 ${path} · ${op}`;
    return;
  }
  if (kind === 'file') {
    const path = typeof event.path === 'string' ? event.path : '文件';
    const bytes = typeof event.bytes === 'number' ? ` · ${formatBytes(event.bytes)}` : '';
    state.liveDetail = `${status === 'start' ? '写入' : status === 'error' ? '写入失败' : '已写入'} ${path}${bytes}`;
    return;
  }
  if (kind === 'question') {
    const text = typeof event.text === 'string' ? event.text : '';
    state.liveDetail = text === '' ? '等待你的回答' : `提问：${text}`;
    return;
  }
  if (kind === 'error') {
    state.liveDetail = detail === '' ? '运行出错' : `错误：${detail}`;
  }
}

function appendThinking(text) {
  if (text === '') return;
  state.thinkingText = `${state.thinkingText}${text}`;
  if (state.thinkingText.length > 60_000) state.thinkingText = state.thinkingText.slice(-60_000);
  state.thinkingChars = state.thinkingText.length;
}

function appendContent(text) {
  if (text === '') return;
  state.contentText = `${state.contentText}${text}`;
  if (state.contentText.length > 60_000) state.contentText = state.contentText.slice(-60_000);
  state.contentChars = state.contentText.length;
}

/** content-json 的正文是 JSON；工作台只展示去标点的流式预览，避免把裸 JSON 倒进页面。 */
function contentPreview(text) {
  const lines = text
    .replace(/```(?:json)?/gi, '')
    .replace(/[{}[\]]/g, '\n')
    .replace(/",\s*"/g, '\n')
    .replace(/"/g, '')
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/^,\s*/, ''))
    .filter((line) => line !== '');
  const preview = lines.slice(-200).join('\n');
  return preview.length <= 12_000 ? preview : preview.slice(-12_000);
}

function scheduleRefreshSoon() {
  if (state.refreshTimer !== null) return;
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    if (state.sessionId !== null) void refresh();
  }, 150);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${String(bytes)} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function stageLabel(stage) {
  return PROGRESS_STAGE_LABEL[stage] ?? stage ?? '处理中';
}

function progressEventText(event) {
  const stage = stageLabel(typeof event.stage === 'string' ? event.stage : 'session');
  const status = typeof event.status === 'string' ? event.status : '';
  const detail = typeof event.detail === 'string' ? event.detail : '';
  if (event.kind === 'stage') {
    const suffix = status === 'start' ? '开始' : status === 'done' ? '完成' : status === 'error' ? '失败' : '';
    return `${stage}${suffix === '' ? '' : ` · ${suffix}`}${detail === '' ? '' : ` · ${detail}`}`;
  }
  if (event.kind === 'tool') {
    const name = typeof event.name === 'string' && event.name !== '' ? event.name : '工具';
    const suffix = status === 'start' ? '开始' : status === 'done' ? '完成' : '生成参数中';
    return `${stage} · 调用 ${name}（${suffix}）`;
  }
  if (event.kind === 'patch') {
    const path = typeof event.path === 'string' ? event.path : '未知路径';
    const op = typeof event.op === 'string' ? event.op : 'replace';
    return `${stage} · 修复 ${path}（${op}）`;
  }
  if (event.kind === 'file') {
    const path = typeof event.path === 'string' ? event.path : '文件';
    const bytes = typeof event.bytes === 'number' ? ` · ${formatBytes(event.bytes)}` : '';
    const suffix = status === 'error' ? '写入失败' : status === 'start' ? '写入中' : '已写入';
    return `${stage} · ${suffix} ${path}${bytes}`;
  }
  if (event.kind === 'question') {
    const text = typeof event.text === 'string' ? event.text : '';
    return `提问 · ${text}`;
  }
  if (event.kind === 'error') {
    return detail === '' ? '运行出错' : `错误 · ${detail}`;
  }
  return stage;
}

function renderProgressLog() {
  const events = state.progress.filter((event) => event.kind !== 'thinking' && event.kind !== 'content').slice(-14);
  const key = events
    .map((event) =>
      [
        String(event.seq),
        String(event.kind),
        String(event.status ?? ''),
        String(event.name ?? ''),
        String(event.path ?? ''),
        String(event.detail ?? ''),
        String(event.text ?? '').slice(0, 80),
      ].join('\u0001'),
    )
    .join('\u0002');
  if (key === state.progressLogKey) return;
  state.progressLogKey = key;
  const element = refs.progressLog;
  const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  element.replaceChildren();
  if (events.length === 0) {
    element.append(createElement('li', 'progress-empty', '等待模型事件…'));
    return;
  }
  for (const event of events) {
    const row = createElement('li', 'progress-event');
    row.dataset.kind = typeof event.kind === 'string' ? event.kind : '';
    row.append(
      createElement(
        'span',
        'progress-kind',
        typeof event.kind === 'string' ? (PROGRESS_KIND_LABEL[event.kind] ?? '事件') : '事件',
      ),
    );
    row.append(createElement('span', 'progress-text', progressEventText(event)));
    element.append(row);
  }
  element.scrollTop = nearBottom ? element.scrollHeight : element.scrollTop;
}

function renderWorkbenchTiming() {
  const snapshot = state.snapshot;
  if (state.sessionId === null || snapshot === null) {
    show(refs.workbenchClock, false);
    show(refs.workbenchHeartbeat, false);
    return;
  }
  const working = snapshot.status === 'thinking';
  if (working && state.stageStartedAt !== null) {
    show(refs.workbenchClock, true);
    setText(refs.workbenchClock, `${String(Math.max(0, Math.floor((Date.now() - state.stageStartedAt) / 1000)))}s`);
  } else {
    show(refs.workbenchClock, false);
  }
  const since = state.lastEventAt ?? state.stageStartedAt;
  const silent = since === null ? 0 : Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (working && silent >= 9) {
    show(refs.workbenchHeartbeat, true);
    setText(
      refs.workbenchHeartbeat,
      state.streamOpen
        ? `仍在工作… 已 ${String(silent)} 秒没有新事件`
        : `连接中断，正在重连… 已 ${String(silent)} 秒没有新事件`,
    );
  } else {
    show(refs.workbenchHeartbeat, false);
  }
}

function renderWorkbench() {
  if (state.sessionId === null) {
    show(refs.workbench, false);
    return;
  }
  show(refs.workbench, true);
  const snapshot = state.snapshot;
  const stage = state.progressStage;
  let title = '等待模型事件';
  let detail = '提交需求后，这里会显示模型正在做的每一步。';

  if (stage !== null) {
    const label = stageLabel(stage.stage);
    title = stage.status === 'start' ? `${label}中…` : stage.status === 'done' ? `${label}完成` : `${label}失败`;
    if (stage.detail !== '') detail = stage.detail;
  }
  if (state.liveDetail !== '') detail = state.liveDetail;

  if (snapshot !== null) {
    if (snapshot.status === 'waiting_answers') {
      title = '等待你的回答';
      detail = '模型已暂停；回答澄清问题后会继续。';
    } else if (snapshot.status === 'waiting_decision') {
      title = '方案待确认';
      detail = '本轮生成结束，请查看右侧方案卡并确认或提出修改。';
    } else if (snapshot.status === 'done') {
      title = snapshot.confirmed ? '已完成' : '已结束';
      detail = snapshot.error ?? '会话已结束；临时思考流不会写入 artifacts。';
    } else if (snapshot.status === 'error') {
      title = '运行出错';
      detail = snapshot.error ?? '模型运行失败，请查看错误信息。';
    } else if (snapshot.status === 'thinking' && stage === null && title === '等待模型事件') {
      title = '模型工作中…';
      detail = '正在等待第一个进度事件。';
    }
  }

  setText(refs.workbenchStage, title);
  setText(refs.workbenchDetail, detail);
  refs.stagePulse.dataset.active = snapshot?.status === 'thinking' ? 'true' : 'false';

  show(refs.thinkingPanel, state.thinkingChars > 0);
  if (state.thinkingChars > 0) {
    const thinkingFollow =
      refs.thinkingText.scrollHeight - refs.thinkingText.scrollTop - refs.thinkingText.clientHeight < 40;
    refs.thinkingText.textContent = state.thinkingText;
    if (thinkingFollow) refs.thinkingText.scrollTop = refs.thinkingText.scrollHeight;
    setText(refs.thinkingSummary, `${String(state.thinkingChars)} 字 · 临时，不写入方案`);
  }
  show(refs.contentPanel, state.contentChars > 0);
  if (state.contentChars > 0) {
    const contentFollow =
      refs.contentText.scrollHeight - refs.contentText.scrollTop - refs.contentText.clientHeight < 40;
    refs.contentText.textContent = contentPreview(state.contentText);
    if (contentFollow) refs.contentText.scrollTop = refs.contentText.scrollHeight;
    setText(refs.contentSummary, `${String(state.contentChars)} 字符 · 去 JSON 标点预览`);
  }
  renderStreamState();
  renderProgressLog();
  renderWorkbenchTiming();
}

function resetProgressState() {
  state.lastProgressSeq = 0;
  state.progress = [];
  state.progressStage = null;
  state.liveDetail = '';
  state.stageStartedAt = null;
  state.thinkingChars = 0;
  state.contentChars = 0;
  state.thinkingText = '';
  state.contentText = '';
  state.progressLogKey = '';
  if (refs.thinkingText !== null) refs.thinkingText.textContent = '';
  if (refs.contentText !== null) refs.contentText.textContent = '';
  if (refs.progressLog !== null) refs.progressLog.replaceChildren();
  show(refs.thinkingPanel, false);
  show(refs.contentPanel, false);
}

function render() {
  const snapshot = state.snapshot;
  if (snapshot === null) return;

  refs.modePill.dataset.mode = snapshot.mode;
  setText(refs.modePill, snapshot.mode === 'mock' ? 'mock · 离线' : 'live · 真实模型');
  setText(refs.sessionId, snapshot.id);
  const stage =
    snapshot.status === 'done'
      ? snapshot.confirmed
        ? '已确认'
        : '已结束'
      : (STAGE_LABEL[snapshot.stage] ?? snapshot.stage);
  setText(refs.stageLabel, stage);
  setText(refs.statusText, statusLabel(snapshot));
  refs.statusText.dataset.status = snapshot.status;
  setText(refs.revisionLabel, snapshot.summary === null ? '—' : `v${snapshot.summary.revision}`);

  renderMessages();
  renderQuestions();
  renderDecision();
  renderScheme();
  renderBuild();
  renderReview();
  renderWorkbench();
  renderErrorBanner();
  if (
    (snapshot.status === 'done' || snapshot.status === 'error' || snapshot.status === 'waiting_decision') &&
    state.lastStatus !== snapshot.status
  ) {
    refs.thinkingPanel.open = false;
    refs.contentPanel.open = false;
  }
  state.lastStatus = snapshot.status;
  if (snapshot.confirmed && !state.wasConfirmed) {
    state.wasConfirmed = true;
    requestAnimationFrame(() => {
      const panel = refs.schemePanel;
      const artifacts = refs.artifactsPanel;
      if (panel === null || artifacts === null || artifacts.hidden) return;
      const top = artifacts.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 12;
      panel.scrollTop = Math.max(0, top);
    });
  }
  if (!snapshot.confirmed) state.wasConfirmed = false;
  syncControls();
}

function renderMessages() {
  const messages = state.snapshot?.messages ?? [];
  const element = refs.messageList;
  const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  const previousTop = element.scrollTop;

  if (state.renderedMessages > messages.length) {
    element.replaceChildren();
    state.renderedMessages = 0;
  }
  if (messages.length === 0) {
    if (!refs.emptyConversation.isConnected) element.append(refs.emptyConversation);
    return;
  }
  if (refs.emptyConversation.isConnected) refs.emptyConversation.remove();

  for (let index = state.renderedMessages; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const article = createElement('article', 'message');
    article.dataset.role = message.role;
    const role = message.role === 'user' ? '你' : message.role === 'assistant' ? '设计 agent' : '系统';
    article.append(createElement('span', 'message-role', role));
    article.append(createElement('div', 'message-body', message.text));
    element.append(article);
  }
  state.renderedMessages = messages.length;
  if (nearBottom) element.scrollTop = element.scrollHeight;
  else element.scrollTop = previousTop;
}

function renderQuestions() {
  const snapshot = state.snapshot;
  const questions = snapshot !== null && snapshot.status === 'waiting_answers' ? snapshot.questions : [];
  if (questions.length === 0) {
    show(refs.questionPanel, false);
    state.questionKey = '';
    state.questionInputs.clear();
    return;
  }

  show(refs.questionPanel, true);
  const key = questions.map((question) => `${question.id}\u0001${question.text}`).join('\u0002');
  if (key !== state.questionKey) {
    state.questionKey = key;
    state.questionInputs.clear();
    refs.questionFields.replaceChildren();
    for (const question of questions) {
      const wrapper = createElement('div', 'question');
      wrapper.append(createElement('p', 'question-text', question.text));
      const input = document.createElement('textarea');
      input.rows = 2;
      input.maxLength = 4000;
      input.placeholder = '写下你的回答';
      input.setAttribute('aria-label', question.text);
      input.addEventListener('input', () => {
        setError(refs.answerError, '');
      });
      wrapper.append(input);
      state.questionInputs.set(question.id, input);

      const fallback = suggestedDefault(question.text);
      if (fallback !== null) {
        const button = createElement('button', 'default-button', `采用建议默认：${fallback}`);
        button.type = 'button';
        button.addEventListener('click', () => {
          input.value = fallback;
          input.focus();
          setError(refs.answerError, '');
        });
        wrapper.append(button);
      }
      refs.questionFields.append(wrapper);
    }
  }
}

function suggestedDefault(text) {
  const match = /建议默认：([\s\S]+)$/.exec(text);
  if (match === null || match[1] === undefined) return null;
  const value = match[1].trim();
  return value === '' ? null : value;
}

function renderDecision() {
  const snapshot = state.snapshot;
  const waiting = snapshot !== null && snapshot.status === 'waiting_decision';
  show(refs.decisionPanel, waiting);
  if (!waiting) {
    state.decisionKey = '';
    setError(refs.decisionError, '');
    return;
  }

  const kind = snapshot.decisionKind === 'feedback' ? 'feedback' : 'review';
  const key = `${kind}|${String(snapshot.revisions)}`;
  if (key !== state.decisionKey) {
    state.decisionKey = key;
    refs.feedbackInput.value = '';
    setError(refs.decisionError, '');
  }

  if (kind === 'feedback') {
    setText(refs.decisionHint, '确定性检查没有通过，方案不能直接确认。请提出修改意见，或退出并保留当前会话。');
  } else {
    setText(refs.decisionHint, '确认后会写出 design.md / build-task.md 等 artifacts；也可以提出一次定向修改。');
  }

  const issues = Array.isArray(snapshot.checkIssues) ? snapshot.checkIssues : [];
  refs.decisionIssues.replaceChildren();
  for (const issue of issues) refs.decisionIssues.append(createElement('li', undefined, String(issue)));
  show(refs.decisionIssues, issues.length > 0);
  renderConflicts(snapshot);
}

function renderConflicts(snapshot) {
  const conflicts = Array.isArray(snapshot.conflicts) ? snapshot.conflicts : [];
  refs.conflictChoices.replaceChildren();
  for (const conflict of conflicts) {
    if (!isRecord(conflict)) continue;
    const card = createElement('div', 'conflict-card');
    card.append(createElement('strong', undefined, reviewText(conflict.title) || '设计冲突'));
    card.append(createElement('p', 'conflict-message', reviewText(conflict.message)));
    if (conflict.status === 'resolved') {
      card.append(createElement('span', 'conflict-resolved', '已选择'));
    } else {
      const actions = createElement('div', 'conflict-actions');
      const options = Array.isArray(conflict.options) ? conflict.options : [];
      for (const option of options) {
        if (!isRecord(option)) continue;
        const button = createElement('button', 'button secondary', reviewText(option.label) || '选择');
        button.type = 'button';
        button.disabled = state.busy;
        button.addEventListener('click', () => {
          void submitConflict(String(conflict.id), String(option.id));
        });
        actions.append(button);
      }
      card.append(actions);
    }
    refs.conflictChoices.append(card);
  }
  show(refs.conflictChoices, conflicts.length > 0);
}

function renderScheme() {
  const snapshot = state.snapshot;
  const summary = snapshot?.summary ?? null;
  if (summary === null) {
    show(refs.schemeEmpty, true);
    show(refs.schemeBody, false);
    setText(refs.revisionLabel, '—');
    state.previewKey = '';
    document.title = '拼图花园 · 交互设计台';
    return;
  }

  show(refs.schemeEmpty, false);
  show(refs.schemeBody, true);
  document.title = `${summary.title} · 拼图花园`;
  setText(refs.schemeKicker, `${summary.schemeId} · revision ${String(summary.revision)}`);
  setText(refs.schemeTitle, summary.title);
  setText(refs.schemeConcept, summary.concept);
  setText(refs.scopeValue, `${summary.scopeLabel}（${summary.scope}）`);
  setText(refs.roomsValue, summary.rooms.length === 0 ? '无' : summary.rooms.join('、'));
  setText(refs.decisionsValue, summary.decisions.length === 0 ? '无额外决策' : summary.decisions.join('；'));
  renderList(refs.mustsList, summary.musts, '无必须项');
  renderList(refs.openList, summary.open, '无未决事项');

  const previews = Array.isArray(snapshot.previews) ? snapshot.previews : [];
  setText(refs.previewCount, `${String(previews.length)} 张`);
  const version = String(summary.revision);
  const key = `${version}\u0003${previews.map((preview) => `${preview.name}\u0001${preview.title}`).join('\u0002')}`;
  if (key !== state.previewKey) {
    state.previewKey = key;
    refs.previewGallery.replaceChildren();
    for (const preview of previews) {
      if (typeof preview.url !== 'string' || !preview.url.startsWith('/api/sessions/')) continue;
      const link = createElement('a', 'preview-card');
      link.href = `${preview.url}?v=${encodeURIComponent(version)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = `在新标签页打开 ${preview.title}`;
      const image = document.createElement('img');
      image.className = 'preview-image';
      image.src = `${preview.url}?v=${encodeURIComponent(version)}`;
      image.alt = `${preview.title}（${preview.name}）`;
      image.loading = 'lazy';
      image.decoding = 'async';
      const caption = createElement('span', 'preview-caption');
      caption.append(createElement('strong', undefined, preview.title));
      caption.append(createElement('code', undefined, preview.name));
      link.append(image, caption);
      refs.previewGallery.append(link);
    }
  }

  if (snapshot.briefStats === null) {
    show(refs.previewMeta, false);
  } else {
    show(refs.previewMeta, true);
    setText(
      refs.briefStats,
      `design.md ${String(snapshot.briefStats.designChars)} 字符 · build-task.md ${String(
        snapshot.briefStats.taskChars,
      )} 字符`,
    );
    refs.gatesList.replaceChildren();
    for (const gate of snapshot.briefStats.gates) {
      refs.gatesList.append(createElement('span', 'gate-chip', gate));
    }
  }

  renderArtifacts();
}

function renderList(element, items, emptyText) {
  element.replaceChildren();
  if (!Array.isArray(items) || items.length === 0) {
    element.append(createElement('li', undefined, emptyText));
    return;
  }
  for (const item of items) element.append(createElement('li', undefined, String(item)));
}

function renderArtifacts() {
  const snapshot = state.snapshot;
  const artifacts = snapshot?.artifacts ?? null;
  show(refs.artifactsPanel, artifacts !== null);
  if (artifacts === null) {
    refs.artifactPaths.replaceChildren();
    setText(refs.buildCommand, '');
    return;
  }
  refs.artifactPaths.replaceChildren();
  for (const key of ARTIFACT_KEYS) {
    const path = artifacts[key];
    if (typeof path === 'string') refs.artifactPaths.append(createElement('li', undefined, path));
  }
  setText(refs.buildCommand, snapshot?.buildCommand ?? '');
}

function renderBuild() {
  const snapshot = state.snapshot;
  if (snapshot === null) return;
  const confirmed = snapshot.confirmed === true;
  show(refs.buildPanel, confirmed);
  if (!confirmed) {
    state.buildLogKey = '';
    state.buildRenderKey = '';
    return;
  }

  const build = isRecord(snapshot.build) ? snapshot.build : {};
  const status =
    typeof build.status === 'string' && Object.hasOwn(BUILD_STATUS_LABEL, build.status) ? build.status : 'idle';
  setText(refs.buildStatus, BUILD_STATUS_LABEL[status] ?? status);
  refs.buildStatus.dataset.status = status;
  setText(refs.buildTurns, typeof build.turns === 'number' ? String(build.turns) : '0');
  setText(
    refs.buildAction,
    typeof build.currentAction === 'string' && build.currentAction.trim() !== '' ? build.currentAction : '尚未启动构建',
  );
  setText(
    refs.buildCost,
    typeof build.costCny === 'number' && Number.isFinite(build.costCny) ? `¥${build.costCny.toFixed(4)}` : '—',
  );
  setError(refs.buildError, typeof build.error === 'string' ? build.error : '');

  if (snapshot.mode === 'mock') {
    setText(refs.buildNote, 'mock 模式不执行构建；请用 --live 实测。');
  } else if (status === 'running') {
    setText(refs.buildNote, '构建进行中；页面会自动刷新轮数与事件。');
  } else if (status === 'done') {
    setText(refs.buildNote, '构建已完成；可在下方下载最终交付渲染图。');
  } else if (status === 'failed') {
    setText(refs.buildNote, '构建失败；可查看停止原因后重试。');
  } else {
    setText(refs.buildNote, '点击后启动构建层 agent；真实构建会产生模型费用。');
  }

  const events = Array.isArray(build.events) ? build.events : [];
  renderBuildLog(events);

  const renders = Array.isArray(build.renders) ? build.renders : [];
  const delivery = isRecord(build.delivery) ? build.delivery : null;
  show(refs.buildDelivery, status === 'done' || renders.length > 0);
  if (status === 'done') {
    const version = typeof delivery?.codeVersion === 'number' ? `第 v${String(delivery.codeVersion)} 版` : '已交付';
    const hash = typeof delivery?.hash === 'string' ? ` · hash ${delivery.hash}` : '';
    setText(refs.buildDeliveryText, `交付：${version}${hash}`);
  } else if (status === 'failed') {
    setText(
      refs.buildDeliveryText,
      renders.length > 0 ? '构建失败；以下是已写出的交付渲染图。' : '构建失败，没有交付图。',
    );
  } else {
    setText(refs.buildDeliveryText, renders.length > 0 ? `已写出 ${String(renders.length)} 张交付渲染图。` : '');
  }
  renderBuildRenders(renders);
}

function renderBuildLog(events) {
  const key = events
    .map((event) => `${String(event.seq)}\u0001${String(event.type)}\u0001${String(event.text)}`)
    .join('\u0002');
  if (key === state.buildLogKey) return;
  state.buildLogKey = key;
  const element = refs.buildLog;
  const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
  element.replaceChildren();
  if (events.length === 0) {
    element.append(createElement('p', 'build-log-empty', '等待构建启动…'));
    return;
  }
  for (const event of events) {
    const row = createElement('div', 'build-event');
    row.dataset.type = typeof event.type === 'string' ? event.type : '';
    row.append(createElement('span', 'build-event-type', typeof event.type === 'string' ? event.type : 'event'));
    row.append(createElement('span', 'build-event-text', typeof event.text === 'string' ? event.text : ''));
    element.append(row);
  }
  element.scrollTop = nearBottom ? element.scrollHeight : element.scrollTop;
}

function renderBuildRenders(renders) {
  const key = renders.map((render) => `${String(render.name)}\u0001${String(render.url)}`).join('\u0002');
  if (key === state.buildRenderKey) return;
  state.buildRenderKey = key;
  refs.buildRenders.replaceChildren();
  for (const render of renders) {
    if (typeof render.name !== 'string' || typeof render.url !== 'string') continue;
    if (!render.url.startsWith('/api/sessions/')) continue;
    const card = createElement('figure', 'render-card');
    const imageLink = createElement('a', 'render-image-link');
    imageLink.href = render.url;
    imageLink.target = '_blank';
    imageLink.rel = 'noopener noreferrer';
    imageLink.title = `在新标签页打开 ${render.name}`;
    const image = document.createElement('img');
    image.className = 'render-image';
    image.src = render.url;
    image.alt = render.name;
    image.loading = 'lazy';
    image.decoding = 'async';
    imageLink.append(image);
    const caption = document.createElement('figcaption');
    caption.className = 'render-caption';
    caption.append(createElement('code', undefined, render.name));
    const download = createElement('a', 'button ghost small', '下载');
    download.href = typeof render.downloadUrl === 'string' ? render.downloadUrl : render.url;
    download.setAttribute('download', render.name);
    caption.append(download);
    card.append(imageLink, caption);
    refs.buildRenders.append(card);
  }
}

function showComposerError(message) {
  setError(refs.composerError, message);
}

function reviewText(value) {
  return typeof value === 'string' ? value : '';
}

function reviewList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '') : [];
}

function reviewLabel(labels, value, fallback) {
  return typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : fallback;
}

function reviewChip(text, status) {
  const chip = createElement('span', 'review-chip', text);
  if (typeof status === 'string' && status !== '') chip.dataset.status = status;
  return chip;
}

function reviewValue(value, unit) {
  const text = typeof value === 'string' && value.trim() !== '' ? value : '—';
  const unitText = typeof unit === 'string' ? unit.trim() : '';
  // 评审引擎的 expected / actual 可能已经带单位（如“20000 块”）；只在纯数字后补单位，避免“块 块”。
  if (unitText === '' || text.includes(unitText) || !/\d/.test(text)) return text;
  return `${text} ${unitText}`;
}

function fillReviewList(element, items) {
  element.replaceChildren();
  for (const item of items) element.append(createElement('li', undefined, item));
}

function reviewKeyFor(report, reviewError) {
  if (report === null) return `error|${reviewError}`;
  const design = isRecord(report.designVersion) ? report.designVersion : null;
  const verdict = isRecord(report.verdict) ? report.verdict : null;
  const next = isRecord(report.nextAction) ? report.nextAction : null;
  const musts = verdict !== null && Array.isArray(verdict.musts) ? verdict.musts : [];
  const mustKey = musts
    .filter(isRecord)
    .map((must) =>
      [
        reviewText(must.requirementId),
        reviewText(must.status),
        String(Array.isArray(must.evidence) ? must.evidence.length : 0),
        String(Array.isArray(must.objects) ? must.objects.length : 0),
        isRecord(must.waiver) ? reviewText(must.waiver.choice) : '',
        reviewText(must.note),
      ].join(':'),
    )
    .join(',');
  return [
    reviewText(report.buildRunId),
    reviewText(design?.schemeId),
    String(design?.revision ?? ''),
    reviewText(verdict?.status),
    reviewText(next?.kind),
    reviewText(next?.instructions),
    String(Array.isArray(report.defects) ? report.defects.length : 0),
    String(verdict?.mustsTruncated === true),
    mustKey,
  ].join('|');
}

function reviewStageHint(snapshot, report) {
  if (snapshot === null) return '';
  if (report === null) return '评审报告不可用；构建结果仍可在上方查看。';
  const verdict = isRecord(report.verdict) ? report.verdict : null;
  const truncated = verdict !== null && verdict.mustsTruncated === true;
  switch (snapshot.stage) {
    case 'post-review':
      if (truncated) {
        return '必须项超过评审上限（mustsTruncated=true），隐藏项未进入逐条列表；接受已禁用，请拆分必须项或人工核对。';
      }
      return reviewAcceptEligible(report)
        ? '评审针对本次构建产物；可以接受结果，或提交定向修改 / 重新设计。'
        : '评审未达到接受门槛（需 verdict=satisfied、nextAction=accept，且必须项全部 met / 当前 revision 已豁免）；请继续修改或补齐证据。';
    case 'accept':
      return '结果已接受，进入验收；本次构建流程结束。';
    case 'targeted-revision':
    case 'redesign':
    case 'revise':
    case 'design':
    case 'check':
      return '已提交评审修改，正在生成新的设计 revision；完成后会显示方案卡与预览。';
    case 'review':
      return '新的设计 revision 已生成；请在方案卡确认，或继续提出修改。';
    default:
      return '当前阶段不在评审决策中；只有 post-review 可以接受或发回修改。';
  }
}

function renderReviewVisualGroup(group, list, items) {
  show(group, items.length > 0);
  fillReviewList(list, items);
}

function appendMustEvidence(item, must) {
  const objects = Array.isArray(must.objects) ? must.objects.filter(isRecord) : [];
  if (objects.length > 0) {
    const shown = objects.slice(0, 5).map((object) => {
      const expected = reviewText(object.expectedId) || '—';
      const actual = reviewText(object.actualId);
      const status = [reviewText(object.status), reviewText(object.severity)].filter((part) => part !== '').join('/');
      const arrow = actual !== '' && actual !== expected ? ` → ${actual}` : '';
      return `${expected}${arrow}${status === '' ? '' : `（${status}）`}`;
    });
    const more = objects.length > shown.length ? ` 等 ${String(objects.length)} 项` : '';
    item.append(createElement('p', 'review-evidence', `关联对象：${shown.join('、')}${more}`));
  }

  const evidence = Array.isArray(must.evidence) ? must.evidence.filter(isRecord) : [];
  for (const ref of evidence.slice(0, 5)) {
    const kind = reviewText(ref.kind);
    const location = reviewText(ref.ref);
    const summary = reviewText(ref.summary);
    const lead = [kind, location].filter((part) => part !== '').join(' · ');
    item.append(createElement('p', 'review-evidence', `证据：${lead}${summary === '' ? '' : ` — ${summary}`}`));
  }
  if (evidence.length > 5) {
    item.append(createElement('p', 'review-evidence', `另有 ${String(evidence.length - 5)} 条证据未展开`));
  }

  const reason = reviewText(must.reason);
  if (reason !== '') item.append(createElement('p', 'review-evidence', `判定依据：${reason}`));

  const waiver = isRecord(must.waiver) ? must.waiver : null;
  if (waiver !== null) {
    const choice = reviewText(waiver.choice) || '用户豁免';
    const note = reviewText(waiver.note);
    const by = reviewText(waiver.by) === 'user' ? '用户' : reviewText(waiver.by) || '用户';
    item.append(
      createElement('p', 'review-must-waiver', `豁免（${by}）：${choice}${note === '' ? '' : `；说明：${note}`}`),
    );
  }
}

function renderReviewBody(report, verdict, nextAction) {
  const objective = report !== null && isRecord(report.objective) ? report.objective : null;
  const visual = report !== null && isRecord(report.visual) ? report.visual : null;
  const measurements = objective !== null && Array.isArray(objective.measurements) ? objective.measurements : [];
  const objectiveNotes = objective === null ? [] : reviewList(objective.notes);
  const musts = verdict !== null && Array.isArray(verdict.musts) ? verdict.musts : [];
  const defects = report !== null && Array.isArray(report.defects) ? report.defects : [];

  refs.reviewMeasurements.replaceChildren();
  if (measurements.length === 0) {
    const row = document.createElement('tr');
    const cell = createElement('td', 'review-empty', '没有客观测量记录');
    cell.colSpan = 4;
    row.append(cell);
    refs.reviewMeasurements.append(row);
  } else {
    for (const measurement of measurements) {
      if (!isRecord(measurement)) continue;
      const status = reviewText(measurement.status);
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      nameCell.append(createElement('strong', undefined, reviewText(measurement.name) || '未命名测量'));
      const evidence = reviewText(measurement.evidence);
      if (evidence !== '') nameCell.append(createElement('span', 'review-evidence', `证据：${evidence}`));
      const statusCell = document.createElement('td');
      statusCell.append(
        reviewChip(reviewLabel(MEASUREMENT_STATUS_LABEL, status, status === '' ? '未检查' : status), status),
      );
      row.append(
        nameCell,
        createElement('td', undefined, reviewValue(measurement.expected, measurement.unit)),
        createElement('td', undefined, reviewValue(measurement.actual, measurement.unit)),
        statusCell,
      );
      refs.reviewMeasurements.append(row);
    }
  }
  show(refs.reviewObjectiveNotes, objectiveNotes.length > 0);
  fillReviewList(refs.reviewObjectiveNotes, objectiveNotes);

  refs.reviewMusts.replaceChildren();
  if (musts.length === 0) {
    refs.reviewMusts.append(createElement('li', 'review-empty', '没有必须项记录'));
  } else {
    for (const must of musts) {
      if (!isRecord(must)) continue;
      const status = reviewText(must.status);
      const item = createElement('li', 'review-must');
      const head = createElement('div', 'review-must-head');
      const title = reviewText(must.text) || reviewText(must.requirementId) || '未命名必须项';
      head.append(createElement('strong', undefined, title));
      head.append(reviewChip(reviewLabel(MUST_STATUS_LABEL, status, status === '' ? '未验证' : status), status));
      item.append(head);
      const requirementId = reviewText(must.requirementId);
      if (requirementId !== '') item.append(createElement('code', 'review-must-id', requirementId));
      const note = reviewText(must.note);
      if (note !== '') item.append(createElement('p', 'review-must-note', note));
      appendMustEvidence(item, must);
      if (requirementId !== '' && (status === 'unverified' || status === 'not-met') && canDecideReview()) {
        const waiver = createElement('button', 'review-waiver', '豁免该必须项');
        waiver.type = 'button';
        waiver.addEventListener('click', () => {
          void waiveReviewMust(requirementId);
        });
        item.append(waiver);
      }
      refs.reviewMusts.append(item);
    }
  }

  refs.reviewDefects.replaceChildren();
  if (defects.length === 0) {
    refs.reviewDefects.append(createElement('li', 'review-empty', '没有记录缺陷'));
  } else {
    for (const defect of defects) {
      if (!isRecord(defect)) continue;
      const severity = reviewText(defect.severity);
      const category = reviewText(defect.category);
      const item = createElement('li', 'review-defect');
      const head = createElement('div', 'review-defect-head');
      head.append(
        reviewChip(reviewLabel(DEFECT_SEVERITY_LABEL, severity, severity === '' ? '缺陷' : severity), severity),
      );
      head.append(
        createElement('span', 'review-category', reviewLabel(DEFECT_CATEGORY_LABEL, category, category || '未分类')),
      );
      const id = reviewText(defect.id);
      if (id !== '') head.append(createElement('code', 'review-defect-id', id));
      item.append(head);
      item.append(createElement('p', 'review-defect-text', reviewText(defect.description) || '（没有描述）'));
      const suggestedAction = reviewText(defect.suggestedAction);
      if (suggestedAction !== '') {
        item.append(createElement('p', 'review-defect-action', `建议：${suggestedAction}`));
      }
      const evidence = reviewText(defect.evidence);
      if (evidence !== '') item.append(createElement('p', 'review-evidence', `证据：${evidence}`));
      const requirementIds = reviewList(defect.requirementIds);
      if (requirementIds.length > 0) {
        item.append(createElement('p', 'review-evidence', `关联必须项：${requirementIds.join('、')}`));
      }
      refs.reviewDefects.append(item);
    }
  }

  const visualStatus = visual === null ? 'not-reviewed' : reviewText(visual.verdict) || 'not-reviewed';
  setText(refs.reviewVisualVerdict, reviewLabel(VISUAL_VERDICT_LABEL, visualStatus, visualStatus));
  refs.reviewVisualVerdict.dataset.status = visualStatus;
  show(refs.reviewVisualNote, visualStatus === 'not-reviewed');
  setText(refs.reviewVisualNote, '未接入看图评审；本轮只记录客观测量与缺陷。');
  const strengths = visual === null ? [] : reviewList(visual.strengths);
  const weaknesses = visual === null ? [] : reviewList(visual.weaknesses);
  const visualNotes = visual === null ? [] : reviewList(visual.notes);
  renderReviewVisualGroup(refs.reviewStrengthsGroup, refs.reviewStrengths, strengths);
  renderReviewVisualGroup(refs.reviewWeaknessesGroup, refs.reviewWeaknesses, weaknesses);
  renderReviewVisualGroup(refs.reviewNotesGroup, refs.reviewNotes, visualStatus === 'not-reviewed' ? [] : visualNotes);
  show(
    refs.reviewVisualLists,
    strengths.length + weaknesses.length + (visualStatus === 'not-reviewed' ? 0 : visualNotes.length) > 0,
  );

  const nextKind = nextAction === null ? '' : reviewText(nextAction.kind);
  const instructions = nextAction === null ? '' : reviewText(nextAction.instructions);
  const affectedSpaces = nextAction === null ? [] : reviewList(nextAction.affectedSpaceIds);
  const affectedElements = nextAction === null ? [] : reviewList(nextAction.affectedElementIds);
  const parts = [];
  if (nextKind !== '') parts.push(`下一步：${reviewLabel(NEXT_ACTION_LABEL, nextKind, nextKind)}`);
  if (instructions !== '') parts.push(instructions);
  if (affectedSpaces.length > 0) parts.push(`影响空间：${affectedSpaces.join('、')}`);
  if (affectedElements.length > 0) parts.push(`影响构件：${affectedElements.join('、')}`);
  setText(refs.reviewNextAction, parts.length === 0 ? '评审没有给出下一步建议。' : parts.join(' — '));
}

function renderReview() {
  const snapshot = state.snapshot;
  const report = snapshot === null ? null : reviewReport();
  const reviewError =
    snapshot !== null && typeof snapshot.reviewError === 'string' && snapshot.reviewError.trim() !== ''
      ? snapshot.reviewError
      : '';
  const visible = report !== null || reviewError !== '';
  show(refs.reviewPanel, visible);
  if (!visible) {
    resetReviewState();
    return;
  }

  const design = report !== null && isRecord(report.designVersion) ? report.designVersion : null;
  const verdict = report !== null && isRecord(report.verdict) ? report.verdict : null;
  const nextAction = report !== null && isRecord(report.nextAction) ? report.nextAction : null;
  const key = reviewKeyFor(report, reviewError);
  if (key !== state.reviewKey) {
    state.reviewKey = key;
    state.reviewMode = null;
    setError(refs.reviewInlineError, '');
    renderReviewBody(report, verdict, nextAction);
  }

  if (report !== null) {
    const status = reviewText(verdict?.status);
    setText(refs.reviewStatus, reviewLabel(REVIEW_STATUS_LABEL, status, status === '' ? '已评审' : status));
    refs.reviewStatus.dataset.status = status;
    const schemeId = design === null ? '—' : reviewText(design.schemeId) || '—';
    const revision = design === null ? '—' : String(design.revision ?? '—');
    const runId = reviewText(report.buildRunId) || '—';
    const currentRevision = snapshot?.summary?.revision;
    const stale =
      typeof currentRevision === 'number' &&
      design !== null &&
      typeof design.revision === 'number' &&
      currentRevision !== design.revision;
    setText(
      refs.reviewMeta,
      `${schemeId} · revision ${revision} · 构建 ${runId}${stale ? ` · 当前方案 revision ${String(currentRevision)}（评审针对旧构建）` : ''}`,
    );
  } else {
    setText(refs.reviewStatus, '评审失败');
    refs.reviewStatus.dataset.status = 'error';
    setText(refs.reviewMeta, '构建产物没有生成可用的评审报告。');
  }
  setError(refs.reviewError, reviewError);
  show(refs.reviewRetryButton, report === null && reviewError !== '');
  show(refs.reviewBody, report !== null);
  show(refs.reviewActions, report !== null);

  if (snapshot !== null && snapshot.stage !== 'post-review' && state.reviewMode !== null) {
    state.reviewMode = null;
  }
  setText(refs.reviewStageHint, reviewStageHint(snapshot, report));
  show(refs.reviewButtons, report !== null && snapshot?.stage !== 'accept');
  setText(
    refs.reviewHint,
    report === null
      ? '评审失败不影响已完成构建的状态；可查看构建进度与交付渲染图。'
      : '评审只读取构建产物；接受后进入验收，修改会生成新的设计 revision，需要重新确认。',
  );
  syncReviewControls();
}

function resetReviewState() {
  state.reviewKey = '';
  state.reviewMode = null;
  state.reviewSubmitting = null;
  show(refs.reviewPanel, false);
  show(refs.reviewBody, false);
  show(refs.reviewActions, false);
  show(refs.reviewEditor, false);
  show(refs.reviewRetryButton, false);
  setError(refs.reviewError, '');
  setError(refs.reviewInlineError, '');
  setText(refs.reviewStatus, '未评审');
  refs.reviewStatus.dataset.status = '';
  setText(refs.reviewMeta, '');
  setText(refs.reviewNextAction, '');
  setText(refs.reviewStageHint, '');
  setText(refs.reviewVisualVerdict, '—');
  refs.reviewVisualVerdict.dataset.status = '';
  setText(refs.reviewVisualNote, '');
  show(refs.reviewVisualNote, false);
  show(refs.reviewVisualLists, false);
  show(refs.reviewStrengthsGroup, false);
  show(refs.reviewWeaknessesGroup, false);
  show(refs.reviewNotesGroup, false);
  show(refs.reviewObjectiveNotes, false);
  refs.reviewMeasurements.replaceChildren();
  refs.reviewMusts.replaceChildren();
  refs.reviewDefects.replaceChildren();
  refs.reviewStrengths.replaceChildren();
  refs.reviewWeaknesses.replaceChildren();
  refs.reviewNotes.replaceChildren();
  refs.reviewObjectiveNotes.replaceChildren();
  refs.reviewInstructions.value = '';
  setText(refs.reviewHint, '评审只读取构建产物；接受后进入验收，修改会生成新的设计 revision，需要重新确认。');
}

function resetSession() {
  stopPolling();
  disconnectStream();
  resetProgressState();
  if (location.search !== '') history.replaceState(null, '', location.pathname);
  state.sessionId = null;
  state.snapshot = null;
  state.busy = false;
  state.lastEventAt = null;
  state.lastStatus = null;
  state.pollFailures = 0;
  state.networkError = null;
  state.renderedMessages = 0;
  state.questionKey = '';
  state.questionInputs.clear();
  state.decisionKey = '';
  state.previewKey = '';
  state.buildLogKey = '';
  state.buildRenderKey = '';
  state.wasConfirmed = false;

  refs.messageList.replaceChildren(refs.emptyConversation);
  refs.composer.hidden = false;
  refs.briefForm.reset();
  showComposerError('');
  show(refs.questionPanel, false);
  show(refs.decisionPanel, false);
  show(refs.errorBanner, false);
  refs.feedbackInput.value = '';
  setError(refs.answerError, '');
  setError(refs.decisionError, '');
  setText(refs.sessionId, '新会话');
  setText(refs.stageLabel, '等待输入');
  setText(refs.statusText, STATUS_LABEL.idle);
  refs.statusText.dataset.status = 'idle';
  setText(refs.revisionLabel, '—');
  show(refs.workbench, false);
  show(refs.workbenchHeartbeat, false);
  show(refs.schemeEmpty, true);
  show(refs.schemeBody, false);
  show(refs.buildPanel, false);
  show(refs.buildDelivery, false);
  setError(refs.buildError, '');
  refs.buildLog.replaceChildren();
  refs.buildRenders.replaceChildren();
  setText(refs.buildStatus, BUILD_STATUS_LABEL.idle);
  refs.buildStatus.dataset.status = 'idle';
  setText(refs.buildTurns, '0');
  setText(refs.buildAction, '尚未启动构建');
  setText(refs.buildCost, '—');
  resetReviewState();
  document.title = '拼图花园 · 交互设计台';
  syncControls();
  refs.briefInput.focus();
}

async function startDesign(event) {
  event.preventDefault();
  if (state.busy || state.sessionId !== null) return;
  const brief = refs.briefInput.value.trim();
  if (brief === '') {
    showComposerError('请先写下你的需求。');
    refs.briefInput.focus();
    return;
  }

  showComposerError('');
  setBusy(true);
  setText(refs.statusText, '正在创建会话…');
  refs.statusText.dataset.status = 'thinking';
  try {
    const data = await request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ brief }),
    });
    if (!isRecord(data) || typeof data.id !== 'string') {
      throw new ApiError('服务端没有返回会话 id。', 500);
    }
    state.sessionId = data.id;
    state.lastStatus = null;
    refs.composer.hidden = true;
    setText(refs.sessionId, data.id);
    history.replaceState(null, '', `?session=${encodeURIComponent(data.id)}`);
    state.renderedMessages = 0;
    refs.messageList.replaceChildren();
    resetProgressState();
    connectStream();
    await refresh();
    schedulePoll();
  } catch (error) {
    showComposerError(error instanceof Error ? error.message : String(error));
    setText(refs.statusText, STATUS_LABEL.idle);
    refs.statusText.dataset.status = 'idle';
  } finally {
    setBusy(false);
  }
}

async function submitAnswers() {
  const snapshot = state.snapshot;
  if (state.busy || snapshot === null || snapshot.status !== 'waiting_answers') return;
  const answers = [];
  for (const question of snapshot.questions) {
    const input = state.questionInputs.get(question.id);
    const answer = input === undefined ? '' : input.value.trim();
    if (answer === '') {
      setError(refs.answerError, '请回答所有问题后再提交。');
      input?.focus();
      return;
    }
    answers.push({ questionId: question.id, answer });
  }
  setError(refs.answerError, '');
  stopPolling();
  setBusy(true);
  try {
    const data = await request(`/api/sessions/${encodeURIComponent(snapshot.id)}/answers`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    });
    if (!isRecord(data) || typeof data.id !== 'string') {
      throw new ApiError('服务端返回了无效的会话状态。', 500);
    }
    applySnapshot(data);
    if (data.status !== 'done' && data.status !== 'error') schedulePoll();
  } catch (error) {
    setError(refs.answerError, error instanceof Error ? error.message : String(error));
    schedulePoll();
  } finally {
    setBusy(false);
  }
}

async function submitConflict(conflictId, optionId) {
  const snapshot = state.snapshot;
  if (state.busy || snapshot === null) return;
  setError(refs.decisionError, '');
  stopPolling();
  setBusy(true);
  try {
    const data = await request(`/api/sessions/${encodeURIComponent(snapshot.id)}/conflict-decision`, {
      method: 'POST',
      body: JSON.stringify({ conflictId, optionId }),
    });
    if (!isRecord(data) || typeof data.id !== 'string') {
      throw new ApiError('服务端返回了无效的会话状态。', 500);
    }
    applySnapshot(data);
    if (data.status !== 'done' && data.status !== 'error') schedulePoll();
  } catch (error) {
    setError(refs.decisionError, error instanceof Error ? error.message : String(error));
    schedulePoll();
  } finally {
    setBusy(false);
  }
}

async function submitDecision(action) {
  const snapshot = state.snapshot;
  if (state.busy || snapshot === null || snapshot.status !== 'waiting_decision') return;
  const feedback = refs.feedbackInput.value.trim();
  if (action === 'revise' && feedback === '') {
    setError(refs.decisionError, '请先写下修改意见，再选择“提出修改”。');
    refs.feedbackInput.focus();
    return;
  }
  setError(refs.decisionError, '');
  stopPolling();
  setBusy(true);
  try {
    const body = action === 'revise' ? { action, feedback } : { action };
    const data = await request(`/api/sessions/${encodeURIComponent(snapshot.id)}/decision`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!isRecord(data) || typeof data.id !== 'string') {
      throw new ApiError('服务端返回了无效的会话状态。', 500);
    }
    applySnapshot(data);
    if (data.status !== 'done' && data.status !== 'error') schedulePoll();
  } catch (error) {
    setError(refs.decisionError, error instanceof Error ? error.message : String(error));
    schedulePoll();
  } finally {
    setBusy(false);
  }
}

function openReviewEditor(mode) {
  if (state.busy || !canDecideReview()) return;
  if (state.reviewMode === mode) {
    refs.reviewInstructions.focus();
    return;
  }
  const report = reviewReport();
  const nextAction = report !== null && isRecord(report.nextAction) ? report.nextAction : null;
  const shouldPrefill = mode === 'targeted-revision' || nextAction?.kind === mode;
  const prefill =
    shouldPrefill && nextAction !== null && typeof nextAction.instructions === 'string' ? nextAction.instructions : '';
  state.reviewMode = mode;
  refs.reviewInstructions.value = prefill;
  setError(refs.reviewInlineError, '');
  syncReviewControls();
  refs.reviewInstructions.focus();
}

function closeReviewEditor() {
  if (state.busy) return;
  state.reviewMode = null;
  refs.reviewInstructions.value = '';
  setError(refs.reviewInlineError, '');
  syncReviewControls();
}

async function submitReviewDecision(action) {
  const snapshot = state.snapshot;
  if (state.busy || snapshot === null) return;
  if (!canDecideReview()) {
    setError(refs.reviewInlineError, '只有构建后评审阶段可以提交决策。');
    return;
  }
  let instructions = '';
  if (action !== 'accept') {
    instructions = refs.reviewInstructions.value.trim();
    if (instructions === '') {
      setError(refs.reviewInlineError, '请先写下修改说明。');
      refs.reviewInstructions.focus();
      return;
    }
  }
  setError(refs.reviewInlineError, '');
  state.reviewSubmitting = action;
  stopPolling();
  setBusy(true);
  try {
    const body = action === 'accept' ? { action } : { action, instructions };
    const data = await request(`/api/sessions/${encodeURIComponent(snapshot.id)}/review-decision`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!isRecord(data) || typeof data.id !== 'string') {
      throw new ApiError('服务端返回了无效的会话状态。', 500);
    }
    state.reviewMode = null;
    applySnapshot(data);
    schedulePoll();
  } catch (error) {
    setError(refs.reviewInlineError, error instanceof Error ? error.message : String(error));
    schedulePoll();
  } finally {
    state.reviewSubmitting = null;
    setBusy(false);
  }
}

/** 用户显式豁免一条未满足必须项；理由与补充说明都写入 reviewWaivers。 */
async function waiveReviewMust(mustId) {
  const snapshot = state.snapshot;
  if (state.busy || snapshot === null || mustId === '' || !canDecideReview()) return;
  const choice = window.prompt('豁免理由（会写入评审记录）', '接受当前现状');
  if (choice === null) return;
  const note = window.prompt('补充说明（可留空）', '');
  if (note === null) return;
  setError(refs.reviewInlineError, '');
  stopPolling();
  setBusy(true);
  try {
    const data = await request(`/api/sessions/${encodeURIComponent(snapshot.id)}/review-waiver`, {
      method: 'POST',
      body: JSON.stringify({
        mustId,
        choice: choice.trim() === '' ? '用户豁免' : choice.trim(),
        note: note.trim() === '' ? null : note.trim(),
      }),
    });
    if (!isRecord(data) || typeof data.id !== 'string') {
      throw new ApiError('服务端返回了无效的会话状态。', 500);
    }
    applySnapshot(data);
    schedulePoll();
  } catch (error) {
    setError(refs.reviewInlineError, error instanceof Error ? error.message : String(error));
    schedulePoll();
  } finally {
    setBusy(false);
  }
}

async function retryReview() {
  const snapshot = state.snapshot;
  if (state.busy || snapshot === null) return;
  setError(refs.reviewInlineError, '');
  stopPolling();
  setBusy(true);
  try {
    const data = await request(`/api/sessions/${encodeURIComponent(snapshot.id)}/review-retry`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!isRecord(data) || typeof data.id !== 'string') {
      throw new ApiError('服务端返回了无效的会话状态。', 500);
    }
    applySnapshot(data);
    schedulePoll();
  } catch (error) {
    setError(refs.reviewInlineError, error instanceof Error ? error.message : String(error));
    schedulePoll();
  } finally {
    setBusy(false);
  }
}

async function startBuild() {
  const snapshot = state.snapshot;
  if (state.busy || snapshot === null || snapshot.canStartBuild !== true) return;
  if (snapshot.mode === 'mock' || snapshot.build?.status === 'running' || snapshot.build?.status === 'done') return;
  stopPolling();
  setBusy(true);
  setError(refs.buildError, '');
  try {
    const data = await request(`/api/sessions/${encodeURIComponent(snapshot.id)}/build`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!isRecord(data) || data.status !== 'running') {
      throw new ApiError('服务端没有接受构建请求。', 500);
    }
    await refresh();
    if (state.snapshot?.build?.status === 'running') schedulePoll();
  } catch (error) {
    setError(refs.buildError, error instanceof Error ? error.message : String(error));
    schedulePoll();
  } finally {
    setBusy(false);
  }
}

refs.briefForm.addEventListener('submit', (event) => {
  void startDesign(event);
});
refs.briefInput.addEventListener('input', () => {
  showComposerError('');
});
refs.feedbackInput.addEventListener('input', () => {
  setError(refs.decisionError, '');
});
refs.submitAnswers.addEventListener('click', () => {
  void submitAnswers();
});
refs.confirmButton.addEventListener('click', () => {
  void submitDecision('confirm');
});
refs.reviseButton.addEventListener('click', () => {
  void submitDecision('revise');
});
refs.exitButton.addEventListener('click', () => {
  void submitDecision('exit');
});
refs.newSessionButton.addEventListener('click', resetSession);
refs.buildStartButton.addEventListener('click', () => {
  void startBuild();
});
refs.reviewAcceptButton.addEventListener('click', () => {
  void submitReviewDecision('accept');
});
refs.reviewTargetedButton.addEventListener('click', () => {
  openReviewEditor('targeted-revision');
});
refs.reviewRedesignButton.addEventListener('click', () => {
  openReviewEditor('redesign');
});
refs.reviewSubmitButton.addEventListener('click', () => {
  if (state.reviewMode !== null) void submitReviewDecision(state.reviewMode);
});
refs.reviewCancelButton.addEventListener('click', closeReviewEditor);
refs.reviewRetryButton.addEventListener('click', () => {
  void retryReview();
});
refs.reviewInstructions.addEventListener('input', () => {
  setError(refs.reviewInlineError, '');
  syncReviewControls();
});

syncControls();
window.setInterval(renderWorkbenchTiming, 1000);

const resumeId = new URLSearchParams(location.search).get('session');
if (resumeId !== null && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(resumeId)) {
  state.sessionId = resumeId;
  refs.composer.hidden = true;
  setText(refs.sessionId, resumeId);
  syncControls();
  connectStream();
  void refresh().then((ok) => {
    if (ok) schedulePoll();
  });
}
