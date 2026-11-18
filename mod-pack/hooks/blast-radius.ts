// Blast Radius: hold a risky shell command until the person presses Proceed or Cancel.
//
// Pure: no `$` here. This file holds the rule table that says whether a command is
// risky, the planning of the read-only preview, and the text of the dialog. The
// engine calls (`$.ui.ask`, `$.process.run`, `$.fs.*`) are all in register.tsx,
// which hands this file plain data and gets plain data back.
//
// ponytail: a safety net, not a permission system. This is a regex table over the
// command text. It does NOT catch: an alias, a script that calls rm, a command
// built from variables (`eval "$cmd"`), or other quoting tricks. A variable set earlier
// in the same command is only filled in for the preview, never used to decide.
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

export type PreviewKind = 'status-all' | 'status-worktree' | 'clean' | 'push' | 'branch' | 'stash' | 'paths' | 'deploy'

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

// A package runner before a CLI: `npx vercel ...`, `pnpm dlx netlify ...`.
const RUN = String.raw`(?:(?:npx|bunx|(?:pnpm|yarn)\s+dlx|(?:pnpm|npm)\s+exec)(?:\s+-\S+)*\s+)?`
const CLI = String.raw`(?:\.cmd|\.exe)?` // the Windows shims of a CLI

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

  // Deploy to production: every user sees the new version at once. A preview deploy is not held.
  { kind: 'deploy-prod', title: '發布到正式環境（vercel --prod）', preview: 'deploy',
    regex: re(String.raw`^${RUN}vercel${CLI}${ARGS}\s+(?:--prod|--production|--target(?:=|\s+)production)${END}`) },
  { kind: 'deploy-prod', title: '把某個版本設為正式版（vercel promote）', preview: 'deploy',
    regex: re(String.raw`^${RUN}vercel${CLI}\s+promote${END}`) },
  { kind: 'deploy-prod', title: '發布到正式環境（netlify deploy --prod）', preview: 'deploy',
    regex: re(String.raw`^${RUN}netlify${CLI}\s+deploy${ARGS}\s+--prod(?:IfUnlocked)?${END}`) },
  // `wrangler deploy` goes to production unless `--env` names another environment.
  { kind: 'deploy-prod', title: '發布到正式環境（wrangler deploy）', preview: 'deploy',
    regex: re(String.raw`^${RUN}wrangler${CLI}\s+(?:deploy|publish)${END}`),
    unless: re(String.raw`\s(?:--dry-run|(?:--env|-e)(?:=|\s+)(?!prod(?:uction)?(?:\s|$))\S+)`) },
  { kind: 'deploy-prod', title: '發布到正式環境（firebase deploy）', preview: 'deploy',
    regex: re(String.raw`^${RUN}firebase${CLI}\s+deploy${END}`) },
  { kind: 'deploy-prod', title: '發布到正式環境（fly deploy）', preview: 'deploy',
    regex: re(String.raw`^${RUN}(?:fly|flyctl)${CLI}\s+deploy${END}`) },
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
  hasCd: boolean
  // Where the segment runs, after the earlier `cd`s. See `Dir`.
  dir: Dir
  // The shell variables an earlier segment set to a known value (`D=/x && rm -rf $D/y`).
  vars: Vars
}

// Where a segment runs. `path` undefined: the session folder. Otherwise the folder the
// earlier `cd`s lead to, absolute or relative to the session folder. `isKnown` false: a `cd`
// named a folder that cannot be worked out here (an unset variable, `~`, a glob, no argument).
export type Dir = { path: string | undefined; isKnown: boolean }
export type Vars = Readonly<Record<string, string>>

const CHANGES_DIRECTORY = /^(?:cd|pushd|chdir|set-location|sl)(?:\s|$)/i

// `NAME=value` or `export NAME=value` alone in a segment sets a variable for the rest of
// the command; `$NAME = 'value'` does in PowerShell. `NAME=1 cmd` sets it for `cmd` only,
// and `$NAME` in that segment is still the old value: it is not an assignment here.
const ASSIGN = /^(?:export\s+)?([A-Za-z_]\w*)=(.*)$/s
const PS_ASSIGN = /^\$([A-Za-z_]\w*)\s*=\s*(.+)$/s
const TOKENS = /"[^"]*"|'[^']*'|\S+/g

// The name and the value it gets. `value` undefined: set to something that cannot be worked out.
export const assignment = (raw: string, vars: Vars): { name: string; value?: string } | undefined => {
  const text = raw.trim().replace(/[)}]+$/, '')
  const shell = ASSIGN.exec(text)
  const match = shell ?? PS_ASSIGN.exec(text)
  if (!match) return undefined
  const name = match[1] ?? ''
  const tokens = (match[2] ?? '').match(TOKENS) ?? []
  if (tokens.length > 1) return shell ? undefined : { name }
  const read = readToken(tokens[0] ?? '', vars)
  return read.why ? { name } : { name, value: read.text }
}

