# context-auto-handoff 規格

## 目的
- Claude Code 的對話 context 用到門檻時，不靠自動壓縮，而是讓 Claude 寫一張交接卡、開新對話接手，舊對話留在 session 清單裡。
- 交接卡的項目、檢查規則、門檻、時機都由使用者的 INI 決定；程式裡不放任何人的路徑、名字、規則。
- 交接卡不合格就不放行，並且說清楚哪裡不合格，讓 Claude 知道要改什麼。
- 交接期間 Claude 不能繼續做別的事，只能做寫交接卡需要的動作。

## 行為
1. **觸發**：context 用到 `threshold`% 算滿（每輪讀 `$.session.usage().context.percent`）。滿了之後依 `contextFullTrigger`：
   - 1＝now：下一個工具呼叫前擋下，擋的理由就是交接指示（這一輪若沒有工具呼叫，回答完照 turnEnd）。
   - 2＝turnEnd（預設）：這一輪回答完，送出交接回合。
   - 3＝nextMessage：先不打斷；使用者下一則訊息被換成交接指示，原訊息保留，交接後連同「讀 … 續做」交給新對話。
   每個對話自動觸發一次；`/handoff cancel` 之後這個對話不再自動觸發。
2. **交接指示**：停止施工；工具已鎖；有 worktree 且有未 commit 的改動先 commit；在 handoffDir 底下本任務的資料夾寫 HANDOFF.md；
   字數上限；只寫還沒做完的；格式＝固定的 project 行＋INI 定義的大項（`## 名稱`）與子項（`- 名稱：內容`）；回覆最後一行「交接檔：<完整路徑>」。
3. **鎖**：交接開始到清空對話前，工具只放行 Read／Grep／Glob、寫 HANDOFF.md（有 handoffDir 時要在底下）、
   每一段都是 `git add|commit|status|diff|log`（或切資料夾）的指令；其他一律擋下並說明。只看指令字串，包進腳本檔的指令看不出來。
4. **檢查**（不合格原因全部列出）：
   - 交接卡存在（`$.fs.stat` resolve）；有 handoffDir 時真實路徑要在該資料夾底下，資料夾不存在也不放行。
   - 第一個 `##` 前要有 `- project：<repo 專案名>（<VS Code 專案資料夾>）`，括號內等於 `$.session.root()`（不分大小寫、斜線方向）。
   - `checkItems` 列的大項要有標題和內容；`checkItemDetail` 列的子項要有 `- 名稱：內容`。
   - 不算空白的字數 ≤ `maxChars`（0＝不限）。
5. **不合格**：照 `retryTimes` 提醒 Claude（附全部原因）；用完就停止提醒，跳訊息，工具仍鎖、不清空，等使用者處理。
6. **合格**：`/clear` → 送出「讀 <路徑> 續做」（nextMessage 模式附上保留的訊息）。
7. **指令**：`/handoff` 手動交接；`/handoff cancel` 取消交接並解鎖（nextMessage 模式被換掉的訊息送回去照常處理）。

## 設定（INI）
- 位置：`<家目錄>\.claude\context-auto-handoff.ini`（家目錄取 `USERPROFILE`，沒有再取 `HOME`）。範例：`context-auto-handoff.example.ini`。
- `[handoff]`：`threshold`（1～100，60）、`contextFullTrigger`（1～3，2）、`userName`（使用者）、`handoffDir`（不限）、
  `maxChars`（≥0，500）、`retryTimes`（≥0，3）、`checkItems`（逗號分隔，不檢查）。
- 其他段落＝大項（英文名稱）：`desc` 說明、`checkItemDetail` 要檢查的子項、其他 `名稱 = 說明` 是子項；`{userName}` 換成稱呼。
  INI 沒有大項段落時用預設組：startHere（goal、taskFolder、stoppedAt、committed、uncommitted、nextSteps）、readFirst、constraints、corrections、waitingOn。
- 沒寫用預設；值不合法、名稱不是英文、checkItems／checkItemDetail 對不到定義：照預設或略過，寫 log。
- 每次用到都重讀，改了下一輪生效。格式：`key = value`；`;`、`#` 開頭是註解；開頭 BOM 略過；值照原樣。

## 安裝
- `~/.claude/settings.json` 的 `env.CLAUDE_CODE_PLUGIN_DIRS` 指向 mod 資料夾。只認全域設定，不讀專案的 `.claude/settings.json`。
- 改程式後要重新啟動 Claude 程式才生效；改 INI 不用。

## 已知行為（Windows 11 ＋ VS Code 擴充套件實測與探測）
- VS Code 的 `/` 選單可能不列 `/handoff`；打完整指令可以用。
- 引擎在 mod 送出的提示前加「The context-auto-handoff plugin sent a message:」。
- mod 的指令 hook 裡不能直接送提示（會等自己那一輪），改用計時器送。
- 引擎傳給 `$.fs` 的路徑會先統一：「/」換成「\」、拿掉結尾的「\」。
