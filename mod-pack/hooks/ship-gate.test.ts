import { test, expect } from 'claude-code/testing'

import {
  buildPublishQuestion, codeFiles, commitDeny, describePublish, fingerprintOf, MAX_HITS, parseHits, parseLog, personalTerms, plan, publishDeny, publishTitle, redactUrl,
  shipGate, SKIP_MARKER,
} from './ship-gate'

const kinds = (command: string, cwd: string | undefined = '/work') => plan(command, cwd).publishes.map(p => p.kind)
const commits = (command: string, cwd: string | undefined = '/work') => plan(command, cwd).commits

// ---- plan: commits and the chain --------------------------------------------------

test('a plain git commit is found, in the session folder, not covered, not skipped', () => {
  expect(commits('git commit -m "x"')).toEqual([{ dir: { path: '/work', isKnown: true }, isCovered: false, isSkipped: false }])
})

test('git commit --dry-run is not a commit; other git commands are not either', () => {
  expect(commits('git commit --dry-run')).toEqual([])
  expect(commits('git status && git log --oneline && git add -A')).toEqual([])
  expect(commits('echo git commit')).toEqual([])
})

test('a test before the commit covers it only through &&', () => {
  expect(commits('npm test && git commit -m x')[0]?.isCovered).toBe(true)
  expect(commits('npm test && git add -A && git commit -m x')[0]?.isCovered).toBe(true)
  expect(commits('npm test; git commit -m x')[0]?.isCovered).toBe(false)
  expect(commits('npm test || git commit -m x')[0]?.isCovered).toBe(false)
  expect(commits('npm test | cat && git commit -m x')[0]?.isCovered).toBe(false)
  expect(commits('git commit -m x && npm test')[0]?.isCovered).toBe(false)
  expect(commits('npm test\ngit commit -m x')[0]?.isCovered).toBe(false)
})

test('the skip marker marks a commit as skipped', () => {
  expect(commits(`git commit -m x # ${SKIP_MARKER}`)[0]?.isSkipped).toBe(true)
  expect(commits(`git commit -m x # ${SKIP_MARKER}: docs only`)[0]?.isSkipped).toBe(true)
})

test('cd and git -C set the folder; a path that cannot be followed makes it unknown', () => {
  expect(commits('cd /repo && git commit -m x')[0]?.dir).toEqual({ path: '/repo', isKnown: true })
  expect(commits('cd "C:/Users/a b/repo" && git commit -m x')[0]?.dir).toEqual({ path: 'C:/Users/a b/repo', isKnown: true })
  expect(commits('cd sub && git commit -m x', '/work')[0]?.dir).toEqual({ path: '/work/sub', isKnown: true })
  expect(commits('cd /a && cd /b && git commit -m x')[0]?.dir.path).toBe('/b')
  expect(commits('git -C /repo commit -m x')[0]?.dir).toEqual({ path: '/repo', isKnown: true })
  expect(commits('git -c user.name=x -C /repo commit -m x')[0]?.dir.path).toBe('/repo')
  expect(commits('cd $REPO && git commit -m x')[0]?.dir.isKnown).toBe(false)
  expect(commits('cd ~/repo && git commit -m x')[0]?.dir.isKnown).toBe(false)
  expect(commits('cd - && git commit -m x')[0]?.dir.isKnown).toBe(false)
  expect(commits('git --git-dir=/x/.git commit -m x')[0]?.dir.isKnown).toBe(false)
  expect(commits('cd $REPO && cd /ok && git commit -m x')[0]?.dir.isKnown).toBe(false)
})

test('PowerShell forms: ; separators and Set-Location', () => {
  expect(commits('Set-Location C:/repo; git add .; git commit -m x')[0]?.dir.path).toBe('C:/repo')
})

test('with no session folder known, a relative cd stays relative and the folder is still known', () => {
  expect(plan('cd sub && git commit -m x', undefined).commits[0]?.dir).toEqual({ path: 'sub', isKnown: true })
  expect(plan('git commit -m x', undefined).commits[0]?.dir).toEqual({ path: undefined, isKnown: true })
})

// ---- plan: tests ------------------------------------------------------------------

