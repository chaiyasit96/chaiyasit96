#!/usr/bin/env node
// Generates the GitHub profile cards (stats, top languages, streak, activity)
// as static SVG files, so the profile README does not depend on public
// third-party image services that are frequently rate-limited or offline.
//
// Usage: GITHUB_TOKEN=... GITHUB_USER=chaiyasit96 node scripts/generate-cards.mjs [outDir]
// For offline preview: MOCK=1 node scripts/generate-cards.mjs [outDir]

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const USER = process.env.GITHUB_USER || 'chaiyasit96';
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = process.argv[2] || 'dist';

const THEME = {
  bg: '#0D1117',
  border: '#30363D',
  title: '#79C0FF',
  accent: '#BC8CFF',
  text: '#C9D1D9',
  muted: '#8B949E',
  font: "'Segoe UI', Ubuntu, 'Helvetica Neue', Helvetica, Arial, sans-serif",
};

// ---------------------------------------------------------------- data ----

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-cards-generator',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`GraphQL error: ${res.status} ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

async function fetchData() {
  if (!TOKEN) throw new Error('GITHUB_TOKEN is required (or set MOCK=1)');

  const main = await gql(
    `query($login: String!) {
      user(login: $login) {
        login
        name
        createdAt
        followers { totalCount }
        pullRequests { totalCount }
        issues { totalCount }
        repositoriesContributedTo(contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, REPOSITORY]) { totalCount }
        contributionsCollection {
          totalCommitContributions
          restrictedContributionsCount
          contributionYears
        }
      }
    }`,
    { login: USER },
  );
  const user = main.user;

  // Repositories (paginated) for stars and languages.
  const repos = [];
  let cursor = null;
  do {
    const page = await gql(
      `query($login: String!, $cursor: String) {
        user(login: $login) {
          repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              stargazerCount
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                edges { size node { name color } }
              }
            }
          }
        }
      }`,
      { login: USER, cursor },
    );
    const conn = page.user.repositories;
    repos.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);

  // Contribution calendar for every year the user has been active.
  const days = [];
  for (const year of user.contributionsCollection.contributionYears) {
    const data = await gql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            contributionCalendar {
              weeks { contributionDays { date contributionCount } }
            }
          }
        }
      }`,
      { login: USER, from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` },
    );
    for (const w of data.user.contributionsCollection.contributionCalendar.weeks) {
      for (const d of w.contributionDays) days.push({ date: d.date, count: d.contributionCount });
    }
  }

  return { user, repos, days };
}

function mockData() {
  const days = [];
  const today = new Date();
  for (let i = 400; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const count = i % 9 === 4 ? 0 : Math.round(Math.abs(Math.sin(i / 3)) * 8);
    days.push({ date: d.toISOString().slice(0, 10), count });
  }
  return {
    user: {
      login: USER,
      name: 'Chaiyasit Ruengdist',
      followers: { totalCount: 12 },
      pullRequests: { totalCount: 34 },
      issues: { totalCount: 8 },
      repositoriesContributedTo: { totalCount: 5 },
      contributionsCollection: { totalCommitContributions: 245, restrictedContributionsCount: 40 },
    },
    repos: [
      { stargazerCount: 7, languages: { edges: [
        { size: 52000, node: { name: 'TypeScript', color: '#3178c6' } },
        { size: 12000, node: { name: 'JavaScript', color: '#f1e05a' } },
        { size: 3000, node: { name: 'CSS', color: '#563d7c' } },
      ] } },
      { stargazerCount: 3, languages: { edges: [
        { size: 21000, node: { name: 'Python', color: '#3572A5' } },
        { size: 4000, node: { name: 'Dockerfile', color: '#384d54' } },
        { size: 2500, node: { name: 'Shell', color: '#89e051' } },
        { size: 1500, node: { name: 'HTML', color: '#e34c26' } },
      ] } },
    ],
    days,
  };
}

