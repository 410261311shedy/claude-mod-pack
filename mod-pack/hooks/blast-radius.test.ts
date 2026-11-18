import { test, expect } from 'claude-code/testing'

import {
  blastRadius, branchTargets, buildQuestion, CANCEL, cleanDryRun, classify, denyReason, ENTRY_CAP, hasGitOptions, isProceed, MAX_SHOWN, NO_GIT_PREVIEW, NO_PREVIEW,
  folderOf, locate, nativePath, pathArgs, previewBranch, previewClean, previewDeploy, previewPaths, previewPush, previewStash, previewStatus, PROCEED, pushPlan, resolvePath,
} from './blast-radius'
import type { GitOut } from './blast-radius'

const kinds = (command: string) => classify(command).map(r => r.kind)

// [command, the kinds it is held for, in order]
const HELD: [string, string[]][] = [
  // recursive delete: flag spellings and orders
  ['rm -rf build', ['rm-recursive']],
  ['rm -fr build', ['rm-recursive']],
  ['rm -r build', ['rm-recursive']],
  ['rm -r -f build', ['rm-recursive']],
  ['rm -f -r build', ['rm-recursive']],
  ['rm -Rf build', ['rm-recursive']],
  ['rm --recursive --force build', ['rm-recursive']],
  ['rm build -rf', ['rm-recursive']],
  // prefixes and chains
  ['sudo rm -rf /var/cache/x', ['rm-recursive']],
  ['sudo -u deploy rm -rf /srv/x', ['rm-recursive']],
  ['/bin/rm -rf x', ['rm-recursive']],
  ['\\rm -rf x', ['rm-recursive']],
  ['FOO=1 rm -rf x', ['rm-recursive']],
  ['cd build && rm -rf *', ['rm-recursive']],
  ['ls; rm -rf build', ['rm-recursive']],
  ['make || rm -rf build', ['rm-recursive']],
  ['find . -name x | xargs rm -rf', ['rm-recursive']],
  ['echo start\nrm -rf build\necho done', ['rm-recursive']],
  ['bash -c "rm -rf x"', ['rm-recursive']],
  ['echo $(rm -rf x)', ['rm-recursive']],
  ['time rm -rf x', ['rm-recursive']],
  ['cmd /c rmdir /s /q build', ['rmdir-windows']],
  ['powershell -NoProfile -Command "Remove-Item -Recurse build"', ['remove-item']],
  ['sudo git push --force', ['git-push-force']],
  // git
  ['git reset --hard', ['git-reset-hard']],
  ['git reset --hard origin/main', ['git-reset-hard']],
  ['git reset HEAD~1 --hard', ['git-reset-hard']],
  ['git -C repo reset --hard HEAD~1', ['git-reset-hard']],
  ['git status && git reset --hard', ['git-reset-hard']],
  ['git clean -fd', ['git-clean']],
  ['git clean -f', ['git-clean']],
  ['git clean -xdf', ['git-clean']],
  ['git clean --force -d', ['git-clean']],
  ['git push --force', ['git-push-force']],
  ['git push -f origin main', ['git-push-force']],
  ['git push origin main --force', ['git-push-force']],
  ['git push --force-with-lease', ['git-push-force']],
  ['git push --force-with-lease=main:abc123 origin main', ['git-push-force']],
  ['git push origin +main', ['git-push-force']],
  ['git checkout -- .', ['git-discard-checkout']],
  ['git checkout .', ['git-discard-checkout']],
  ['git checkout main -- .', ['git-discard-checkout']],
  ['git restore .', ['git-discard-restore']],
  ['git restore --worktree --staged .', ['git-discard-restore']],
  ['git branch -D feature', ['git-branch-delete']],
  ['git stash drop', ['git-stash-drop']],
  ['git stash clear', ['git-stash-drop']],
  // Windows
  ['rmdir /s /q build', ['rmdir-windows']],
  ['RD /S /Q build', ['rmdir-windows']],
  ['del /s /q *.tmp', ['del-windows']],
  ['Remove-Item -Recurse -Force build', ['remove-item']],
  ['remove-item build -recurse', ['remove-item']],
  ['ri -r build', ['remove-item']],
  ['Remove-Item build -Recurse:$true', ['remove-item']],
  // several risks in one command, in order
  ['rm -rf a && git push -f', ['rm-recursive', 'git-push-force']],
]

