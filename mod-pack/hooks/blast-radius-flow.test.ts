// The decision flow of Blast Radius through the plugin. The engine is stubbed beneath
// the plugin: `tool.call` for AskUserQuestion (the dialog `$.ui.ask` opens), `process.run`,
// `fs.stat`, `fs.list`, `session.cwd`, and a `tool.call` for Bash and PowerShell that
// records whether a command was let through. No dialog is drawn here: the stub plays the person.

import { test, expect, mock } from 'claude-code/testing'

// What the stub person does when the dialog opens.
type Reply = { say: string } | 'dismiss' | 'throw'

type Fs = { stat?: (path: string) => unknown; list?: (path: string) => unknown[] }

type Config = {
  reply: Reply
  git: (args: string[]) => string | Error
  fs: Fs
  storeDown: boolean // $.store.get throws: the guard itself crashes
  bashThrows: boolean // the command stub throws: the command itself fails
}

const FILE = { kind: 'file', size: 1, mtimeMs: 0, isLink: false }
const DIR = { kind: 'dir', size: 0, mtimeMs: 0, isLink: false }

// `w.cfg` can be changed in the middle of a test: the stubs read it at each call.
// (A second `on('process.run', ...)` in one test would be a repeat, so a test calls `world` once.)
const world = (on: any, init: Partial<Config> = {}) => {
  const w = {
    cfg: { reply: { say: '執行' }, git: () => '', fs: {}, storeDown: false, bashThrows: false, ...init } as Config,
    reached: [] as string[], // commands that got past Blast Radius to the stub below it
    questions: [] as { question: string; header: string; labels: string[] }[],
    runs: [] as { argv: string[]; cwd?: string }[],
    stats: [] as string[],
    lists: [] as string[],
  }
  if (init.storeDown) {
    on('store.get', () => {
      throw new Error('store is down')
    })
  } else {
    mock.store(on)
  }
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', (_$: any, e: any) => {
    w.runs.push({ argv: e.argv, cwd: e.init?.cwd })
    const result = w.cfg.git(e.argv)
    if (result instanceof Error) throw result
    return { value: { exitCode: 0, stdout: result, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', (_$: any, e: any) => {
    const path = slashStyle(e.path)
    w.stats.push(path)
    const stat = w.cfg.fs.stat?.(path)
    if (!stat) throw new Error('ENOENT')
    return { value: stat }
  })
  on('fs.list', (_$: any, e: any) => {
    const path = slashStyle(e.path)
    w.lists.push(path)
    return { value: w.cfg.fs.list?.(path) ?? [] }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    const q = e.questions[0]
    w.questions.push({ question: q.question, header: q.header, labels: q.options.map((o: any) => o.label) })
    const r = w.cfg.reply
    if (r === 'throw') throw new Error('no UI')
    if (r === 'dismiss') return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: r.say } } } as any
  })
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: 'x', content: '', numLines: 0, startLine: 1, totalLines: 0 } } }) as any)
  for (const tool of ['Bash', 'PowerShell'] as const) {
    on('tool.call', { tool }, (_$: any, e: any) => {
      if (w.cfg.bashThrows) throw new Error('the shell died')
      w.reached.push(e.command)
      return { result: { stdout: 'ran', stderr: '', interrupted: false } } as any
    })
  }
  return w
}

const bash = (command: string) => ({ tool: 'Bash' as const, command })
const slash = (args: string) => ({ command: 'mods', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const say = (text: string): Reply => ({ say: text })

// The engine hands the stubs a native path (C:\work\build on Windows). Compare slash-style, without a drive.
const slashStyle = (path: string) => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

const entry = (name: string, kind: 'file' | 'dir' | 'other' = 'file', isLink = false) => ({ name, kind, size: 1, mtimeMs: 0, isLink })

// ---- the decision ----

test('risky command + Proceed: the dialog is shown, then the command runs untouched', async ($, on) => {
  const w = world(on)
  const result: any = await $.tool.call(bash('rm -rf build'))
  expect(w.questions).toHaveLength(1)
  expect(w.reached).toEqual(['rm -rf build'])
  expect(result.deny).toBeUndefined()
  expect(result.result).toEqual({ stdout: 'ran', stderr: '', interrupted: false })
})

test('the dialog: header, exactly two options Proceed and Cancel, the kind and the exact command', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('cd x && git push --force origin main'))
  const [asked] = w.questions
  expect(asked?.header).toBe('危險指令確認')
  expect(asked?.labels).toEqual(['執行', '取消'])
  expect(asked?.question).toContain('git push --force（覆蓋遠端的歷史）')
  expect(asked?.question).toContain('cd x && git push --force origin main')
  expect(asked?.question).toContain('執行後會改變什麼')
  expect(asked?.question.endsWith('要現在執行嗎？選「執行」才會跑，其他選項都當成取消。')).toBe(true)
})

