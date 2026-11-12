/**
 * @pg/interaction/schema 的稳定入口：按领域分组重新导出，调用方不需要知道内部文件拆分。
 * 本文件只做 re-export，不含运行时逻辑（tools/check-tests.ts 对纯 re-export 的 index/schema 入口免测试）。
 */
export * from './primitives.ts';
export * from './requirements.ts';
export * from './scheme.ts';
export * from './review.ts';
export * from './build.ts';
export * from './must-ledger.ts';
export * from './floor-datum.ts';
export * from './scheme-gate.ts';
export * from './design-conflict.ts';
export * from './flush-text.ts';
export * from './review-evidence.ts';