// --------------------------------------------------------------- stats ----

function computeStreaks(days) {
  const byDate = new Map();
  for (const d of days) byDate.set(d.date, (byDate.get(d.date) || 0) + d.count);
  const sorted = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  const todayStr = new Date().toISOString().slice(0, 10);
  const list = sorted.filter(([date]) => date <= todayStr);

  let total = 0;
  let longest = { len: 0, start: null, end: null };
  let run = { len: 0, start: null, end: null };
  for (const [date, count] of list) {
    total += count;
    if (count > 0) {
      run = run.len === 0 ? { len: 1, start: date, end: date } : { ...run, len: run.len + 1, end: date };
      if (run.len > longest.len) longest = { ...run };
    } else {
      run = { len: 0, start: null, end: null };
    }
  }

  // Current streak: count back from today; if today has no contributions yet,
  // the streak is still alive as long as yesterday had some.
  let i = list.length - 1;
  if (i >= 0 && list[i][1] === 0) i--;
  let current = { len: 0, start: null, end: null };
  while (i >= 0 && list[i][1] > 0) {
    current = { len: current.len + 1, start: list[i][0], end: current.end || list[i][0] };
    i--;
  }

  return { total, longest, current, firstDate: list.length ? list[0][0] : null };
}

function topLanguages(repos, limit = 6) {
  const totals = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      const prev = totals.get(node.name) || { size: 0, color: node.color || THEME.muted };
      totals.set(node.name, { size: prev.size + size, color: prev.color });
    }
  }
  const all = [...totals.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.size - a.size);
  const top = all.slice(0, limit);
  const sum = top.reduce((s, l) => s + l.size, 0) || 1;
  return top.map((l) => ({ ...l, pct: (l.size / sum) * 100 }));
}

// ----------------------------------------------------------------- svg ----

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmt = (n) => new Intl.NumberFormat('en-US').format(n);

function fmtDate(iso, withYear = true) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

function frame(width, height, body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>
  <style>
    text { font-family: ${THEME.font}; }
    .title { font-size: 18px; font-weight: 600; fill: ${THEME.title}; }
    .label { font-size: 14px; fill: ${THEME.text}; }
    .value { font-size: 14px; font-weight: 700; fill: ${THEME.text}; }
    .muted { font-size: 12px; fill: ${THEME.muted}; }
    .fade { opacity: 0; animation: fade 0.6s ease-in-out forwards; }
    @keyframes fade { to { opacity: 1; } }
  </style>
  <rect x="0.5" y="0.5" rx="6" width="${width - 1}" height="${height - 1}" fill="${THEME.bg}" stroke="${THEME.border}"/>
${body}
</svg>
`;
}

// Simple 16px icons (Octicons-style paths).
const ICONS = {
  star: 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z',
  commit: 'M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z',
  pr: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z',
  issue: 'M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z',
  repo: 'M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z',
  people: 'M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 3.102 8.05 3.493 3.493 0 0 1 2 5.5ZM11 4a3.001 3.001 0 0 1 2.22 5.018 5.01 5.01 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.752.752 0 0 1-.549-.514 3.507 3.507 0 0 0-2.522-2.372.75.75 0 0 1-.574-.73v-.352a.75.75 0 0 1 .416-.672A1.5 1.5 0 0 0 11 5.5.75.75 0 0 1 11 4Zm-5.5-.5a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 3.5Z',
};

function statsCard({ user, repos }) {
  const stars = repos.reduce((s, r) => s + r.stargazerCount, 0);
  const cc = user.contributionsCollection;
  const rows = [
    ['star', 'Total Stars Earned', stars],
    ['commit', 'Commits (last year)', cc.totalCommitContributions + cc.restrictedContributionsCount],
    ['pr', 'Total PRs', user.pullRequests.totalCount],
    ['issue', 'Total Issues', user.issues.totalCount],
    ['repo', 'Contributed to', user.repositoriesContributedTo.totalCount],
    ['people', 'Followers', user.followers.totalCount],
  ];
  const name = user.name || user.login;
  const body = [
    `  <text x="25" y="35" class="title">${esc(name)}'s GitHub Stats</text>`,
    ...rows.map(([icon, label, value], i) => {
      const y = 62 + i * 24;
      return `  <g class="fade" style="animation-delay:${150 + i * 100}ms" transform="translate(25, ${y})">
    <path transform="translate(0, -12)" fill="${THEME.accent}" d="${ICONS[icon]}"/>
    <text x="26" y="0" class="label">${esc(label)}:</text>
    <text x="220" y="0" class="value">${fmt(value)}</text>
  </g>`;
    }),
  ].join('\n');
  return frame(495, 210, body, `${name}'s GitHub Stats`);
}

