// v1.4.0 本地管理页：单文件内联 HTML（中文、零外部依赖）。
// 页面仅从本机回环可访问，token 由用户输入并存 localStorage；所有 API 调用带 x-dsh-sync-token。
// 数据渲染只用 textContent，不做任何 innerHTML 注入，避免状态/配置文本进入 HTML 上下文。
export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>dsh-plugin-sync 本地管理</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 860px; margin: 24px auto; padding: 0 16px; line-height: 1.5; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; border-bottom: 1px solid #8884; padding-bottom: 4px; }
  section { margin-bottom: 24px; }
  textarea { width: 100%; min-height: 240px; font-family: ui-monospace, monospace; font-size: 12px; }
  button { padding: 6px 14px; margin-right: 8px; cursor: pointer; }
  input[type=text], input[type=password] { padding: 4px 8px; width: 320px; }
  pre { background: #8881; padding: 10px; overflow: auto; max-height: 320px; font-size: 12px; white-space: pre-wrap; }
  .ok { color: #0a7d32; } .err { color: #b3261e; } .warn { color: #9a6700; }
  .row { margin: 6px 0; }
</style>
</head>
<body>
<h1>dsh-plugin-sync 本地管理页</h1>
<p class="warn">仅限本机回环访问。更新应用后需要<b>重启 DSH</b> 才会加载新版本。</p>

<section>
  <h2>访问令牌</h2>
  <div class="row">
    <input type="password" id="token" placeholder="x-dsh-sync-token">
    <button id="saveToken">保存令牌</button>
    <span id="tokenHint"></span>
  </div>
</section>

<section>
  <h2>状态</h2>
  <div class="row">
    <button id="refresh">刷新状态</button>
    <button id="syncNow">立即同步</button>
    <button id="checkUpdate">检查更新</button>
    <button id="applyUpdate">应用更新</button>
    <label>指定版本 <input type="text" id="applyVersion" placeholder="如 1.5.0（留空=最新）" size="18"></label>
    <label><input type="checkbox" id="applyForce"> 强制（允许降级/重装）</label>
  </div>
  <pre id="statusOut">（未加载）</pre>
</section>

<section>
  <h2>配置</h2>
  <div class="row">
    <button id="loadConfig">加载配置</button>
    <button id="saveConfig">保存配置</button>
    <span class="warn">listenPort / role / bindHost / token 变更需要重启 DSH 生效</span>
  </div>
  <textarea id="configText" spellcheck="false"></textarea>
</section>

<div id="updateBlock"></div>

<script>
var $ = function (id) { return document.getElementById(id) }
function out(el, text, cls) { el.textContent = text; el.className = cls || '' }
async function api(path, init) {
  var token = localStorage.getItem('dshSyncToken') || ''
  var headers = Object.assign({ 'x-dsh-sync-token': token }, (init && init.headers) || {})
  var res = await fetch(path, Object.assign({}, init, { headers: headers }))
  var body = null
  try { body = await res.json() } catch (e) {}
  if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status))
  return body
}
$('saveToken').onclick = function () {
  localStorage.setItem('dshSyncToken', $('token').value.trim())
  out($('tokenHint'), '已保存到 localStorage（仅本浏览器）', 'ok')
  refreshStatus()
}
$('refresh').onclick = refreshStatus
$('syncNow').onclick = async function () {
  try { var r = await api('/v1/admin/sync', { method: 'POST' })
    out($('statusOut'), r.started ? '已触发一轮同步（后台执行中），稍后刷新状态查看结果。' : '已有同步在进行中（inFlight）。', r.started ? 'ok' : 'warn')
    setTimeout(refreshStatus, 2000)
  } catch (e) { out($('statusOut'), '同步失败：' + e.message, 'err') }
}
async function refreshStatus() {
  try { out($('statusOut'), JSON.stringify(await api('/v1/admin/status'), null, 2)) }
  catch (e) { out($('statusOut'), '获取状态失败：' + e.message, 'err') }
}
$('loadConfig').onclick = async function () {
  try { var r = await api('/v1/admin/config'); $('configText').value = JSON.stringify(r.settings, null, 2); $('configText').className = 'ok' }
  catch (e) { $('configText').value = ''; $('configText').placeholder = '加载失败：' + e.message }
}
$('saveConfig').onclick = async function () {
  var parsed
  try { parsed = JSON.parse($('configText').value) } catch (e) { out($('statusOut'), '配置不是合法 JSON：' + e.message, 'err'); return }
  try {
    var r = await api('/v1/admin/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ set: parsed }) })
    out($('statusOut'), '配置已保存。' + (r.needRestart ? 'needRestart=true：listenPort/role/bindHost/token 变更，需重启 DSH 生效。' : '下一轮同步自动生效。'), r.needRestart ? 'warn' : 'ok')
    $('configText').value = JSON.stringify(r.settings, null, 2)
  } catch (e) { out($('statusOut'), '保存配置失败：' + e.message, 'err') }
}
$('checkUpdate').onclick = async function () {
  try {
    var r = await api('/v1/admin/update/check')
    var lines = ['当前版本：' + r.current, '最新版本：' + (r.latest || '未知'),
      r.available ? '有可用更新。' : (r.error ? '检查失败：' + r.error : '已是最新。')]
    if (r.notesUrl) lines.push('发布说明：' + r.notesUrl)
    out($('updateBlock'), lines.join('\\n'), r.available ? 'warn' : (r.error ? 'err' : 'ok'))
    refreshStatus()
  } catch (e) { out($('updateBlock'), '检查更新失败：' + e.message, 'err') }
}
$('applyUpdate').onclick = async function () {
  if (!confirm('确认应用更新？将下载并替换插件文件，完成后需重启 DSH 生效。')) return
  var payload = { force: $('applyForce').checked }
  var v = $('applyVersion').value.trim()
  if (v) payload.version = v.replace(/^v/, '')
  try {
    var r = await api('/v1/admin/update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    if (r.applied) out($('updateBlock'), '已更新 ' + r.fromVersion + ' → ' + r.toVersion + '。请立即重启 DSH 加载新版本。备份：' + r.backupDir, 'ok')
    else out($('updateBlock'), '更新失败：' + (r.error || '未知错误'), 'err')
    refreshStatus()
  } catch (e) { out($('updateBlock'), '应用更新失败：' + e.message, 'err') }
}
$('token').value = localStorage.getItem('dshSyncToken') || ''
refreshStatus()
</script>
</body>
</html>
`