const NOT_HELD: string[] = [
  // delete without recursion: one named file at a time. Decision: not held.
  'rm file.txt',
  'rm -f file.txt',
  'rm -i file.txt',
  'rmdir build',
  'del file.txt',
  'Remove-Item file.txt',
  'Get-ChildItem -Recurse',
  // git: safe forms
  'git reset --soft HEAD~1',
  'git reset --mixed HEAD~1',
  'git reset HEAD file.txt',
  'git reset',
  'git clean -n',
  'git clean -nd',
  'git clean -fdn',
  'git clean --dry-run -fd',
  'git push',
  'git push origin main',
  'git push -u origin feature',
  'git push --follow-tags',
  'git status',
  'git diff --stat',
  'git log --oneline',
  'git checkout main',
  'git checkout -b feature',
  'git checkout .gitignore',
  'git restore file.txt',
  'git restore --staged .',
  'git branch',
  'git branch -d feature',
  'git stash',
  'git stash pop',
  'git stash list',
  // text that only mentions a risky command. Decision: a rule matches only at the
  // start of a segment, so these are not held.
  'grep rm -rf README',
  'echo "rm -rf x"',
  "echo 'git reset --hard'",
  'cat rm-rf.txt',
  'npm run build',
  'ls -la',
]

test('the Blast Radius feature entry: id, default on, no model tokens, no sound', () => {
  expect(blastRadius.id).toBe('blast-radius')
  expect(blastRadius.defaultOn).toBe(true)
  expect(blastRadius.usesModel).toBe(false)
  expect(blastRadius.hasSound).toBeUndefined()
  expect(blastRadius.about).toContain('no model tokens')
})

test('the classifier holds each risky command, with the right kinds', () => {
  for (const [command, expected] of HELD) expect([command, kinds(command)]).toEqual([command, expected])
})

test('the classifier lets safe commands through', () => {
  for (const command of NOT_HELD) expect([command, kinds(command)]).toEqual([command, []])
})

test('the tables are big enough: 25 or more cases each way', () => {
  expect(HELD.length).toBeGreaterThanOrEqual(25)
  expect(NOT_HELD.length).toBeGreaterThanOrEqual(25)
})

test('a risky word inside quotes after a separator is a false positive (accepted)', () => {
  expect(kinds('echo "a; rm -rf x"')).toEqual(['rm-recursive'])
})

test('known ceiling: an alias, a script and a command built from variables are not caught', () => {
  expect(kinds('nuke build')).toEqual([])
  expect(kinds('./cleanup.sh')).toEqual([])
  expect(kinds('rm $FLAGS build')).toEqual([])
  expect(kinds('eval "$cmd"')).toEqual([])
})

test('hasCd records an earlier cd in the same command', () => {
  expect(classify('cd build && rm -rf x')[0]?.hasCd).toBe(true)
  expect(classify('rm -rf x && cd build')[0]?.hasCd).toBe(false)
  expect(classify('rm -rf x')[0]?.hasCd).toBe(false)
  expect(classify('Set-Location build; Remove-Item -Recurse x')[0]?.hasCd).toBe(true)
})

test('dir follows each cd, relative to the one before; a cd that cannot be worked out makes it unknown', () => {
  expect(classify('rm -rf x')[0]?.dir).toEqual({ path: undefined, isKnown: true })
  expect(classify('cd build && rm -rf x')[0]?.dir).toEqual({ path: 'build', isKnown: true })
  expect(classify('cd /srv && cd app && rm -rf x')[0]?.dir).toEqual({ path: '/srv/app', isKnown: true })
  expect(classify('cd "C:\\work dir"; Remove-Item -Recurse x')[0]?.dir).toEqual({ path: 'C:\\work dir', isKnown: true })
  expect(classify('cd $NOPE && rm -rf x')[0]?.dir).toEqual({ path: undefined, isKnown: false })
  expect(classify('cd ~/x && rm -rf y')[0]?.dir.isKnown).toBe(false)
  expect(classify('cd && rm -rf y')[0]?.dir.isKnown).toBe(false)
  expect(classify('cd - && rm -rf y')[0]?.dir.isKnown).toBe(false)
  // once unknown, a later relative cd stays unknown
  expect(classify('cd $NOPE && cd sub && rm -rf y')[0]?.dir.isKnown).toBe(false)
})

