// 大V观点取数自检（无框架，assert 断言）。
// 运行：cd backend && pnpm exec tsx src/scripts/kol.selfcheck.ts
//
// 微博访客态握手与小红书 SSR 解析都是逆向私有流程，平台改版/风控升级即失效。
// 此脚本是失效的第一道哨兵：覆盖 HTML 清洗（纯本地）、微博访客握手 + 时间线 +
// 长文补拉 + 用户搜索（联网），以及小红书主页解析 + 笔记详情（联网）。
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir, cacheImages } from '../kol/images';
import { fetchLongText, fetchUserTimeline, searchUsers, stripHtml } from '../kol/weibo';
import {
  cleanDesc,
  fetchNoteDetail,
  fetchUserProfile,
  hasCookie,
  parseUserId,
  syntheticNoteKey,
} from '../kol/xiaohongshu';

// ===== 1. HTML 清洗（纯本地，不联网） =====
assert.equal(stripHtml('a<br />b'), 'a\nb', '<br> 应转换行');
assert.equal(
  stripHtml('<a href="/n/x">@某人</a>：看多'),
  '@某人：看多',
  '锚文本应保留、标签应剥掉',
);
assert.equal(
  stripHtml('开心<img alt="[笑]" src="x.png" />'),
  '开心[笑]',
  '表情图应还原为 alt 文案',
);
assert.equal(stripHtml('A&nbsp;&amp;&nbsp;B'), 'A & B', 'HTML 实体应还原');
// 外链：微博显示成「网页链接」占位并用 sinaurl 包一层跳转，需还原成真实地址前端才能点开
assert.match(
  stripHtml(
    '看这个 <a href="https://weibo.cn/sinaurl?u=https%3A%2F%2Fmp.weixin.qq.com%2Fs%2Fabc" ' +
      'data-hide=""><span class="surl-text">网页链接</span></a> 很好',
  ),
  /https:\/\/mp\.weixin\.qq\.com\/s\/abc/,
  '外链占位应还原为真实 URL',
);
// 话题锚文本自身有意义，不能被当外链替换掉
assert.match(
  stripHtml('<a href="https://m.weibo.cn/search?containerid=x">#大咖说财经#</a> 观点'),
  /^#大咖说财经# 观点$/,
  '话题锚点应保留原文本',
);
console.log('✓ HTML 清洗（含外链还原）');

// ===== 2. 访客握手 + 时间线（联网） =====
// 财经网：官方蓝V，长期高频发博，适合作为探针
const PROBE_UID = '1642088277';
const posts = await fetchUserTimeline(PROBE_UID);
assert.ok(
  posts.length > 0,
  '时间线应返回至少 1 条博文（为空说明访客握手被风控，需对照 client.ts 三步流程排查）',
);
const p = posts[0];
assert.ok(p.bid.length > 0, '博文应有 bid');
assert.ok(!Number.isNaN(new Date(p.createdAt).getTime()), 'createdAt 应为可解析的 ISO 时间');
assert.ok(p.screenName.length > 0, '博文应带作者昵称');
assert.ok(p.url.startsWith('https://m.weibo.cn/detail/'), '博文应有原文链接');
console.log(`✓ 访客握手 + 时间线（${posts.length} 条，最新：${p.screenName} ${p.createdAt}）`);

// ===== 3. 长文补拉（联网，样本里没长文则跳过） =====
const longPost = posts.find((x) => x.isLongText);
if (longPost) {
  const full = await fetchLongText(longPost.bid);
  assert.ok(full && full.length > 0, '长文补拉应返回非空全文');
  assert.ok(
    full.length >= longPost.text.length,
    '补拉的全文长度不应短于列表里的截断正文',
  );
  console.log(`✓ 长文补拉（${longPost.text.length} → ${full.length} 字）`);
} else {
  console.log('- 长文补拉：本轮样本无长文，跳过');
}

// ===== 4. 用户搜索（联网） =====
const found = await searchUsers('财经网');
assert.ok(found.length > 0, '用户搜索应返回候选');
assert.ok(
  found.every((u) => /^\d+$/.test(u.uid)),
  '搜索结果的 uid 应为纯数字',
);
console.log(`✓ 用户搜索（${found.length} 个候选，首个：${found[0].screenName}/${found[0].uid}）`);

