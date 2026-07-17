#!/usr/bin/env node
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const USER = process.env.DASHBOARD_USER ?? 'CoderJoeW'
const TOKEN = process.env.GITHUB_TOKEN

// Curated feature list. Names here win; anything missing falls back to
// top-starred non-forks. Edit this, not the README.
const PINNED = ['POME', 'LightningTables', 'Atlas', 'Nitrado-Server-Manager']
const TAGLINE = 'systems tooling · game infrastructure · database internals'

const W = 880
const C = {
  bg: '#05080d',
  panel: '#0a0f16',
  tile: '#0d141d',
  border: '#1b2734',
  grid: '#101a24',
  text: '#d5dfe9',
  dim: '#6b8299',
  faint: '#3d4d5c',
  green: '#00e5a0',
  amber: '#ffa94d',
  cyan: '#4cc9f0',
}
const HEAT = ['#0d141d', '#0b4d3a', '#0f8560', '#00c489', '#4dffc3']

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  )

const wrap = (text, maxChars, maxLines) => {
  const words = String(text ?? '').split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length > maxChars && cur) {
      lines.push(cur)
      cur = w
    } else cur = next
  }
  if (cur) lines.push(cur)
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  const last = kept[maxLines - 1]
  kept[maxLines - 1] = (last.length > maxChars - 1 ? last.slice(0, maxChars - 1) : last) + '…'
  return kept
}

const ago = (iso) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5)
  if (days < 1) return 'today'
  if (days < 30) return `${days}d ago`
  const mo = Math.floor(days / 30)
  return mo < 12 ? `${mo}mo ago` : `${Math.floor(days / 365)}y ago`
}

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': `${USER}-dashboard`,
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`)
  const body = await res.json()
  if (body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`)
  return body.data
}

async function fetchProfile() {
  return gql(
    `query($login: String!) {
      user(login: $login) {
        name
        bio
        createdAt
        followers { totalCount }
        repositories(first: 100, ownerAffiliations: OWNER, isFork: false, orderBy: {field: STARGAZERS, direction: DESC}) {
          totalCount
          nodes {
            name url description stargazerCount isArchived pushedAt
            primaryLanguage { name color }
            languages(first: 12, orderBy: {field: SIZE, direction: DESC}) {
              edges { size node { name color } }
            }
          }
        }
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount contributionLevel } }
          }
        }
      }
    }`,
    { login: USER },
  )
}

// One aliased query for every year the account has existed, rather than N round trips.
async function fetchLifetimeCommits(createdAt) {
  const start = new Date(createdAt).getUTCFullYear()
  const end = new Date().getUTCFullYear()
  const years = []
  for (let y = start; y <= end; y++) years.push(y)
  const fields = years
    .map(
      (y) =>
        `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z") {
          totalCommitContributions
          restrictedContributionsCount
        }`,
    )
    .join('\n')
  const data = await gql(`query($login: String!) { user(login: $login) { ${fields} } }`, {
    login: USER,
  })
  return years.reduce((sum, y) => {
    const c = data.user[`y${y}`]
    return sum + c.totalCommitContributions + c.restrictedContributionsCount
  }, 0)
}

// Each repo contributes equal weight regardless of size. Byte-weighting across
// all repos lets one vendored/generated dump (Better carries ~8MB of C#) swallow
// the chart and misreport what you actually build in.
function languageBreakdown(repos) {
  const totals = new Map()
  for (const repo of repos) {
    const bytes = repo.languages.edges.reduce((s, e) => s + e.size, 0)
    if (!bytes) continue
    for (const { size, node } of repo.languages.edges) {
      const prev = totals.get(node.name)
      totals.set(node.name, {
        weight: (prev?.weight ?? 0) + size / bytes,
        color: node.color ?? C.dim,
      })
    }
  }
  const all = [...totals.entries()].map(([name, v]) => ({ name, ...v }))
  const grand = all.reduce((s, l) => s + l.weight, 0) || 1
  const sorted = all.sort((a, b) => b.weight - a.weight)
  const top = sorted.slice(0, 6).map((l) => ({ ...l, pct: (l.weight / grand) * 100 }))
  const restPct = (sorted.slice(6).reduce((s, l) => s + l.weight, 0) / grand) * 100
  if (restPct > 0.5) top.push({ name: 'other', color: C.faint, pct: restPct })
  return top
}

