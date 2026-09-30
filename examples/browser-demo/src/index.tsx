/**
 * Browser demo for @adsq/solid-signal-store. The Playwright suite in test/browser drives this
 * file, so its labels, test ids and behaviour are part of the test contract.
 *
 * Layout
 *   1. Stores      two named stores: `app` (Store + Design views) and `dashboard`.
 *   2. StoreView   board of 160 cells, wake-mode + batch toggles, JSNQ mutation, dynamic key.
 *   3. DesignView  sliders/inputs writing straight into store.design.componentA.*.
 *   4. DashboardView  metrics, history and services of the separately named store.
 *   5. App         tab switcher and the timer that feeds the dashboard store.
 *
 * Conventions used throughout (see the root README, "In Solid Components"):
 *   - a leaf is called to read it:           store.board.leftClicks()
 *   - a write is a plain assignment:         store.board.leftClicks = n
 *   - list items are plain snapshots, so a field that changes over time is read through its
 *     index:                                 store.board.rows[r].cells[c].value()
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { createSolidStore, onSolidDevAction, waitForStore } from '@adsq/solid-signal-store';
import '@adsq/solid-signal-store/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

// ---------------------------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------------------------

type Tab = 'store' | 'design' | 'dashboard';
type WakeMode = 'grained' | 'container';

const colors = ['#c7d2fe', '#bae6fd', '#bbf7d0', '#fde68a', '#fecdd3', '#ddd6fe'];

function makeBoard(rows = 10, columns = 16) {
  return Array.from({ length: rows }, (_, row) => ({
    id: `row-${row}`,
    cells: Array.from({ length: columns }, (_, column) => ({
      id: `cell-${row}-${column}`,
      value: row * columns + column,
      color: colors[(row + column) % colors.length],
      clicks: 0,
      meta: { row, column, changedAt: 0 },
    })),
  }));
}

// `preciseMutationWake` lets the flat `users.mutate(where(...), update(...))` below wake only the
// changed leaves and the `users` branch instead of every observed descendant.
const appApi = createSolidStore({
  board: {
    rows: makeBoard(),
    batch: true,
    wakeMode: 'grained' as WakeMode,
    leftClicks: 0,
    rightClicks: 0,
    lastCell: '',
  },
  users: [
    { id: 1, name: 'Ann', active: true, score: 72 },
    { id: 2, name: 'Bob', active: false, score: 61 },
    { id: 3, name: 'Cy', active: true, score: 84 },
  ],
  design: {
    componentA: {
      width: 620,
      height: 360,
      padding: 32,
      radius: 6,
      accent: '#6d7cff',
      surface: '#151824',
      title: 'Adaptive AI workspace',
    },
  },
  runtime: {} as Record<string, unknown>,
}, 'app', { preciseMutationWake: true });

const dashboardApi = createSolidStore({
  metrics: { requests: 128430, throughput: 2840, latency: 24, errors: 3 },
  services: [
    { name: 'query-api', status: 'healthy', rps: 1180, latency: 18 },
    { name: 'mutation-worker', status: 'healthy', rps: 940, latency: 26 },
    { name: 'event-stream', status: 'healthy', rps: 720, latency: 31 },
  ],
  history: [42, 48, 44, 56, 61, 58, 68, 72, 69, 77, 74, 82],
}, 'dashboard');

// The stores are used through an untyped view so event handlers can assign directly
// (`cell.value = ...`). On a typed store direct assignment is a type error; typed code assigns
// through `api.setValue(path, value)` or a cast write view (see the README, "TypeScript").
const store = appApi.store as any;
const dashboard = dashboardApi.store as any;

// ---------------------------------------------------------------------------------------------
// Store view: fine-grained board, wake modes, batching, JSNQ, dynamic keys
// ---------------------------------------------------------------------------------------------

function StoreView() {
  // Only the row/cell *structure* is read as a whole; each cell then binds its own leaves below.
  const rows = createMemo(() => store.board.rows());
  const [events, setEvents] = createSignal<string[]>([]);

  const log = (message: string) => setEvents((current) => [message, ...current].slice(0, 8));

  // The Batch toggle wraps the multi-write handlers in api.batch(): one reactive flush instead of
  // one per write. Writes are synchronous and readable either way.
  const runBoardMutation = (mutation: () => void) => {
    if (store.board.batch()) appApi.batch(mutation);
    else mutation();
  };

  const leftClick = (row: number, column: number) => {
    runBoardMutation(() => {
      const cell = store.board.rows[row].cells[column];
      cell.value = cell.value() + 1;
      cell.clicks = cell.clicks() + 1;
      cell.meta.changedAt = Date.now();
      store.board.leftClicks = store.board.leftClicks() + 1;
      store.board.lastCell = cell.id();
    });
  };

  const rightClick = (event: MouseEvent, row: number, column: number) => {
    event.preventDefault();
    runBoardMutation(() => {
      const cell = store.board.rows[row].cells[column];
      const next = (colors.indexOf(cell.color()) + 1) % colors.length;
      cell.color = colors[next];
      cell.meta.changedAt = Date.now();
      store.board.rightClicks = store.board.rightClicks() + 1;
      store.board.lastCell = cell.id();
    });
  };

  // 'grained' wakes the exact written path; 'container' also wakes its parents.
  const setWakeMode = (mode: WakeMode) => {
    store.board.wakeMode = mode;
    appApi.wakeUp(mode);
    log(`wake mode: ${mode}`);
  };

  // JSNQ bulk mutation; enabled by the `@adsq/solid-signal-store/jsnq` import at the top.
  const mutateActiveUsers = () => {
    store.users.mutate(
      where('active', '===', true),
      update('score', (score: number) => score + 1),
    );
    log('JSNQ updated active user scores');
  };

  // `runtime` starts as `{}`; `lastAction` is created on first assignment.
  const addDynamicKey = () => {
    store.runtime.lastAction = `dynamic-${Date.now()}`;
    log(`runtime.lastAction = ${store.runtime.lastAction()}`);
  };

  const resetBoard = () => runBoardMutation(() => {
    store.board.rows = makeBoard();
    store.board.leftClicks = 0;
    store.board.rightClicks = 0;
    store.board.lastCell = '';
  });

  // Devtools events of the `app` store (enabled in App) feed the "Runtime events" panel.
  onMount(() => {
    const unsubscribe = onSolidDevAction((event) => {
      if (event.storeName === 'app') log(`${event.type}: ${String(event.payload?.path ?? '')}`);
    });
    onCleanup(unsubscribe);
  });

  return (
    <section class="page store-page" data-testid="solid-store-page">
      <header class="page-heading">
        <div><span class="eyebrow">PROXY RENDER LAB</span><h1>Store board</h1></div>
        <div class="store-stats">
          <span>left <strong>{store.board.leftClicks()}</strong></span>
          <span>right <strong>{store.board.rightClicks()}</strong></span>
          <span>last <strong>{store.board.lastCell() || '-'}</strong></span>
        </div>
      </header>

      <div class="toolbar">
        <label class="toggle"><input type="checkbox" checked={store.board.batch()} onChange={(event) => store.board.batch = event.currentTarget.checked} /><span>Batch</span></label>
        <label>Wake
          <select value={store.board.wakeMode()} onInput={(event) => setWakeMode(event.currentTarget.value as WakeMode)}>
            <option value="grained">grained</option>
            <option value="container">container</option>
          </select>
        </label>
        <button type="button" onClick={mutateActiveUsers}>Mutate active users</button>
        <button type="button" onClick={addDynamicKey}>Add dynamic key</button>
        <button type="button" onClick={resetBoard}>Reset board</button>
        <code>store.board.rows[row].cells[col].value = value</code>
      </div>

      <div class="board-layout">
        <div class="board" data-testid="solid-store-board">
          <For each={rows()}>{(row: any, rowIndex) =>
            <For each={row.cells}>{(_cell: any, columnIndex) =>
              <button
                type="button"
                class="board-cell"
                style={{ background: store.board.rows[rowIndex()].cells[columnIndex()].color() }}
                data-testid={`solid-board-cell-${rowIndex()}-${columnIndex()}`}
                onClick={() => leftClick(rowIndex(), columnIndex())}
                onContextMenu={(event) => rightClick(event, rowIndex(), columnIndex())}>
                <strong>{store.board.rows[rowIndex()].cells[columnIndex()].value()}</strong>
                <span>{store.board.rows[rowIndex()].cells[columnIndex()].clicks()} clicks</span>
              </button>
            }</For>
          }</For>
        </div>

        <aside class="event-log">
          <h2>Runtime events</h2>
          <For each={events()} fallback={<p>No events yet</p>}>
            {(entry) => <code>{entry}</code>}
          </For>
          <h2>Users</h2>
          <For each={store.users()}>{(user: any) =>
            <div class="user-row"><span>{user.name}</span><strong>{user.score}</strong></div>
          }</For>
        </aside>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Design view: every control writes one nested leaf, every style reads one nested leaf
// ---------------------------------------------------------------------------------------------

function DesignView() {
  const component = store.design.componentA;
  const setNumber = (key: string, value: string) => component[key] = Number(value);

  return (
    <section class="page" data-testid="solid-design-page">
      <header class="page-heading"><div><span class="eyebrow">DESIGN STORE</span><h1>Reactive component tuning</h1></div></header>
      <div class="design-workspace">
        <div class="preview-stage">
          <article class="ai-component" style={{
            '--panel-width': `${component.width()}px`,
            '--panel-height': `${component.height()}px`,
            '--panel-padding': `${component.padding()}px`,
            '--panel-radius': `${component.radius()}px`,
            '--panel-accent': component.accent(),
            '--panel-surface': component.surface(),
          }}>
            <div class="component-topline"><i></i><span>MODEL SESSION 04</span><b>18 ms</b></div>
            <h2>{component.title()}</h2>
            <p>Dimensions and visual tokens are read from callable proxy leaves.</p>
            <div class="prompt"><span>Summarize the active workspace</span><button type="button">Run</button></div>
            <div class="tokens"><span>context 72%</span><span>quality high</span><span>streaming</span></div>
          </article>
        </div>
        <aside class="controls">
          <div class="control-heading"><strong>componentA</strong><code>store.design.componentA</code></div>
          <For each={[
            ['width', 360, 820, 10], ['height', 240, 520, 10], ['padding', 12, 64, 2], ['radius', 0, 8, 1],
          ]}>{([key, min, max, step]) =>
            <label><span>{key} <output>{component[key]()}px</output></span><input type="range" min={min} max={max} step={step} value={component[key]()} onInput={(event) => setNumber(String(key), event.currentTarget.value)} /></label>
          }</For>
          <label><span>Title</span><input type="text" value={component.title()} onInput={(event) => component.title = event.currentTarget.value} /></label>
          <div class="color-controls">
            <label><span>Accent</span><input type="color" value={component.accent()} onInput={(event) => component.accent = event.currentTarget.value} /></label>
            <label><span>Surface</span><input type="color" value={component.surface()} onInput={(event) => component.surface = event.currentTarget.value} /></label>
          </div>
        </aside>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Dashboard view: a separately named store fed by a timer (see App)
// ---------------------------------------------------------------------------------------------

function DashboardView() {
  return (
    <section class="page" data-testid="solid-dashboard-page">
      <header class="page-heading dashboard-heading"><div><span class="eyebrow">LIVE OPERATIONS</span><h1>Runtime dashboard</h1></div><p><i></i> All systems operational</p></header>
      <div class="metrics">
        <article><span>Total requests</span><strong>{dashboard.metrics.requests()}</strong><small>cumulative</small></article>
        <article><span>Throughput</span><strong>{dashboard.metrics.throughput()}</strong><small>events / sec</small></article>
        <article><span>p50 latency</span><strong>{dashboard.metrics.latency()} ms</strong><small>last interval</small></article>
        <article><span>Error count</span><strong>{dashboard.metrics.errors()}</strong><small>rolling hour</small></article>
      </div>
      <div class="dashboard-grid">
        <section class="chart"><header><h2>Throughput history</h2><span>{dashboard.history.length} samples</span></header><div class="bars"><For each={dashboard.history()}>{(value: number) => <i style={{ height: `${value}%` }}></i>}</For></div></section>
        <section class="services"><header><h2>Services</h2><span>realtime</span></header><div class="service-row head"><span>Service</span><span>Status</span><span>RPS</span><span>Latency</span></div><For each={dashboard.services()}>{(service: any, index) => <div class="service-row"><strong>{service.name}</strong><span class="healthy">{service.status}</span><span>{dashboard.services[index()].rps()}</span><span>{dashboard.services[index()].latency()} ms</span></div>}</For></section>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// App: tabs, devtools wiring, and the timer that feeds the dashboard store
// ---------------------------------------------------------------------------------------------

function App() {
  const [tab, setTab] = createSignal<Tab>('store');
  let interval: ReturnType<typeof setInterval> | undefined;

  onMount(async () => {
    // Resolves at once here because the store is created at module scope; it is the same call a
    // separately loaded consumer would use to wait for a store created elsewhere.
    await waitForStore('dashboard', { timeoutMs: 1_000 });
    // Devtools live in their own entry, loaded only in development.
    if (import.meta.env.DEV) {
      const { createSolidDevtools } = await import('@adsq/solid-signal-store/devtools');
      appApi.attachDevtools(createSolidDevtools());
      appApi.enableDevTools('app');
    }
    // One batch per tick: the metric, service and history writes flush as a single update.
    interval = setInterval(() => dashboardApi.batch(() => {
      dashboard.metrics.requests = dashboard.metrics.requests() + Math.floor(120 + Math.random() * 80);
      dashboard.metrics.throughput = Math.floor(2600 + Math.random() * 500);
      dashboard.metrics.latency = Math.floor(18 + Math.random() * 16);
      dashboard.services[0].rps = Math.floor(1050 + Math.random() * 220);
      dashboard.history.push(Math.floor(44 + Math.random() * 42));
      if (dashboard.history.length > 18) dashboard.history.shift();
    }), 1_500);
  });

  onCleanup(() => {
    if (interval) clearInterval(interval);
    appApi.destroy();
    dashboardApi.destroy();
  });

  return (
    <div class="app-shell">
      <header class="app-header"><button class="brand" type="button" onClick={() => setTab('store')}>SolidStore</button><nav><For each={['store', 'design', 'dashboard'] as Tab[]}>{(name) => <button type="button" classList={{ active: tab() === name }} onClick={() => setTab(name)}>{name[0].toUpperCase() + name.slice(1)}</button>}</For></nav></header>
      <main><Show when={tab() === 'store'}><StoreView /></Show><Show when={tab() === 'design'}><DesignView /></Show><Show when={tab() === 'dashboard'}><DashboardView /></Show></main>
    </div>
  );
}

render(() => <App />, document.getElementById('root')!);