test('vars: an assignment alone in a segment is kept for the later segments', () => {
  expect(classify('D=/tmp/out && rm -rf $D/assets')[0]?.vars).toEqual({ D: '/tmp/out' })
  expect(classify('export D="/a b"; rm -rf "$D"')[0]?.vars).toEqual({ D: '/a b' })
  expect(classify("D='$HOME' && rm -rf $D")[0]?.vars).toEqual({ D: '$HOME' })
  expect(classify('A=/x && B=$A/y && rm -rf $B')[0]?.vars).toEqual({ A: '/x', B: '/x/y' })
  expect(classify('$D = "C:\\out"; Remove-Item -Recurse $D')[0]?.vars).toEqual({ D: 'C:\\out' })
  // an inline FOO=1 cmd is for cmd only, and a value that cannot be worked out drops the name
  expect(classify('D=/x rm -rf $D')[0]?.vars).toEqual({})
  expect(classify('D=/x && D=$(pwd) && rm -rf $D')[0]?.vars).toEqual({})
  // an assignment is not itself a risky segment, and cd can use a variable
  expect(classify('D=/x && cd $D && rm -rf y')[0]?.dir).toEqual({ path: '/x', isKnown: true })
})

test('the command from the report: the variable and the cd are both worked out', () => {
  const command = 'cd /c/Data/app && npx tsc --noEmit && D=/c/Temp/out && rm -rf $D/assets && cp -r dist/* $D/ && (cd $D && vercel deploy --prod --yes 2>&1 | grep Aliased)'
  const risks = classify(command)
  expect(risks.map(r => r.kind)).toEqual(['rm-recursive', 'deploy-prod'])
  expect(pathArgs(risks[0]?.segment ?? '', risks[0]?.vars)).toEqual({ paths: ['/c/Temp/out/assets'], skipped: [] })
  expect(risks[1]?.dir).toEqual({ path: '/c/Temp/out', isKnown: true })
})

test('deploys to production are held; preview deploys and dry runs are not', () => {
  for (const c of ['vercel deploy --prod --yes', 'vercel --prod', 'npx vercel deploy --prod', 'vercel.cmd --prod', 'vercel deploy --target production', 'vercel deploy --target=production',
    'vercel promote https://x.vercel.app', 'netlify deploy --prod', 'pnpm dlx netlify deploy --dir dist --prod', 'wrangler deploy', 'npx wrangler deploy --env production',
    'wrangler publish', 'firebase deploy', 'firebase deploy --only hosting', 'fly deploy', 'flyctl deploy']) {
    expect([c, kinds(c)]).toEqual([c, ['deploy-prod']])
  }
  for (const c of ['vercel deploy', 'vercel', 'vercel deploy --prebuilt', 'netlify deploy', 'wrangler deploy --dry-run', 'wrangler deploy --env staging', 'wrangler deploy -e dev',
    'wrangler pages deploy dist', 'firebase hosting:channel:deploy pr-1', 'echo vercel --prod', 'grep -r "vercel --prod" .']) {
    expect([c, kinds(c)]).toEqual([c, []])
  }
})

test('a risk keeps the segment the rule saw, prefix removed', () => {
  const [risk] = classify('cd x && sudo rm -rf  build/ dist')
  expect(risk?.segment).toBe('rm -rf  build/ dist')
  expect(risk?.preview).toBe('paths')
})