function pickFeatured(repos) {
  const byName = new Map(repos.map((r) => [r.name, r]))
  const picked = PINNED.map((n) => byName.get(n)).filter(Boolean)
  const fallback = repos
    .filter((r) => !picked.includes(r) && r.description && !r.isArchived)
    .sort((a, b) => b.stargazerCount - a.stargazerCount || new Date(b.pushedAt) - new Date(a.pushedAt))
  return [...picked, ...fallback].slice(0, 4)
}

const defs = `
  <defs>
    <pattern id="grid" width="26" height="26" patternUnits="userSpaceOnUse">
      <path d="M26 0H0V26" fill="none" stroke="${C.grid}" stroke-width="1"/>
    </pattern>
    <linearGradient id="scan" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${C.cyan}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${C.cyan}" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="${C.cyan}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="title" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${C.green}"/>
      <stop offset="60%" stop-color="${C.cyan}"/>
      <stop offset="100%" stop-color="#8ab4ff"/>
    </linearGradient>
  </defs>`

const FONT = `ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace`

const shell = (h, body, extraStyle = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img">
  ${defs}
  <style>
    text { font-family: ${FONT}; }
    @keyframes blink { 0%, 45% { opacity: 1 } 50%, 95% { opacity: .15 } 100% { opacity: 1 } }
    @keyframes sweep { from { transform: translateY(-70px) } to { transform: translateY(var(--h, 200px)) } }
    .blink { animation: blink 2.4s steps(1) infinite; }
    ${extraStyle}
  </style>
  <rect width="${W}" height="${h}" rx="10" fill="${C.bg}"/>
  <rect width="${W}" height="${h}" rx="10" fill="url(#grid)" opacity="0.55"/>
  ${body}
  <rect x="0.5" y="0.5" width="${W - 1}" height="${h - 1}" rx="10" fill="none" stroke="${C.border}"/>
</svg>`

const corners = (h, len = 14) => {
  const p = 8
  const mk = (x, y, sx, sy) =>
    `<path d="M${x} ${y + sy * len} L${x} ${y} L${x + sx * len} ${y}" fill="none" stroke="${C.green}" stroke-width="1.5" opacity="0.7"/>`
  return [mk(p, p, 1, 1), mk(W - p, p, -1, 1), mk(p, h - p, 1, -1), mk(W - p, h - p, -1, -1)].join('')
}

const panelTitle = (x, y, label, accent = C.green) =>
  `<rect x="${x}" y="${y - 9}" width="3" height="12" fill="${accent}"/>
   <text x="${x + 9}" y="${y}" font-size="11" letter-spacing="2.2" fill="${C.dim}">${esc(label)}</text>`

function renderHeader(d, syncedAt) {
  const h = 200
  const title = USER.toUpperCase()
  const cursorX = 32 + title.length * (46 * 0.6 + 5) + 3
  const body = `
    <rect class="scanline" x="0" y="0" width="${W}" height="70" fill="url(#scan)" opacity="0.12"/>
    <line x1="0" y1="36" x2="${W}" y2="36" stroke="${C.border}"/>
    <circle class="blink" cx="24" cy="21" r="3.5" fill="${C.green}"/>
    <text x="36" y="25" font-size="10" letter-spacing="1.8" fill="${C.green}">SYSTEM ONLINE</text>
    <text x="${W - 22}" y="25" font-size="10" letter-spacing="1.2" fill="${C.faint}" text-anchor="end">LAST SYNC ${syncedAt}</text>
    <text x="32" y="106" font-size="46" font-weight="700" letter-spacing="5" fill="url(#title)">${esc(title)}</text>
    <rect class="blink" x="${cursorX}" y="82" width="16" height="30" fill="${C.cyan}" opacity="0.85"/>
    <text x="34" y="134" font-size="12" letter-spacing="2" fill="${C.cyan}">${esc(TAGLINE)}</text>
    <text x="34" y="168" font-size="11.5" fill="${C.dim}" font-style="italic">${esc(d.bio ?? '')}</text>
    ${corners(h)}`
  return shell(
    h,
    body,
    `.scanline { animation: sweep 7s linear infinite; --h: ${h}px; }`,
  )
}

function renderTelemetry(stats, langs) {
  const h = 292
  const tiles = [
    { label: 'REPOS AUTHORED', value: String(stats.repos), accent: C.green },
    { label: 'COMMITS ALL TIME', value: stats.commits.toLocaleString('en-US'), accent: C.cyan },
    { label: 'FOLLOWERS', value: String(stats.followers), accent: C.amber },
    { label: 'SHIPPING SINCE', value: String(stats.since), accent: C.green },
  ]
  const tw = (W - 40 - 3 * 12) / 4
  const tileSvg = tiles
    .map((t, i) => {
      const x = 20 + i * (tw + 12)
      return `<g>
        <rect x="${x}" y="46" width="${tw}" height="76" rx="6" fill="${C.tile}" stroke="${C.border}"/>
        <rect x="${x}" y="46" width="3" height="76" rx="1.5" fill="${t.accent}"/>
        <text x="${x + 16}" y="88" font-size="27" font-weight="700" fill="${C.text}">${esc(t.value)}</text>
        <text x="${x + 16}" y="108" font-size="9" letter-spacing="1.4" fill="${C.faint}">${t.label}</text>
      </g>`
    })
    .join('')

  const barY = 176
  const barW = W - 40
  let cursor = 20
  const segs = langs
    .map((l) => {
      const w = Math.max((l.pct / 100) * barW, 1.5)
      const seg = `<rect x="${cursor}" y="${barY}" width="${w}" height="16" fill="${l.color}"/>`
      cursor += w
      return seg
    })
    .join('')

  const legend = langs
    .map((l, i) => {
      const col = i % 4
      const row = Math.floor(i / 4)
      const x = 20 + col * 214
      const y = 228 + row * 24
      return `<circle cx="${x + 4}" cy="${y - 4}" r="4" fill="${l.color}"/>
        <text x="${x + 15}" y="${y}" font-size="11" fill="${C.text}">${esc(l.name)}</text>
        <text x="${x + 196}" y="${y}" font-size="11" fill="${C.dim}" text-anchor="end">${l.pct.toFixed(1)}%</text>`
    })
    .join('')

  const body = `
    ${panelTitle(20, 28, 'TELEMETRY')}
    <text x="${W - 20}" y="28" font-size="10" fill="${C.faint}" text-anchor="end">NOMINAL</text>
    ${tileSvg}
    ${panelTitle(20, 158, 'LANGUAGE DISTRIBUTION · WEIGHTED BY REPO', C.cyan)}
    <!-- Full width is the authored state so the bar degrades to correct-but-static
         wherever SMIL doesn't run, rather than clipping to nothing. -->
    <clipPath id="barclip"><rect x="20" y="${barY}" width="${barW}" height="16" rx="3">
      <animate attributeName="width" from="0" to="${barW}" dur="1.3s" fill="freeze" calcMode="spline" keySplines="0.16 1 0.3 1"/>
    </rect></clipPath>
    <rect x="20" y="${barY}" width="${barW}" height="16" rx="3" fill="${C.tile}"/>
    <g clip-path="url(#barclip)">${segs}</g>
    ${legend}`
  return shell(h, body)
}

function renderActivity(calendar) {
  const h = 190
  const cell = 11
  const gap = 3
  const x0 = 46
  const y0 = 58
  const levels = {
    NONE: 0,
    FIRST_QUARTILE: 1,
    SECOND_QUARTILE: 2,
    THIRD_QUARTILE: 3,
    FOURTH_QUARTILE: 4,
  }
  const weeks = calendar.weeks
  const cells = weeks
    .map((week, wi) =>
      week.contributionDays
        .map((day) => {
          const di = new Date(day.date).getUTCDay()
          const x = x0 + wi * (cell + gap)
          const y = y0 + di * (cell + gap)
          const fill = HEAT[levels[day.contributionLevel] ?? 0]
          return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${fill}"><title>${day.date}: ${day.contributionCount}</title></rect>`
        })
        .join(''),
    )
    .join('')

  const months = []
  let lastMonth = -1
  weeks.forEach((week, wi) => {
    const first = week.contributionDays[0]
    if (!first) return
    const m = new Date(first.date).getUTCMonth()
    if (m !== lastMonth && wi < weeks.length - 2) {
      lastMonth = m
      const name = new Date(first.date).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
      months.push(
        `<text x="${x0 + wi * (cell + gap)}" y="${y0 - 8}" font-size="9" fill="${C.faint}">${name.toUpperCase()}</text>`,
      )
    }
  })

  const days = ['MON', 'WED', 'FRI']
    .map((label, i) => {
      const row = [1, 3, 5][i]
      return `<text x="${x0 - 8}" y="${y0 + row * (cell + gap) + 9}" font-size="8" fill="${C.faint}" text-anchor="end">${label}</text>`
    })
    .join('')

  const gridW = weeks.length * (cell + gap)
  const scale = HEAT.map(
    (c, i) =>
      `<rect x="${W - 118 + i * 14} " y="${h - 26}" width="10" height="10" rx="2" fill="${c}"/>`,
  ).join('')

  const body = `
    ${panelTitle(20, 28, 'CONTRIBUTION TELEMETRY · 52 WEEKS')}
    <text x="${W - 20}" y="28" font-size="10" fill="${C.green}" text-anchor="end">${calendar.totalContributions.toLocaleString('en-US')} EVENTS</text>
    ${months}${days}${cells}
    <rect class="radar" x="${x0}" y="${y0 - 4}" width="26" height="${7 * (cell + gap) + 4}" fill="url(#scan)" opacity="0.35"/>
    <text x="${W - 132}" y="${h - 17}" font-size="8.5" fill="${C.faint}" text-anchor="end">LOW</text>
    ${scale}
    <text x="${W - 20}" y="${h - 17}" font-size="8.5" fill="${C.faint}" text-anchor="end">HIGH</text>`
  return shell(
    h,
    body,
    `@keyframes radar { from { transform: translateX(0) } to { transform: translateX(${gridW}px) } }
     .radar { animation: radar 6s linear infinite; }`,
  )
}