test('risky command + Cancel: denied with a reason for Claude, and the command is never reached', async ($, on) => {
  const w = world(on, { reply: say('取消') })
  const result: any = await $.tool.call(bash('rm -rf build'))
  expect(w.reached).toEqual([])
  expect(w.questions).toHaveLength(1)
  expect(result.deny).toContain('the person cancelled this command (rm-recursive)')
  expect(result.deny).toContain('Do not retry the same command unprompted')
})

test('risky command + dialog dismissed: denied, never reached', async ($, on) => {
  const w = world(on, { reply: 'dismiss' })
  const result: any = await $.tool.call(bash('git reset --hard'))
  expect(w.reached).toEqual([])
  expect(result.deny).toContain('no confirmation was given')
})

test('risky command + nothing can ask (the ask rejects, as in a -p run): denied, never reached', async ($, on) => {
  const w = world(on, { reply: 'throw' })
  const result: any = await $.tool.call(bash('git clean -fd'))
  expect(w.reached).toEqual([])
  expect(result.deny).toContain('no confirmation was given')
  expect(result.deny).toContain('non-interactive')
})

test('risky command + any answer other than the label Proceed: denied', async ($, on) => {
  const w = world(on)
  for (const text of ['sure, go ahead', 'proceed', '', '執行, 取消', ' 執行']) {
    w.cfg.reply = say(text)
    const result: any = await $.tool.call(bash('rm -rf build'))
    expect([text, w.reached]).toEqual([text, []])
    expect(result.deny).toBeDefined()
  }
})

test('safe command: no dialog, no git, no file system look, the command reaches the stub', async ($, on) => {
  const w = world(on, { reply: say('取消') })
  const result: any = await $.tool.call(bash('git status && rm file.txt && ls -la'))
  expect(w.questions).toEqual([])
  expect(w.runs).toEqual([])
  expect(w.stats).toEqual([])
  expect(w.reached).toEqual(['git status && rm file.txt && ls -la'])
  expect(result.deny).toBeUndefined()
})

test('a tool that is not a shell tool is not looked at', async ($, on) => {
  const w = world(on, { reply: say('取消') })
  const result: any = await $.tool.call({ tool: 'Read', file_path: 'rm -rf x' })
  expect(w.questions).toEqual([])
  expect(result.deny).toBeUndefined()
})

test('the PowerShell tool is guarded the same way', async ($, on) => {
  const w = world(on, { reply: say('取消') })
  const denied: any = await $.tool.call({ tool: 'PowerShell', command: 'Remove-Item -Recurse -Force build' })
  expect(denied.deny).toContain('(remove-item)')
  expect(w.reached).toEqual([])

  w.cfg.reply = say('執行')
  await $.tool.call({ tool: 'PowerShell', command: 'Remove-Item -Recurse -Force build' })
  expect(w.reached).toEqual(['Remove-Item -Recurse -Force build'])
})

// ---- the switch ----

test('/mods off blast-radius: a risky command passes at once with no dialog; /mods on asks again', async ($, on) => {
  const w = world(on, { reply: say('取消') })

  const off = await $.command.run(slash('off blast-radius'))
  expect(off.text).toBe('mod-pack: blast-radius is OFF.')
  await $.tool.call(bash('rm -rf build'))
  expect(w.questions).toEqual([])
  expect(w.reached).toEqual(['rm -rf build'])

  await $.command.run(slash('on blast-radius'))
  const denied: any = await $.tool.call(bash('rm -rf dist'))
  expect(w.questions).toHaveLength(1)
  expect(denied.deny).toContain('cancelled')
  expect(w.reached).toEqual(['rm -rf build'])
})

test('the blastRadius setting off: no dialog. A /mods on choice beats the setting.', { options: { blastRadius: false } }, async ($, on) => {
  const w = world(on, { reply: say('取消') })
  await $.tool.call(bash('git reset --hard'))
  expect(w.questions).toEqual([])
  expect(w.reached).toEqual(['git reset --hard'])

  await $.command.run(slash('on blast-radius'))
  const denied: any = await $.tool.call(bash('git reset --hard'))
  expect(denied.deny).toBeDefined()
  expect(w.questions).toHaveLength(1)
})