const RUNS = [
  'npm test', 'npm t', 'npm run test', 'npm run test:unit', 'pnpm test', 'yarn test', 'bun run typecheck', 'npm run check',
  'npx tsc -p .', 'npx --no-install tsc -p .', 'tsc --noEmit', 'node_modules/.bin/tsc', 'npx vitest run', 'jest', 'npx jest --ci', 'mocha',
  'node --test', 'node --test-reporter=spec --test', 'pytest -q', 'python -m pytest', 'python3 -m unittest', 'cargo test', 'cargo check', 'go test ./...',
  'go vet ./...', 'dotnet test', 'mvn test', 'mvn -q verify', './gradlew test', 'make test', 'deno test', 'claude plugin test .', 'claude plugin validate .',
  'bundle exec rspec', 'Invoke-Pester',
]
const NOT_RUNS = ['npm install', 'npm run build', 'npm run dev', 'echo npm test', 'grep tsc file', 'git commit -m "npm test"', 'cat jest.config.js', 'pytest-cov-report', 'make build', 'go build ./...']

test('known test, type-check and validator runners are found', () => {
  for (const command of RUNS) expect([command, plan(command, '/w').tests.length]).toEqual([command, 1])
})

test('commands that only look like a test are not found', () => {
  for (const command of NOT_RUNS) expect([command, plan(command, '/w').tests.length]).toEqual([command, 0])
})

test('a test run keeps the folder of the cd before it', () => {
  const [run] = plan('cd /repo && npm test', '/w').tests
  expect(run).toEqual({ dir: { path: '/repo', isKnown: true }, name: 'npm test' })
})

test('a test name is cut to 80 characters', () => {
  expect(plan(`npm test -- ${'x'.repeat(200)}`, '/w').tests[0]?.name.length).toBe(80)
})

// ---- plan: publishes --------------------------------------------------------------

test('git push is a publish; a dry run is not', () => {
  expect(kinds('git push')).toEqual(['push'])
  expect(kinds('git push -u origin main')).toEqual(['push'])
  expect(kinds('git push --dry-run')).toEqual([])
  expect(kinds('git push -n')).toEqual([])
  expect(kinds('git pull')).toEqual([])
})

test('quotes are read: a push named in a commit message is not a push; one in bash -c is', () => {
  expect(kinds('git commit -m "docs: say when to run git push; and gh repo create"')).toEqual([])
  expect(kinds("echo 'git push --force'")).toEqual([])
  expect(kinds('bash -c "cd /repo && git push"')).toEqual(['push'])
  expect(plan('bash -c "cd /repo && git push"', '/w').publishes[0]?.dir).toEqual({ path: '/repo', isKnown: true })
  // a test before `&&` still covers the commit after it, inside a wrapper too
  expect(plan('sh -c "npm test && git commit -m x"', '/w').commits[0]?.isCovered).toBe(true)
})

test('git push names its remote when it has one, and runs in the cd folder', () => {
  const [push] = plan('cd /repo && git push origin main', '/w').publishes
  expect(push).toMatchObject({ kind: 'push', remote: 'origin', dir: { path: '/repo', isKnown: true } })
  expect(plan('git push', '/w').publishes[0]?.remote).toBeUndefined()
})

test('gh repo create: the visibility flag and whether it pushes the folder', () => {
  const [a] = plan('gh repo create me/x --public --source=. --remote=origin --push', '/w').publishes
  expect(a).toMatchObject({ kind: 'create', flag: '--public', hasSource: true })
  const [b] = plan('gh repo create me/x --private', '/w').publishes
  expect(b).toMatchObject({ kind: 'create', flag: '--private', hasSource: false })
  expect(plan('gh repo create', '/w').publishes[0]?.flag).toBeUndefined()
})

test('gh api pages: a change is held, a read is not', () => {
  expect(kinds('gh api -X POST repos/o/r/pages -f "source[branch]=main" -f "source[path]=/docs"')).toEqual(['pages'])
  expect(kinds('gh api --method PUT repos/o/r/pages -f cname=x')).toEqual(['pages'])
  expect(kinds('gh api --method=POST repos/o/r/pages')).toEqual(['pages'])
  expect(kinds('gh api -XPOST repos/o/r/pages')).toEqual(['pages'])
  expect(kinds('gh api repos/o/r/pages -f source[branch]=main')).toEqual(['pages'])
  expect(kinds('gh api repos/o/r/pages')).toEqual([])
  expect(kinds('gh api repos/o/r/pages/builds/latest --jq .status')).toEqual([])
  expect(kinds('gh api -X GET repos/o/r/pages')).toEqual([])
  expect(kinds('gh api repos/o/r/issues -f title=x')).toEqual([])
})

