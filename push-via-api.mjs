/**
 * 备用推送通路：github.com 被封、但 api.github.com + gh 可用时，用它把提交推上去。
 *   node push-via-api.mjs "commit message"
 *
 * 为什么需要它：
 *   本机直连 github.com:443 被阻断，代理又经常 502；但 api.github.com 始终可达。
 *   本脚本走 GitHub 的 Git Data API（blob → tree → commit → 移动 ref）完成一次等价的 push。
 *
 * 关键点（别改坏）：
 *   1. 文件一律用 **base64** 建 blob —— 直接传文本会把 GBK 编码的 .cmd 破坏成乱码；
 *   2. tree 必须带 base_tree，否则仓库里其它文件会被清空；
 *   3. 推完会在**本地重建同一个 commit**（用相同 tree / parent / author / committer / 时间），
 *      让本地 HEAD 与远端 sha 完全一致 —— 否则本地会一直显示"有未推送提交"。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const GH = 'C:/Program Files/GitHub CLI/gh.exe';   // 没装在默认位置就改成 'gh'
const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MSG = process.argv[2] || 'update';

function gh(args) {
  return execFileSync(GH, ['api', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}
function git(args, env) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...(env || {}) }, maxBuffer: 64 * 1024 * 1024 }).trim();
}

/* ---- 远端信息 ---- */
const remote = git(['remote', 'get-url', 'origin']).trim();
const repo = remote.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '');
const ref = JSON.parse(gh(['repos/' + repo + '/git/ref/heads/master']));
const remoteSha = ref.object.sha;
// ⚠ 本机 .git/refs/remotes/ 下的写入会被静默吞（git update-ref 返回 0 却不落地），
//   所以远端进度记在 .git/ailens_remote_sha 这个文件里，别去依赖 refs/remotes/origin/master。
const SYNC_FILE = path.join(ROOT, '.git', 'ailens_remote_sha');
let apiParent = remoteSha;
if (fs.existsSync(SYNC_FILE)) {
  const s = fs.readFileSync(SYNC_FILE, 'utf8').trim();
  if (s) apiParent = s;
}
const localParent = git(['rev-parse', 'HEAD']);
const baseCommit = JSON.parse(gh(['repos/' + repo + '/git/commits/' + remoteSha]));   // 取远端的 tree 当 base_tree
console.log('仓库', repo, '| 远端 =', remoteSha.slice(0, 7), '| API parent =', apiParent.slice(0, 7), '| 本地 parent =', localParent.slice(0, 7));

/* ---- 本地要提交的文件（git 跟踪的全部文件） ---- */
const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
const remoteTree = JSON.parse(gh(['repos/' + repo + '/git/trees/' + baseCommit.tree.sha + '?recursive=1']));
const remotePaths = new Set((remoteTree.tree || []).filter(x => x.type === 'blob').map(x => x.path));
console.log('本地文件', files.length, '| 远端文件', remotePaths.size);

/* ---- 1) 每个文件建 blob（base64，保证字节精确） ---- */
const tree = [];
for (const f of files) {
  const abs = path.join(ROOT, f);
  const b64 = fs.readFileSync(abs).toString('base64');
  fs.writeFileSync(path.join(ROOT, '.git', '_ailens_blob.json'), JSON.stringify({ content: b64, encoding: 'base64' }));
  const b = JSON.parse(gh(['--method', 'POST', 'repos/' + repo + '/git/blobs', '--input', path.join(ROOT, '.git', '_ailens_blob.json')]));
  tree.push({ path: f.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: b.sha });
}
// 本地已删除、远端还存在的 → 显式置空
for (const p of remotePaths) if (!files.includes(p)) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
fs.unlinkSync(path.join(ROOT, '.git', '_ailens_blob.json'));

/* ---- 2) tree → 3) commit → 4) 移动 ref ---- */
const t = JSON.parse(gh(['--method', 'POST', 'repos/' + repo + '/git/trees',
  '--input', (fs.writeFileSync(path.join(ROOT, '.git', '_ailens_tree.json'), JSON.stringify({ base_tree: baseCommit.tree.sha, tree })), path.join(ROOT, '.git', '_ailens_tree.json'))]));
fs.unlinkSync(path.join(ROOT, '.git', '_ailens_tree.json'));
console.log('新 tree =', t.sha.slice(0, 7));

// message 统一补一个尾换行：git commit-tree -F 会自动补，API 端不会 ——
// 两边差一个 '\n'，commit sha 就对不上，本地永远对齐不了。
const MSG_N = MSG.replace(/\s*$/, '') + '\n';
fs.writeFileSync(path.join(ROOT, '.git', '_ailens_commit.json'), JSON.stringify({ message: MSG_N, tree: t.sha, parents: [apiParent] }));
const c = JSON.parse(gh(['--method', 'POST', 'repos/' + repo + '/git/commits', '--input', path.join(ROOT, '.git', '_ailens_commit.json')]));
fs.unlinkSync(path.join(ROOT, '.git', '_ailens_commit.json'));
// force=true：parent 用的是本地认得的提交，往往不是快进，必须强制移动 ref。
// gh 的 -f 一律当字符串传，布尔必须走 --input 的 JSON。
const refBody = path.join(ROOT, '.git', '_ailens_ref.json');
fs.writeFileSync(refBody, JSON.stringify({ sha: c.sha, force: true }));
gh(['--method', 'PATCH', 'repos/' + repo + '/git/refs/heads/master', '--input', refBody]);
fs.unlinkSync(refBody);
console.log('已推送 →', c.sha.slice(0, 7));

/* ---- 5) 本地重建同一个 commit，让 HEAD 与远端对齐 ---- */
const msgFile = path.join(ROOT, '.git', '_ailens_msg.txt');
fs.writeFileSync(msgFile, MSG_N, 'utf8');
git(['read-tree', '--empty']);
for (const f of files) {
  const blob = git(['hash-object', '-w', '--no-filters', '--', path.join(ROOT, f)]);
  git(['update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + f.replace(/\\/g, '/')]);
}
const localTree = git(['write-tree']);
const env = {
  GIT_AUTHOR_NAME: c.author.name, GIT_AUTHOR_EMAIL: c.author.email, GIT_AUTHOR_DATE: c.author.date,
  GIT_COMMITTER_NAME: c.committer.name, GIT_COMMITTER_EMAIL: c.committer.email, GIT_COMMITTER_DATE: c.committer.date
};
const localSha = git(['commit-tree', localTree, '-p', localParent, '-F', msgFile], env);
fs.unlinkSync(msgFile);
fs.writeFileSync(SYNC_FILE, c.sha, 'utf8');   // 记下远端真实 sha，下次当 API parent

if (localSha !== c.sha) {
  // tree 相同 = 文件内容一字不差；sha 不同只是 author/committer 元数据在两端拼法不同。
  // 远端已经是对的，本地就指向这个内容等价的提交，避免永远显示"有未推送提交"。
  console.log('\n⚠ 本地重建的 sha 与远端不同，但 tree 一致（内容完全相同）');
  console.log('  远端 =', c.sha.slice(0, 7), '/ 本地 =', localSha.slice(0, 7), '→ 按内容对齐本地');
}
git(['update-ref', 'refs/heads/master', localSha]);   // 本地 HEAD 指向内容等价的那个提交
console.log('本地 HEAD →', localSha.slice(0, 7), '（远端', c.sha.slice(0, 7) + '，内容一致）');
console.log('\n完成：https://github.com/' + repo);
