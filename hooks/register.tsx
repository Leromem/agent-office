import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Flow, Panel, Phase, PlannedTask } from '../types'

const flow = atom({ plugin: 'agent-office', key: 'flow' } as const, null)
const agents = atom({ plugin: 'agent-office', key: 'agents' } as const, [])
const panel = atom({ plugin: 'agent-office', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  autoOpenedFor: '',
})
const now = atom({ plugin: 'agent-office', key: 'now' } as const, 0)

const TOOL = 'mcp__agent-office__progress'
const STEP_TOOL = 'mcp__agent-office__step'
const PANE = 'savvy-agents'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: Phase
  finished?: boolean
  tasks?: { title?: string; tier?: string; after?: number[] }[]
}

// ---------------------------------------------------------------------------
// Language: the `language` option, else Claude Code's `language` setting, else the
// process locale; English when nothing says Russian.

type Lang = 'en' | 'ru'

const STRINGS = {
  en: {
    pane: 'Agents',
    cost: 'Cost',
    tokens: 'Tokens',
    time: 'Time',
    collapse: 'Collapse',
    expand: 'Expand',
    running: 'Running',
    finished: 'Finished',
    planned: 'Planned',
    empty: 'No subagents yet.',
    round: 'round',
    failed: 'error',
    after: 'after',
    tokensWord: 'tokens',
    agentsCount: 'agents',
    isRunning: 'running',
    isFinished: 'finished',
    isPlanned: 'planned',
    opened: 'Agents panel opened.',
    closed: 'Agents panel closed.',
    done: 'Done',
    plan: 'Plan',
    design: 'Design',
    tasks: 'Tasks',
    review: 'Review',
    busy: 'running',
    workers: 'Workers',
    openWindow: 'Open window',
    windowOpened: 'Workers window opened.',
    windowFallback: 'No Edge or Chrome found: opened in the default browser.',
    windowFailed: 'Could not open the workers window.',
    compactWord: 'Compact',
    fullWord: 'Full',
    waiting: 'Waiting for the mod…',
    windowDesc: 'Live view of the subagents working on the current flow.',
  },
  ru: {
    pane: 'Агенты',
    cost: 'Стоимость',
    tokens: 'Токены',
    time: 'Время',
    collapse: 'Свернуть',
    expand: 'Развернуть',
    running: 'Работают',
    finished: 'Завершены',
    planned: 'Запланированы',
    empty: 'Субагентов пока нет.',
    round: 'раунд',
    failed: 'ошибка',
    after: 'после',
    tokensWord: 'токенов',
    agentsCount: 'агентов',
    isRunning: 'работает',
    isFinished: 'завершён',
    isPlanned: 'запланирована',
    opened: 'Панель агентов открыта.',
    closed: 'Панель агентов закрыта.',
    done: 'Готово',
    plan: 'План',
    design: 'Дизайн',
    tasks: 'Задачи',
    review: 'Ревью',
    busy: 'в работе',
    workers: 'Работники',
    openWindow: 'Открыть окно',
    windowOpened: 'Окно работников открыто.',
    windowFallback: 'Edge и Chrome не найдены: открыто в браузере по умолчанию.',
    windowFailed: 'Не удалось открыть окно работников.',
    compactWord: 'Компактно',
    fullWord: 'Полно',
    waiting: 'Ожидание мода…',
    windowDesc: 'Работа субагентов текущего потока в реальном времени.',
  },
} as const

// Module scope is fine here: session.start sets it again on every (re)load.
let lang: Lang = 'en'
const tr = () => STRINGS[lang]

const isRussian = (v: unknown): boolean => typeof v === 'string' && /^(ru|russian|рус)/i.test(v.trim())

async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'en' || option === 'ru') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (typeof settings.language === 'string' && settings.language.trim()) return isRussian(settings.language) ? 'ru' : 'en'
  } catch {
    // No settings: fall through to the locale.
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  return isRussian(locale) ? 'ru' : 'en'
}

const blank = (): Flow => ({
  title: 'savvy-flow',
  total: 0,
  done: 0,
  running: 0,
  phase: 'plan',
  isFinished: false,
  tasks: [],
})

const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev || prev.isFinished || (input.title !== undefined && input.title.trim() !== prev.title)

const cleanTasks = (tasks: ProgressInput['tasks']): PlannedTask[] | undefined =>
  tasks
    ?.filter(t => t.title?.trim())
    .map(t => ({
      title: (t.title ?? '').trim(),
      tier: (t.tier ?? '').replace(/^savvy-/, '').trim().toLowerCase(),
      after: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0),
    }))

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const tasks = cleanTasks(input.tasks) ?? base.tasks
  const total = Math.max(0, Math.round(input.total ?? (input.tasks ? tasks.length : base.total)))
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? base.done)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    title: input.title?.trim() || base.title,
    total,
    done,
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    tasks,
  }
}

const label = (f: Flow): string => {
  const s = tr()
  if (f.isFinished) return s.done
  if (f.phase === 'plan') return s.plan
  if (f.phase === 'design') return s.design
  const count = f.total ? `${f.done}/${f.total}` : `${f.running} ${s.busy}`
  return `${f.phase === 'review' ? s.review : s.tasks} ${count}`
}

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// The whole row is one SVG: the desktop wraps sibling elements onto new lines,
// so title, bar, percent and the crab live in one drawing; only the count and
// the dismiss are Buttons beside it.
const H = 22
const BAR_H = 16
const CRAB_W = 26
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