const cdTarget = (dir: Dir, segment: string, vars: Vars): Dir => {
  const raw = (segment.match(TOKENS) ?? []).slice(1).find(w => !/^(?:-[A-Za-z]+|\/d)$/i.test(w))
  const target = raw === undefined ? undefined : readToken(raw.replace(/\)+$/, ''), vars)
  if (!dir.isKnown || !target || target.why || target.text === '' || target.text === '-') return { path: dir.path, isKnown: false }
  return { path: dir.path === undefined ? target.text : resolvePath(dir.path, target.text), isKnown: true }
}

// Every risky segment of `command`, in order. An empty list means: not held.
export const classify = (command: string): Risk[] => {
  const risks: Risk[] = []
  let hasCd = false
  let dir: Dir = { path: undefined, isKnown: true }
  const vars: Record<string, string> = {}
  const parts = command.split(new RegExp(`(${SEPARATORS.source})`))
  for (let i = 0; i < parts.length; i += 2) {
    const raw = parts[i] ?? ''
    const set = assignment(stripGrouping(raw), vars)
    if (set) {
      // `D=$(pwd)` is split at `$(`: what D gets is the output of the nested command.
      const isNested = parts[i + 1] === '$(' || parts[i + 1] === '`'
      if (set.value === undefined || isNested) delete vars[set.name]
      else vars[set.name] = set.value
      continue
    }
    const segment = stripPrefix(raw)
    if (!segment) continue
    const rule = RULES.find(r => r.regex.test(segment) && !r.unless?.test(segment))
    if (rule) risks.push({ kind: rule.kind, title: rule.title, preview: rule.preview, segment, hasCd, dir, vars: { ...vars } })
    if (CHANGES_DIRECTORY.test(segment)) {
      hasCd = true
      dir = cdTarget(dir, segment, vars)
    }
  }
  return risks
}

