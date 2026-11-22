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

export function createClientOperations(api, onRecord = () => {}) {
  const recent = new Map();
  let unconfirmedAcquire, releaseId, pendingRelease;
  return {
    last: (kind) => recent.get(kind),
    async send(route, body) {
      const kind =
        route === 'session/acquire' ? 'acquire' : route === 'session/release' ? 'release' : 'command';
      if (kind === 'release' && pendingRelease) return pendingRelease;
      if (kind === 'acquire' && pendingRelease) await pendingRelease.catch(() => {});
      const previousId = kind === 'acquire' ? unconfirmedAcquire : kind === 'release' ? releaseId : undefined;
      const operationId = previousId ?? crypto.randomUUID();
      recent.set(kind, operationId);
      onRecord(kind, operationId);
      if (kind === 'acquire') unconfirmedAcquire = operationId;
      if (kind === 'release') {
        unconfirmedAcquire = undefined;
        releaseId = operationId;
        pendingRelease = api(route, { ...body, operationId });
        try {
          return await pendingRelease;
        } finally {
          pendingRelease = undefined;
        }
      }
      try {
        const result = await api(route, { ...body, operationId });
        if (kind === 'acquire' && unconfirmedAcquire === operationId) {
          unconfirmedAcquire = undefined;
          releaseId = undefined;
        }
        return result;
      } catch (error) {
        if (kind === 'acquire' && error.confirmed && unconfirmedAcquire === operationId)
          unconfirmedAcquire = undefined;
        throw error;
      }
    },
    lookup(kind) {
      const id = recent.get(kind);
      if (!id) throw Error('当前标签页没有此类操作 ID');
      return api('operations/' + encodeURIComponent(id));
    }
  };
}

export function createQrView({ image, load, clock = globalThis, urls = URL, onExpire = () => {} }) {
  let current, timer, source;
  function clear() {
    current?.abort();
    current = undefined;
    clock.clearTimeout(timer);
    image.hidden = true;
    image.removeAttribute('src');
    if (source) urls.revokeObjectURL(source);
    source = undefined;
  }
  async function show(revision, allowed = () => true) {
    clear();
    const capture = new AbortController();
    current = capture;
    timer = clock.setTimeout(clear, 15000);
    try {
      const png = await load(revision, capture.signal);
      if (current !== capture) return false;
      if (!allowed()) {
        clear();
        return false;
      }
      source = urls.createObjectURL(png);
      image.src = source;
      await image.decode().catch(() => { throw Error('PROBE_QR_UNAVAILABLE'); });
      if (current !== capture) return false;
      if (!allowed()) {
        clear();
        return false;
      }
      image.hidden = false;
      image.scrollIntoView({ block: 'nearest' });
      clock.clearTimeout(timer);
      timer = clock.setTimeout(() => {
        clear();
        onExpire();
      }, 40000);
      return true;
    } catch (error) {
      if (current !== capture) return false;
      clear();
      throw error;
    }
  }
  return { clear, show };
}

if (typeof document !== 'undefined') {
  const el = (id) => document.getElementById(id);
  const controls = el('controls'),
    status = el('status'),
    output = el('output');
  const qrReadyMessage = '请用手机抖音扫码并确认，再点“核验账号”。';
  let holder = false,
    pulse,
    identityAttempt = 0;
  async function api(path, body) {
    const res = await fetch('/probe/v1/' + path, {
      cache: 'no-store',
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const result = await res.json();
    if (!res.ok) throw Object.assign(Error(result.code), { confirmed: true, authSessionChange: result.authSessionChange });
    return result;
  }
  const operations = createClientOperations(api, (kind, operationId) => {
    const field = el('receipt-' + kind);
    field.value = operationId;
  });
  const qrView = createQrView({
    image: el('login-qr'),
    onExpire() {
      if (output.textContent === qrReadyMessage) {
        output.textContent = '二维码显示时间已到。已在手机确认可点“核验账号”继续，否则可重新打开登录页。';
      }
    },
    async load(revision, signal) {
      const res = await fetch('/probe/v1/identity/qr?revision=' + encodeURIComponent(revision), {
        cache: 'no-store', signal
      });
      if (!res.ok) throw Error((await res.json()).code);
      if (res.headers.get('Content-Type') !== 'image/png') throw Error('PROBE_QR_UNAVAILABLE');
      return res.blob();
    }
  });
  const gate = createClientGate({
    renew: () => api('session/renew', {}),
    onLock() {
      qrView.clear();
      controls.disabled = true;
      output.textContent = '';
      el('object').value = '';
      el('token').value = '';
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
      await operations.send('session/acquire', {});
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
      await operations.send('session/release', {});
      status.textContent = '已释放';
    } catch (e) {
      status.textContent = e.message;
    }
  };
  const id = () => encodeURIComponent(el('object').value.trim());
  controls.addEventListener('click', async (e) => {
    if (!e.target.dataset.cmd || gate.locked) return;
    const ticket = gate.generation,
      cmd = e.target.dataset.cmd;
    const identityTicket = ['open', 'verify'].includes(cmd) ? ++identityAttempt : null;
    const current = () => !gate.locked && ticket === gate.generation &&
      (identityTicket === null || identityTicket === identityAttempt);
    if (identityTicket !== null) {
      qrView.clear();
      output.textContent = '';
    }
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
      enqueue: ['downloads', { workIds: [el('object').value.trim()] }],
      start: [
        'reads',
        {
          source: {
            kind: el('kind').value,
            id: el('kind').value === 'total' ? '__all__' : el('object').value.trim()
          }
        }
      ]
    };
    const [path, body] = paths[cmd] ?? [el('target').value + '/' + id() + '/' + cmd, {}];
    try {
      const result =
        cmd === 'saved-receipt'
          ? await operations.lookup(el('receipt-kind').value)
          : ['enqueue', 'start', 'pause', 'resume', 'stop', 'cancel'].includes(cmd)
            ? await operations.send(path, body)
            : await api(path, body);
      if (!current()) return;
      if (cmd === 'open') {
        output.textContent = '正在检查来源登录页…';
        if (await qrView.show(result.pageRevision, current) && current())
          output.textContent = qrReadyMessage;
        return;
      }
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
      if (current()) {
        if (cmd === 'open' && ['PROBE_QR_UNAVAILABLE', 'STALE_BROWSER_VIEW'].includes(err.message)) {
          output.textContent = '暂无可用的扫码二维码。可重新打开登录页。如果来源要求短信或安全验证，需要在受信任的服务端浏览器手动操作。';
        } else if (cmd === 'verify' && err.message === 'PROBE_AUTH_REQUIRED') {
          output.textContent = '来源尚未确认登录。请在手机确认。如果来源要求短信或安全验证，需要在受信任的服务端浏览器手动操作。';
        } else if (cmd === 'collections' && err.authSessionChange === 'before-read') {
          output.textContent = 'STALE_AUTH_EPOCH：抖音会话在发送读取请求前有变化。';
        } else if (cmd === 'collections' && err.authSessionChange === 'after-read') {
          output.textContent = 'STALE_AUTH_EPOCH：抖音会话在收到读取响应后有变化。';
        } else {
          output.textContent = err.message;
        }
        if (err.message === 'STALE_LEASE') gate.lock();
      }
    }
  });
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', () => (document.hidden ? gate.lock() : check()));
  window.addEventListener('pagehide', () => gate.lock());
}