function langsCard({ repos }) {
  const langs = topLanguages(repos);
  const width = 495;
  const barX = 25;
  const barW = width - 50;
  let x = barX;
  const segments = langs
    .map((l) => {
      const w = (l.pct / 100) * barW;
      const seg = `<rect x="${x.toFixed(2)}" y="62" width="${w.toFixed(2)}" height="8" fill="${l.color}"/>`;
      x += w;
      return seg;
    })
    .join('');
  const legend = langs
    .map((l, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const lx = 25 + col * 230;
      const ly = 105 + row * 28;
      return `  <g class="fade" style="animation-delay:${150 + i * 100}ms" transform="translate(${lx}, ${ly})">
    <circle cx="5" cy="-5" r="5" fill="${l.color}"/>
    <text x="16" y="0" class="label">${esc(l.name)}</text>
    <text x="200" y="0" class="muted" text-anchor="end">${l.pct.toFixed(1)}%</text>
  </g>`;
    })
    .join('\n');
  const body = langs.length
    ? `  <text x="25" y="35" class="title">Most Used Languages</text>
  <clipPath id="bar"><rect x="${barX}" y="62" width="${barW}" height="8" rx="4"/></clipPath>
  <g clip-path="url(#bar)">${segments}</g>
${legend}`
    : `  <text x="25" y="35" class="title">Most Used Languages</text>
  <text x="25" y="80" class="muted">No language data yet.</text>`;
  return frame(width, 210, body, 'Most Used Languages');
}

function streakCard({ days }) {
  const { total, longest, current, firstDate } = computeStreaks(days);
  const today = new Date().toISOString().slice(0, 10);
  const range = (s) => (s.len ? `${fmtDate(s.start, false)} - ${fmtDate(s.end, false)}` : 'No streak yet');
  const cols = [
    { x: 116, value: fmt(total), label: 'Total Contributions', sub: firstDate ? `${fmtDate(firstDate)} - Present` : '' },
    { x: 330, value: fmt(current.len), label: 'Current Streak', sub: current.len ? range(current) : fmtDate(today), ring: true },
    { x: 544, value: fmt(longest.len), label: 'Longest Streak', sub: range(longest) },
  ];
  const body = [
    `  <line x1="223" y1="28" x2="223" y2="170" stroke="${THEME.border}"/>`,
    `  <line x1="437" y1="28" x2="437" y2="170" stroke="${THEME.border}"/>`,
    ...cols.map((c, i) => {
      const valueY = c.ring ? 92 : 80;
      const ring = c.ring
        ? `    <circle cx="0" cy="83" r="40" fill="none" stroke="${THEME.title}" stroke-width="5"/>
    <g transform="translate(-8, 22)"><path fill="${THEME.accent}" stroke="${THEME.bg}" stroke-width="2" d="M8 0c1 5 6 7 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-3-1-6 1-9Z"/></g>`
        : '';
      const labelY = c.ring ? 150 : 115;
      const subY = c.ring ? 172 : 140;
      return `  <g class="fade" style="animation-delay:${150 + i * 150}ms" transform="translate(${c.x}, 0)" text-anchor="middle">
${ring}
    <text x="0" y="${valueY}" style="font-size:28px;font-weight:700;fill:${THEME.text}">${c.value}</text>
    <text x="0" y="${labelY}" style="font-size:14px;font-weight:600;fill:${c.ring ? THEME.title : THEME.text}">${esc(c.label)}</text>
    <text x="0" y="${subY}" class="muted">${esc(c.sub)}</text>
  </g>`;
    }),
  ].join('\n');
  return frame(660, 195, body, 'GitHub Contribution Streak');
}