test('pathArgs: plain paths, and what is skipped', () => {
  expect(pathArgs('rm -rf build dist/')).toEqual({ paths: ['build', 'dist/'], skipped: [] })
  expect(pathArgs('rm -rf "my dir" other')).toEqual({ paths: ['my dir', 'other'], skipped: [] })
  expect(pathArgs('rm -rf *.log $HOME/x ~/y build')).toEqual({
    paths: ['build'],
    skipped: [{ token: '*.log', why: 'glob', base: '' }, { token: '$HOME/x', why: 'var', unset: ['HOME'] }, { token: '~/y', why: 'home' }],
  })
  expect(pathArgs('rm -rf dist/*.js out/a?/b', {})).toEqual({
    paths: [],
    skipped: [{ token: 'dist/*.js', why: 'glob', base: 'dist/' }, { token: 'out/a?/b', why: 'glob', base: 'out/' }],
  })
  // variables set earlier in the command are filled in; a single-quoted word is taken as it is
  expect(pathArgs('rm -rf $D/assets "${D}/b" \'$D\'', { D: '/tmp/out' })).toEqual({ paths: ['/tmp/out/assets', '/tmp/out/b', '$D'], skipped: [] })
  expect(pathArgs('rm -rf $D/$E', { D: '/x' })).toEqual({ paths: [], skipped: [{ token: '$D/$E', why: 'var', unset: ['E'] }] })
  expect(pathArgs('rm -rf $(pwd)/x %TEMP%\\y', {})).toEqual({ paths: [], skipped: [{ token: '$(pwd)/x', why: 'var', unset: [] }, { token: '%TEMP%\\y', why: 'var', unset: [] }] })
  expect(pathArgs('rm -rf $D/*', { D: '/x' })).toEqual({ paths: [], skipped: [{ token: '$D/*', why: 'glob', base: '/x/' }] })
  expect(pathArgs('rd /s /q C:\\work\\out')).toEqual({ paths: ['C:\\work\\out'], skipped: [] })
  expect(pathArgs('Remove-Item -Recurse -Force -Include *.tmp build')).toEqual({ paths: ['build'], skipped: [] })
  expect(pathArgs('rm -rf build 2>/dev/null')).toEqual({ paths: ['build'], skipped: [] })
  expect(pathArgs('rm -rf')).toEqual({ paths: [], skipped: [] })
})

test('resolvePath joins a relative path to the session folder and leaves an absolute one', () => {
  expect(resolvePath('/work', 'build')).toBe('/work/build')
  expect(resolvePath('/work/', 'a/b')).toBe('/work/a/b')
  expect(resolvePath('C:\\work', 'build')).toBe('C:\\work/build')
  expect(resolvePath('/work', '/tmp/x')).toBe('/tmp/x')
  expect(resolvePath('/work', 'C:\\x')).toBe('C:\\x')
})

test('nativePath: a Git Bash drive path becomes a Windows path when the session folder is on Windows', () => {
  expect(nativePath('/c/Users/x', 'C:\\work')).toBe('C:/Users/x')
  expect(nativePath('/d', 'C:\\work')).toBe('D:/')
  expect(nativePath('/tmp/x', 'C:\\work')).toBeUndefined()
  expect(nativePath('C:\\x', 'C:\\work')).toBe('C:\\x')
  expect(nativePath('rel/x', 'C:\\work')).toBe('rel/x')
  expect(nativePath('//server/share', 'C:\\work')).toBe('//server/share')
  // not on Windows: unchanged
  expect(nativePath('/c/x', '/work')).toBe('/c/x')
  expect(nativePath('/c/x', undefined)).toBe('/c/x')
})

test('folderOf and locate: relative paths are found in the folder the cd led to', () => {
  const session = { path: undefined, isKnown: true }
  expect(folderOf('/work', session)).toBe('/work')
  expect(folderOf('/work', { path: 'sub', isKnown: true })).toBe('/work/sub')
  expect(folderOf('C:\\work', { path: '/c/out', isKnown: true })).toBe('C:/out')
  expect(folderOf('/work', { path: undefined, isKnown: false })).toBeUndefined()
  expect(folderOf(undefined, { path: 'sub', isKnown: true })).toBeUndefined()
  expect(folderOf(undefined, { path: '/abs', isKnown: true })).toBe('/abs')
  expect(locate('/work', session, 'build')).toBe('/work/build')
  expect(locate('/work', { path: '/srv', isKnown: true }, 'build')).toBe('/srv/build')
  expect(locate('/work', { path: undefined, isKnown: false }, 'build')).toBeUndefined()
  expect(locate('/work', { path: undefined, isKnown: false }, '/abs/x')).toBe('/abs/x')
  expect(locate('C:\\work', session, '/c/Temp/out/assets')).toBe('C:/Temp/out/assets')
  expect(locate('C:\\work', session, '/tmp/x')).toBeUndefined()
})

