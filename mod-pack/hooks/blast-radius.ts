// Blast Radius: hold a risky shell command until the person presses Proceed or Cancel.
//
// Pure: no `$` here. This file holds the rule table that says whether a command is
// risky, the planning of the read-only preview, and the text of the dialog. The
// engine calls (`$.ui.ask`, `$.process.run`, `$.fs.*`) are all in register.tsx,
// which hands this file plain data and gets plain data back.
//
// ponytail: a safety net, not a permission system. This is a regex table over the
// command text. It does NOT catch: an alias, a script that calls rm, a command
// built from variables (`rm -rf "$DIR"`, `eval "$cmd"`), or other quoting tricks.
// It splits on `&&`, `||`, `;`, `|`, `&` and newlines and also inside quotes, so
// `echo "a; rm -rf x"` is a false positive. That is acceptable. `echo "rm -rf x"`
// and `grep rm -rf README` are NOT held: a rule matches only at the start of a segment.

import { defineFeature } from './feature'

// The Feature entry. It has no callbacks: the dispatcher reads only its id, text and
// default, for `/mods` and for the on/off check. The guard itself is the `tool.call`
// hook in register.tsx. It makes no model call, so it costs no tokens.
export const blastRadius = defineFeature<never>({
  id: 'blast-radius',
  title: 'Blast Radius',
  about: 'asks Proceed or Cancel before a risky shell command (rm -rf, git reset --hard, git push --force, ...); costs no model tokens',
  usesModel: false,
  defaultOn: true,
})

// ---- The rule table -------------------------------------------------------------

export type PreviewKind = 'status-all' | 'status-worktree' | 'clean' | 'push' | 'branch' | 'stash' | 'paths'

export type Rule = {
  kind: string
  title: string
  // Tested on one segment, after the prefix (sudo, env vars, ...) is removed.
  regex: RegExp
  // When this also matches, the segment is NOT held (a dry run, a staged-only restore).
  unless?: RegExp
  // How the person is shown what would change.
  preview: PreviewKind
}

// Pieces of the patterns.
const ARGS = String.raw`(?:\s+\S+)*?` // any words between the command and the flag
const END = String.raw`(?=\s|$)` // the end of a word
// `git`, then global options (`-C dir`, `-c k=v`, `--no-pager`), then a space.
const GIT = String.raw`^git(?:\.exe)?(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+`

const re = (source: string, flags = '') => new RegExp(source, flags)

export const RULES: readonly Rule[] = [
  // Delete. `rm -f file` and `rm file` (no recursion) are NOT held: one named file at a time.
  { kind: 'rm-recursive', title: '整個資料夾刪除（rm -r）', preview: 'paths',
    regex: re(String.raw`^(?:\S*[\\/])?rm(?:\.exe)?${ARGS}\s+(?:-[fiIrRdv]*[rR][fiIrRdv]*|--recursive)${END}`) },
  { kind: 'rmdir-windows', title: '整個資料夾刪除（rmdir /s）', preview: 'paths',
    regex: re(String.raw`^(?:rmdir|rd)${ARGS}\s+/s(?=[\s/]|$)`, 'i') },
  { kind: 'del-windows', title: '整個資料夾刪除（del /s）', preview: 'paths',
    regex: re(String.raw`^(?:del|erase)${ARGS}\s+/s(?=[\s/]|$)`, 'i') },
  { kind: 'remove-item', title: '整個資料夾刪除（Remove-Item -Recurse）', preview: 'paths',
    regex: re(String.raw`^(?:remove-item|ri|rm|del|erase|rd|rmdir)${ARGS}\s+-r[a-z]*(?=[\s:]|$)`, 'i') },

  // Git: discards work that has no copy.
  { kind: 'git-reset-hard', title: 'git reset --hard（丟掉還沒 commit 的修改）', preview: 'status-all',
    regex: re(String.raw`${GIT}reset${ARGS}\s+--hard${END}`) },
  { kind: 'git-clean', title: 'git clean（刪掉沒被 git 追蹤的檔案）', preview: 'clean',
    regex: re(String.raw`${GIT}clean${ARGS}\s+(?:-[a-zA-Z]*[fdxX][a-zA-Z]*|--force)${END}`),
    unless: re(String.raw`\s(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)${END}`) },
  // `--force-with-lease` is held too: it is safer, but it still overwrites remote history.
  { kind: 'git-push-force', title: 'git push --force（覆蓋遠端的歷史）', preview: 'push',
    regex: re(String.raw`${GIT}push${ARGS}\s+(?:-[a-zA-Z]*f[a-zA-Z]*|--force(?:-with-lease|-if-includes)?(?:=\S+)?|\+[^\s+]\S*)${END}`) },
  { kind: 'git-discard-checkout', title: 'git checkout -- .（丟掉工作中的修改）', preview: 'status-worktree',
    regex: re(String.raw`${GIT}checkout${ARGS}\s+(?:--\s+)?(?:\.|:/)${END}`) },
  { kind: 'git-discard-restore', title: 'git restore .（丟掉工作中的修改）', preview: 'status-worktree',
    regex: re(String.raw`${GIT}restore${ARGS}\s+(?:--\s+)?(?:\.|:/)${END}`),
    // `--staged` alone only unstages. With `--worktree` it also discards.
    unless: re(String.raw`^(?=.*\s(?:--staged|-S)${END})(?!.*\s(?:--worktree|-W)${END})`) },
  { kind: 'git-branch-delete', title: 'git branch -D（強制刪除分支）', preview: 'branch',
    regex: re(String.raw`${GIT}branch${ARGS}\s+-[a-zA-Z]*D[a-zA-Z]*${END}`) },
  { kind: 'git-stash-drop', title: 'git stash drop／clear（刪掉暫存起來的修改）', preview: 'stash',
    regex: re(String.raw`${GIT}stash\s+(?:drop|clear)${END}`) },
]

