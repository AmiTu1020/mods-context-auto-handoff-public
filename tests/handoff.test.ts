import { expect, mock, test } from 'claude-code/testing'

const r = String.raw
const PROJECT = r`C:\Users\T\proj`
const HANDOFF = r`C:\Users\T\work\demo\HANDOFF.md`
const INI_PATH = r`C:\Users\T\.claude\context-auto-handoff.ini`
const DEFAULT_ITEMS = ['startHere', 'readFirst', 'constraints', 'corrections', 'waitingOn']
const DEFAULT_DETAIL = ['goal', 'taskFolder', 'stoppedAt', 'committed', 'uncommitted', 'nextSteps']

// 交接卡：project 行＋每個大項（startHere 底下列子項）。opts 可拿掉某些項或改 project。
function card(opts: { items?: string[]; detail?: string[]; project?: string | null; extraLines?: Record<string, number> } = {}) {
  const items = opts.items ?? DEFAULT_ITEMS
  const detail = opts.detail ?? DEFAULT_DETAIL
  const lines = ['# demo 交接（2026-10-15 20:00，context 61%）']
  if (opts.project !== null) lines.push(`- project：demo-repo（${opts.project ?? PROJECT}）`)
  for (const item of items) {
    lines.push(`## ${item}`)
    if (item === 'startHere') for (const d of detail) lines.push(`- ${d}：${d} 的內容`)
    else lines.push(`${item} 的內容`)
    for (let i = 0; i < (opts.extraLines?.[item] ?? 0); i++) lines.push(`多寫的第 ${i + 1} 行`)
  }
  return lines.join('\n')
}

type File = { realPath: string; text: string }
type Setup = { percent: number; ini?: string; files?: Record<string, File>; dirs?: Record<string, string> }

// 真引擎會先統一路徑再交給 fs：「/」換成「\」、拿掉結尾的「\」（2026-10-15 探測：C:\A\B\、C:/A/B/ 都變 C:\A\B）。
// 模擬也照做，不然結尾有「\」或寫成「/」的路徑會對不上（wiki 踩坑：反斜線／正斜線對不上）。
const engPath = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '')
function lookup<T>(map: Record<string, T>, path: string): T | undefined {
  const hit = Object.keys(map).find(k => engPath(k) === engPath(path))
  return hit === undefined ? undefined : map[hit]
}

// 測試用的引擎：context、INI、檔案與資料夾由參數決定；記下送出的提示、執行的指令、log。
function fakeEngine(on: any, setup: Setup) {
  const submitted: string[] = []
  const commands: string[] = []
  const logs: string[] = []
  const state = { percent: setup.percent, ini: setup.ini }
  const files: Record<string, File> = setup.files ?? { [HANDOFF]: { realPath: HANDOFF, text: card() } }
  const dirs = setup.dirs ?? {}
  const clock = mock.clock(on)
  on('env.get', ($: any, e: any) => ({ value: e.name === 'USERPROFILE' ? r`C:\Users\T` : undefined }))
  on('session.root', () => ({ value: PROJECT }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: state.percent * 10_000, percent: state.percent }, rateLimits: [] } }))
  on('fs.exists', ($: any, e: any) => ({ value: e.path === INI_PATH ? state.ini !== undefined : lookup(files, e.path) !== undefined || lookup(dirs, e.path) !== undefined }))
  on('fs.read', ($: any, e: any) => {
    if (e.path === INI_PATH && state.ini !== undefined) return { value: state.ini }
    const file = lookup(files, e.path)
    return file ? { value: file.text } : { deny: 'ENOENT' }
  })
  on('fs.stat', ($: any, e: any) => {
    const base = { size: 0, mtimeMs: 0, isLink: false }
    const file = lookup(files, e.path)
    if (file) return { value: { ...base, kind: 'file', realPath: file.realPath } }
    const dir = lookup(dirs, e.path)
    if (dir) return { value: { ...base, kind: 'dir', realPath: dir } }
    return { deny: 'ENOENT' }
  })
  on('ui.log', ($: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('command.run', ($: any, e: any) => {
    commands.push(e.command)
    return { text: '' }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  return { submitted, commands, clock, state, logs, files }
}

type Eng = ReturnType<typeof fakeEngine>
let turnNo = 0
const answer = (text: string) => ({ answer: text, durationMs: 1, isAborted: false, turnId: `t${++turnNo}`, reason: 'answer' as const })
const reported = (path: string) => answer(`寫好了。\n交接檔：${path}`)

// 一輪結束 → 時鐘走一步（讓計時器排的動作執行）。
async function finish($: any, eng: Eng, text: string) {
  await $.turn.complete(answer(text))
  await eng.clock.advance(1)
}

// 到門檻（turnEnd）→ 交接回合回報路徑。
async function handoff($: any, eng: Eng, path = HANDOFF) {
  await finish($, eng, '做完一步')
  await $.turn.complete(reported(path))
  await eng.clock.advance(1)
}

const denied = (res: any) => String(res?.deny ?? (res?.isError ? res?.text : ''))

// ---- 觸發 ----

test('沒到門檻：不交接', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 59 })
  await finish($, eng, '做完了')
  expect(eng.submitted).toEqual([])
})

