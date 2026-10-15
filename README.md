# context-auto-handoff

Claude Code 的 mod：**對話的 context 快滿時，自動寫交接卡、開新對話接手**，不用等 Claude Code 自動壓縮把細節摘要掉。

舊對話不會刪掉，還留在 session 清單裡，隨時可以點回去看。

---

## 它會做什麼

```
context 用到門檻（預設 60%）
        │
        ▼
mod 叫 Claude 停手 ──► 工具鎖住，只能讀檔、寫交接卡、git commit
        │
        ▼
Claude 先 commit 改到一半的東西，再寫 HANDOFF.md（交接卡）
        │
        ▼
mod 檢查交接卡 ──不合格──► 列出全部原因，叫 Claude 改（預設最多提醒 3 次）
        │
       合格
        ▼
mod 自動 /clear，新對話收到「讀 <交接卡路徑> 續做」，接著做
```

- **不會讓 Claude 邊交接邊做別的事**：交接期間其他工具都會被擋下。
- **不合格一定說原因**：缺哪一項、字數超過多少、放錯資料夾，全部列給 Claude。
- **什麼都可以設定**：門檻、交接時機、交接卡要寫哪些項目、哪些要檢查、字數上限，都寫在一個 INI 檔裡；不設定也能直接用。

---

## 需求

- Claude Code **2.1.287 以上**（mod 功能從這版開始）
- 實測環境：**Windows 11 ＋ VS Code 的 Claude Code 擴充套件**
- 終端機版、桌面 App、macOS／Linux 應該也能用，但**還沒實測**（見「測試狀態」）

---

## 安裝

### 1. 下載到 mods 資料夾

Windows（PowerShell）：

```powershell
git clone https://github.com/AmiTu1020/mods-context-auto-handoff-public.git "$env:USERPROFILE\.claude\mods\context-auto-handoff"
```

macOS／Linux（未實測）：

```bash
git clone https://github.com/AmiTu1020/mods-context-auto-handoff-public.git ~/.claude/mods/context-auto-handoff
```

### 2. 在全域設定指定 mod 位置

打開 `<家目錄>\.claude\settings.json`，加上 `env`（已經有 `env` 就把這一行加進去）。路徑換成你的使用者名稱，用 `/` 寫：

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:/Users/<你的使用者名稱>/.claude/mods/context-auto-handoff"
  }
}
```

> ⚠️ 一定要寫在**家目錄的** `.claude\settings.json`。寫在專案資料夾的 `.claude\settings.json` 不會生效（Claude Code 只從全域設定讀這一項）。

### 3. 重新啟動 Claude

- **VS Code**：`Ctrl+Shift+P` → **Developer: Restart Extension Host**（或 **Developer: Reload Window**）。
  修改 mod 不會跳出「Restart Extensions」按鈕，要用這個指令。
- **終端機**：結束 `claude` 再重新開。

### 4. 確認裝好了

開一個不重要的對話，打 `/handoff` 按 Enter：

- 出現「已排入交接：Claude 先寫交接卡，接著清空對話、由新對話接手。」→ 裝好了。
- 不想真的交接，接著打 `/handoff cancel` 取消就好。

> VS Code 的 `/` 選單**不會列出** `/handoff`，直接把整個指令打完送出就可以用。

### 更新與移除

- **更新**：在 mod 資料夾執行 `git pull`，再重新啟動 Claude。
- **移除**：拿掉 `settings.json` 裡那一行、刪掉 mod 資料夾，再重新啟動 Claude。

---

## 用法

| 指令 | 作用 |
|---|---|
| （不用做任何事） | context 用到門檻時自動交接 |
| `/handoff` | 不等門檻，現在就交接 |
| `/handoff cancel` | 取消正在進行的交接、解鎖工具；這個對話之後不再自動交接 |

---

## 設定（選用）

不設定也能用，全部照預設。要調整的話，把 [`context-auto-handoff.example.ini`](context-auto-handoff.example.ini) 複製成：

```
<家目錄>\.claude\context-auto-handoff.ini
```

再照需要修改。**每次檢查都會重新讀這個檔，改完下一輪就生效，不用重啟**。存成 UTF-8（有沒有 BOM 都可以）；路徑直接寫，反斜線不用寫兩次。**沒寫的項目一律用預設值**。

### `[handoff]`：整體設定

| 項目 | 意思 | 預設 |
|---|---|---|
| `threshold` | context 用到幾 % 算滿（1～100） | `60` |
| `contextFullTrigger` | 滿了之後什麼時候交接：`1`＝now（下一個動作前就攔下）、`2`＝turnEnd（這一輪回答完）、`3`＝nextMessage（等你下一則訊息，先交接、再把那則訊息交給新對話） | `2` |
| `userName` | 交接卡裡怎麼稱呼你 | `使用者` |
| `handoffDir` | 交接卡**一定要**放在這個資料夾裡面（mod 會照真實路徑檢查） | 不限制 |
| `maxChars` | 整份交接卡最多幾個字（不算空白；`0`＝不限制） | `500` |
| `retryTimes` | 交接卡不合格時，自動提醒 Claude 重寫幾次 | `3` |
| `checkItems` | 要檢查的大項（逗號分隔） | 不檢查 |

### 其他段落：交接卡的項目

除了 `[handoff]`，**每個段落就是交接卡的一個大項**，段落名稱用英文：

```ini
[startHere]
desc = ★ 先接這件
checkItemDetail = goal, nextSteps
goal = 主旨（{userName} 原話）
stoppedAt = 停在哪
nextSteps = 接下來（依序）