test('gh repo edit --visibility public is held; private is not', () => {
  expect(kinds('gh repo edit o/r --visibility public')).toEqual(['visibility'])
  expect(kinds('gh repo edit o/r --visibility=public --accept-visibility-change-consequences')).toEqual(['visibility'])
  expect(kinds('gh repo edit o/r --visibility private')).toEqual([])
  expect(kinds('gh repo edit o/r --description x')).toEqual([])
  expect(kinds('gh repo view o/r')).toEqual([])
})

test('several publish parts in one command are all found, in order', () => {
  expect(kinds('git push && gh api -X POST repos/o/r/pages -f a=b')).toEqual(['push', 'pages'])
})

test('a command with nothing of interest gives an empty plan', () => {
  expect(plan('ls -la && echo hi', '/w')).toEqual({ commits: [], publishes: [], tests: [] })
})

// ---- fingerprint, code files ------------------------------------------------------

test('the same text gives the same fingerprint; any change gives another', () => {
  expect(fingerprintOf('a', 'b')).toBe(fingerprintOf('a', 'b'))
  expect(fingerprintOf('a', 'b')).not.toBe(fingerprintOf('a', 'c'))
  expect(fingerprintOf('ab', '')).not.toBe(fingerprintOf('a', 'b'))
  expect(fingerprintOf('', '')).toBe(fingerprintOf('', ''))
})

test('codeFiles reads git status lines and keeps only code files', () => {
  const status = [' M src/a.ts', 'M  b.py', '?? c.md', 'A  d.html', 'R  old.js -> new.js', '?? "odd name.rs"', '!! ignored.ts', ' M README.md', ' M x.json'].join('\n')
  expect(codeFiles(status)).toEqual(['src/a.ts', 'b.py', 'new.js', 'odd name.rs'])
})

test('a docs-only change has no code files; empty status has none', () => {
  expect(codeFiles(' M docs/index.html\n?? notes.md\n M style.css\n')).toEqual([])
  expect(codeFiles('')).toEqual([])
})

// ---- commit text ------------------------------------------------------------------

test('commitDeny names the files, the last check and the skip marker', () => {
  const text = commitDeny(['a.ts', 'b.ts'], { command: 'npm test', at: 0, fingerprint: 'x' }, 7 * 60_000)
  expect(text).toContain('2 code files (a.ts, b.ts)')
  expect(text).toContain('"npm test", 7 min ago')
  expect(text).toContain(`# ${SKIP_MARKER}`)
  expect(commitDeny(['a.ts'], undefined, 0)).toContain('No test, type check or validator has passed in this session.')
  expect(commitDeny(['a.ts'], undefined, 0)).toContain('1 code file (a.ts)')
})

test('commitDeny cuts a long file list and survives an unreadable clock', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(n => `${n}.ts`)
  const text = commitDeny(files, { command: 'tsc', at: 0, fingerprint: 'x' }, NaN)
  expect(text).toContain('a.ts, b.ts, c.ts, d.ts, e.ts, and 2 more')
  expect(text).not.toContain('NaN')
})

// ---- terms ------------------------------------------------------------------------

test('personalTerms: the user name in a Windows or Unix home path', () => {
  expect(personalTerms({ path: 'C:\\Users\\alice\\Downloads\\repo', email: undefined, extra: undefined })).toEqual(['alice'])
  expect(personalTerms({ path: 'C:/Users/alice/repo', email: undefined, extra: undefined })).toEqual(['alice'])
  expect(personalTerms({ path: '/home/alice/repo', email: undefined, extra: undefined })).toEqual(['alice'])
  expect(personalTerms({ path: '/work/repo', email: undefined, extra: undefined })).toEqual([])
  expect(personalTerms({ path: undefined, email: undefined, extra: undefined })).toEqual([])
})

test('personalTerms: generic and short home names are not searched', () => {
  for (const name of ['Public', 'Default', 'runner', 'ab', 'root']) expect(personalTerms({ path: `C:/Users/${name}/x`, email: undefined, extra: undefined })).toEqual([])
})