test('turnEnd（預設）：到門檻排交接；交接卡合格 → /clear，新對話讀交接卡續做', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61 })
  await handoff($, eng)
  expect(eng.submitted[0]).toMatch(/^【交接】context 已 61%｜下一步：寫交接檔、停手/)
  expect(eng.commands).toEqual(['clear'])
  expect(eng.submitted[1]).toBe(`讀 ${HANDOFF} 續做`)
})

test('now：到門檻時下一個工具就被擋，擋的理由是交接指示', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: 'contextFullTrigger = 1' })
  const res = await $.tool.call({ tool: 'Edit', file_path: r`C:\Users\T\proj\a.ts`, old_string: 'a', new_string: 'b' })
  expect(denied(res)).toContain('【交接】context 已 61%')
  await $.turn.complete(reported(HANDOFF))
  await eng.clock.advance(1)
  expect(eng.commands).toEqual(['clear'])
})

test('nextMessage：到門檻不打斷；下一則訊息先交接，新對話再處理那則訊息', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: 'contextFullTrigger = 3' })
  await finish($, eng, '做完一步')
  expect(eng.submitted).toEqual([])

  const sent = await $.prompt.submit({ text: '幫我看一下 bug', origin: { kind: 'sdk' } })
  expect(sent.text).toMatch(/^【交接】/)
  await $.turn.complete(reported(HANDOFF))
  await eng.clock.advance(1)
  expect(eng.commands).toEqual(['clear'])
  expect(eng.submitted.at(-1)).toContain(`讀 ${HANDOFF} 續做`)
  expect(eng.submitted.at(-1)).toContain('幫我看一下 bug')
})

test('contextFullTrigger 寫錯：照預設 2（turnEnd）', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: 'contextFullTrigger = 9' })
  await finish($, eng, '做完一步')
  expect(eng.submitted[0]).toMatch(/^【交接】context 已 61%/)
})

test('/handoff：不用等門檻就交接', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 10 })
  await $.command.run({ command: 'handoff', args: '' })
  await eng.clock.advance(1)
  expect(eng.submitted[0]).toMatch(/^【交接】使用者手動要求交接/)
})

test('/handoff cancel：解鎖，這個對話之後不再自動交接', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61 })
  await finish($, eng, '做完一步')
  await $.command.run({ command: 'handoff', args: 'cancel' })
  const res = await $.tool.call({ tool: 'Edit', file_path: r`C:\Users\T\proj\a.ts`, old_string: 'a', new_string: 'b' })
  expect(denied(res)).toBe('')
  await finish($, eng, '又做完一步')
  expect(eng.submitted.length).toBe(1)
})

// ---- 鎖 ----