[readFirst]
desc = 先讀（依序）
```

- `desc`：這一項要寫什麼，給 Claude 看的說明（可以不寫）。
- `checkItemDetail`：這個大項裡要檢查的子項（逗號分隔）。沒寫這行就不檢查子項。
- 其他 `名稱 = 說明`：都是子項，交接卡上寫成 `- 名稱：內容`。
- `{userName}` 會換成你設定的稱呼。
- 名稱要用英文（英文字母開頭，可含數字、`_`、`-`），不是英文的會被略過並寫 log。

**「寫」跟「檢查」是分開的**：段落裡定義的項目，Claude 都會寫進交接卡；只有列在 `checkItems`／`checkItemDetail` 的才會被檢查（要有，而且有內容）。所以你可以先定義很多項目，只檢查其中幾項，不用的不必刪。

INI 裡沒有任何大項段落時，用預設的這一組（不檢查）：

| 大項 | 說明 | 子項 |
|---|---|---|
| `startHere` | ★ 先接這件 | goal、taskFolder、stoppedAt、committed、uncommitted、nextSteps |
| `readFirst` | 先讀（依序） | — |
| `constraints` | 不可偏離／不做 | — |
| `corrections` | 跟 {userName} 互動（這次被指正的） | — |
| `waitingOn` | 等 {userName} 一句話 | — |

---

## 交接卡長什麼樣子

```markdown
# login-remember-me 交接（2026-10-20 14:30，context 62%）
- project：my-web-app（C:\Users\me\projects\my-web-app）
## startHere
- goal：「登入頁加一個記住我，勾了 30 天內不用再登入」
- taskFolder：C:\Users\me\work\2026-10-20\login-remember-me
- stoppedAt：前端勾選框做完，後端 token 有效期還沒改
- committed：a1b2c3d（feat: 登入頁加記住我勾選框）
- uncommitted：無
- nextSteps：改 auth/token.ts 的有效期 → 補測試 → 請人 review
## readFirst
plan.md、auth/token.ts
## constraints
不改註冊流程
## corrections
有效期是 30 天，不是 7 天
## waitingOn
無
```

### 一定會檢查的（不用設定）

1. **交接卡檔案真的存在**（設了 `handoffDir` 的話，還要真的在那個資料夾裡面；用 `..` 繞出去、名字只差一點的隔壁資料夾都不算）。
2. **第一個 `##` 前面有 project 那一行**：`- project：<repo 名稱，不是 git repo 就寫「無」>（<VS Code 專案資料夾>）`。括號裡的資料夾由 mod 告訴 Claude，也會核對（不分大小寫、斜線方向）。
3. **字數**不超過 `maxChars`。