test('cleanDryRun: same flags, force removed, dry run added', () => {
  expect(cleanDryRun('git clean -fd')).toEqual(['clean', '-n', '-d'])
  expect(cleanDryRun('git clean -xdf')).toEqual(['clean', '-n', '-xd'])
  expect(cleanDryRun('git clean --force -d src')).toEqual(['clean', '-n', '-d', 'src'])
  expect(cleanDryRun('git clean -f')).toEqual(['clean', '-n'])
  expect(cleanDryRun('git clean -f $DIR')).toBeUndefined()
  expect(cleanDryRun('git -C x clean -f')).toBeUndefined()
})

test('pushPlan: which commits would the remote lose', () => {
  expect(pushPlan('git push --force')).toEqual({ range: 'HEAD..@{u}' })
  expect(pushPlan('git push -f origin')).toEqual({ range: 'HEAD..@{u}' })
  expect(pushPlan('git push -f origin main')).toEqual({ range: 'main..origin/main' })
  expect(pushPlan('git push origin +main')).toEqual({ range: 'main..origin/main' })
  expect(pushPlan('git push -f origin HEAD:main').note).toContain('不是單純的「遠端 分支」寫法')
  expect(pushPlan('git push -f origin a b').range).toBeUndefined()
})

test('branchTargets and hasGitOptions', () => {
  expect(branchTargets('git branch -D a b')).toEqual(['a', 'b'])
  expect(branchTargets('git branch -D a b c d')).toEqual(['a', 'b', 'c'])
  expect(branchTargets('git branch -D $X')).toEqual([])
  expect(hasGitOptions('git reset --hard')).toBe(false)
  expect(hasGitOptions('git -C repo reset --hard')).toBe(true)
  expect(hasGitOptions('git -c core.pager=x clean -f')).toBe(true)
})

// ---- preview text ----

const out = (text: string, over: Partial<GitOut> = {}): GitOut => ({ ok: true, text, isCut: false, ...over })
const FAILED: GitOut = { ok: false, text: '', isCut: false }

test('status preview: tracked count, first paths, untracked left alone', () => {
  const text = [' M a.ts', 'M  b.ts', 'A  c.ts', '?? new1.txt', '?? new2.txt'].join('\n')
  const lines = previewStatus(out(text), out(' 3 files changed, 10 insertions(+), 2 deletions(-)\n'), 'all')
  expect(lines[0]).toBe('有 3 個檔案的修改會被蓋掉（還沒 commit；下面每行是「狀態 路徑」）：')
  expect(lines.slice(1, 4)).toEqual(['   M a.ts', '  M  b.ts', '  A  c.ts'])
  expect(lines).toContain('  3 files changed, 10 insertions(+), 2 deletions(-)')
  expect(lines).toContain('另有 2 個沒被 git 追蹤的檔案不會被動到。')
})

test('status preview: the work-tree scope counts only unstaged changes', () => {
  const text = [' M a.ts', 'M  b.ts', 'MM c.ts'].join('\n')
  const lines = previewStatus(out(text), undefined, 'worktree')
  expect(lines[0]).toBe('有 2 個檔案的修改會被蓋掉（還沒 git add；下面每行是「狀態 路徑」）：')
  expect(lines.join('\n')).not.toContain('b.ts')
})

test('status preview: truncation to 10 paths with "and N more", and an exact count line', () => {
  const text = Array.from({ length: 14 }, (_, i) => ` M file${i}.ts`).join('\n')
  const lines = previewStatus(out(text), undefined, 'all')
  expect(lines[0]).toContain('有 14 個檔案')
  expect(lines.filter(l => l.includes('file') && l.includes('.ts'))).toHaveLength(MAX_SHOWN)
  expect(lines).toContain('  ……還有 4 項沒列出')
})

test('status preview: clean tree, cut output, and no preview', () => {
  expect(previewStatus(out(''), undefined, 'all')[0]).toBe('沒有還沒 commit 的修改會被丟掉。')
  expect(previewStatus(out(' M a.ts\n', { isCut: true }), undefined, 'all')[0]).toContain('有 1+ 個檔案')
  expect(previewStatus(FAILED, undefined, 'all')).toEqual([NO_GIT_PREVIEW])
  expect(previewStatus(undefined, undefined, 'worktree')).toEqual([NO_GIT_PREVIEW])
  expect(NO_GIT_PREVIEW).toContain('無法預覽')
})