test('鎖：交接中只放行讀檔、寫 HANDOFF.md、git add/commit/status/diff/log', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61 })
  await finish($, eng, '做完一步')
  const call = (input: any) => $.tool.call(input).then(denied)
  expect(await call({ tool: 'Read', file_path: r`C:\x\a.ts` })).toBe('')
  expect(await call({ tool: 'Grep', pattern: 'x' })).toBe('')
  expect(await call({ tool: 'Write', file_path: HANDOFF, content: 'x' })).toBe('')
  expect(await call({ tool: 'Bash', command: 'git status -sb && git diff --stat' })).toBe('')
  expect(await call({ tool: 'Bash', command: "git add -A && git commit -q -F - <<'EOF'\nwip: 存檔; 未完成\nEOF" })).toBe('')
  expect(await call({ tool: 'Edit', file_path: r`C:\x\a.ts`, old_string: 'a', new_string: 'b' })).toContain('工具已鎖')
  expect(await call({ tool: 'Write', file_path: r`C:\x\notes.md`, content: 'x' })).toContain('工具已鎖')
  expect(await call({ tool: 'Bash', command: 'rm -rf build' })).toContain('工具已鎖')
  expect(await call({ tool: 'Bash', command: 'git commit -m "x" && rm -rf .' })).toContain('工具已鎖')
  expect(await call({ tool: 'Bash', command: 'git push origin main' })).toContain('工具已鎖')
  expect(await call({ tool: 'Agent', prompt: 'x' })).toContain('工具已鎖')
})

test('鎖：交接完成後解鎖', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61 })
  await handoff($, eng)
  const res = await $.tool.call({ tool: 'Edit', file_path: r`C:\x\a.ts`, old_string: 'a', new_string: 'b' })
  expect(denied(res)).toBe('')
})

// ---- 不合格與提醒 ----

test('交接卡找不到：照 retryTimes（預設 3）提醒，用完就不再提醒、不清空、仍鎖', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, files: {} })
  await handoff($, eng)
  for (let i = 0; i < 3; i++) {
    await $.turn.complete(reported(HANDOFF))
    await eng.clock.advance(1)
  }
  const reminders = eng.submitted.filter(t => t.startsWith('【交接】交接檔沒過檢查'))
  expect(reminders.length).toBe(3)
  expect(eng.commands).toEqual([])
  const res = await $.tool.call({ tool: 'Edit', file_path: r`C:\x\a.ts`, old_string: 'a', new_string: 'b' })
  expect(denied(res)).toContain('工具已鎖')
})

test('retryTimes = 0：不自動提醒；之後交接卡寫好了照樣放行', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: 'retryTimes = 0', files: {} })
  await handoff($, eng)
  expect(eng.submitted.filter(t => t.startsWith('【交接】交接檔沒過檢查'))).toEqual([])
  eng.files[HANDOFF] = { realPath: HANDOFF, text: card() }
  await $.turn.complete(reported(HANDOFF))
  await eng.clock.advance(1)
  expect(eng.commands).toEqual(['clear'])
})

test('retryTimes 寫錯：照預設 3', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: 'retryTimes = abc', files: {} })
  await handoff($, eng)
  for (let i = 0; i < 4; i++) await $.turn.complete(reported(HANDOFF))
  await eng.clock.advance(1)
  expect(eng.submitted.filter(t => t.startsWith('【交接】交接檔沒過檢查')).length).toBe(3)
})

// ---- project 行（固定檢查） ----

test('project：交接指示告訴 Claude VS Code 專案資料夾', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61 })
  await finish($, eng, '做完一步')
  expect(eng.submitted[0]).toContain(`- project：<repo 專案名，不是 git repo 就寫「無」>（${PROJECT}）`)
})

test('project：缺 project 行 → 不放行', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, files: { [HANDOFF]: { realPath: HANDOFF, text: card({ project: null }) } } })
  await handoff($, eng)
  expect(eng.commands).toEqual([])
  expect(eng.submitted.at(-1)).toContain('project')
})

