/**
 * Mission control: intents on the left, the factory on the right, and working software, journeys walked and
 * passing, as the measure between them.
 */
import { factoryIntent, loadFeed, studioIntent, type Feed, type IntentRow, type Status } from './feed.ts';
import { factoryPanel, headline, intentCard, journeyDetail, journeys } from './views.ts';
import { drawer, $ } from './shell.ts';

let feed: Feed | null = null;
let rows: IntentRow[] = [];
let selected = 'factory';
let filter: Status | 'all' = 'all';

function studioRaw(): string | null {
  try {
    return localStorage.getItem('intent-studio:v1');
  } catch {
    return null;
  }
}

function render() {
  const row = rows.find((r) => r.id === selected) ?? rows[0] ?? null;
  if (row) selected = row.id;
  $('measure').innerHTML = headline(row, feed);
  $('intents').innerHTML = `<ul class="ilist">${rows.map((r) => intentCard(r, r.id === selected)).join('')}</ul><a class="btn new" href="/intent">${rows.some((r) => r.source === 'studio') ? 'Open your intent in the studio' : 'Write an intent'}</a>`;
  $('journeys').innerHTML = row ? journeys(row, filter) : '<p class="muted">Journeys appear here once there is an intent.</p>';
  $('journeys-h').textContent = row ? `Journeys: ${row.title}` : 'Journeys';
  $('factory').innerHTML = factoryPanel(feed);
}

async function start() {
  document.documentElement.classList.add('js');
  feed = await loadFeed();
  const studio = studioIntent(studioRaw(), feed);
  rows = [...(feed ? [factoryIntent(feed)] : []), ...(studio ? [studio] : [])];
  if (!feed && studio) selected = 'studio';
  render();
  document.body.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-intent], [data-filter], [data-journey]');
    if (!t) return;
    if (t.dataset['intent']) {
      selected = t.dataset['intent'];
      filter = 'all';
      render();
      document.querySelector<HTMLElement>(`[data-intent="${selected}"]`)?.focus();
    } else if (t.dataset['filter']) {
      filter = t.dataset['filter'] as Status | 'all';
      render();
      document.querySelector<HTMLElement>(`[data-filter="${filter}"]`)?.focus();
    } else if (t.dataset['journey']) {
      const row = rows.find((r) => r.id === selected);
      const d = row && journeyDetail(row, t.dataset['journey']);
      if (d) drawer.open(d.title, d.html, t);
    }
  });
  window.addEventListener('storage', (e) => {
    if (e.key !== 'intent-studio:v1') return;
    const studio = studioIntent(e.newValue, feed);
    rows = [...rows.filter((r) => r.source !== 'studio'), ...(studio ? [studio] : [])];
    render();
  });
}

void start();
