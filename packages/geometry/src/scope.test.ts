/** 镜像句柄作用域前缀判定：只读的创建快照与当前栈比较（R9）。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HandleScopes } from './scope.ts';

test('镜像句柄作用域：当前栈以快照为前缀才放行，未登记句柄放行', () => {
  const scopes = new HandleScopes();
  const handle = {};
  scopes.tag(handle, 'walls', [{ axis: 'x', at: 0 }]);
  // 同作用域与内层作用域（当前栈更长且前缀一致）合法。
  assert.doesNotThrow(() => {
    scopes.assert(handle, [{ axis: 'x', at: 0 }]);
  });
  assert.doesNotThrow(() => {
    scopes.assert(handle, [
      { axis: 'x', at: 0 },
      { axis: 'z', at: 1 },
    ]);
  });
  // 当前栈更短、轴或 at 不一致都报错。
  assert.throws(() => {
    scopes.assert(handle, []);
  }, /walls 建在 mirror\(\{axis:'x',at:0\}\)/);
  assert.throws(() => {
    scopes.assert(handle, [{ axis: 'x', at: 2 }]);
  }, /mirror/);
  assert.throws(() => {
    scopes.assert(handle, [{ axis: 'z', at: 0 }]);
  }, /mirror/);
  assert.doesNotThrow(() => {
    scopes.assert({}, []);
  });
  assert.equal(scopes.info(handle)?.name, 'walls');
  assert.equal(scopes.info(handle)?.scope.length, 1);
});