test('personalTerms: a git e-mail counts unless it is a noreply address', () => {
  expect(personalTerms({ path: undefined, email: 'me@example.com', extra: undefined })).toEqual(['me@example.com'])
  expect(personalTerms({ path: undefined, email: '1+me@users.noreply.github.com', extra: undefined })).toEqual([])
  expect(personalTerms({ path: undefined, email: 'not-an-email', extra: undefined })).toEqual([])
  expect(personalTerms({ path: undefined, email: '', extra: undefined })).toEqual([])
})

test('personalTerms: the setting is split on commas and lines, trimmed, deduplicated, and capped at 10', () => {
  expect(personalTerms({ path: undefined, email: undefined, extra: ' Jane Doe, acme-corp\nx, jane doe ,' })).toEqual(['Jane Doe', 'acme-corp'])
  expect(personalTerms({ path: undefined, email: undefined, extra: 42 })).toEqual([])
  const many = Array.from({ length: 15 }, (_, i) => `term${i}`).join(',')
  expect(personalTerms({ path: undefined, email: undefined, extra: many })).toHaveLength(10)
})

// ---- facts ------------------------------------------------------------------------

test('parseHits cuts git grep lines to path:line: text and caps the list', () => {
  const lines = Array.from({ length: MAX_HITS + 3 }, (_, i) => `HEAD:docs/p${i}.md:${i + 1}:  path C:\\Users\\alice\\x`)
  const { total, shown } = parseHits(lines.join('\n'))
  expect(total).toBe(MAX_HITS + 3)
  expect(shown).toHaveLength(MAX_HITS)
  expect(shown[0]).toBe('docs/p0.md:1: path C:\\Users\\alice\\x')
  expect(parseHits('').total).toBe(0)
  expect(parseHits(undefined).total).toBe(0)
})

test('parseHits cuts a long line to 80 characters of text', () => {
  const [line] = parseHits(`HEAD:a.md:3:${'y'.repeat(300)}`).shown
  expect(line).toBe(`a.md:3: ${'y'.repeat(80)}`)
})

test('parseLog counts commits, lists addresses that are not noreply, counts personal strings', () => {
  const text = ['a1\t1+me@users.noreply.github.com\t1+me@users.noreply.github.com\tfix', 'b2\tme@home.net\tnoreply@github.com\tadd alice path', 'c3\tme@home.net\tme@home.net\tx'].join('\n')
  expect(parseLog(text, ['alice'])).toEqual({ count: 3, offAddresses: ['me@home.net'], termCommits: 1 })
  expect(parseLog(text, ['ME@HOME.NET']).termCommits).toBe(2)
  expect(parseLog('', ['x'])).toEqual({ count: 0, offAddresses: [], termCommits: 0 })
  expect(parseLog(undefined, [])).toEqual({ count: 0, offAddresses: [], termCommits: 0 })
})