其他項目照 `checkItems`／`checkItemDetail` 檢查。

---

## 交接期間的鎖

交接一開始，到對話清空之前，Claude 只能：

| ✅ 可以 | ❌ 會被擋 |
|---|---|
| 讀檔、搜尋（Read、Grep、Glob） | 改其他檔案 |
| 寫或改 `HANDOFF.md`（設了 `handoffDir` 要在裡面） | 跑其他指令（包括 `git push`） |
| `git add`、`git commit`、`git status`、`git diff`、`git log`、切換資料夾 | 開 subagent 等其他工具 |

被擋時，Claude 會收到說明：「交接中，工具已鎖：…先把交接卡寫好；要取消請打 /handoff cancel」。

> 限制：mod 是看指令的文字判斷。把指令包進腳本檔再執行的話，mod 看不出來。

---

## 交接卡不合格時

mod 會把**所有**原因一次列給 Claude，例如：

```
【交接】交接檔沒過檢查｜缺少「- project：…」這一行；缺少項目：readFirst、startHere.nextSteps；
交接卡 612 字，超過上限 500 字，請精簡。改好後，回覆最後一行只寫「交接檔：<HANDOFF.md 完整路徑>」，然後停手。
```

- 照 `retryTimes` 自動提醒（預設 3 次）。
- 提醒用完還是不合格：**停止自動提醒，但工具保持鎖住、不清空對話**，等你處理。你可以直接跟 Claude 說哪裡要改，或打 `/handoff cancel` 取消。

---

## 測試狀態

| 項目 | 狀態 |
|---|---|
| `contextFullTrigger = 2`（turnEnd，預設） | ✅ Windows 11 ＋ VS Code 實測：76% 自動交接、新對話接手成功 |
| `/handoff` 手動交接 | ✅ Windows 11 ＋ VS Code 實測 |
| 項目檢查、字數、`handoffDir`、鎖、提醒次數 | ✅ 自動測試（37 項）；Windows 11 ＋ VS Code 載入確認 |
| `contextFullTrigger = 1`（now） | ⚠️ **已實作、還沒實測** |
| `contextFullTrigger = 3`（nextMessage） | ⚠️ **已實作、還沒實測** |
| 終端機版、桌面 App、macOS／Linux | ⚠️ **還沒實測** |

**有問題請開 [Issue](https://github.com/AmiTu1020/mods-context-auto-handoff-public/issues) 回報 bug**，附上：你的系統、Claude Code 版本、`contextFullTrigger` 設定、發生了什麼。

---

## 已知行為

- 自動交接**每個對話只觸發一次**；打過 `/handoff cancel` 的對話不會再自動觸發（`/handoff` 還是可以用）。
- 新對話開在**同一個專案**裡；舊對話在 session 清單（VS Code：Claude 面板右上角的時鐘圖示）。
- mod 送出的訊息前面會被加上「The context-auto-handoff plugin sent a message:」，這是 Claude Code 的正常行為。
- 改 INI 立刻生效；改 mod 程式要重新啟動 Claude。

## 疑難排解

| 狀況 | 檢查 |
|---|---|
| 打 `/handoff` 說找不到指令 | Claude Code 版本 ≥ 2.1.287？`env` 寫在**家目錄**的 `settings.json`？路徑對嗎？有重新啟動嗎？ |
| 到門檻沒有交接 | 這個對話是不是已經交接過或 cancel 過？INI 的 `threshold` 是多少？ |
| 一直卡在「交接檔沒過檢查」 | 看提醒裡列的原因；設了 `handoffDir` 的話，那個資料夾要存在 |
| INI 改了沒效果 | 名稱要用英文；數字超出範圍會用預設值 |

---

## 開發

```bash
claude plugin validate <mod 資料夾>
claude plugin test <mod 資料夾>
```

規格：[docs/context-auto-handoff-spec.md](docs/context-auto-handoff-spec.md)

## 授權

[MIT](LICENSE)