function renderProjects(repos) {
  const cardW = (W - 40 - 14) / 2
  const cardH = 132
  const rows = Math.ceil(repos.length / 2)
  const h = 56 + rows * (cardH + 14)

  const cards = repos
    .map((r, i) => {
      const x = 20 + (i % 2) * (cardW + 14)
      const y = 48 + Math.floor(i / 2) * (cardH + 14)
      const lang = r.primaryLanguage
      const desc = wrap(r.description, 46, 3)
        .map((line, li) => `<text x="${x + 16}" y="${y + 66 + li * 16}" font-size="11" fill="${C.dim}">${esc(line)}</text>`)
        .join('')
      const star =
        r.stargazerCount > 0
          ? `<text x="${x + cardW - 16}" y="${y + 30}" font-size="11" fill="${C.amber}" text-anchor="end">★ ${r.stargazerCount}</text>`
          : ''
      const langDot = lang
        ? `<circle cx="${x + 20}" cy="${y + cardH - 18}" r="4" fill="${lang.color ?? C.dim}"/>
           <text x="${x + 31}" y="${y + cardH - 14}" font-size="10" fill="${C.faint}">${esc(lang.name)}</text>`
        : ''
      return `<g>
        <rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="7" fill="${C.panel}" stroke="${C.border}"/>
        <rect x="${x}" y="${y}" width="${cardW}" height="2.5" rx="1" fill="${C.green}" opacity="0.5"/>
        <text x="${x + 16}" y="${y + 32}" font-size="14.5" font-weight="700" fill="${C.text}">${esc(r.name)}</text>
        ${star}${desc}${langDot}
        <text x="${x + cardW - 16}" y="${y + cardH - 14}" font-size="9.5" fill="${C.faint}" text-anchor="end">${esc(ago(r.pushedAt))}</text>
      </g>`
    })
    .join('')

  return shell(h, `${panelTitle(20, 28, 'SHIPPING', C.amber)}
    <text x="${W - 20}" y="28" font-size="10" fill="${C.faint}" text-anchor="end">SELECTED WORK</text>
    ${cards}`)
}