test('project：資料夾寫錯 → 不放行；大小寫、斜線不同 → 放行', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, files: { [HANDOFF]: { realPath: HANDOFF, text: card({ project: r`C:\Users\T\other` }) } } })
  await handoff($, eng)
  expect(eng.commands).toEqual([])

  eng.files[HANDOFF] = { realPath: HANDOFF, text: card({ project: 'c:/users/t/proj' }) }
  await $.turn.complete(reported(HANDOFF))
  await eng.clock.advance(1)
  expect(eng.commands).toEqual(['clear'])
})

// ---- 項目 ----

const SAMPLE_INI = [
  '[handoff]',
  'userName = Alex',
  'checkItems = startHere, readFirst',
  '',
  '[startHere]',
  'desc = ★ 先接這件',
  'checkItemDetail = goal, nextSteps',
  'goal = 主旨（{userName} 原話）',
  'stoppedAt = 停在哪',
  'nextSteps = 接下來（依序）',
  '',
  '[readFirst]',
  'desc = 先讀（依序）',
  '',
  '[waitingOn]',
  'desc = 等 {userName} 一句話',
].join('\r\n')

test('沒有 INI：用預設項目寫，但不檢查項目（缺項目也放行）', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, files: { [HANDOFF]: { realPath: HANDOFF, text: card({ items: ['readFirst'] }) } } })
  await finish($, eng, '做完一步')
  for (const item of DEFAULT_ITEMS) expect(eng.submitted[0]).toContain(`## ${item}`)
  for (const d of DEFAULT_DETAIL) expect(eng.submitted[0]).toContain(`- ${d}：`)
  expect(eng.submitted[0]).toContain('使用者')
  expect(eng.submitted[0]).not.toMatch(/Alex|handoffs/)
  await $.turn.complete(reported(HANDOFF))
  await eng.clock.advance(1)
  expect(eng.commands).toEqual(['clear'])
})

test('INI 項目：照段落寫；desc、子項說明、{userName} 都帶進指示', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: SAMPLE_INI })
  await finish($, eng, '做完一步')
  const text = eng.submitted[0]
  expect(text).toContain('## startHere\n★ 先接這件')
  expect(text).toContain('- goal：主旨（Alex 原話）')
  expect(text).toContain('- stoppedAt：停在哪')
  expect(text).toContain('## waitingOn\n等 Alex 一句話')
  expect(text).not.toContain('## constraints')
})

test('checkItems：缺列出的大項 → 不放行；沒列的大項（waitingOn）缺了不管', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: SAMPLE_INI, files: { [HANDOFF]: { realPath: HANDOFF, text: card({ items: ['startHere'], detail: ['goal', 'nextSteps'] }) } } })
  await handoff($, eng)
  expect(eng.commands).toEqual([])
  expect(eng.submitted.at(-1)).toContain('readFirst')

  eng.files[HANDOFF] = { realPath: HANDOFF, text: card({ items: ['startHere', 'readFirst'], detail: ['goal', 'nextSteps'] }) }
  await $.turn.complete(reported(HANDOFF))
  await eng.clock.advance(1)
  expect(eng.commands).toEqual(['clear'])
})

test('checkItems：標題有但沒內容 → 算缺', async ($: any, on: any) => {
  const text = card({ items: ['startHere', 'readFirst'], detail: ['goal', 'nextSteps'] }).replace('readFirst 的內容', '  ')
  const eng = fakeEngine(on, { percent: 61, ini: SAMPLE_INI, files: { [HANDOFF]: { realPath: HANDOFF, text } } })
  await handoff($, eng)
  expect(eng.commands).toEqual([])
  expect(eng.submitted.at(-1)).toContain('readFirst')
})

test('checkItemDetail：缺列出的子項 → 不放行；沒列的子項（stoppedAt）缺了不管', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: SAMPLE_INI, files: { [HANDOFF]: { realPath: HANDOFF, text: card({ items: ['startHere', 'readFirst'], detail: ['goal'] }) } } })
  await handoff($, eng)
  expect(eng.commands).toEqual([])
  expect(eng.submitted.at(-1)).toContain('nextSteps')
})

