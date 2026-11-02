/**
 * SAM 3 没认出的部件，用 MobileSAM 按框补掩码。
 *
 * 用户那轮 SAM 3 对 body、两条上臂、两条小腿全部「无命中」，直接退回 AI 的粗多边形，
 * body 把白内衬袖子和裤子都圈了进去。MobileSAM 有框就能切，比多边形准得多。
 *
 * 两个分割客户端都是注入的假对象：真 worker 要装 4GB 的模型，而这里要验的
 * 只是「谁缺了、缺的交给谁、结果怎么合并」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentParts } from '../../server/sam/segment.mjs';

const box = { x: 0, y: 0, width: 10, height: 10 };
const parts = [{ name: 'body', bbox: box }, { name: 'head', bbox: box }];

function fakeClient(names, calls) {
  return {
    checkEnv: () => true,
    segment: async (_img, ps) => {
      calls?.push(ps.map((p) => p.name));
      return new Map(ps.filter((p) => names.includes(p.name))
        .map((p) => [p.name, { png: `png-${p.name}`, score: 0.9, coverage: 0.8 }]));
    }
  };
}

test('sam3 没命中的部件用 MobileSAM 补上', async () => {
  const mobileCalls = [];
  const masks = await segmentParts('x.png', parts, {
    segmenter: 'sam3',
    clients: { sam3: fakeClient(['head']), mobilesam: fakeClient(['body', 'head'], mobileCalls) }
  });

  assert.deepEqual([...masks.keys()].sort(), ['body', 'head']);
  assert.equal(masks.get('body').via, 'mobilesam');
  assert.equal(masks.get('head').png, 'png-head');
  assert.equal(masks.get('head').via, undefined, 'sam3 认出的那份不该被替换');
  assert.deepEqual(mobileCalls, [['body']], 'MobileSAM 只该被要求切没命中的部件');
});

test('MobileSAM 环境缺失时照旧退回多边形', async () => {
  const masks = await segmentParts('x.png', parts, {
    segmenter: 'sam3',
    clients: { sam3: fakeClient(['head']), mobilesam: { checkEnv: () => false, segment: async () => new Map() } }
  });
  assert.deepEqual([...masks.keys()], ['head']);
});

test('sam3 一个都没认出时，全部交给 MobileSAM', async () => {
  const masks = await segmentParts('x.png', parts, {
    segmenter: 'sam3',
    clients: { sam3: fakeClient([]), mobilesam: fakeClient(['body', 'head']) }
  });
  assert.deepEqual([...masks.keys()].sort(), ['body', 'head']);
});