test('/mods lists Blast Radius ON by default, with its text, and no token or sound flag', async ($, on) => {
  world(on)
  const list = await $.command.run(slash(''))
  expect(list.text).toMatch(/ON\s+blast-radius\s+Blast Radius: asks Proceed or Cancel before a risky shell command/)
  const line = (list.text ?? '').split('\n').find(l => l.includes('blast-radius')) ?? ''
  expect(line).not.toContain('[')
  expect(line).toContain('costs no model tokens')
})

// ---- the preview inside the dialog ----

test('rm -rf: each plain path is looked at; a glob is listed as skipped; entries counted at every level', async ($, on) => {
  const w = world(on, {
    reply: say('取消'),
    fs: {
      stat: path => (path === '/work/build' ? DIR : path === '/work/a.txt' ? FILE : undefined),
      list: path => (path === '/work/build' ? [entry('x.o'), entry('y.o'), entry('sub', 'dir'), entry('lnk', 'other', true)] : path === '/work/build/sub' ? [entry('z.o')] : []),
    },
  })
  await $.tool.call(bash('rm -rf build a.txt gone *.log'))
  const { question } = w.questions[0]!
  expect(question).toContain('build：資料夾，裡面有 5 個項目')
  expect(question).toContain('a.txt：檔案')
  expect(question).toContain('gone：找不到')
  // a glob is not listed one by one; the folder it lies in is looked at instead
  expect(question).toContain('*.log：有萬用字元，沒辦法逐一列出；符合的項目都在 /work 底下')
  // the symbolic link is an entry, and it is not entered
  expect(w.lists).toEqual(['/work/build', '/work/build/sub'])
  expect(w.stats).toEqual(['/work/build', '/work/a.txt', '/work/gone', '/work'])
})

test('rm -rf on a directory with more than 1000 entries: the count is capped and the walk stops', async ($, on) => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => entry(`f${i}`))
  const w = world(on, {
    reply: say('取消'),
    fs: { stat: () => DIR, list: path => (path === '/work/big' ? [...many(600), entry('d1', 'dir'), entry('d2', 'dir')] : many(600)) },
  })
  await $.tool.call(bash('rm -rf big'))
  expect(w.questions[0]?.question).toContain('big：資料夾，裡面有 1000+ 個項目')
  expect(w.lists.length).toBeLessThanOrEqual(3)
})

test('rm -rf on a symbolic link: reported as a link, its target is not listed', async ($, on) => {
  const w = world(on, { reply: say('取消'), fs: { stat: () => ({ ...DIR, isLink: true }) } })
  await $.tool.call(bash('rm -rf shortcut'))
  expect(w.questions[0]?.question).toContain('shortcut：捷徑')
  expect(w.lists).toEqual([])
})

test('an earlier cd: relative paths are looked at in the folder the cd led to', async ($, on) => {
  const w = world(on, { reply: say('取消'), fs: { stat: () => DIR } })
  await $.tool.call(bash('cd elsewhere && rm -rf build'))
  expect(w.questions[0]?.question).toContain('前面先 cd 到 /work/elsewhere，相對路徑以那裡為準。')
  expect(w.questions[0]?.question).toContain('build：資料夾')
  expect(w.stats).toEqual(['/work/elsewhere/build'])
})

test('a cd that cannot be worked out: relative paths are not looked at, absolute ones still are', async ($, on) => {
  const w = world(on, { reply: say('取消'), fs: { stat: () => FILE } })
  await $.tool.call(bash('cd $SOMEWHERE && rm -rf build /tmp/x'))
  expect(w.questions[0]?.question).toContain('cd 用了查不出來的路徑')
  expect(w.stats).toEqual(['/tmp/x'])
})

test('a variable set earlier in the command is filled in, and the dialog shows the real path', async ($, on) => {
  const w = world(on, { reply: say('取消'), fs: { stat: path => (path === '/scratch/out/assets' ? DIR : undefined), list: () => [entry('a.js'), entry('b.css')] } })
  await $.tool.call(bash('cd /repo && npm run build && D=/scratch/out && rm -rf $D/assets && cp -r dist/* $D/'))
  expect(w.questions[0]?.question).toContain('/scratch/out/assets：資料夾，裡面有 2 個項目')
  expect(w.questions[0]?.question).not.toContain('沒有預覽')
  expect(w.stats).toEqual(['/scratch/out/assets'])
})

test('an unset variable is named in the dialog', async ($, on) => {
  const w = world(on, { reply: say('取消') })
  await $.tool.call(bash('rm -rf "$OUT_DIR/assets"'))
  expect(w.questions[0]?.question).toContain('$OUT_DIR/assets：$OUT_DIR 在這串指令裡沒有設定值')
  expect(w.stats).toEqual([])
})