function activityCard({ user, days }) {
  const DAYS = 31;
  const byDate = new Map();
  for (const d of days) byDate.set(d.date, (byDate.get(d.date) || 0) + d.count);
  const points = [];
  const now = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    points.push({ date: key, count: byDate.get(key) || 0 });
  }

  const width = 1000;
  const height = 320;
  const pad = { l: 60, r: 30, t: 60, b: 50 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const maxRaw = Math.max(...points.map((p) => p.count), 1);
  const step = Math.max(1, Math.ceil(maxRaw / 4));
  const yMax = step * 4;
  const px = (i) => pad.l + (i / (DAYS - 1)) * plotW;
  const py = (v) => pad.t + plotH - (v / yMax) * plotH;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(p.count).toFixed(1)}`).join(' ');
  const area = `${line} L${px(DAYS - 1).toFixed(1)},${py(0)} L${px(0).toFixed(1)},${py(0)} Z`;

  const grid = [0, 1, 2, 3, 4]
    .map((k) => {
      const v = k * step;
      const y = py(v).toFixed(1);
      return `  <line x1="${pad.l}" y1="${y}" x2="${width - pad.r}" y2="${y}" stroke="${THEME.border}" stroke-dasharray="${k ? '3 4' : '0'}"/>
  <text x="${pad.l - 12}" y="${Number(y) + 4}" class="muted" text-anchor="end">${v}</text>`;
    })
    .join('\n');

  const xLabels = points
    .map((p, i) => (i % 5 === 0 || i === DAYS - 1
      ? `  <text x="${px(i).toFixed(1)}" y="${height - pad.b + 22}" class="muted" text-anchor="middle">${esc(fmtDate(p.date, false))}</text>`
      : ''))
    .filter(Boolean)
    .join('\n');

  const dots = points
    .map((p, i) => `<circle cx="${px(i).toFixed(1)}" cy="${py(p.count).toFixed(1)}" r="3" fill="#FFFFFF" stroke="${THEME.accent}" stroke-width="1.5"><title>${esc(fmtDate(p.date))}: ${p.count}</title></circle>`)
    .join('');

  const name = user.name || user.login;
  const body = `  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${THEME.title}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${THEME.title}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <text x="${width / 2}" y="36" class="title" text-anchor="middle">${esc(name)}'s Contribution Graph (last ${DAYS} days)</text>
${grid}
${xLabels}
  <g class="fade" style="animation-delay:200ms">
    <path d="${area}" fill="url(#area)"/>
    <path d="${line}" fill="none" stroke="${THEME.accent}" stroke-width="2.5" stroke-linejoin="round"/>
    ${dots}
  </g>`;
  return frame(width, height, body, `${name}'s Contribution Graph`);
}

// ---------------------------------------------------------------- main ----

const data = process.env.MOCK ? mockData() : await fetchData();
await mkdir(OUT_DIR, { recursive: true });
const files = {
  'stats.svg': statsCard(data),
  'top-langs.svg': langsCard(data),
  'streak.svg': streakCard(data),
  'activity.svg': activityCard(data),
};
for (const [name, svg] of Object.entries(files)) {
  await writeFile(path.join(OUT_DIR, name), svg);
  console.log(`wrote ${path.join(OUT_DIR, name)}`);
}