// `( D=x` -> `D=x`: a group opened before an assignment.
const stripGrouping = (raw: string) => raw.replace(/^\s*[({]\s*/, '')

// ---- Words with variables ---------------------------------------------------------

const VAR_REF = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g

// What one word of the command stands for. `why` set: it cannot be worked out here.
// `unset`: the variables it uses that no earlier segment set. A single-quoted word is taken
// as it is. A glob keeps its text, so the folder it lies in can still be looked at.
export type Token = { text: string; why?: 'var' | 'home' | 'glob'; unset?: string[] }

export const readToken = (raw: string, vars: Vars): Token => {
  if (/^'.*'$/s.test(raw)) return { text: raw.slice(1, -1) }
  const typed = raw.replace(/^"|"$/g, '')
  const unset: string[] = []
  const text = typed.replace(VAR_REF, (whole, braced?: string, bare?: string) => {
    const name = braced ?? bare ?? ''
    const value = vars[name]
    if (value === undefined) unset.push(name)
    return value ?? whole
  })
  if (unset.length) return { text: typed, why: 'var', unset }
  // `$(`, `$1`, `${X:-y}`, `%X%` and backticks are not worked out.
  if (/[$%`]/.test(text)) return { text: typed, why: 'var', unset: [] }
  if (/^~/.test(text)) return { text, why: 'home' }
  if (/[*?[\]{}]/.test(text)) return { text, why: 'glob' }
  return { text }
}

// The folder a glob lies in: the part before the segment that holds the first wildcard.
// '' means the folder the command runs in.
export const globBase = (glob: string) => {
  const head = glob.slice(0, glob.search(/[*?[\]{}]/))
  const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'))
  return cut < 0 ? '' : head.slice(0, cut + 1)
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

// A word that is not looked at, as typed, with why. `base`: for a glob, the folder it lies in.
export type Skipped = { token: string; why: 'var' | 'home' | 'glob'; unset?: string[]; base?: string }
export type PathArgs = { paths: string[]; skipped: Skipped[] }

// Flags of Remove-Item that take a value which is not a path.
const VALUE_FLAGS = /^-(?:include|exclude|filter|credential|stream)$/i

// The path arguments of a delete command, with the variables of `vars` filled in. A glob,
// an unset variable or `~` cannot be resolved here and is listed as skipped.
export const pathArgs = (segment: string, vars: Vars = {}): PathArgs => {
  const tokens = (segment.match(TOKENS) ?? []).slice(1)
  const paths: string[] = []
  const skipped: Skipped[] = []
  for (let i = 0; i < tokens.length; i++) {
    const raw = (tokens[i] ?? '').replace(/\)+$/, '')
    const plain = raw.replace(/^["']|["']$/g, '')
    if (VALUE_FLAGS.test(plain)) i++
    else if (plain === '' || plain.startsWith('-') || /^\/[a-zA-Z]$/.test(plain) || /^\d*[<>]/.test(plain)) continue
    else {
      const token = readToken(raw, vars)
      if (!token.why) paths.push(token.text)
      else if (token.why === 'glob') skipped.push({ token: plain, why: 'glob', base: globBase(token.text) })
      else skipped.push({ token: plain, why: token.why, ...(token.unset ? { unset: token.unset } : {}) })
    }
  }
  return { paths, skipped }
}

export const isAbsolute = (path: string) => /^(?:[A-Za-z]:)?[\\/]/.test(path)
const isWindowsPath = (path: string | undefined) => path !== undefined && /^[A-Za-z]:[\\/]/.test(path)

// A relative path belongs to the session folder. `cwd` joins with `/`, which Windows accepts too.
export const resolvePath = (cwd: string, path: string) => (isAbsolute(path) ? path : `${cwd.replace(/[\\/]+$/, '')}/${path}`)

// Git Bash on Windows writes `C:\x` as `/c/x`. When the session folder is a Windows path, such a
// path is turned back into `C:/x`, so the engine can look at it. Any other `/x` path on Windows
// is a folder of Git Bash itself (`/tmp`, `/usr`): undefined, it cannot be looked at.
export const nativePath = (path: string, cwd: string | undefined): string | undefined => {
  if (!isWindowsPath(cwd) || !/^[\\/]/.test(path) || /^[\\/]{2}/.test(path)) return path
  const drive = /^\/([A-Za-z])(?=\/|$)/.exec(path)
  return drive ? `${(drive[1] ?? '').toUpperCase()}:${path.slice(2) || '/'}` : undefined
}

// The folder a segment runs in, as the engine can look at it. Undefined: it cannot be worked out.
export const folderOf = (cwd: string | undefined, dir: Dir): string | undefined => {
  if (!dir.isKnown) return undefined
  if (dir.path === undefined) return cwd
  const path = nativePath(dir.path, cwd)
  if (path === undefined || isAbsolute(path)) return path
  return cwd === undefined ? undefined : resolvePath(cwd, path)
}

// Where one path of a segment is. Undefined: it cannot be worked out.
export const locate = (cwd: string | undefined, dir: Dir, path: string): string | undefined => {
  const native = nativePath(path, cwd)
  if (native === undefined || isAbsolute(native)) return native
  const base = folderOf(cwd, dir)
  return base === undefined ? undefined : resolvePath(base, native)
}

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

const factText = (f: PathFact) =>
  f.kind === 'dir' ? `資料夾，裡面有 ${f.isCapped ? `${ENTRY_CAP}+` : f.entries} 個項目`
  : f.kind === 'file' ? '檔案'
  : f.kind === 'link' ? '捷徑（symbolic link；只刪捷徑本身，不會刪它指向的東西）'
  : f.kind === 'other' ? '存在，但不是一般的檔案或資料夾'
  : '找不到'

// Where the relative paths of a segment are. `folder`: the folder after the earlier `cd`s, shown
// only when a `cd` moved it. `isKnown` false: a `cd` named a folder that cannot be worked out.
export type Place = { folder?: string; isKnown: boolean }

// `globs`: for a skipped glob, what its folder is (by the glob's text).
export const previewPaths = (facts: readonly PathFact[], args: PathArgs, place: Place, globs: Readonly<Record<string, PathFact>> = {}): string[] => {
  const out: string[] = []
  if (!place.isKnown) out.push('這串指令前面的 cd 用了查不出來的路徑（沒設定的變數、~ 或萬用字元），所以相對路徑沒辦法預覽。')
  else if (place.folder) out.push(`前面先 cd 到 ${place.folder}，相對路徑以那裡為準。`)
  for (const f of facts) out.push(`${f.path}：${factText(f)}`)
  if (args.paths.length > facts.length) out.push(`還有 ${args.paths.length - facts.length} 個要刪的路徑沒有檢查（超過一次檢查的上限，或查不到實際位置）`)
  for (const s of args.skipped.slice(0, MAX_SHOWN)) {
    if (s.why === 'var') {
      const names = (s.unset ?? []).map(n => `$${n}`).join('、')
      out.push(`${s.token}：${names ? `${names} 在這串指令裡沒有設定值` : '用了這裡算不出來的寫法'}，查不出指到哪裡，沒有預覽`)
    } else if (s.why === 'home') out.push(`${s.token}：用了 ~（家目錄），這裡查不到實際位置，沒有預覽`)
    else {
      const base = globs[s.token]
      out.push(base ? `${s.token}：有萬用字元，沒辦法逐一列出；符合的項目都在 ${base.path} 底下（${factText(base)}）` : `${s.token}：有萬用字元，沒辦法逐一列出，沒有預覽`)
    }
  }
  if (args.skipped.length > MAX_SHOWN) out.push(`……還有 ${args.skipped.length - MAX_SHOWN} 個路徑沒列出`)
  return out.length ? out : [`${NO_PREVIEW}（指令裡沒有路徑）`]
}

// A deploy to production. `folder`: where it deploys from; `fact`: what the engine found there.
export const previewDeploy = (place: Place, fact?: PathFact): string[] => [
  '會直接發布到正式環境，所有使用者馬上會看到新版本。這個檢查看不出新版本跟線上版本差在哪裡。',
  !place.isKnown
    ? '查不出從哪個資料夾發布（前面的 cd 用了沒設定的變數、~ 或萬用字元）。'
    : `從這個資料夾發布：${place.folder ?? '目前的工作資料夾'}${fact?.kind === 'missing' ? '（找不到這個資料夾）' : ''}`,
]

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