function renderReadme(repos, syncedAt) {
  const links = repos.map((r) => `[\`${r.name}\`](${r.url})`).join(' · ')
  return `<!-- Generated by scripts/build-dashboard.mjs. Edits inside the markers are overwritten. -->
<!-- dashboard:start -->
<div align="center">

![${USER}](assets/header.svg)

![Telemetry](assets/telemetry.svg)

![Activity](assets/activity.svg)

![Shipping](assets/projects.svg)

${links}

<sub>Every panel above is an SVG generated from live GitHub API data by [a workflow in this repo](.github/workflows/dashboard.yml) — no third-party stat services. Last sync ${syncedAt}.</sub>

</div>
<!-- dashboard:end -->
`
}

async function main() {
  if (!TOKEN) {
    console.error('GITHUB_TOKEN is required (try: GITHUB_TOKEN=$(gh auth token) node scripts/build-dashboard.mjs)')
    process.exit(1)
  }
  const syncedAt = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z'

  const { user } = await fetchProfile()
  const repos = user.repositories.nodes.filter((r) => !r.isArchived)
  const commits = await fetchLifetimeCommits(user.createdAt)

  const stats = {
    repos: user.repositories.totalCount, // non-forks only; GitHub's public count includes forks

    followers: user.followers.totalCount,
    commits,
    since: new Date(user.createdAt).getUTCFullYear(),
  }
  const langs = languageBreakdown(repos)
  const featured = pickFeatured(repos)
  const calendar = user.contributionsCollection.contributionCalendar

  await mkdir(join(ROOT, 'assets'), { recursive: true })
  const out = {
    'assets/header.svg': renderHeader(user, syncedAt),
    'assets/telemetry.svg': renderTelemetry(stats, langs),
    'assets/activity.svg': renderActivity(calendar),
    'assets/projects.svg': renderProjects(featured),
  }
  for (const [path, svg] of Object.entries(out)) {
    await writeFile(join(ROOT, path), svg)
    console.log(`wrote ${path} (${(svg.length / 1024).toFixed(1)}kb)`)
  }

  const readmePath = join(ROOT, 'README.md')
  const block = renderReadme(featured, syncedAt)
  let readme = await readFile(readmePath, 'utf8').catch(() => '')
  readme = /<!-- dashboard:start -->[\s\S]*<!-- dashboard:end -->/.test(readme)
    ? readme.replace(/<!--[^\n]*build-dashboard[^\n]*-->\n?/g, '').replace(
        /<!-- dashboard:start -->[\s\S]*<!-- dashboard:end -->\n?/,
        block,
      )
    : block
  await writeFile(readmePath, readme)
  console.log(`wrote README.md · ${stats.commits} commits · ${langs.length} languages · ${featured.length} featured`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
