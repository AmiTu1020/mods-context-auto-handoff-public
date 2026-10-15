import type { EngineInterface, Register } from 'claude-code'

const MARK = '【交接】'
const PATH_LINE = /交接檔[:：]\s*`?((?:[A-Za-z]:[\\/]|\/)[^`\r\n]*?\.md)`?\s*$/
const INI_NAME = 'context-auto-handoff.ini'
const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/
const LOG = 'context-auto-handoff：'

type Sub = { key: string; desc: string }
type Section = { name: string; desc?: string; subs: Sub[]; checkDetail?: string[] }
type Config = {
  threshold: number
  trigger: number // 1＝now、2＝turnEnd、3＝nextMessage
  userName: string
  handoffDir?: string
  retryTimes: number
  maxChars: number // 0＝不限
  checkItems?: string[]
  sections: Section[]
}

// 沒有 INI（或 INI 沒有大項段落）時的預設交接卡項目。
const DEFAULT_SECTIONS: Section[] = [
  {
    name: 'startHere',
    desc: '★ 先接這件',
    subs: [
      { key: 'goal', desc: '主旨（{userName} 原話）' },
      { key: 'taskFolder', desc: '任務資料夾' },
      { key: 'stoppedAt', desc: '停在哪' },
      { key: 'committed', desc: '已 commit' },
      { key: 'uncommitted', desc: '未 commit' },
      { key: 'nextSteps', desc: '接下來（依序）' },
    ],
  },
  { name: 'readFirst', desc: '先讀（依序）', subs: [] },
  { name: 'constraints', desc: '不可偏離／不做', subs: [] },
  { name: 'corrections', desc: '跟 {userName} 互動（這次被指正的）', subs: [] },
  { name: 'waitingOn', desc: '等 {userName} 一句話', subs: [] },
]

// 沒寫的設定一律用預設；預設不放任何人的路徑、名字，也不檢查項目。
const DEFAULTS: Config = { threshold: 60, trigger: 2, userName: '使用者', retryTimes: 3, maxChars: 500, sections: DEFAULT_SECTIONS }

// ---- INI ----

// [段落] 底下 key = value；; 或 # 開頭是註解；段落前的 key 算 [handoff]；值照原樣（路徑反斜線不用跳脫）。
function parseIni(text: string): { name: string; entries: [string, string][] }[] {
  const sections = [{ name: 'handoff', entries: [] as [string, string][] }]
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || /^[;#]/.test(trimmed)) continue
    const header = /^\[(.+)\]$/.exec(trimmed)
    if (header) {
      sections.push({ name: header[1].trim(), entries: [] })
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq > 0) sections[sections.length - 1].entries.push([trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim()])
  }
  return sections
}

const list = (value: string | undefined) => value?.split(',').map(s => s.trim()).filter(Boolean)

const iniPath = (home: string) => {
  const sep = home.includes('\\') ? '\\' : '/'
  return `${home}${sep}.claude${sep}${INI_NAME}`
}

// 整數設定：在範圍內才採用，否則照預設並寫 log。
function intSetting($: EngineInterface, raw: string | undefined, key: string, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (Number.isInteger(n) && n >= min && n <= max) return n
  $.ui.log(`${LOG}${INI_NAME} 的 ${key}「${raw}」不是 ${min}～${max === Infinity ? '' : max} 的整數，照預設 ${fallback}`)
  return fallback
}

// 每次用到都重讀 ~/.claude/context-auto-handoff.ini，改了下一輪就生效。
async function loadConfig($: EngineInterface): Promise<Config> {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (home === undefined) return DEFAULTS
    const path = iniPath(home)
    if (!(await $.fs.exists(path))) return DEFAULTS
    const parsed = parseIni(await $.fs.read(path))
    const handoff = new Map<string, string>()
    for (const sec of parsed.filter(s => s.name.toLowerCase() === 'handoff')) for (const [k, v] of sec.entries) handoff.set(k.toLowerCase(), v)

    const sections: Section[] = []
    for (const sec of parsed.filter(s => s.name.toLowerCase() !== 'handoff')) {
      if (!NAME.test(sec.name)) {
        $.ui.log(`${LOG}${INI_NAME} 的大項「${sec.name}」要用英文名稱（英文字母開頭，可含數字、_、-），已略過`)
        continue
      }
      const section: Section = { name: sec.name, subs: [] }
      for (const [k, v] of sec.entries) {
        const key = k.toLowerCase()
        if (key === 'desc') section.desc = v
        else if (key === 'checkitemdetail') section.checkDetail = list(v)
        else if (NAME.test(k)) section.subs.push({ key: k, desc: v })
        else $.ui.log(`${LOG}${INI_NAME} 的 [${sec.name}] 子項「${k}」要用英文名稱（英文字母開頭，可含數字、_、-），已略過`)
      }
      for (const d of section.checkDetail ?? []) {
        if (!section.subs.some(s => s.key.toLowerCase() === d.toLowerCase())) $.ui.log(`${LOG}[${sec.name}] 的 checkItemDetail 有「${d}」，但沒有這個子項的說明（打錯字？）；照樣檢查`)
      }
      sections.push(section)
    }
    const useSections = sections.length > 0 ? sections : DEFAULT_SECTIONS
    const checkItems = list(handoff.get('checkitems'))
    for (const name of checkItems ?? []) {
      if (!useSections.some(s => s.name.toLowerCase() === name.toLowerCase())) $.ui.log(`${LOG}checkItems 有「${name}」，但沒有 [${name}] 段落（打錯字？）；照樣檢查`)
    }

    return {
      threshold: intSetting($, handoff.get('threshold'), 'threshold', 1, 100, DEFAULTS.threshold),
      trigger: intSetting($, handoff.get('contextfulltrigger'), 'contextFullTrigger', 1, 3, DEFAULTS.trigger),
      userName: handoff.get('username') || DEFAULTS.userName,
      handoffDir: handoff.get('handoffdir') || undefined,
      retryTimes: intSetting($, handoff.get('retrytimes'), 'retryTimes', 0, Infinity, DEFAULTS.retryTimes),
      maxChars: intSetting($, handoff.get('maxchars'), 'maxChars', 0, Infinity, DEFAULTS.maxChars),
      checkItems,
      sections: useSections,
    }
  } catch (err) {
    $.ui.log(`${LOG}讀 ${INI_NAME} 失敗，照預設（${String(err)}）`)
    return DEFAULTS
  }
}

// ---- 交接指示 ----

const fill = (text: string, cfg: Config) => text.replaceAll('{userName}', cfg.userName)
const where = (cfg: Config) => (cfg.handoffDir ? `${cfg.handoffDir} 底下本任務的資料夾` : '目前任務的資料夾（沒有就用專案根目錄）')
const LOCK_RULE = '只能讀檔（Read、Grep、Glob）、寫 HANDOFF.md、跑 git add/commit/status/diff/log'

function instruction(cfg: Config, root: string, reason: string) {
  const format = [
    '# <任務> 交接（YYYY-MM-DD HH:MM，<交接原因>）',
    `- project：<repo 專案名，不是 git repo 就寫「無」>（${root}）`,
    ...cfg.sections.flatMap(s => [`## ${s.name}`, ...(s.desc ? [fill(s.desc, cfg)] : []), ...s.subs.map(sub => `- ${sub.key}：${fill(sub.desc, cfg)}`)]),
  ]
  return [
    `${MARK}${reason}｜下一步：寫交接檔、停手`,
    `停止施工；工具已鎖，${LOCK_RULE}。有 worktree 且有未 commit 的改動就先 commit。`,
    `再寫 HANDOFF.md，放在 ${where(cfg)}；已有 HANDOFF.md 就改寫成現況。`,
    `${cfg.maxChars > 0 ? `整份最多 ${cfg.maxChars} 字（不算空白）。` : ''}只寫還沒做完的，細節寫路徑指過去，不重講經過。`,
    '大項寫成「## 英文名稱」標題、子項寫成「- 英文名稱：內容」；沒東西就寫「無」。格式：',
    '```',
    ...format,
    '```',
    '寫完，回覆最後一行只寫「交接檔：<HANDOFF.md 完整路徑>」，然後停手。不要自己開新對話：mod 會清空對話，叫新對話讀交接檔續做。',
  ].join('\n')
}