test('vercel --prod: held, the dialog says it goes to production and where it deploys from', async ($, on) => {
  const w = world(on, { reply: say('取消'), fs: { stat: () => DIR } })
  const r = await $.tool.call(bash('D=/scratch/out && (cd $D && vercel deploy --prod --yes 2>&1 | grep Aliased)'))
  const { question } = w.questions[0]!
  expect(question).toContain('原因：發布到正式環境（vercel --prod）')
  expect(question).toContain('會直接發布到正式環境')
  expect(question).toContain('從這個資料夾發布：/scratch/out')
  expect(w.stats).toEqual(['/scratch/out'])
  expect(w.reached).toEqual([])
  expect(JSON.stringify(r)).toContain('deny')
})

test('a preview deploy is not held', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('vercel deploy --yes'))
  expect(w.questions).toEqual([])
  expect(w.reached).toEqual(['vercel deploy --yes'])
})

test('cd /repo && git reset --hard: git runs in /repo, not in the session folder', async ($, on) => {
  const w = world(on, { reply: say('取消'), git: args => (args.includes('status') ? ' M a.ts\n' : '') })
  await $.tool.call(bash('cd /repo && git reset --hard'))
  expect(w.runs.length).toBeGreaterThan(0)
  expect(w.runs.every(r => r.cwd === '/repo')).toBe(true)
})

test('cd to a folder that cannot be worked out && git reset --hard: no git runs, the dialog says why', async ($, on) => {
  const w = world(on, { reply: say('取消') })
  await $.tool.call(bash('cd "$REPO" && git reset --hard'))
  expect(w.runs).toEqual([])
  expect(w.questions[0]?.question).toContain('不知道是哪個 git 資料夾')
})

test('an absolute path is looked at as it is', async ($, on) => {
  const w = world(on, { reply: say('取消'), fs: { stat: () => FILE } })
  await $.tool.call(bash('rm -rf /tmp/x'))
  expect(w.stats).toEqual(['/tmp/x'])
})

test('git reset --hard: runs git status and diff in the session folder, shows count and paths', async ($, on) => {
  const w = world(on, {
    reply: say('取消'),
    git: args => (args.includes('status') ? ' M a.ts\nM  b.ts\n?? new.txt\n' : ' 2 files changed, 3 insertions(+)\n'),
  })
  await $.tool.call(bash('git reset --hard'))
  const { question } = w.questions[0]!
  expect(question).toContain('有 2 個檔案的修改會被蓋掉（還沒 commit')
  expect(question).toContain('   M a.ts')
  expect(question).toContain('2 files changed, 3 insertions(+)')
  expect(question).toContain('另有 1 個沒被 git 追蹤的檔案不會被動到。')
  expect(w.runs.every(r => r.argv[0] === 'git' && r.cwd === '/work')).toBe(true)
})

test('git clean -fd: previews with git clean -n and the same flags, never with force', async ($, on) => {
  const w = world(on, { reply: say('取消'), git: () => 'Would remove build/\nWould remove tmp.log\n' })
  await $.tool.call(bash('git clean -fd'))
  expect(w.questions[0]?.question).toContain('有 2 個沒被 git 追蹤的路徑會被刪掉（用 git clean -n 試跑的結果）')
  const clean = w.runs.find(r => r.argv.includes('clean'))!
  expect(clean.argv.slice(clean.argv.indexOf('clean'))).toEqual(['clean', '-n', '-d'])
})

test('git push --force: branch, upstream, and the commits the remote would lose', async ($, on) => {
  const w = world(on, {
    reply: say('取消'),
    git: args => {
      if (args.includes('--count')) return '2\n'
      if (args.includes('log')) return 'abc1234 fix\ndef5678 add\n'
      return args.includes('@{u}') ? 'origin/main\n' : 'main\n'
    },
  })
  await $.tool.call(bash('git push --force'))
  const { question } = w.questions[0]!
  expect(question).toContain('目前的分支：main，對應的遠端分支：origin/main')
  expect(question).toContain('遠端有 2 個 commit 會消失')
  expect(question).toContain('abc1234 fix')
  expect(w.runs.some(r => r.argv.includes('HEAD..@{u}'))).toBe(true)
})

test('git branch -D and git stash drop get their previews', async ($, on) => {
  const w = world(on, { reply: say('取消'), git: args => (args.includes('stash') ? 'stash@{0}: WIP on main: abc fix\n' : '3\n') })
  await $.tool.call(bash('git branch -D feature'))
  expect(w.questions[0]?.question).toContain('分支 feature：有 3 個 commit 不在目前的分支裡')
  await $.tool.call(bash('git stash drop'))
  expect(w.questions[1]?.question).toContain('目前有 1 筆暫存的修改')
})

