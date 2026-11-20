export function createClientGate({ clock = performance, renew, onLock }) {
  const schedule = clock.setTimeout?.bind(clock) ?? setTimeout;
  const cancel = clock.clearTimeout?.bind(clock) ?? clearTimeout;
  let generation = 0,
    deadline = 0,
    timer,
    disposed = false;
  function lock() {
    generation++;
    cancel(timer);
    deadline = 0;
    onLock();
  }
  async function update(wake) {
    if (wake) lock();
    else if (clock.now() >= deadline) {
      lock();
      return false;
    }
    if (disposed) return false;
    const ticket = generation,
      started = clock.now();
    cancel(timer);
    timer = schedule(lock, wake ? 3000 : Math.min(3000, deadline - started));
    try {
      const { ttlMs } = await renew();
      if (ticket !== generation || disposed) return false;
      const remaining = started + Math.min(ttlMs, 20000) - clock.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        lock();
        return false;
      }
      cancel(timer);
      deadline = clock.now() + remaining;
      timer = schedule(lock, remaining);
      return true;
    } catch {
      if (ticket === generation) lock();
      return false;
    }
  }
  return {
    lock,
    resumeCheck: () => update(true),
    heartbeat: () => update(false),
    dispose() {
      disposed = true;
      lock();
    },
    get locked() {
      return disposed || clock.now() >= deadline;
    },
    get generation() {
      return generation;
    }
  };
}

if (typeof document !== 'undefined') {
  const el = (id) => document.getElementById(id);
  const controls = el('controls'),
    status = el('status'),
    output = el('output');
  let holder = false,
    pulse;
  async function api(path, body) {
    const res = await fetch('/probe/v1/' + path, {
      cache: 'no-store',
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const result = await res.json();
    if (!res.ok) throw Error(result.code);
    return result;
  }
  const gate = createClientGate({
    renew: () => api('session/renew', {}),
    onLock() {
      controls.disabled = true;
      output.textContent = '';
      el('object').value = '';
      el('receipt').value = '';
      status.textContent = '已锁定';
      el('preview').replaceChildren();
    }
  });
  async function check(wake = true) {
    if (!holder || document.hidden) return;
    if (await (wake ? gate.resumeCheck() : gate.heartbeat())) {
      controls.disabled = false;
      status.textContent = '持有使用权';
    }
  }
  function schedule() {
    clearInterval(pulse);
    pulse = setInterval(() => check(false), 5000);
  }
  el('login').onclick = async () => {
    try {
      await api('access/login', { token: el('token').value });
      el('token').value = '';
      status.textContent = '已认证，可以申请使用权';
    } catch (e) {
      status.textContent = e.message;
    }
  };
  el('acquire').onclick = async () => {
    try {
      await api('session/acquire', { operationId: crypto.randomUUID() });
      holder = true;
      await check();
      schedule();
    } catch (e) {
      status.textContent = e.message;
    }
  };
  el('release').onclick = async () => {
    holder = false;
    clearInterval(pulse);
    gate.lock();
    try {
      await api('session/release', { operationId: crypto.randomUUID() });
      status.textContent = '已释放';
    } catch (e) {
      status.textContent = e.message;
    }
  };
  const id = () => encodeURIComponent(el('object').value.trim());
  const op = () => ({ operationId: crypto.randomUUID() });
  controls.addEventListener('click', async (e) => {
    if (!e.target.dataset.cmd || gate.locked) return;
    const ticket = gate.generation,
      cmd = e.target.dataset.cmd;
    const paths = {
      cover: ['works/' + id() + '/cover-check', {}],
      report: ['report'],
      library: ['library?page=' + encodeURIComponent(el('page').value)],
      works: ['works/' + id()],
      downloads: ['downloads'],
      verify: ['identity/verify', {}],
      open: ['identity/open', {}],
      collections: ['sources/collections'],
      receipt: ['operations/' + id()],
      read: ['reads/' + id()],
      enqueue: ['downloads', { ...op(), workIds: [el('object').value.trim()] }],
      start: [
        'reads',
        {
          ...op(),
          source: {
            kind: el('kind').value,
            id: el('kind').value === 'total' ? '__all__' : el('object').value.trim()
          }
        }
      ]
    };
    const [path, body] = paths[cmd] ?? [el('target').value + '/' + id() + '/' + cmd, op()];
    if (body?.operationId) el('receipt').value = body.operationId;
    try {
      const result = await api(path, body);
      if (gate.locked || ticket !== gate.generation) return;
      output.textContent = JSON.stringify(result, null, 2);
      if (cmd === 'works') {
        const box = el('preview');
        box.replaceChildren();
        for (const item of result.resources) {
          const button = document.createElement('button');
          button.textContent = '查看 ' + item.key;
          button.onclick = () => {
            if (gate.locked || ticket !== gate.generation) return;
            const media = document.createElement(item.kind === 'video' ? 'video' : 'img');
            if (item.kind === 'video') media.controls = true;
            media.src = '/probe/v1/media/' + encodeURIComponent(item.id);
            box.replaceChildren(media);
          };
          box.append(button);
        }
      }
    } catch (err) {
      if (ticket === gate.generation) {
        output.textContent = err.message;
        if (err.message === 'STALE_LEASE') gate.lock();
      }
    }
  });
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', () => (document.hidden ? gate.lock() : check()));
  window.addEventListener('pagehide', () => gate.lock());
}