// ---- 字數 ----

const chars = (text: string) => text.replace(/\s/g, '').length

test('maxChars 預設 500：超過 → 不放行，提醒精簡並說出字數', async ($: any, on: any) => {
  const text = card({ extraLines: { readFirst: 40 } })
  expect(chars(text)).toBeGreaterThan(500)
  const eng = fakeEngine(on, { percent: 61, files: { [HANDOFF]: { realPath: HANDOFF, text } } })
  await handoff($, eng)
  expect(eng.commands).toEqual([])
  expect(eng.submitted.at(-1)).toContain(`${chars(text)} 字`)
  expect(eng.submitted.at(-1)).toContain('500')
})

// 不合格原因全部列出，不是只講第一個，Claude 才知道要改什麼。
test('不合格原因全部列出：缺 project、缺項目、超過字數一起講', async ($: any, on: any) => {
  const text = card({ project: null, items: ['startHere'], extraLines: { startHere: 70 } })
  expect(chars(text)).toBeGreaterThan(500)
  const eng = fakeEngine(on, { percent: 61, ini: 'checkItems = startHere, readFirst', files: { [HANDOFF]: { realPath: HANDOFF, text } } })
  await handoff($, eng)
  const msg = eng.submitted.at(-1)
  expect(msg).toContain('project')
  expect(msg).toContain('readFirst')
  expect(msg).toContain('超過上限 500 字')
})

test('maxChars：交接指示寫明字數上限；預設的交接卡在上限內', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61 })
  await finish($, eng, '做完一步')
  expect(eng.submitted[0]).toContain('500 字')
  expect(chars(card())).toBeLessThanOrEqual(500)
})

test('maxChars = 0：不限制字數', async ($: any, on: any) => {
  const text = card({ extraLines: { readFirst: 40 } })
  const eng = fakeEngine(on, { percent: 61, ini: 'maxChars = 0', files: { [HANDOFF]: { realPath: HANDOFF, text } } })
  await handoff($, eng)
  expect(eng.commands).toEqual(['clear'])
})

test('maxChars 寫錯：照預設 500', async ($: any, on: any) => {
  const text = card({ extraLines: { readFirst: 40 } })
  const eng = fakeEngine(on, { percent: 61, ini: 'maxChars = abc', files: { [HANDOFF]: { realPath: HANDOFF, text } } })
  await handoff($, eng)
  expect(eng.commands).toEqual([])
})

test('checkItems 寫了沒有段落的名稱：照樣檢查，log 提醒', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: 'checkItems = fooo' })
  await handoff($, eng)
  expect(eng.commands).toEqual([])
  expect(eng.logs.join('\n')).toContain('fooo')
})

test('不是英文的大項、子項名稱：略過並寫 log', async ($: any, on: any) => {
  const ini = ['[主旨]', 'desc = x', '[readFirst]', '先讀 = x', 'goal = 主旨'].join('\n')
  const eng = fakeEngine(on, { percent: 61, ini })
  await finish($, eng, '做完一步')
  expect(eng.submitted[0]).not.toContain('## 主旨')
  expect(eng.submitted[0]).not.toContain('- 先讀：')
  expect(eng.submitted[0]).toContain('- goal：主旨')
  expect(eng.logs.join('\n')).toContain('要用英文名稱')
})

// ---- INI 讀取 ----

test('改 INI 不用重啟：下一輪就照新門檻', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 70, ini: 'threshold = 80' })
  await finish($, eng, '做完一步')
  expect(eng.submitted).toEqual([])
  eng.state.ini = 'threshold = 65'
  await finish($, eng, '又做完一步')
  expect(eng.submitted.length).toBe(1)
})

test('threshold 寫錯：照預設 60', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: 'threshold = abc' })
  await finish($, eng, '做完一步')
  expect(eng.submitted.length).toBe(1)
})

