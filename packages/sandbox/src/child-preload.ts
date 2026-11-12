/**
 * node `--require` 预加载（SANDBOX-SPEC §7.2、F1）。
 *
 * 为什么必须放在 `--require` 里：Node 的 `--require` 预加载在 `--frozen-intrinsics` 冻结内置
 * **之前**执行（`--import` 在冻结之后，改不了已冻结的 `Date.prototype`，实测）。child-globals 只
 * 能替换 `globalThis.Date`，堵不住 `Date.prototype.constructor` 这条取回真实 Date 的后门。
 *
 * 只做这一件事，绝不写 stdout（会破坏 child 的二进制分帧）；加载失败会让 node 直接退出（响亮
 * 的宿主故障），由端到端测试暴露，不静默回退。
 */
import { installFixedDate } from './fixed-date.ts';

installFixedDate();