test('clean preview: count, 10 paths, and "and N more"', () => {
  const text = Array.from({ length: 12 }, (_, i) => `Would remove tmp/f${i}.log`).join('\n') + '\nWould skip repository sub/\n'
  const lines = previewClean(out(text))
  expect(lines[0]).toBe('有 12 個沒被 git 追蹤的路徑會被刪掉（用 git clean -n 試跑的結果）：')
  expect(lines).toHaveLength(1 + MAX_SHOWN + 1)
  expect(lines.at(-1)).toBe('  ……還有 2 項沒列出')
  expect(previewClean(out(''))).toEqual(['用 git clean -n 試跑，沒有東西會被刪。'])
  expect(previewClean(undefined)).toEqual([NO_GIT_PREVIEW])
})

test('push preview: branch, upstream, lost commits; and the fallback text', () => {
  const lines = previewPush({
    branch: out('main\n'),
    upstream: out('origin/main\n'),
    count: out('2\n'),
    log: out('abc1234 fix\ndef5678 add\n'),
    plan: { range: 'HEAD..@{u}' },
  })
  expect(lines[0]).toBe('目前的分支：main，對應的遠端分支：origin/main')
  expect(lines[1]).toBe('遠端有 2 個 commit 會消失（依上一次 fetch 的結果，範圍 HEAD..@{u}）：')
  expect(lines.slice(2)).toEqual(['  abc1234 fix', '  def5678 add'])

  const none = previewPush({ branch: out('main'), upstream: FAILED, count: undefined, log: undefined, plan: { note: 'the target "x" is odd' } })
  expect(none).toEqual(['目前的分支：main，對應的遠端分支：沒有設定', '遠端的歷史可能被覆蓋；算不出會消失幾個 commit。', 'the target "x" is odd'])
  expect(previewPush({ branch: undefined, upstream: undefined, count: undefined, log: undefined, plan: {} })).toEqual(['遠端的歷史可能被覆蓋；算不出會消失幾個 commit。'])
  expect(previewPush({ branch: out('m'), upstream: out('o/m'), count: out('0'), log: out(''), plan: { range: 'HEAD..@{u}' } })[1]).toContain('沒有你本機缺少的 commit')
})

test('branch and stash previews', () => {
  expect(previewBranch([{ name: 'a', count: out('3\n') }, { name: 'b', count: out('0') }, { name: 'c', count: FAILED }])).toEqual([
    '分支 a：有 3 個 commit 不在目前的分支裡（刪掉後只剩 reflog 找得回來）',
    '分支 b：有 0 個 commit 不在目前的分支裡',
    `分支 c：${NO_PREVIEW}`,
  ])
  expect(previewBranch([])).toEqual([NO_PREVIEW])
  expect(previewStash(out('stash@{0}: WIP on main: abc fix\nstash@{1}: WIP on main: def add\n'))[0]).toContain('目前有 2 筆暫存的修改')
  expect(previewStash(undefined)).toEqual([NO_GIT_PREVIEW])
})

