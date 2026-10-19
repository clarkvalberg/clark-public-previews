(() => {
  'use strict';

  const DAY = 86400000;
  const state = { context: null, tasks: null, ledger: [], filter: 'all', mode: 'sample' };
  const el = (id) => document.getElementById(id);
  const contextFile = el('contextFile');
  const tasksFile = el('tasksFile');

  const parseDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const ageInDays = (value, now = new Date()) => {
    const date = parseDate(value);
    return date ? Math.max(0, Math.floor((now - date) / DAY)) : null;
  };

  const freshness = (days) => {
    if (days === null) return 'unknown';
    if (days <= 14) return 'current';
    if (days <= 30) return 'aging';
    return 'stale';
  };

  const basename = (path) => String(path || 'source').split('/').pop();
  const concise = (value, fallback) => String(value || fallback || '').trim().replace(/\s+/g, ' ');

  function claim({ title, detail, source, date, type, stateName, needsClark, blockers, openLoops }) {
    const days = ageInDays(date);
    const flags = [];
    if (!date) flags.push('No confirmation date is available.');
    if (stateName === 'scheduled' && days !== null && days > 0) flags.push('Scheduled date may have passed; reconcile the actual outcome.');
    if (stateName === 'done' && openLoops > 0) flags.push('Marked done while open loops remain.');
    if (needsClark && !['needs_clark', 'blocked'].includes(stateName)) flags.push('Needs Clark but state does not expose that dependency.');
    if (blockers > 0 && stateName === 'done') flags.push('Marked done while blockers remain.');
    return {
      id: `${type}-${source}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 100),
      title,
      detail,
      source,
      confirmedAt: date || null,
      ageDays: days,
      status: freshness(days),
      type,
      flags
    };
  }

  function buildLedger(context, tasks) {
    const output = [];
    const contextSource = basename(context.__filename || 'operating-context-index.json');
    const taskSource = basename(tasks.__filename || 'task-registry.json');

    for (const project of context.projects || []) {
      output.push(claim({
        title: concise(project.name, 'Unnamed project'),
        detail: concise(project.summary || project.desired_outcome, 'Project context'),
        source: contextSource,
        date: project.freshness || context.generated_at,
        type: 'project',
        stateName: project.status
      }));
    }
    for (const theme of context.themes || []) {
      output.push(claim({
        title: concise(theme.name, 'Unnamed theme'),
        detail: concise(theme.summary, 'Durable theme'),
        source: contextSource,
        date: theme.freshness || context.generated_at,
        type: 'theme',
        stateName: theme.trend
      }));
    }
    if (!(context.projects || []).length && !(context.themes || []).length) {
      output.push(claim({
        title: 'Operating context projection',
        detail: 'No project or theme records were found.',
        source: contextSource,
        date: context.generated_at,
        type: 'projection'
      }));
    }
    for (const task of tasks.tasks || []) {
      output.push(claim({
        title: concise(task.title || task.id, 'Unnamed task'),
        detail: concise(task.next_action, 'No next action recorded.'),
        source: taskSource,
        date: task.last_update || tasks.last_updated,
        type: 'task',
        stateName: task.state,
        needsClark: Boolean(task.needs_clark),
        blockers: (task.blockers || []).length,
        openLoops: (task.open_loops || []).length
      }));
    }
    if (!(tasks.tasks || []).length) {
      output.push(claim({
        title: 'Task registry',
        detail: 'No task records were found.',
        source: taskSource,
        date: tasks.last_updated,
        type: 'registry'
      }));
    }
    const statusRank = { stale: 0, unknown: 1, aging: 2, current: 3 };
    return output.sort((a, b) => statusRank[a.status] - statusRank[b.status] || b.flags.length - a.flags.length || (b.ageDays || 0) - (a.ageDays || 0));
  }

  function render() {
    const counts = { current: 0, aging: 0, stale: 0, unknown: 0, flags: 0 };
    state.ledger.forEach((item) => {
      counts[item.status] += 1;
      counts.flags += item.flags.length;
    });
    el('metricClaims').textContent = state.ledger.length;
    el('metricCurrent').textContent = counts.current;
    el('metricAging').textContent = counts.aging;
    el('metricStale').textContent = counts.stale + counts.unknown;
    el('metricFlags').textContent = counts.flags;

    const visible = state.ledger.filter((item) => state.filter === 'all' || item.status === state.filter);
    const queue = el('queue');
    queue.replaceChildren();
    for (const item of visible) {
      const row = document.createElement('article');
      row.className = 'queue-row';
      row.dataset.status = item.status;

      const status = document.createElement('span');
      status.className = 'queue-status';
      status.dataset.status = item.status;
      if (item.status === 'current') status.dataset.ontologySignal = 'current';
      status.textContent = item.status;

      const main = document.createElement('div');
      main.className = 'queue-main';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const detail = document.createElement('small');
      detail.textContent = item.detail;
      main.append(title, detail);
      for (const flagText of item.flags) {
        const flag = document.createElement('span');
        flag.className = 'flag';
        flag.textContent = flagText;
        main.append(flag);
      }

      const source = document.createElement('span');
      source.className = 'queue-source';
      source.textContent = `${item.type} · ${item.source}`;
      const age = document.createElement('span');
      age.className = 'queue-age';
      age.textContent = item.ageDays === null ? 'Date unknown' : `${item.ageDays}d since confirmation`;
      row.append(status, main, source, age);
      queue.append(row);
    }
    el('emptyState').hidden = visible.length > 0;
    el('results').hidden = false;
    el('actionNote').textContent = `${state.ledger.length} claims mapped locally. No data left this tab.`;
  }

  async function readJson(file) {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file.name} is not a JSON object.`);
    data.__filename = file.name;
    return data;
  }

  function updateFileState() {
    el('contextStatus').textContent = contextFile.files[0]?.name || 'Choose operating-context-index.json';
    el('tasksStatus').textContent = tasksFile.files[0]?.name || 'Choose task-registry.json';
    el('analyzeButton').disabled = !(contextFile.files[0] && tasksFile.files[0]);
  }

  async function analyzeFiles() {
    el('errorBanner').hidden = true;
    el('analyzeButton').disabled = true;
    el('actionNote').textContent = 'Reading files locally…';
    try {
      const [context, tasks] = await Promise.all([readJson(contextFile.files[0]), readJson(tasksFile.files[0])]);
      state.context = context;
      state.tasks = tasks;
      state.mode = 'local-files';
      state.ledger = buildLedger(context, tasks);
      render();
      el('results').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } catch (error) {
      el('errorBanner').textContent = `Could not analyze these files: ${error.message}`;
      el('errorBanner').hidden = false;
      el('actionNote').textContent = 'Nothing was uploaded. Correct the files and try again.';
    } finally {
      updateFileState();
    }
  }

  function safeSample() {
    const now = Date.now();
    const isoDaysAgo = (days) => new Date(now - days * DAY).toISOString();
    state.context = {
      __filename: 'safe-operating-context-sample.json',
      generated_at: isoDaysAgo(47),
      projects: [
        { name: 'Bounded Messaging Instances', summary: 'Operate isolated agent experiences with explicit permissions.', status: 'waiting', freshness: isoDaysAgo(47) },
        { name: 'Creative Router Pilot', summary: 'Benchmark a new optional backend against real workflows.', status: 'active', freshness: isoDaysAgo(11) }
      ],
      themes: [
        { name: 'Agentic Interfaces', summary: 'Identity, isolation, permissions, and orchestration.', trend: 'accelerating', freshness: isoDaysAgo(46) }
      ]
    };
    state.tasks = {
      __filename: 'safe-task-registry-sample.json',
      last_updated: isoDaysAgo(27),
      tasks: [
        { id: 'benchmark', title: 'Run five-reference benchmark', state: 'needs_clark', last_update: isoDaysAgo(27), next_action: 'Complete account authorization, then run the benchmark.', needs_clark: true, blockers: ['Authentication required'], open_loops: ['Set spend limit'] },
        { id: 'shipping', title: 'Reconcile scheduled order', state: 'scheduled', last_update: isoDaysAgo(4), next_action: 'Check whether the order completed.', needs_clark: false, blockers: [], open_loops: ['Read back receipt'] },
        { id: 'release', title: 'Credential-independent publishing', state: 'done', last_update: isoDaysAgo(2), next_action: 'Keep Git as publication authority.', needs_clark: false, blockers: [], open_loops: [] }
      ]
    };
    state.mode = 'safe-sample';
    state.ledger = buildLedger(state.context, state.tasks);
    render();
  }

  function clearAll() {
    contextFile.value = '';
    tasksFile.value = '';
    state.context = null;
    state.tasks = null;
    state.ledger = [];
    state.filter = 'all';
    el('results').hidden = true;
    el('errorBanner').hidden = true;
    el('actionNote').textContent = 'Add both files, or use the safe sample.';
    document.querySelectorAll('.filter').forEach((button) => {
      const active = button.dataset.filter === 'all';
      button.classList.toggle('is-active', active);
      if (active) button.dataset.ontologySignal = 'active'; else delete button.dataset.ontologySignal;
    });
    updateFileState();
  }

  function exportLedger() {
    const payload = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      privacy: 'Generated entirely in-browser; source files were not uploaded.',
      mode: state.mode,
      counts: state.ledger.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {}),
      refresh_queue: state.ledger
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'living-context-refresh-queue.json';
    link.click();
    URL.revokeObjectURL(url);
    el('actionNote').textContent = 'Refresh queue exported locally.';
  }

  contextFile.addEventListener('change', updateFileState);
  tasksFile.addEventListener('change', updateFileState);
  el('analyzeButton').addEventListener('click', analyzeFiles);
  el('sampleButton').addEventListener('click', safeSample);
  el('clearButton').addEventListener('click', clearAll);
  el('exportButton').addEventListener('click', exportLedger);
  document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll('.filter').forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle('is-active', active);
      if (active) candidate.dataset.ontologySignal = 'active'; else delete candidate.dataset.ontologySignal;
    });
    render();
  }));
  el('themeToggle').addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    el('themeToggle').textContent = next === 'dark' ? 'Light mode' : 'Dark mode';
    el('themeToggle').setAttribute('aria-label', `Switch to ${next === 'dark' ? 'light' : 'dark'} mode`);
  });

  updateFileState();
})();