test('redactUrl hides a credential in a URL and leaves a plain URL alone', () => {
  expect(redactUrl('https://user:ghp_secret@github.com/o/r.git')).toBe('https://***@github.com/o/r.git')
  expect(redactUrl('https://github.com/o/r.git')).toBe('https://github.com/o/r.git')
  expect(redactUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git')
})

const base = { kind: 'push' as const, hasSource: false, isFolderKnown: true, terms: [] as string[], grepRan: false }

test('describePublish for a push: remote, visibility, commits, addresses, hits', () => {
  const lines = describePublish({
    ...base,
    remote: 'origin',
    url: 'https://tok@github.com/o/r.git',
    visibility: 'PUBLIC',
    terms: ['alice'],
    log: 'a1\tme@home.net\tme@home.net\tfix\nb2\tme@home.net\tme@home.net\tx',
    hits: 'HEAD:README.md:4:see C:\\Users\\alice\\x',
    grepRan: true,
  })
  expect(lines).toEqual([
    '推送到遠端 origin：https://***@github.com/o/r.git（公開 repo）',
    '有 2 個 commit 還沒推上去。',
    'commit 的作者或提交者信箱不是 noreply 信箱（推上去會看得到）：me@home.net',
    '個人資訊字串（alice）：最新 commit 的文字檔裡有 1 行：',
    '  README.md:4: see C:\\Users\\alice\\x',
    '圖片等二進位檔沒有搜尋。',
  ])
})

test('describePublish for a clean push says so, with no hit lines', () => {
  const lines = describePublish({ ...base, remote: 'origin', url: 'u', visibility: 'private', terms: ['alice'], log: 'a1\t1+m@users.noreply.github.com\t1+m@users.noreply.github.com\tx', hits: '', grepRan: true })
  expect(lines).toContain('推送到遠端 origin：u（私有 repo）')
  expect(lines).toContain('有 1 個 commit 還沒推上去。')
  expect(lines).toContain('每個 commit 的作者和提交者信箱都是 noreply 信箱。')
  expect(lines).toContain('個人資訊字串（alice）：最新 commit 的文字檔裡沒有找到。')
})

test('describePublish names what it could not read', () => {
  const lines = describePublish({ ...base, remote: 'origin', terms: ['alice'] })
  expect(lines).toContain('推送到遠端 origin：讀不到網址（讀不到這個 repo 是公開還是私有）')
  expect(lines).toContain('還沒推上去的 commit：列不出來。')
  expect(lines.join('\n')).toContain('沒有檢查（git grep 失敗，或還沒有任何 commit）')
})

test('describePublish with no terms says there was nothing to search for', () => {
  expect(describePublish({ ...base, remote: 'origin', log: '' }).join('\n')).toContain('沒有可以搜尋的字')
})

test('describePublish for an unknown folder says nothing was looked at', () => {
  expect(describePublish({ ...base, isFolderKnown: false })).toEqual(['查不出這個指令是在哪個資料夾執行（cd 或 git -C 後面用了變數或 ~），所以什麼都沒有檢查。'])
})

test('describePublish for create, pages and visibility', () => {
  expect(describePublish({ ...base, kind: 'create', flag: '--public', hasSource: true, terms: ['alice'], hits: '', grepRan: true }).join('\n')).toContain('會建立一個新的 repo：--public；並把本機資料夾推上去')
  expect(describePublish({ ...base, kind: 'create' })[0]).toContain('指令沒寫公開或私有')
  expect(describePublish({ ...base, kind: 'pages', visibility: 'PUBLIC' })[0]).toBe('會更改 GitHub Pages：把 repo 裡的檔案當成網頁公開（這個 repo 是公開）')
  expect(describePublish({ ...base, kind: 'visibility', visibility: 'PRIVATE' })[0]).toBe('會把 repo 改成公開（現在是私有）')
  // create without a source does not search the tree
  expect(describePublish({ ...base, kind: 'create', flag: '--private', terms: ['alice'] }).join('\n')).not.toContain('個人資訊字串')
})

test('the dialog text: header words, the command, the facts, the question', () => {
  const text = buildPublishQuestion('git push', ['push'], ['remote origin: u'])
  expect(text).toContain('這個指令先被擋下來，等你確認（Ship Gate 推送前檢查）。原因：git push（把 commit 推到遠端）。')
  expect(text).toContain('  git push')
  expect(text).toContain('  remote origin: u')
  expect(text.endsWith('要現在執行嗎？選「執行」才會跑，其他選項都當成取消。')).toBe(true)
  expect(buildPublishQuestion('x'.repeat(500), ['push'], [])).toContain(`${'x'.repeat(400)}...`)
  for (const kind of ['push', 'create', 'pages', 'visibility'] as const) expect(publishTitle(kind).length).toBeGreaterThan(0)
})

test('publishDeny tells a cancel from no answer, and both warn against a silent retry', () => {
  expect(publishDeny('Cancel', ['push'])).toContain('the person cancelled this command (push)')
  expect(publishDeny(undefined, ['push', 'pages'])).toContain('no confirmation was given for this command (push, pages)')
  expect(publishDeny('Cancel', ['push'])).toContain('Do not retry the same command unprompted')
})

test('the feature entry: id, default, no tokens, no sound, and the /mods line', () => {
  expect(shipGate.id).toBe('ship-gate')
  expect(shipGate.defaultOn).toBe(true)
  expect(shipGate.usesModel).toBe(false)
  expect(shipGate.hasSound).toBeUndefined()
  expect(shipGate.last?.(undefined)).toBeUndefined()
  expect(shipGate.last?.({ gate: 'held: push (cancelled)', test: { command: 'npm test', at: 1, fingerprint: 'f' } })).toBe('held: push (cancelled); last passing check: npm test')
  expect(shipGate.last?.({ test: { command: 'tsc', at: 1, fingerprint: 'f' } })).toBe('last passing check: tsc')
})