// ===== 5. 小红书：ID 解析与正文清洗（纯本地） =====
const XHS_PROBE_UID = '6437c1bc000000000d01b4c1';
assert.equal(await parseUserId(XHS_PROBE_UID), XHS_PROBE_UID, '裸 24 位 ID 应原样返回');
assert.equal(
  await parseUserId(`https://www.xiaohongshu.com/user/profile/${XHS_PROBE_UID}?xsec_token=ABC`),
  XHS_PROBE_UID,
  '主页链接应能解析出 userId',
);
await assert.rejects(parseUserId('随便一段文字'), '非法输入应抛错而非静默放过');
// 小红书号不是 userId（两者无公开互查入口），要给出可操作的提示而不是笼统报错
await assert.rejects(
  parseUserId('95852292902'),
  /小红书号/,
  '纯数字的小红书号应被识别并提示改用主页/分享链接',
);
assert.equal(cleanDesc('聊聊 #A股[话题]# 走势'), '聊聊 #A股# 走势', '话题标记应归一为 #xx#');
// 合成主键必须稳定且区分作者，否则两个博主的同名笔记会互相覆盖
assert.equal(
  syntheticNoteKey(XHS_PROBE_UID, '标题'),
  syntheticNoteKey(XHS_PROBE_UID, '标题'),
  '同作者同标题的合成主键应稳定',
);
assert.notEqual(
  syntheticNoteKey(XHS_PROBE_UID, '标题'),
  syntheticNoteKey('6437c1bc000000000d01b4c2', '标题'),
  '不同作者的同名笔记不应撞主键',
);
console.log('✓ 小红书 ID 解析 / 正文清洗 / 合成主键');

// 分享短链展开（联网）：失效 token 会被 xhslink 跳到站点首页，据此校验错误提示是可操作的
await assert.rejects(
  parseUserId('看看这个 http://xhslink.com/a/sT7omKb6ijX6，复制本条信息，打开【小红书】App查看'),
  /失效/,
  '失效分享链接应提示重新复制，而不是笼统报错',
);
console.log('✓ 小红书分享短链展开（失效链接提示可操作）');

// ===== 6. 小红书主页解析（联网） =====
const profile = await fetchUserProfile(XHS_PROBE_UID);
assert.ok(profile.nickname.length > 0, '应解析出博主昵称（为空说明 __INITIAL_STATE__ 结构变了）');
assert.ok(profile.redId.length > 0, '应解析出小红书号（名单里用它和 App 账号核对）');
assert.ok(profile.notes.length > 0, '应解析出至少 1 条笔记');
assert.ok(
  profile.notes.some((n) => n.title.length > 0),
  '笔记应带标题',
);
console.log(
  `✓ 小红书主页解析（${profile.nickname}，小红书号 ${profile.redId}，粉丝 ${profile.fansCount || '-'}，${profile.notes.length} 条笔记）`,
);

// ===== 7. 小红书笔记详情（联网，需 Cookie） =====
// 免登录时小红书会把 noteId 抹成空串，此时只能验证降级路径可用，不能验证正文。
const withId = profile.notes.find((n) => n.noteId.length > 0);
if (hasCookie()) {
  assert.ok(withId, '已配置 Cookie 却拿不到 noteId，说明 Cookie 失效或页面改版');
  const detail = await fetchNoteDetail(withId.noteId, withId.xsecToken);
  assert.ok(detail, '笔记详情不应为空');
  assert.ok((detail.title + detail.desc).length > 0, '详情应有标题或正文');
  assert.ok(
    !Number.isNaN(new Date(detail.createdAt).getTime()) && detail.createdAt.length > 0,
    'createdAt 应为可解析的 ISO 时间',
  );
  console.log(`✓ 小红书笔记详情（${detail.title || detail.desc.slice(0, 20)} @ ${detail.createdAt}）`);

  // ===== 8. 配图提取与落盘（联网） =====
  // 小红书信息大量画在图里；且图床直链是短时效签名，必须抓到当下就落盘。
  // 这里验证「解析得到图」与「字节能真的存下来」两段都通。
  assert.ok(detail.images.length > 0, '笔记应至少解析出 1 张配图（视频笔记也有封面）');
  const first = detail.images[0];
  assert.match(first.url, /^https?:\/\//, '配图应有 http 直链');
  assert.ok(first.width > 0 && first.height > 0, '配图应带宽高，供前端预留位置');

  const cached = await cacheImages(detail.images.slice(0, 1), 'xiaohongshu');
  assert.equal(cached.length, 1, '配图应成功缓存到本地（图床签名可能已变更或过期）');
  assert.ok(cached[0].src.startsWith('/media/kol/'), '缓存后应返回站内地址');
  const file = join(cacheDir(), cached[0].src.replace('/media/kol/', ''));
  assert.ok(existsSync(file), `缓存文件应真实落盘：${file}`);
  assert.ok(statSync(file).size > 1024, '缓存文件不应是空文件或错误页');
  console.log(
    `✓ 小红书配图（解析 ${detail.images.length} 张，落盘 ${(statSync(file).size / 1024).toFixed(0)}KB → ${cached[0].src}）`,
  );
} else {
  assert.equal(withId, undefined, '未配置 Cookie 却拿到了 noteId，降级判定逻辑需重新评估');
  console.log('- 小红书笔记详情：未配置 xhsCookie，当前为「仅标题」降级模式，跳过');
}

console.log('\n大V观点取数自检全部通过');