const retryText = (problems: string[]) =>
  `${MARK}交接檔沒過檢查｜${problems.join('；')}。改好後，回覆最後一行只寫「交接檔：<HANDOFF.md 完整路徑>」，然後停手。`

// ---- 檢查 ----

// Windows 路徑不分大小寫、斜線方向；比對前一律正規化。
const norm = (p: string) => p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
const visible = (text: string) => text.replace(/\s/g, '').length

// 交接卡按「## 名稱」切段：名稱（小寫）→ 該段非空白的行。
function cardSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) sections.set(heading[1].toLowerCase(), (current = []))
    else if (current && line.trim()) current.push(line.trim())
  }
  return sections
}

// 交接卡不合格的原因，全部列出（空陣列＝合格）。
async function checkHandoff($: EngineInterface, cfg: Config, path: string): Promise<string[]> {
  let real: string
  try {
    const stat = await $.fs.stat(path, { resolve: true })
    if (stat.kind !== 'file') return [`${path} 不是檔案`]
    real = stat.realPath ?? path
  } catch {
    return [`找不到 ${path}`]
  }

  const problems: string[] = []
  if (cfg.handoffDir) {
    let dir: string | undefined
    try {
      const stat = await $.fs.stat(cfg.handoffDir, { resolve: true })
      if (stat.kind === 'dir') dir = stat.realPath ?? cfg.handoffDir
    } catch {}
    if (dir === undefined) {
      $.ui.log(`${LOG}${INI_NAME} 的 handoffDir「${cfg.handoffDir}」不是存在的資料夾，交接卡不放行`)
      problems.push(`${INI_NAME} 的 handoffDir「${cfg.handoffDir}」不是存在的資料夾（要請 ${cfg.userName} 改 INI）`)
    } else if (!norm(real).startsWith(`${norm(dir)}\\`)) {
      problems.push(`交接檔要放在 ${cfg.handoffDir} 底下，現在在 ${real}`)
    }
  }

  const text = await $.fs.read(path)
  const root = await $.session.root()
  const head = text.split(/^##\s/m)[0]
  const project = head.split(/\r?\n/).find(l => /^-\s*project\s*[:：]/i.test(l.trim()))
  const folder = project && /[（(]([^（）()]+)[）)]\s*$/.exec(project.trim())?.[1]
  if (!project) problems.push(`缺少「- project：<repo 專案名>（${root}）」這一行（要在第一個 ## 前面）`)
  else if (!folder || norm(folder) !== norm(root)) problems.push(`project 括號裡的資料夾要寫 ${root}`)

  const body = cardSections(text)
  const missing: string[] = []
  for (const name of cfg.checkItems ?? []) if (!body.get(name.toLowerCase())?.length) missing.push(name)
  for (const section of cfg.sections) {
    const lines = body.get(section.name.toLowerCase()) ?? []
    for (const d of section.checkDetail ?? []) {
      const pattern = new RegExp(`^-\\s*${d}\\s*[:：]\\s*\\S`, 'i')
      if (!lines.some(l => pattern.test(l))) missing.push(`${section.name}.${d}`)
    }
  }
  if (missing.length > 0) problems.push(`缺少項目：${missing.join('、')}（大項要有「## 名稱」標題和內容，子項要有「- 名稱：內容」）`)

  const count = visible(text)
  if (cfg.maxChars > 0 && count > cfg.maxChars) problems.push(`交接卡 ${count} 字，超過上限 ${cfg.maxChars} 字，請精簡`)
  return problems
}

// ---- 鎖：交接中只放行寫交接卡需要的動作 ----

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const GIT_OK = /^git(\s+-C\s+\S+)?\s+(add|commit|status|diff|log)\b/
const CD_OK = /^(cd|Set-Location|pushd|popd)\b/

// 指令每一段都只能是允許的 git 或切換資料夾；heredoc 內文與引號內字串不算指令。
function isGitOnly(command: string): boolean {
  const flat = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g, '<<HEREDOC')
    .replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""')
  if (/[>`]|\$\(/.test(flat)) return false
  return flat
    .split(/&&|\|\||[;|\n]/)
    .map(s => s.trim())
    .filter(Boolean)
    .every(s => GIT_OK.test(s) || CD_OK.test(s))
}

function isHandoffPath(path: unknown, cfg: Config): boolean {
  if (typeof path !== 'string' || !/(^|[\\/])HANDOFF\.md$/i.test(path)) return false
  return !cfg.handoffDir || norm(path).startsWith(`${norm(cfg.handoffDir)}\\`)
}

function isAllowed(e: { tool: string; file_path?: unknown; command?: unknown }, cfg: Config): boolean {
  if (READ_TOOLS.has(e.tool)) return true
  if (WRITE_TOOLS.has(e.tool)) return isHandoffPath(e.file_path, cfg)
  if (e.tool === 'Bash' || e.tool === 'PowerShell') return typeof e.command === 'string' && isGitOnly(e.command)
  return false
}

const lockText = (cfg: Config) =>
  `${MARK}交接中，工具已鎖：${LOCK_RULE}${cfg.handoffDir ? `（HANDOFF.md 要在 ${cfg.handoffDir} 底下）` : ''}。先把交接卡寫好；要取消請${cfg.userName}打 /handoff cancel。`

// ---- 流程 ----

// idle：正常；pending：已滿、等下一則訊息（nextMessage）；asked：交接中、工具鎖住；clearing：清空中；done：這個對話不再自動交接
type Phase = 'idle' | 'pending' | 'asked' | 'clearing' | 'done'

let phase: Phase = 'idle'
let retries = 0
let pendingPercent = 0
let held: string | undefined

function say($: EngineInterface, text: string) {
  $.ui.log(`${LOG}${text}`)
  $.ui.toast(text)
}

async function begin($: EngineInterface, cfg: Config, reason: string): Promise<string> {
  phase = 'asked'
  retries = 0
  return instruction(cfg, await $.session.root(), reason)
}

async function startManual($: EngineInterface) {
  const cfg = await loadConfig($)
  void $.prompt.submit({ text: await begin($, cfg, `${cfg.userName}手動要求交接`) })
}

async function handOver($: EngineInterface, path: string, message: string) {
  phase = 'clearing'
  try {
    await $.command.run({ command: 'clear' })
    phase = 'idle'
    await $.prompt.submit({ text: message })
  } catch (err) {
    phase = 'done'
    say($, `清空對話失敗，請自己開新對話並貼上：讀 ${path} 續做（${String(err)}）`)
  }
}

async function resubmit($: EngineInterface, text: string) {
  await $.prompt.submit({ text })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'handoff', description: '寫交接卡，清空對話並由新對話接手；/handoff cancel 取消交接', argumentHint: '[cancel]' })
    return result
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'cancel') {
      if (phase !== 'asked' && phase !== 'pending') return { text: '目前沒有在交接。' }
      phase = 'done'
      const message = held
      held = undefined
      // nextMessage 模式被換掉的那則訊息，取消後送回去照常處理。
      if (message !== undefined) $.clock.after(0, () => void resubmit($, message))
      return { text: '已取消交接，工具已解鎖；這個對話不再自動交接（要交接可以再打 /handoff）。' }
    }
    if (phase === 'clearing') return { text: '正在清空對話，請稍等。' }
    // 指令的 hook 裡不能直接送提示（會等自己這一輪），交給計時器送。
    phase = 'asked'
    $.clock.after(0, () => void startManual($))
    return { text: '已排入交接：Claude 先寫交接卡，接著清空對話、由新對話接手。' }
  })

  on('tool.call', async ($, e, next) => {
    if (phase === 'asked' || phase === 'clearing') {
      const cfg = await loadConfig($)
      return isAllowed(e, cfg) ? next(e) : { deny: lockText(cfg) }
    }
    if (phase === 'idle') {
      const cfg = await loadConfig($)
      if (cfg.trigger === 1) {
        const { context } = await $.session.usage()
        if (context.percent !== undefined && context.percent >= cfg.threshold) {
          return { deny: await begin($, cfg, `context 已 ${context.percent}%`) }
        }
      }
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const from = e.origin?.kind
    if (phase === 'pending' && from !== 'plugin' && from !== 'task-notification') {
      const cfg = await loadConfig($)
      held = e.text
      return next({ ...e, text: await begin($, cfg, `context 已 ${pendingPercent}%（${cfg.userName}剛送出的訊息先保留，交給新對話處理）`) })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result

    try {
      if (phase === 'idle' && e.reason === 'answer') {
        const { context } = await $.session.usage()
        if (context.percent === undefined) return result
        const cfg = await loadConfig($)
        if (context.percent < cfg.threshold) return result
        if (cfg.trigger === 3) {
          phase = 'pending'
          pendingPercent = context.percent
        } else {
          void $.prompt.submit({ text: await begin($, cfg, `context 已 ${context.percent}%`) })
        }
      } else if (phase === 'asked') {
        const cfg = await loadConfig($)
        if (e.reason !== 'answer') {
          say($, `交接被中斷，工具仍鎖著；請叫 Claude 繼續寫交接卡，或打 /handoff cancel 取消`)
          return result
        }
        const lines = e.answer.trim().split(/\r?\n/)
        const path = PATH_LINE.exec(lines[lines.length - 1] ?? '')?.[1]
        const problems = path === undefined ? ['回覆最後一行沒有「交接檔：<HANDOFF.md 完整路徑>」'] : await checkHandoff($, cfg, path)
        if (path !== undefined && problems.length === 0) {
          const message = held === undefined ? `讀 ${path} 續做` : `讀 ${path} 續做。\n\n${cfg.userName}交接前送出的訊息（接手後回答）：\n${held}`
          held = undefined
          $.clock.after(0, () => void handOver($, path, message))
        } else if (retries < cfg.retryTimes) {
          retries++
          void $.prompt.submit({ text: retryText(problems) })
        } else {
          say($, `交接卡沒過檢查：${problems.join('；')}。工具仍鎖著；請跟 Claude 說哪裡要改，或打 /handoff cancel 取消`)
        }
      }
    } catch (err) {
      say($, `交接檢查出錯（${String(err)}）；工具${phase === 'asked' ? '仍鎖著，可打 /handoff cancel 取消' : '沒有鎖'}`)
    }
    return result
  })
}