test('INI 開頭有 BOM：照樣讀得到', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: '\uFEFFuserName = Alex' })
  await finish($, eng, '做完一步')
  expect(eng.submitted[0]).toContain('Alex')
})

// ---- handoffDir：INI 只寫資料夾，確切路徑由該任務的 Claude 回報；要在資料夾裡面才放行 ----

const ROOT = r`C:\Users\T\handoffs` + '\\'
const ROOT_INI = `handoffDir = ${ROOT}`
const ROOT_DIR = { [ROOT]: r`C:\Users\T\handoffs` }
const INSIDE = r`C:\Users\T\handoffs\2026-10-15\demo\HANDOFF.md`
const at = (path: string, realPath = path): Record<string, File> => ({ [path]: { realPath, text: card() } })

test('handoffDir：在資料夾裡面 → 放行；指示寫明放在資料夾底下', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: ROOT_INI, dirs: ROOT_DIR, files: at(INSIDE) })
  await handoff($, eng, INSIDE)
  expect(eng.submitted[0]).toContain(`放在 ${ROOT} 底下本任務的資料夾`)
  expect(eng.commands).toEqual(['clear'])
})

test('handoffDir：不在資料夾裡面 → 不放行', async ($: any, on: any) => {
  const outside = r`D:\other\HANDOFF.md`
  const eng = fakeEngine(on, { percent: 61, ini: ROOT_INI, dirs: ROOT_DIR, files: at(outside) })
  await handoff($, eng, outside)
  expect(eng.commands).toEqual([])
  expect(eng.submitted.at(-1)).toContain(`交接檔要放在 ${ROOT} 底下`)
})

test('handoffDir：用 .. 繞出去 → 照真實路徑判斷，不放行', async ($: any, on: any) => {
  const sneaky = r`C:\Users\T\handoffs\..\x\HANDOFF.md`
  const eng = fakeEngine(on, { percent: 61, ini: ROOT_INI, dirs: ROOT_DIR, files: at(sneaky, r`C:\Users\T\x\HANDOFF.md`) })
  await handoff($, eng, sneaky)
  expect(eng.commands).toEqual([])
})

test('handoffDir：名字開頭一樣的隔壁資料夾（handoffsX）不算裡面', async ($: any, on: any) => {
  const neighbour = r`C:\Users\T\handoffsX\HANDOFF.md`
  const eng = fakeEngine(on, { percent: 61, ini: ROOT_INI, dirs: ROOT_DIR, files: at(neighbour) })
  await handoff($, eng, neighbour)
  expect(eng.commands).toEqual([])
})

test('handoffDir：大小寫、斜線寫法不同但真的在裡面 → 放行', async ($: any, on: any) => {
  const spelled = 'c:/users/t/handoffs/2026-10-15/demo/HANDOFF.md'
  const eng = fakeEngine(on, { percent: 61, ini: ROOT_INI, dirs: ROOT_DIR, files: at(spelled, INSIDE) })
  await handoff($, eng, spelled)
  expect(eng.commands).toEqual(['clear'])
})

test('handoffDir：INI 寫的資料夾不存在 → 不放行，log 說明', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: ROOT_INI, files: at(INSIDE) })
  await handoff($, eng, INSIDE)
  expect(eng.commands).toEqual([])
  expect(eng.logs.join('\n')).toContain('handoffDir')
})

test('鎖＋handoffDir：交接中只能寫 handoffDir 底下的 HANDOFF.md', async ($: any, on: any) => {
  const eng = fakeEngine(on, { percent: 61, ini: ROOT_INI, dirs: ROOT_DIR, files: at(INSIDE) })
  await finish($, eng, '做完一步')
  expect(denied(await $.tool.call({ tool: 'Write', file_path: INSIDE, content: 'x' }))).toBe('')
  expect(denied(await $.tool.call({ tool: 'Write', file_path: r`D:\other\HANDOFF.md`, content: 'x' }))).toContain('工具已鎖')
})