const rowSvg = (f: Flow, W: number, isWorking: boolean): string => {
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(f.title, 13, Math.max(60, W * 0.4))
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  const color = f.isFinished ? DONE : ACCENT
  const y0 = (H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratio(f))
  const runW = f.total ? Math.round((BAR_W * Math.min(f.total, f.done + f.running)) / f.total) : 0
  const dots: string[] = []

  // Dithered fill: sparse at the start, dense toward the head.
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  // Handed to workers, not yet accepted: a faint second layer.
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }

  const ticks: string[] = []
  for (let i = 1; i < f.total; i++) {
    const x = Math.round((BAR_W * i) / f.total)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const text = label(f)
  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const percent = `${Math.round(ratio(f) * 100)}%`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
/* Pixels twinkle in four out-of-phase groups; a finished bar settles to a slow glow. */
.t0,.t1,.t2,.t3{animation:tw ${f.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${f.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${f.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${f.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${f.isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(W - CRAB_W + 1, 0, 'other', false, isWorking, 0.8)}
</svg>`
}

const barText = (f: Flow, width: number): string => {
  const filled = Math.round(width * ratio(f))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// ---------------------------------------------------------------------------
// Agents panel: every subagent of the session, plus the tasks the flow planned.

const TIER_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  other: '#888780',
}

// What each savvy tier runs on, for planned tasks that have no run yet.
const colorOf = (tier: string): string => TIER_COLOR[tier] ?? '#888780'

const TIER_MODEL: Record<string, string> = {
  fable: 'Fable · high',
  heavy: 'Opus · xhigh',
  careful: 'Sonnet · high',
  medium: 'Sonnet · medium',
  light: 'Haiku · low',
}

// USD per million tokens: input, output, cache read, cache write (5-minute TTL).
// The engine reports tokens, not money, so the panel's cost is an estimate.
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/fable|mythos/, [10, 50, 0.25, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus/, [5, 25, 0.5, 6.25]],
  [/sonnet/, [2, 10, 0.2, 2.5]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string): [number, number, number, number] =>
  PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 5]

const costOf = (model: string, u: Usage): number => {
  const [i, o, r, w] = priceOf(model)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

const windowOf = (model: string): number => (/haiku/i.test(model) ? 200_000 : 1_000_000)

// `savvy-careful`, or `savvy-flow:savvy-careful` when the agents ship in a plugin.
const tierOf = (type: string): string => {
  const bare = type.replace(/^[^:]*:/, '')
  const t = bare.replace(/^savvy-/, '').toLowerCase()
  return t in TIER_COLOR && bare.startsWith('savvy-') ? t : 'other'
}

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

type Planned = PlannedTask & { n: number }

const plannedOf = (f: Flow | null, list: AgentRun[]): Planned[] => {
  if (!f || f.isFinished) return []
  const started = new Set(list.map(a => norm(a.description)))
  return (f.tasks ?? []).map((t, i) => ({ ...t, n: i + 1 })).filter(t => !started.has(norm(t.title)))
}

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// --- desktop drawings: each row is one SVG, as the band above the prompt is.

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per tier.
// The body keeps the brand clay; the tier's color lives in the costume's accent.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

// Pixel office worker, one look per kind of task (`role`); the shirt is the tier's color.
const SKIN = '#F1C9A5'
const OFFICE_HAIR: Record<string, string> = {
  fable: '#E07A5F', heavy: '#6B4226', careful: '#222222', medium: '#222222', light: '#6B4226', explore: '#8A5A2B', other: '#444444',
}

// The kind of work, guessed from the task title. First match wins; no match is a typist.
const ROLE_WORDS: [string, RegExp][] = [
  ['paint', /\b(design|ui|ux|style|css|page|layout|logo|icon|visual|theme|landing|mockup)/i],
  ['build', /\b(build|refactor|migrat|install|deploy|implement|fix|patch|rewrite|port|upgrade)/i],
  ['test', /\b(test|review|audit|check|verif|lint|debug|qa)/i],
  ['read', /\b(explor|search|read(?!me)|find|research|scan|investigat|analy[sz]|look)/i],
  ['write', /\b(doc|readme|write|report|note|copy|draft|summar|changelog)/i],
]
const roleOf = (text: string): string => ROLE_WORDS.find(([, re]) => re.test(text))?.[0] ?? 'type'

// Animated parts get a class (`la`/`lb` typing hands, `tb` thought bubble, `brush`, `dab`, `ham`,
// `spk`, `mag`, `pg`, `pen`, `zz`); `.run` in CRAB_CSS moves them, otherwise they sit still.
const officeWorker = (f: Fill, t: string, costume: string, role = 'type', mark = ''): void => {
  const head = (hair: string) => { f(10, 3, 10, 2, hair); f(10, 5, 10, 7, SKIN); f(12, 7, 2, 2, INK, 'ey'); f(16, 7, 2, 2, INK, 'ey') }
  const desk = () => { f(2, 18, 26, 3, '#8B5A2B'); f(4, 21, 2, 6, '#6B4420'); f(24, 21, 2, 6, '#6B4420') }
  const legs = () => { f(10, 21, 4, 6, '#3D405B'); f(16, 21, 4, 6, '#3D405B') }
  const hair = OFFICE_HAIR[costume] ?? '#444444'
  if (role === 'paint') {
    head('#6B4226'); f(9, 1, 12, 2, '#C0392B'); f(14, 0, 2, 1, '#C0392B')
    f(8, 12, 14, 9, t); legs()
    f(25, 8, 1, 19, '#8B5A2B'); f(21, 5, 8, 9, '#FFFFFF')
    f(22, 6, 2, 2, '#E63946', 'dab'); f(25, 8, 2, 2, '#4CC9F0', 'dab2'); f(23, 10, 2, 2, '#F5C542', 'dab3')
    f(2, 15, 5, 3, '#C79A6B'); f(3, 15, 1, 1, '#E63946'); f(5, 16, 1, 1, '#4CC9F0')
    f(22, 13, 5, 2, SKIN, 'brush'); f(26, 10, 1, 4, '#8B5A2B', 'brush'); f(26, 9, 1, 1, '#E63946', 'brush')
  } else if (role === 'build') {
    head('#6B4226'); f(9, 1, 12, 3, '#F5C542'); f(8, 4, 14, 1, '#F5C542')
    f(8, 12, 14, 9, t); f(8, 15, 14, 1, '#FFFFFF'); legs(); f(2, 15, 5, 3, SKIN)
    f(24, 22, 6, 5, '#B4572F'); f(24, 24, 6, 1, '#7A3A1E')
    f(23, 13, 2, 7, '#8B5A2B', 'ham'); f(21, 10, 6, 3, '#9AA5B1', 'ham')
    f(25, 20, 1, 1, '#FFFFFF', 'spk'); f(27, 19, 1, 1, '#F5C542', 'spk'); f(23, 19, 1, 1, '#FFFFFF', 'spk')
  } else if (role === 'test') {
    head(hair); f(7, 12, 16, 7, t); desk()
    f(8, 16, 14, 2, '#FFFFFF'); f(5, 16, 3, 3, SKIN); f(22, 16, 3, 3, SKIN)
    f(15, 12, 5, 5, '#8ECAE6', 'mag'); f(14, 11, 7, 1, '#444444', 'mag'); f(14, 17, 7, 1, '#444444', 'mag')
    f(14, 12, 1, 5, '#444444', 'mag'); f(20, 12, 1, 5, '#444444', 'mag'); f(20, 17, 2, 2, '#8B5A2B', 'mag')
  } else if (role === 'read') {
    head('#8A5A2B'); f(11, 6, 4, 1, INK); f(15, 6, 4, 1, INK)
    f(7, 12, 16, 7, t); desk()
    f(7, 14, 7, 4, '#FFFFFF'); f(16, 14, 7, 4, '#FFFFFF'); f(14, 14, 2, 4, '#7A3A1E'); f(16, 14, 6, 4, '#E0E1DD', 'pg')
    f(5, 16, 3, 3, SKIN); f(22, 16, 3, 3, SKIN)
  } else if (role === 'write') {
    head('#E07A5F'); f(7, 12, 16, 7, t); desk()
    f(9, 14, 9, 5, '#FFFFFF'); f(10, 15, 6, 1, '#9AA5B1'); f(10, 17, 5, 1, '#9AA5B1'); f(5, 16, 3, 3, SKIN)
    f(18, 15, 1, 4, '#F5C542', 'pen'); f(18, 19, 1, 1, INK, 'pen'); f(18, 17, 4, 3, SKIN, 'pen')
  } else {
    head(hair); f(7, 12, 16, 7, t); desk()
    f(10, 14, 10, 4, '#9AA5B1'); f(12, 15, 6, 1, '#6E7A86')
    f(5, 16, 3, 3, SKIN, 'la'); f(22, 16, 3, 3, SKIN, 'lb')
    f(21, 0, 8, 5, '#FFFFFF', 'tb'); f(22, 2, 1, 1, INK, 'tb'); f(24, 2, 1, 1, INK, 'tb'); f(26, 2, 1, 1, INK, 'tb')
  }
  if (mark === 'done') {
    f(2, 0, 9, 8, '#52B788')
    for (const [x, y] of [[4, 4], [5, 5], [6, 4], [7, 3], [8, 2]]) f(x ?? 0, y ?? 0, 1, 1, '#FFFFFF')
  }
  if (mark === 'sleep') { f(22, 1, 4, 1, '#FFFFFF', 'zz'); f(24, 2, 1, 1, '#FFFFFF', 'zz'); f(22, 3, 4, 1, '#FFFFFF', 'zz') }
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Only a running
// worker moves; finished and planned ones sit still.
const CRAB_CSS = `<style>
.run g{transform-box:fill-box}
.tb,.spk{opacity:0}
.run .la{animation:type .4s steps(1) infinite}.run .lb{animation:type .4s steps(1) infinite -.2s}
.run .tb{animation:think 1s steps(1) infinite}
.run .brush{transform-origin:0 100%;animation:brush .8s ease-in-out infinite}
.run .dab{animation:dab 2.4s steps(1) infinite}.run .dab2{animation:dab 2.4s steps(1) infinite -.8s}.run .dab3{animation:dab 2.4s steps(1) infinite -1.6s}
.run .ham{transform-origin:50% 100%;animation:ham .6s ease-in infinite}
.run .spk{animation:spk .6s steps(1) infinite}
.run .mag{animation:mag 1.6s ease-in-out infinite}
.run .pg{transform-origin:0 50%;animation:pg 1.4s steps(1) infinite}
.run .pen{animation:pen .5s steps(1) infinite}
.zz{animation:zz 2.4s ease-in-out infinite}
@keyframes type{50%{transform:translateY(-2px)}}
@keyframes think{0%,40%{opacity:0}50%,100%{opacity:1}}
@keyframes brush{0%,100%{transform:rotate(-12deg)}50%{transform:rotate(14deg)}}
@keyframes dab{0%{opacity:0}33%,100%{opacity:1}}
@keyframes ham{0%{transform:rotate(-55deg)}60%,100%{transform:rotate(25deg)}}
@keyframes spk{0%,55%{opacity:0}60%,100%{opacity:1}}
@keyframes mag{0%,100%{transform:translateX(0)}50%{transform:translateX(-8px)}}
@keyframes pg{0%{transform:scaleX(1)}50%{transform:scaleX(-1)}}
@keyframes pen{50%{transform:translate(1px,1px)}}
@keyframes zz{0%{opacity:0;transform:translateY(3px)}50%{opacity:1}100%{opacity:0;transform:translateY(-4px)}}
@media (prefers-reduced-motion: reduce){.run,.run g,.run rect,.zz{animation:none!important}}
</style>`


const costumeOf = (type: string): string => (type === 'Explore' ? 'explore' : tierOf(type))

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own.
const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE, role = 'type', mark = ''): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  officeWorker(f, colorOf(costume), costume, role, mark)
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

// `x0` crops the drawing's left edge, for a row whose crab is drawn on its own.
const svg = (W: number, H: number, body: string, x0 = 0): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W - x0}" height="${H}" viewBox="${x0} 0 ${W - x0} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// A working crab gets a drawing of its own that never changes, so the desktop
// keeps it animating; the row beside it redraws each second as a still image.
const CRAB_COL = 42
const crabSvg = (costume: string, H: number, y: number, role = 'type', rule = true): string =>
  svg(CRAB_COL, H, `${crab(0, y, costume, false, true, CRAB_SCALE, role)}${rule ? `<line class="ln" x1="0" y1="${H - 0.5}" x2="${CRAB_COL}" y2="${H - 0.5}"/>` : ''}`)

// The pane's own title already says "Agents": the header names the flow, if any.
const headerSvg = (W: number, title: string, t: ReturnType<typeof totals>): string => {
  const s = tr()
  const gap = 6
  const tw = (W - gap * 2) / 3
  const top = title ? 28 : 0
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="${top}" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="${top + 16}" font-family="${FONT}" font-size="11">${k}</text>
<text class="t" x="${i * (tw + gap) + 9}" y="${top + 33}" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(
    W,
    headerHeight(title),
    `${title ? `<text class="t" x="0" y="15" font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(title, 14, W))}</text>` : ''}
${tile(0, s.cost, '≈' + fmtCost(t.cost))}${tile(1, s.tokens, fmtTokens(t.tokens))}${tile(2, s.time, fmtTime(t.time))}`,
  )
}

const headerHeight = (title: string): number => (title ? 72 : 44)

// The task's own progress when the worker reports steps; a finished run is full.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

const agentSvg = (W: number, a: AgentRun, at: number, x0 = 0): string => {
  const s = tr()
  const tier = tierOf(a.type)
  const color = colorOf(tier)
  const ctx = ctxOf(a)
  const textW = W - 42 - 22
  const meta = [a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)]
  if (a.round > 1) meta.push(`${s.round} ${a.round}`)
  if (a.status === 'failed') meta.push(s.failed)
  const barW = textW - 36
  const progress = progressOf(a)
  const stats = `ctx ${ctx}% · ${fmtTokens(a.contextTokens)}  ≈${fmtCost(a.costUsd)}  ${fmtTime(elapsed(a, at))}`
  const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' · ' + a.stepNote : ''}` : ''
  const stepsW = Math.max(0, barW - textWidth(stats, 11) - 12)
  // Without reported steps the bar falls back to the context, drawn grey.
  const fillW = Math.round(barW * (progress ?? ctx / 100))
  return svg(
    W,
    66,
    `${x0 ? '' : crab(0, 14, costumeOf(a.type), false, a.status === 'running', CRAB_SCALE, roleOf(a.description || a.type), a.status === 'done' ? 'done' : '')}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier === 'other' ? a.type : tier)}</tspan><tspan class="s">  ${xml(meta.join('  ·  '))}</tspan></text>
${steps && stepsW > 30 ? `<text class="t" x="42" y="49" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(steps, 11, stepsW))}</text>` : ''}
<text class="s" x="${42 + barW}" y="49" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
<text class="t" x="${42 + textW}" y="60" text-anchor="end" font-family="${FONT}" font-size="11" font-weight="600" font-variant-numeric="tabular-nums">${progress === null ? '~' : ''}${Math.round((progress ?? ctx / 100) * 100)}%</text>
<rect class="k" x="42" y="55" width="${barW}" height="4" rx="2"/><rect${progress === null ? ' class="m"' : ''} x="42" y="55" width="${fillW}" height="4" rx="2"${progress === null ? '' : ` fill="${color}"`}/>
${statusMark(W - 8, 16, a.status, color)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
    x0,
  )
}

const plannedSvg = (W: number, p: Planned): string => {
  const tier = p.tier in TIER_COLOR ? p.tier : 'other'
  const color = colorOf(tier)
  const textW = W - 42 - 22
  const meta = [TIER_MODEL[tier] ?? '']
  if (p.after.length) meta.push(`${tr().after} ${p.after.join(', ')}`)
  return svg(
    W,
    46,
    `${crab(0, 6, tier, true, false, CRAB_SCALE, roleOf(p.title), 'sleep')}
<text class="s" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${p.n}. ${p.title}`, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier)}</tspan><tspan class="m">  ${xml(meta.filter(Boolean).join('  ·  '))}</tspan></text>
${statusMark(W - 8, 16, 'planned', color)}
<line class="ln" x1="0" y1="45.5" x2="${W}" y2="45.5"/>`,
  )
}

// The crabs and the ticking totals are two drawings, for the same reason as crabSvg.
const compactSvg = (W: number, list: AgentRun[], planned: Planned[], t: ReturnType<typeof totals>): [string, string, number] => {
  const icons = [
    ...list.filter(a => a.status === 'running').map(a => ({ k: costumeOf(a.type), c: colorOf(tierOf(a.type)), s: 'running', dim: false, r: roleOf(a.description || a.type) })),
    ...list.filter(a => a.status !== 'running').map(a => ({ k: costumeOf(a.type), c: colorOf(tierOf(a.type)), s: a.status, dim: false, r: roleOf(a.description || a.type) })),
    ...planned.map(p => ({ k: p.tier in TIER_COLOR ? p.tier : 'other', c: colorOf(p.tier), s: 'planned', dim: true, r: roleOf(p.title) })),
  ]
  const fit = Math.max(1, Math.floor((W - 150) / 36))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown
    .map((ic, i) => crab(i * 36, 0, ic.k, ic.dim, ic.s === 'running', CRAB_SCALE, ic.r, ic.s === 'done' ? 'done' : ic.s === 'planned' ? 'sleep' : '') +(ic.s === 'running' ? `<circle class="live" cx="${i * 36 + 32}" cy="4" r="3" fill="${ic.c}"/>` : ''))
    .join('')
  const x = shown.length * 36 + (more ? 4 : 0)
  const cw = shown.length * 36 + (more ? 34 : 0)
  return [
    svg(cw, 32, `${body}${more ? `<text class="s" x="${x}" y="21" font-family="${FONT}" font-size="12">+${more}</text>` : ''}`),
    svg(
      W,
      32,
      `<text class="s" x="${W}" y="21" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`,
      cw,
    ),
    cw,
  ]
}

// --- separate window: the same workers in an app-mode browser window, so they stay
// visible while the Claude app is minimized. The mod writes `state.js` (HTML strings),
// the page `window.html` reloads it every second; no server.

const WIN_ART_H = 44

type WinKind = 'run' | 'done' | 'fail' | 'plan'

// The page carries CRAB_CSS once (the drawings use no PANE_CSS class), and an inline SVG's
// <style> is global there, so each drawing's own copies are dropped.
const unstyle = (s: string): string => s.split(PANE_CSS).join('').split(CRAB_CSS).join('')

const winArt = (costume: string, role: string, kind: WinKind, small: boolean): string => {
  if (kind === 'run' && !small) return unstyle(crabSvg(costume, WIN_ART_H, 6, role, false))
  const mark = kind === 'done' ? 'done' : kind === 'plan' ? 'sleep' : ''
  const body = small
    ? svg(28, 26, crab(0, 2, costume, kind === 'plan', kind === 'run', 0.8, role, mark))
    : svg(CRAB_COL, WIN_ART_H, crab(0, 6, costume, kind === 'plan', false, CRAB_SCALE, role, mark))
  return unstyle(body)
}

const winPct = (frac: number, isEstimate: boolean): string => `${isEstimate ? '~' : ''}${Math.round(frac * 100)}%`

// Tier colors are for shapes only: colored text would miss 4.5:1 on one of the two themes.
const winMeta = (tier: string, label: string, parts: string[]): string =>
  `<span class="dot" style="background:${colorOf(tier)}"></span>${xml([label, ...parts].filter(Boolean).join(' · '))}`

const winAgentRow = (a: AgentRun): string => {
  const s = tr()
  const tier = tierOf(a.type)
  const progress = progressOf(a)
  const frac = progress ?? ctxOf(a) / 100
  const kind: WinKind = a.status === 'running' ? 'run' : a.status === 'done' ? 'done' : 'fail'
  const parts = [a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)]
  if (a.stepTotal) parts.push(`${a.stepDone ?? 0}/${a.stepTotal}`)
  if (a.round > 1) parts.push(`${s.round} ${a.round}`)
  if (a.status === 'failed') parts.push(s.failed)
  const name = a.description || a.type
  return `<div class="row"><div class="art">${winArt(costumeOf(a.type), roleOf(name), kind, false)}</div>
<div class="txt"><div class="nm">${xml(name)}</div><div class="mt">${winMeta(tier, tier === 'other' ? a.type : tier, parts)}</div>
<div class="bar" aria-hidden="true"><i${progress === null ? ' class="est"' : ''} style="width:${Math.round(frac * 100)}%${progress === null ? '' : `;background:${colorOf(tier)}`}"></i></div></div>
<div class="pc">${winPct(frac, progress === null)}</div></div>`
}

const winPlannedRow = (p: Planned): string => {
  const tier = p.tier in TIER_COLOR ? p.tier : 'other'
  const parts = [TIER_MODEL[tier] ?? '']
  if (p.after.length) parts.push(`${tr().after} ${p.after.join(', ')}`)
  return `<div class="row plan"><div class="art">${winArt(tier, roleOf(p.title), 'plan', false)}</div>
<div class="txt"><div class="nm">${xml(`${p.n}. ${p.title}`)}</div><div class="mt">${winMeta(tier, tier, parts)}</div></div><div></div></div>`
}

const winCompactRow = (a: AgentRun): string => {
  const name = a.description || a.type
  const progress = progressOf(a)
  return `<div class="cr"><div class="art">${winArt(costumeOf(a.type), roleOf(name), 'run', true)}</div><div class="nm">${xml(name)}</div><div class="pc">${winPct(progress ?? ctxOf(a) / 100, progress === null)}</div></div>`
}

// Full and compact bodies for the page, plus the header's flow title and "N running".
const buildWindow = (f: Flow | null, list: AgentRun[]) => {
  const s = tr()
  const running = list.filter(a => a.status === 'running').reverse()
  const finished = list.filter(a => a.status !== 'running').reverse()
  const planned = plannedOf(f, list)
  const head = (text: string, n: number) => `<h2>${text} · ${n}</h2>`
  const full =
    list.length === 0 && planned.length === 0
      ? `<p class="empty">${s.empty}</p>`
      : [
          running.length ? head(s.running, running.length) + running.map(winAgentRow).join('') : '',
          planned.length ? head(s.planned, planned.length) + planned.map(winPlannedRow).join('') : '',
          finished.length ? head(s.finished, finished.length) + finished.slice(0, 5).map(winAgentRow).join('') : '',
        ].join('')
  const rest = [planned.length ? `${planned.length} ${s.isPlanned}` : '', finished.length ? `${finished.length} ${s.isFinished}` : ''].filter(Boolean).join(' · ')
  const compact = `${running.map(winCompactRow).join('')}${rest ? `<p class="sum">${rest}</p>` : running.length ? '' : `<p class="empty">${s.empty}</p>`}`
  return {
    full,
    compact,
    title: f && !f.isFinished ? f.title : '',
    status: `${running.length} ${s.isRunning}`,
    running: running.length,
  }
}

let isWindowOn = false
let lastWindow = ''
let lastWindowAt = 0
let projKey = 'p'
let seenBody = ''
let chgAt = Date.now()
const OWNER = Math.random().toString(36).slice(2, 10)

// $.process takes no shell string: PowerShell gets its script as UTF-16 base64.
function ps($: EngineInterface, script: string, env: Record<string, string>, timeoutMs: number) {
  const full = `$ErrorActionPreference='Stop'; ${script}`
  let utf16 = ''
  for (let i = 0; i < full.length; i += 1) utf16 += String.fromCharCode(full.charCodeAt(i) & 255, full.charCodeAt(i) >> 8)
  return $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', btoa(utf16)], { env, timeoutMs })
}

async function windowDir($: EngineInterface): Promise<string> {
  const home =
    (await $.env.get('USERPROFILE').catch(() => undefined)) ||
    (await $.env.get('HOME').catch(() => undefined)) ||
    ($.plugin.root.replace(/\\/g, '/').split('/.claude/')[0] ?? '')
  return `${home.replace(/\\/g, '/').replace(/\/+$/, '')}/.claude/agent-office-window`
}

// The static page is a template next to the code; the mod fills in the shared strings,
// so a plugin update reaches the window the next time it opens.
async function ensureWindowHtml($: EngineInterface): Promise<void> {
  const s = tr()
  const fill: [string, string][] = [
    ['{{LANG}}', lang],
    ['{{FONT}}', FONT],
    ['{{CSS}}', CRAB_CSS],
    ['{{desc}}', s.windowDesc],
    ['{{workers}}', s.workers],
    ['{{compact}}', s.compactWord],
    ['{{full}}', s.fullWord],
    ['{{waiting}}', s.waiting],
  ]
  let html = String(await $.fs.read(`${$.plugin.root}/window/window.html`))
  // split/join: CRAB_CSS must go in verbatim, not through String.replace's `$` patterns.
  for (const [key, value] of fill) html = html.split(key).join(value)
  html = html.split("'state.js?t='").join(`'state-${projKey}.js?t='`)
  await $.fs.write(`${await windowDir($)}/window-${projKey}.html`, html)
}

// Rewrites state.js when the content changed, and every 3 s anyway: the page calls a
// state.js older than 5 s stale, so an idle flow still needs a heartbeat.
async function writeWindow($: EngineInterface): Promise<void> {
  const [list, f, at] = await Promise.all([read($, agents), read($, flow), $.clock.now()])
  const body = JSON.stringify(buildWindow(f, list))
  if (body !== seenBody) { seenBody = body; chgAt = at }
  if (body === lastWindow && at - lastWindowAt < 3000) return
  // Every Claude session runs this mod and shares one state.js. A fresh file from another
  // session stays untouched unless it is idle and this one is busy, so an empty session
  // cannot blank a busy one. Two busy sessions: the first keeps the window until it ends.
  const busy = list.some(a => a.status === 'running') || !!(f && !f.isFinished)
  const file = `${await windowDir($)}/state-${projKey}.js`
  const cur = String(await $.fs.read(file).catch(() => ''))
  const m = cur.match(/"own":"(\w+)","busy":([01]),"chg":(\d+),"at":(\d+)\}\s*$/)
  // The window follows the session that changed last: another owner keeps it while its own
  // content moved in the last 20 s, or unless this session changed after it.
  if (m && m[1] !== OWNER && at - Number(m[4]) < 8000 && (at - Number(m[3]) < 20000 || chgAt <= Number(m[3]))) return
  lastWindow = body
  lastWindowAt = at
  await $.fs.write(file, `window.__S=${body.slice(0, -1)},"own":"${OWNER}","busy":${busy ? 1 : 0},"chg":${chgAt},"at":${at}}\n`)
}

const WINDOW_LAUNCH = `$d=$env:SW_DIR
$c=@("\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe","$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe","$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe","\${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe","$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe")
$e=$c | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if(-not $e){ exit 3 }
$u='file:///'+(($d -replace '\\\\','/') -replace ' ','%20')+'/window-'+$env:SW_KEY+'.html'
Start-Process -FilePath $e -ArgumentList @('--app='+$u,'--window-size=360,560','--no-first-run','--no-default-browser-check',('--user-data-dir="'+$d+'\\profile-'+$env:SW_KEY+'"'))`

// Edge or Chrome in app mode with a profile of its own: a separate window and taskbar
// entry that keeps running whatever the Claude app does. Start-Process returns at once.
async function openWorkersWindow($: EngineInterface): Promise<string> {
  const s = tr()
  try {
    isWindowOn = true
    await ensureWindowHtml($)
    lastWindow = ''
    await writeWindow($)
    const dir = (await windowDir($)).replace(/\//g, '\\')
    const run = await ps($, WINDOW_LAUNCH, { SW_DIR: dir, SW_KEY: projKey }, 20_000)
    if (run.exitCode === 0) return s.windowOpened
    await $.process.run(['rundll32', 'url.dll,FileProtocolHandler', `${dir}\\window-${projKey}.html`])
    return s.windowFallback
  } catch {
    return s.windowFailed
  }
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗', planned: '◷' }

// Opens the agents pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: tr().pane })
  return true
}

async function autoOpen($: EngineInterface, key: string): Promise<void> {
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
  void $.ui.open({ id: PANE, title: tr().pane })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // One window per project: its own page, state file and browser profile.
    const path = e.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    let h = 0
    for (const c of path) h = (h * 31 + c.charCodeAt(0)) >>> 0
    projKey = `${(path.split('/').pop() ?? '').replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'p'}-${h.toString(36)}`
    lang = await detectLang($, options.language)
    await $.tool.register({
      name: 'progress',
      description:
        'Report /savvy-flow progress to the progress bar above the prompt and the agents panel. ' +
        'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done), ' +
        'when switching phase or re-planning (tasks), and once at the end with finished: true. Fields left out keep their previous value.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the flow is closed.' },
          tasks: {
            type: 'array',
            description:
              'The planned worker tasks in order, numbered from 1. Each title must equal the Agent tool `description` the task will be delegated with, so the panel can match runs to tasks.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
                tier: { type: 'string', enum: ['fable', 'heavy', 'careful', 'medium', 'light'] },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
              },
              required: ['title', 'tier'],
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For savvy-flow workers: report progress on your own task to the agents panel. ' +
        'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
    })
    await $.command.register({
      name: 'agents-info',
      description: 'Show or hide the panel of subagents: running, finished and planned, with model, context, cost and time',
    })

    await $.command.register({
      name: 'agents-window',
      description: 'Open the workers in a separate window that stays visible when the Claude app is minimized',
    })
    // A window opened in an earlier session keeps being fed.
    isWindowOn = await $.fs.exists(`${await windowDir($)}/state-${projKey}.js`).catch(() => false)
    if (isWindowOn) await ensureWindowHtml($).catch(() => undefined)

    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        // The window also shows idle and finished states, so it ticks before the early return.
        if (isWindowOn) await writeWindow($).catch(() => undefined)
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  on('command.run', { command: 'agents-info' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? tr().opened : tr().closed }
  })

  on('command.run', { command: 'agents-window' }, async $ => ({ text: await openWorkersWindow($) }))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as ProgressInput
    const prev = await read($, flow)
    if (isNewFlow(prev, input) && input.title !== undefined) {
      // A new flow starts with a clean list; agents still running stay.
      await update($, agents, list => list.filter(a => a.status === 'running'))
    }
    const next = await update($, flow, p => merge(p, input))
    if (next && input.tasks?.length) await autoOpen($, next.title)
    return { result: `ok: ${label(next ?? blank())}` }
  })

  // A worker's own progress: the call runs in the worker's loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    await update($, agents, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
        const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
        return { ...a, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: input.note?.trim() || undefined }
      }),
    )
    return { result: 'ok' }
  })

  // Safety net: worker launches move the faint layer even if the orchestrator forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = String(e.subagent_type ?? '')
    if (!type.startsWith('savvy-')) return next(e)

    await update($, flow, prev => {
      const base = prev && !prev.isFinished ? { ...blank(), ...prev } : blank()
      return { ...base, running: base.running + 1, phase: base.phase === 'plan' ? 'delegate' : base.phase }
    })
    try {
      return await next(e)
    } finally {
      await update($, flow, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    await update($, agents, list => {
      const round = 1 + list.filter(a => norm(a.description) === norm(e.description) && e.description).length
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
        round,
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)
    if (e.subagentType.startsWith('savvy-')) {
      const f = await read($, flow)
      await autoOpen($, f && !f.isFinished ? f.title : 'savvy-flow')
    }
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    await update($, agents, list =>
      list.map(a =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              contextTokens:
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                (usage.output_tokens || 0),
              contextMax: windowOf(model),
              tokens:
                a.tokens +
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0),
              costUsd: a.costUsd + costOf(model, usage),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map(a => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens:
                    e.usage.input_tokens +
                    e.usage.output_tokens +
                    e.usage.cache_read_input_tokens +
                    e.usage.cache_creation_input_tokens,
                  costUsd: costOf(e.usage.model || a.model, e.usage),
                }
              : {}),
          }
        }),
      )
      await update($, now, () => at)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = tr()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const f = await read($, flow)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const planned = plannedOf(f, list)
    const t = totals(list, at)
    // The pane's title says "Agents"; inside, only the flow's own name.
    const title = f && !f.isFinished ? f.title : ''

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? s.expand : s.collapse}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const openWindow = (
      <Button key="window" label={s.openWindow} plain onPress={() => void openWorkersWindow($).then(m => $.ui.toast(m))} />
    )
    const controls = (
      <Box key="controls" flexDirection="row" gap={1}>
        {toggleCompact}
        {openWindow}
      </Box>
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} ${s.finished} · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    const isEmpty = list.length === 0 && planned.length === 0
    const summary = `≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} ${s.tokensWord}, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string) => (
        <Text key={key} dimColor>
          {text}
        </Text>
      )

      if (p.isCompact) {
        const [crabs, totalsSvg, cw] = compactSvg(W, list, planned, t)
        return (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row">
              <Svg source={crabs} alt={`${list.length} ${s.agentsCount}`} width={cw} height={32} isInteractive={running.length > 0} />
              <Svg source={totalsSvg} alt={summary} width={W - cw} height={32} />
            </Box>
            {controls}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Svg source={headerSvg(W, title, t)} alt={title ? `${title}: ${summary}` : summary} width={W} height={headerHeight(title)} />
          {controls}
          {isEmpty && <Text dimColor>{s.empty}</Text>}
          {running.length > 0 && section('h-run', `${s.running} · ${running.length}`)}
          {running.map(a => (
            <Box key={a.id} flexDirection="row">
              <Svg source={crabSvg(costumeOf(a.type), 66, 14, roleOf(a.description || a.type))}alt={tierOf(a.type)} width={CRAB_COL} height={66} isInteractive />
              <Svg source={agentSvg(W, a, at, CRAB_COL)} alt={`${a.description}: ${modelName(a.model)}, ${s.isRunning}`} width={W - CRAB_COL} height={66} />
            </Box>
          ))}
          {finished.length > 0 && toggleDone}
          {!p.isDoneCollapsed &&
            finished.map(a => (
              <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${s.isFinished}`} width={W} height={66} />
            ))}
          {planned.length > 0 && section('h-plan', `${s.planned} · ${planned.length}`)}
          {planned.map(pl => (
            <Svg key={`plan-${pl.n}`} source={plannedSvg(W, pl)} alt={`${pl.n}. ${pl.title}: ${s.isPlanned}`} width={W} height={46} />
          ))}
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const row = (a: AgentRun) => {
      const tier = tierOf(a.type)
      const color = colorOf(tier)
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      const model = a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)
      const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''} · ` : ''
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={color}>▣</Text>
            <Text bold wrap="truncate-end">
              {a.description || a.type}
            </Text>
            <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {tier === 'other' ? a.type : tier} · {model}
            {a.round > 1 ? ` · ${s.round} ${a.round}` : ''}
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={color}>{ctxBar(progress * 100, barW)}</Text>}
            <Text dimColor>
              {' '}
              {steps}ctx {ctx}% · {fmtTokens(a.contextTokens)} ≈{fmtCost(a.costUsd)} {fmtTime(elapsed(a, at))}
            </Text>
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {title}
          </Text>
          {controls}
        </Box>
        <Text dimColor>
          ≈{fmtCost(t.cost)} · {fmtTokens(t.tokens)} {s.tokensWord} · {fmtTime(t.time)}
        </Text>
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...running, ...finished].map(a => (
              <Text key={a.id} color={colorOf(tierOf(a.type))}>
                {STATUS_GLYPH[a.status]}{' '}
              </Text>
            ))}
            {planned.map(pl => (
              <Text key={`plan-${pl.n}`} dimColor>
                ◷{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {isEmpty && <Text dimColor>{s.empty}</Text>}
            {running.length > 0 && <Text dimColor>{s.running} · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.map(row)}
            {planned.length > 0 && <Text dimColor>{s.planned} · {planned.length}</Text>}
            {planned.map(pl => {
              const tier = pl.tier in TIER_COLOR ? pl.tier : 'other'
              return (
                <Box key={`plan-${pl.n}`} flexDirection="column" marginBottom={1}>
                  <Text dimColor wrap="truncate-end">
                    <Text color={colorOf(tier)}>▢</Text> {pl.n}. {pl.title} ◷
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    {tier} · {TIER_MODEL[tier] ?? ''}
                    {pl.after.length ? ` · ${s.after} ${pl.after.join(', ')}` : ''}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, flow)
    if (f === null || e.props.hasSurvey) return next(e)
    // Other mods' bands (handoff, next-steps) draw beneath this one: keep them.
    const rest = await next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const crew = list.length + plannedOf(f, list).length
    const isWorking = list.some(a => a.status === 'running')
    const crewButton = (
      <Button key="savvy-agents" label={`×${crew}`} plain onPress={() => void togglePane($)} />
    )
    const percent = `${Math.round(ratio(f) * 100)}%`
    const dismiss = (
      <Button
        key="savvy-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={() => update($, flow, () => null)}
      />
    )

    if ('Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the count, the dismiss
      // and their gaps. No floor above the slot: a row wider than it would wrap.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      return (
        <Box flexDirection="column">
          {rest}
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={rowSvg(f, width, isWorking)} alt={`${f.title}: ${label(f)}, ${percent}`} width={width} height={H} isInteractive={isWorking} />
            {crewButton}
            {dismiss}
          </Box>
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(cols / 3)))
    const width = Math.max(6, Math.min(40, cols - titleW - 32))
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="row" gap={2}>
          <Box width={titleW} flexShrink={0}>
            <Text color={f.isFinished ? DONE : ACCENT}>● </Text>
            <Text wrap="truncate-end">{f.title}</Text>
          </Box>
          <Text color={f.isFinished ? DONE : ACCENT}>{barText(f, width)}</Text>
          <Text bold>{label(f)}</Text>
          <Text dimColor>{percent}</Text>
          <Text color={CLAY}>▣</Text>
          {crewButton}
          {dismiss}
        </Box>
      </Box>
    )
  })
}