// ---- Classifier -------------------------------------------------------------------

// Where one command ends and the next begins. `$(` and a backtick start a nested command.
export const SEPARATORS = /&&|\|\||[;|\n\r`]|\$\(|(?<![0-9>&])&(?![&>])/

// What may stand before the real command word: grouping, `!`, VAR=value, sudo, env,
// xargs, time, a backslash that skips an alias, and the shell wrappers `sh -c '...'`,
// `eval '...'`, `cmd /c ...`, `powershell -Command '...'`.
const PREFIX = new RegExp(
  String.raw`^\s*(?:` +
    String.raw`[({!]\s*|\\|[A-Za-z_]\w*=\S*\s+|` +
    String.raw`(?:sudo|doas)(?:\s+(?:-[ughCpUrtT]\s+\S+|-\S+))*\s+|` +
    String.raw`(?:command|builtin|exec|nohup|time|nice|xargs|env)(?:\s+(?:-[IdEeLnPsaui]\s+\S+|-\S+))*\s+|` +
    String.raw`(?:(?:ba|z|da)?sh|eval)(?:\s+-c)?\s+["']?|` +
    String.raw`cmd(?:\.exe)?\s+/[ck]\s+["']?|` +
    String.raw`(?:powershell|pwsh)(?:\.exe)?(?:\s+-\S+)*?\s+-c(?:ommand)?\s+["']?` +
    String.raw`)`,
  'i',
)

export const stripPrefix = (segment: string) => {
  let rest = segment
  while (PREFIX.test(rest)) rest = rest.replace(PREFIX, '')
  return rest.trim()
}

export type Risk = {
  kind: string
  title: string
  preview: PreviewKind
  // The segment as the rule saw it (prefix removed).
  segment: string
  // True when an earlier segment of the command changed directory (`cd x && rm -rf y`).
  // A relative path is then not resolved against the session folder.
  hasCd: boolean
}

const CHANGES_DIRECTORY = /^(?:cd|pushd|chdir|set-location|sl)(?:\s|$)/i

// Every risky segment of `command`, in order. An empty list means: not held.
export const classify = (command: string): Risk[] => {
  const risks: Risk[] = []
  let hasCd = false
  for (const raw of command.split(SEPARATORS)) {
    const segment = stripPrefix(raw)
    if (!segment) continue
    const rule = RULES.find(r => r.regex.test(segment) && !r.unless?.test(segment))
    if (rule) risks.push({ kind: rule.kind, title: rule.title, preview: rule.preview, segment, hasCd })
    if (CHANGES_DIRECTORY.test(segment)) hasCd = true
  }
  return risks
}

// ---- Preview plans: what to read, from the segment's own words --------------------

export const MAX_SHOWN = 10 // paths shown in a list
export const ENTRY_CAP = 1000 // entries counted in a directory, in total
export const MAX_PATHS = 8 // plain paths looked at for one rm
export const MAX_RISKS_PREVIEWED = 3
export const STEP_TIMEOUT_MS = 3000 // for each `git` call
export const OUTPUT_CAP = 200_000 // characters of git output read
export const NO_PREVIEW = '無法預覽'

// The `git` the previews run. Read only, argv (no shell). The command's own global
// options (`-C`, `-c`) are NOT passed on: a `-c core.fsmonitor=...` would run code
// before the person said yes.
export const GIT_READ = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false'] as const

const unquote = (token: string) => token.replace(/^["']|["')]+$/g, '')
export const words = (segment: string) => (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote)

// `git <sub> <args...>`. Undefined when global options stand before the subcommand:
// the previews do not follow `-C` or `--git-dir`.
export const gitArgs = (segment: string, sub: string): string[] | undefined => {
  const all = words(segment)
  return /^git(?:\.exe)?$/.test(all[0] ?? '') && all[1] === sub ? all.slice(2) : undefined
}

// True when global options (`-C dir`, `-c k=v`) stand between `git` and the subcommand.
export const hasGitOptions = (segment: string) => !/^git(?:\.exe)?\s+[a-z]/.test(segment)

export const SAFE_NAME = /^[\w.\/-]+$/

// `git clean -fd` -> ['clean', '-n', '-d']: the same flags, and `-n` for a dry run.
export const cleanDryRun = (segment: string): string[] | undefined => {
  const args = gitArgs(segment, 'clean')
  if (!args || args.some(a => /[$%]/.test(a))) return undefined
  const kept = args.flatMap(a => {
    if (a === '--force' || a === '--interactive' || a === '--dry-run') return []
    if (/^-[a-zA-Z]+$/.test(a)) {
      const letters = a.slice(1).replace(/[fniq]/g, '')
      return letters ? [`-${letters}`] : []
    }
    return [a]
  })
  return ['clean', '-n', ...kept]
}

export type PushPlan = { range?: string; note?: string }

// Which commits does the force push drop? The ones the remote branch has and the
// local branch has not: `local..remote`.
export const pushPlan = (segment: string): PushPlan => {
  const args = gitArgs(segment, 'push')
  if (!args) return { note: '指令裡的 git 選項（例如 -C）沒有納入檢查' }
  const places = args.filter(a => !a.startsWith('-')).map(a => a.replace(/^\+/, ''))
  if (places.length <= 1) return { range: 'HEAD..@{u}' }
  const [remote = '', branch = ''] = places
  if (places.length === 2 && /^[\w.-]+$/.test(remote) && SAFE_NAME.test(branch) && !branch.startsWith('-')) {
    return { range: `${branch}..${remote}/${branch}` }
  }
  return { note: `推送目標「${places.join(' ')}」不是單純的「遠端 分支」寫法，所以沒有計算會消失幾個 commit` }
}

// Names after `git branch -D`: at most 3, plain names only.
export const branchTargets = (segment: string): string[] =>
  (gitArgs(segment, 'branch') ?? []).filter(a => !a.startsWith('-') && SAFE_NAME.test(a)).slice(0, 3)

export type PathArgs = { paths: string[]; skipped: string[] }

// Flags of Remove-Item that take a value which is not a path.
const VALUE_FLAGS = /^-(?:include|exclude|filter|credential|stream)$/i

// The plain path arguments of a delete command. A glob, a variable or `~` cannot be
// resolved here and is listed as skipped.
export const pathArgs = (segment: string): PathArgs => {
  const tokens = words(segment).slice(1)
  const paths: string[] = []
  const skipped: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    if (VALUE_FLAGS.test(token)) i++
    else if (token === '' || token.startsWith('-') || /^\/[a-zA-Z]$/.test(token) || /^\d*[<>]/.test(token)) continue
    else if (/[*?[\]$%`{}]|^~/.test(token)) skipped.push(token)
    else paths.push(token)
  }
  return { paths, skipped }
}

const isAbsolute = (path: string) => /^(?:[A-Za-z]:)?[\\/]/.test(path)

// A relative path belongs to the session folder. `cwd` joins with `/`, which Windows accepts too.
export const resolvePath = (cwd: string, path: string) => (isAbsolute(path) ? path : `${cwd.replace(/[\\/]+$/, '')}/${path}`)

// ---- Preview text -----------------------------------------------------------------

// What a git read returned. `undefined` (not this type): the step could not run or ran out of time.
export type GitOut = { ok: boolean; text: string; isCut: boolean }
type Out = GitOut | undefined

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const lines = (out: Out) => (out?.ok ? out.text.split(/\r?\n/).filter(Boolean) : undefined)
const more = (n: number) => (n > 0 ? [`  ……還有 ${n} 項沒列出`] : [])
const countText = (n: number, isCut: boolean) => (isCut ? `${n}+` : String(n))
const list = (items: readonly string[]) => [...items.slice(0, MAX_SHOWN).map(i => `  ${i}`), ...more(items.length - MAX_SHOWN)]

export const NO_GIT_PREVIEW = `${NO_PREVIEW}（這裡不是 git 資料夾、沒有安裝 git，或讀取 git 失敗）`

// `git status --porcelain` lines are `XY path`: X the index, Y the work tree.
// `scope` 'worktree' counts only what `checkout -- .` / `restore .` would discard.
export const previewStatus = (status: Out, shortstat: Out, scope: 'all' | 'worktree'): string[] => {
  const all = lines(status)
  if (!all || !status) return [NO_GIT_PREVIEW]
  const untracked = all.filter(l => l.startsWith('??')).length
  const tracked = all.filter(l => !l.startsWith('??') && !l.startsWith('!!') && (scope === 'all' || (l[1] ?? ' ') !== ' '))
  const out: string[] = []
  if (tracked.length === 0) {
    out.push(scope === 'all' ? '沒有還沒 commit 的修改會被丟掉。' : '沒有還沒 git add 的修改會被丟掉。')
  } else {
    out.push(`有 ${countText(tracked.length, status.isCut)} 個檔案的修改會被蓋掉（${scope === 'all' ? '還沒 commit' : '還沒 git add'}；下面每行是「狀態 路徑」）：`)
    out.push(...list(tracked))
    const stat = lines(shortstat)?.[0]
    if (stat) out.push(`  ${stat.trim()}`)
  }
  if (untracked > 0) out.push(`另有 ${untracked} 個沒被 git 追蹤的檔案不會被動到。`)
  if (scope === 'all') out.push('如果是 reset 到別的 commit，分支也會跟著移動；那些 commit 沒有算在這裡。')
  return out
}

export const previewClean = (dryRun: Out): string[] => {
  const all = lines(dryRun)
  if (!all || !dryRun) return [NO_GIT_PREVIEW]
  const paths = all.filter(l => l.startsWith('Would remove ')).map(l => l.slice('Would remove '.length))
  if (paths.length === 0) return ['用 git clean -n 試跑，沒有東西會被刪。']
  return [`有 ${countText(paths.length, dryRun.isCut)} 個沒被 git 追蹤的路徑會被刪掉（用 git clean -n 試跑的結果）：`, ...list(paths)]
}

export type PushInfo = { branch: Out; upstream: Out; count: Out; log: Out; plan: PushPlan }

export const previewPush = ({ branch, upstream, count, log, plan }: PushInfo): string[] => {
  const name = lines(branch)?.[0]
  const target = lines(upstream)?.[0]
  const out: string[] = []
  if (name) out.push(`目前的分支：${name}，對應的遠端分支：${target ?? '沒有設定'}`)
  const n = Number(lines(count)?.[0])
  if (plan.range && Number.isInteger(n)) {
    out.push(
      n === 0
        ? '遠端分支沒有你本機缺少的 commit（依上一次 fetch 的結果）。'
        : `遠端有 ${n} 個 commit 會消失（依上一次 fetch 的結果，範圍 ${plan.range}）：`,
    )
    const commits = lines(log) ?? []
    if (n > 0) out.push(...list(commits))
  } else {
    out.push('遠端的歷史可能被覆蓋；算不出會消失幾個 commit。')
  }
  if (plan.note) out.push(plan.note)
  return out.length ? out : [NO_GIT_PREVIEW]
}

export const previewBranch = (items: readonly { name: string; count: Out }[]): string[] => {
  if (items.length === 0) return [NO_PREVIEW]
  return items.map(({ name, count }) => {
    const n = Number(lines(count)?.[0])
    return Number.isInteger(n)
      ? `分支 ${name}：有 ${n} 個 commit 不在目前的分支裡${n > 0 ? '（刪掉後只剩 reflog 找得回來）' : ''}`
      : `分支 ${name}：${NO_PREVIEW}`
  })
}

export const previewStash = (stashes: Out): string[] => {
  const all = lines(stashes)
  if (!all) return [NO_GIT_PREVIEW]
  return [`目前有 ${all.length} 筆暫存的修改。drop 會刪掉指定的那一筆（沒指定就是 stash@{0}）；clear 會全部刪掉。`, ...list(all)]
}

// What the engine found for one path.
export type PathFact =
  | { path: string; kind: 'missing' | 'file' | 'other' }
  | { path: string; kind: 'link' }
  | { path: string; kind: 'dir'; entries: number; isCapped: boolean }

export const previewPaths = (facts: readonly PathFact[], args: PathArgs, hasCd: boolean): string[] => {
  const out: string[] = []
  if (hasCd) out.push('這串指令前面先用 cd 換了資料夾，所以後面寫的相對路徑查不到實際位置，沒辦法預覽。')
  for (const f of facts) {
    if (f.kind === 'dir') out.push(`${f.path}：資料夾，裡面有 ${f.isCapped ? `${ENTRY_CAP}+` : f.entries} 個項目`)
    else if (f.kind === 'file') out.push(`${f.path}：檔案`)
    else if (f.kind === 'link') out.push(`${f.path}：捷徑（symbolic link；只刪捷徑本身，不會刪它指向的東西）`)
    else if (f.kind === 'other') out.push(`${f.path}：存在，但不是一般的檔案或資料夾`)
    else out.push(`${f.path}：找不到`)
  }
  if (args.paths.length > facts.length) out.push(`還有 ${args.paths.length - facts.length} 個要刪的路徑沒有檢查（指令裡 rm 後面寫的那些）`)
  if (args.skipped.length) out.push(`沒有預覽（路徑裡有萬用字元或變數）：${args.skipped.slice(0, MAX_SHOWN).join(' ')}`)
  return out.length ? out : [`${NO_PREVIEW}（指令裡沒有單純的路徑）`]
}

// ---- The dialog -------------------------------------------------------------------

export const PROCEED = '執行'
export const CANCEL = '取消'
export const DIALOG_HEADER = '危險指令確認' // the chip takes 12 characters at most

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text)

export const buildQuestion = (command: string, risks: readonly Pick<Risk, 'title'>[], preview: readonly string[]): string =>
  [
    `這個指令先被擋下來，等你確認（Blast Radius 安全檢查）。原因：${risks.length ? risks.map(r => r.title).join('；') : '檢查不出這個指令會做什麼'}。`,
    '',
    `  ${shorten(command, 400)}`,
    '',
    '執行後會改變什麼（只讀取、沒有動任何東西；能查多少算多少）：',
    ...preview.map(l => `  ${l}`),
    '',
    '要現在執行嗎？選「執行」才會跑，其他選項都當成取消。',
  ].join('\n')

// Only the exact label Proceed lets the command run. Free text typed under "Other",
// an empty answer and every other label count as Cancel. `answer` is undefined when
// `$.ui.ask` rejected: the dialog was dismissed, or nobody could be asked (`claude -p`).
export const isProceed = (answer: string | undefined) => answer === PROCEED

// What Claude reads when the command is refused.
export const denyReason = (answer: string | undefined, kinds: readonly string[]): string => {
  const what = kinds.join(', ') || 'unchecked'
  const tail = 'It did not run. Do not retry the same command unprompted; ask the person what they want instead.'
  return answer === undefined
    ? `Blast Radius: no confirmation was given for this command (${what}): the dialog was dismissed, or nobody could be asked (a non-interactive run). ${tail}`
    : `Blast Radius: the person cancelled this command (${what}). ${tail}`
}