test('path preview: each state, the cd note, skipped paths and the cap', () => {
  const lines = previewPaths(
    [
      { path: 'build', kind: 'dir', entries: 412, isCapped: false },
      { path: 'big', kind: 'dir', entries: ENTRY_CAP, isCapped: true },
      { path: 'one', kind: 'dir', entries: 1, isCapped: false },
      { path: 'a.txt', kind: 'file' },
      { path: 'lnk', kind: 'link' },
      { path: 'gone', kind: 'missing' },
    ],
    {
      paths: ['build', 'big', 'one', 'a.txt', 'lnk', 'gone', 'x', 'y'],
      skipped: [
        { token: '*.log', why: 'glob', base: '' },
        { token: 'logs/*', why: 'glob', base: 'logs/' },
        { token: '$X/y', why: 'var', unset: ['X'] },
        { token: '$(pwd)', why: 'var', unset: [] },
        { token: '~/z', why: 'home' },
      ],
    },
    { isKnown: true },
    { 'logs/*': { path: 'logs/', kind: 'dir', entries: 3, isCapped: false } },
  )
  expect(lines).toEqual([
    'build：資料夾，裡面有 412 個項目',
    'big：資料夾，裡面有 1000+ 個項目',
    'one：資料夾，裡面有 1 個項目',
    'a.txt：檔案',
    'lnk：捷徑（symbolic link；只刪捷徑本身，不會刪它指向的東西）',
    'gone：找不到',
    '還有 2 個要刪的路徑沒有檢查（超過一次檢查的上限，或查不到實際位置）',
    '*.log：有萬用字元，沒辦法逐一列出，沒有預覽',
    'logs/*：有萬用字元，沒辦法逐一列出；符合的項目都在 logs/ 底下（資料夾，裡面有 3 個項目）',
    '$X/y：$X 在這串指令裡沒有設定值，查不出指到哪裡，沒有預覽',
    '$(pwd)：用了這裡算不出來的寫法，查不出指到哪裡，沒有預覽',
    '~/z：用了 ~（家目錄），這裡查不到實際位置，沒有預覽',
  ])
  expect(previewPaths([], { paths: ['x'], skipped: [] }, { isKnown: false })[0]).toContain('cd 用了查不出來的路徑')
  expect(previewPaths([{ path: 'x', kind: 'file' }], { paths: ['x'], skipped: [] }, { isKnown: true, folder: '/srv' })).toEqual(['前面先 cd 到 /srv，相對路徑以那裡為準。', 'x：檔案'])
  expect(previewPaths([], { paths: [], skipped: [] }, { isKnown: true })).toEqual([`${NO_PREVIEW}（指令裡沒有路徑）`])
})

test('deploy preview: says it goes to production, and where it deploys from', () => {
  expect(previewDeploy({ isKnown: true, folder: 'C:/out' }, { path: 'C:/out', kind: 'dir', entries: 4, isCapped: false })).toEqual([
    '會直接發布到正式環境，所有使用者馬上會看到新版本。這個檢查看不出新版本跟線上版本差在哪裡。',
    '從這個資料夾發布：C:/out',
  ])
  expect(previewDeploy({ isKnown: true, folder: 'C:/out' }, { path: 'C:/out', kind: 'missing' })[1]).toBe('從這個資料夾發布：C:/out（找不到這個資料夾）')
  expect(previewDeploy({ isKnown: true })[1]).toBe('從這個資料夾發布：目前的工作資料夾')
  expect(previewDeploy({ isKnown: false })[1]).toContain('查不出從哪個資料夾發布')
})

test('the dialog text names the kinds and the exact command, then the preview', () => {
  const text = buildQuestion('rm -rf build', [{ title: 'recursive delete (rm -r)' }], ['build: directory, 3 entries inside'])
  expect(text).toBe(
    [
      '這個指令先被擋下來，等你確認（Blast Radius 安全檢查）。原因：recursive delete (rm -r)。',
      '',
      '  rm -rf build',
      '',
      '執行後會改變什麼（只讀取、沒有動任何東西；能查多少算多少）：',
      '  build: directory, 3 entries inside',
      '',
      '要現在執行嗎？選「執行」才會跑，其他選項都當成取消。',
    ].join('\n'),
  )
  expect(buildQuestion('x'.repeat(500), [], [])).toContain('檢查不出這個指令會做什麼')
  expect(buildQuestion('x'.repeat(500), [], [])).toContain(`${'x'.repeat(400)}...`)
})

test('only the exact label Proceed lets a command run', () => {
  expect(isProceed(PROCEED)).toBe(true)
  for (const other of [CANCEL, 'proceed', 'Proceed', `${PROCEED} `, '', 'yes', `${PROCEED}, ${CANCEL}`, undefined]) expect(isProceed(other)).toBe(false)
})

test('the denial tells Claude the command did not run and not to retry it unprompted', () => {
  const cancelled = denyReason('Cancel', ['rm-recursive'])
  expect(cancelled).toContain('the person cancelled this command (rm-recursive)')
  expect(cancelled).toContain('Do not retry the same command unprompted')
  const none = denyReason(undefined, ['git-reset-hard', 'git-clean'])
  expect(none).toContain('no confirmation was given')
  expect(none).toContain('non-interactive')
  expect(none).toContain('git-reset-hard, git-clean')
  expect(none).toContain('Do not retry the same command unprompted')
  expect(denyReason('x', [])).toContain('(unchecked)')
})