test('git options in the command are not passed to the preview: no preview, still asks', async ($, on) => {
  const w = world(on, { reply: say('取消') })
  await $.tool.call(bash('git -c core.fsmonitor=evil -C repo reset --hard'))
  expect(w.runs).toEqual([])
  expect(w.questions[0]?.question).toContain('無法預覽')
})

test('not a git repository or git missing: "no preview available", the dialog is still shown', async ($, on) => {
  const w = world(on, { reply: say('取消'), git: () => new Error('spawn git ENOENT') })
  const result: any = await $.tool.call(bash('git reset --hard'))
  expect(w.questions).toHaveLength(1)
  expect(w.questions[0]?.question).toContain('無法預覽')
  expect(result.deny).toBeDefined()
})

test('preview step throws: the dialog is still shown and the command still waits for the answer', async ($, on) => {
  const w = world(on, {
    reply: say('取消'),
    git: () => new Error('git exploded'),
    fs: {
      stat: () => {
        throw new Error('stat exploded')
      },
    },
  })
  const denied: any = await $.tool.call(bash('git reset --hard && rm -rf build'))
  expect(w.questions).toHaveLength(1)
  expect(w.questions[0]?.question).toContain('無法預覽')
  expect(w.reached).toEqual([])
  expect(denied.deny).toBeDefined()

  w.cfg.reply = say('執行')
  await $.tool.call(bash('git reset --hard'))
  expect(w.questions).toHaveLength(2)
  expect(w.reached).toEqual(['git reset --hard'])
})

test('the previews run only read-only git: status, diff, clean -n, rev-parse, rev-list, log, stash list', async ($, on) => {
  const w = world(on, { reply: say('取消') })
  for (const command of ['git reset --hard', 'git clean -xdf', 'git push -f origin main', 'git checkout -- .', 'git restore .', 'git branch -D a', 'git stash clear']) {
    await $.tool.call(bash(command))
  }
  expect(w.runs.length).toBeGreaterThan(8)
  for (const { argv } of w.runs) {
    expect(argv.slice(0, 4)).toEqual(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false'])
    const [sub = '', ...rest] = argv.slice(4)
    expect(['status', 'diff', 'clean', 'rev-parse', 'rev-list', 'log', 'stash']).toContain(sub)
    if (sub === 'clean') expect(rest).toContain('-n')
    if (sub === 'stash') expect(rest).toEqual(['list'])
    if (sub === 'diff') expect(rest).toContain('--shortstat')
    expect(argv.join(' ')).not.toMatch(/--hard|--force|push|-D\b|\bdrop\b|\bclear\b|-fd|-xdf/)
  }
})

test('several risks in one command: one dialog, every kind named', async ($, on) => {
  const w = world(on, { reply: say('取消') })
  await $.tool.call(bash('rm -rf a && git push -f && git stash clear'))
  expect(w.questions).toHaveLength(1)
  const { question } = w.questions[0]!
  for (const part of ['整個資料夾刪除（rm -r）', 'git push --force', 'git stash drop／clear']) expect(question).toContain(part)
})

// ---- a crash in the guard ----

test('the guard crashes: the .catch handler still asks, so a risky command is not silently allowed', async ($, on) => {
  // $.store.get throws, and the guard reads it first.
  const w = world(on, { reply: say('取消'), storeDown: true })
  const denied: any = await $.tool.call(bash('rm -rf build'))
  expect(w.questions).toHaveLength(1)
  expect(w.questions[0]?.question).toContain('安全檢查自己出錯了')
  expect(w.reached).toEqual([])
  expect(denied.deny).toContain('cancelled')

  w.cfg.reply = say('執行')
  await $.tool.call(bash('rm -rf dist'))
  expect(w.questions).toHaveLength(2)
  expect(w.reached).toEqual(['rm -rf dist'])
})

test('the guard crashes on a safe command: the handler lets it through without asking', async ($, on) => {
  const w = world(on, { reply: say('取消'), storeDown: true })
  await $.tool.call(bash('ls -la'))
  expect(w.questions).toEqual([])
  expect(w.reached).toEqual(['ls -la'])
})

test('the command itself fails after Proceed: the handler does not ask a second time', async ($, on) => {
  const w = world(on, { reply: say('執行'), bashThrows: true })
  await $.tool.call(bash('rm -rf build')).catch(() => undefined)
  expect(w.questions).toHaveLength(1)
})
