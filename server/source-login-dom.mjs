function inspectLoginPanel(readPanel, { key, action }) {
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.floor(rect.left),
      y: Math.floor(rect.top),
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height)
    };
  };
  const compact = (element) => (element.innerText || '').replace(/\s+/g, '');
  const label = (element) => (element.getAttribute('aria-label') || compact(element)).trim();
  const fits = (rect) =>
    rect.width >= 260 &&
    rect.height >= 160 &&
    rect.width <= 920 &&
    rect.height <= 720 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= innerWidth &&
    rect.y + rect.height <= innerHeight;
  const visible = (element) => {
    const { width, height } = box(element);
    const style = getComputedStyle(element);
    return (
      width > 5 &&
      height > 5 &&
      style.visibility === 'visible' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  };
  const sameBox = (first, second) => Object.keys(first).every((key) => first[key] === second[key]);
  const changesAccount =
    /(?:更换|修改|换绑|解绑|重置)(?:绑定)?(?:手机号|密码|邮箱)|(?:注销|删除)(?:抖音)?账号|授权管理|隐私设置/;
  const challengeLabel =
    /^(身份验证|安全验证|手机号验证|手机验证|短信验证|输入验证码|请输入验证码|接收短信验证码|发送短信验证)$/;
  const qrLabel = /^(扫码登录|二维码登录|使用抖音扫码登录)$/;
  if (scrollX !== 0 || scrollY !== 0) return null;
  const knownRect = readPanel();
  const surfaces = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')];
  if (knownRect && fits(knownRect)) {
    const center = document.elementsFromPoint(
      knownRect.x + knownRect.width / 2,
      knownRect.y + knownRect.height / 2
    );
    surfaces.unshift(...center.filter((element) => sameBox(box(element), knownRect)));
  }
  let selected;
  let challenge;
  const titlesOf = (surface) =>
    [...surface.querySelectorAll('h1,h2,h3,[role="heading"],button,span,div')]
      .filter((element) => element.children.length < 3 && visible(element))
      .map(compact);
  for (const surface of surfaces) {
    const rect = box(surface);
    if (!fits(rect) || !visible(surface) || changesAccount.test(compact(surface))) continue;
    const titles = titlesOf(surface);
    challenge = !!knownRect && sameBox(rect, knownRect) && titles.some((title) => challengeLabel.test(title));
    const qr = titles.some((title) => qrLabel.test(title)) && !!surface.querySelector('canvas,img,svg');
    if (challenge || qr) {
      selected = surface;
      break;
    }
  }
  if (!selected && ['locate', 'open', 'qr'].includes(action)) {
    // The official QR modal can omit dialog attributes. This recognition is only for the QR path.
    selected = document.elementsFromPoint(innerWidth / 2, innerHeight / 2).find((surface) => {
      if (
        !fits(box(surface)) ||
        !visible(surface) ||
        !(parseFloat(getComputedStyle(surface).borderRadius) > 0) ||
        changesAccount.test(compact(surface)) ||
        !surface.querySelector('canvas,img,svg')
      )
        return false;
      const titles = titlesOf(surface);
      return (
        titles.includes('如何扫码') &&
        titles.includes('验证码登录') &&
        titles.some((title) => qrLabel.test(title)) &&
        !titles.some((title) => challengeLabel.test(title))
      );
    });
  }
  if (!selected) {
    if (action === 'locate' || action === 'open') {
      // Opening the ordinary login dialog is the only action outside a recognized panel.
      const entry = [...document.querySelectorAll('button,[role="button"]')].find(
        (element) =>
          label(element) === '登录' &&
          !element.closest('a[href]') &&
          !element.disabled &&
          element.getAttribute('aria-disabled') !== 'true' &&
          visible(element)
      );
      if (!entry || document.readyState === 'loading') return { loginEntry: 'not-present' };
      if (action === 'locate') return { loginEntry: 'ready' };
      entry.click();
      return { loginEntry: 'clicked' };
    }
    return null;
  }
  const identities = (window[key] ??= { elements: new WeakMap(), next: 0 });
  if (!identities.elements.has(selected)) identities.elements.set(selected, ++identities.next);
  return { ...box(selected), id: identities.elements.get(selected), challenge };
}

function loginQrRegion({ key, panel, encode, maxBitmapSize }) {
  const compact = (element) => (element.innerText || element.textContent || '').replace(/\s+/g, '');
  if (!document.body || scrollX || scrollY) return null;
  const body = compact(document.body);
  if (
    /访问.{0,3}频繁|操作过于频繁|请求过于频繁|二维码.{0,3}(失效|过期)|扫码成功|扫描成功|请在手机.{0,8}确认登录|已确认[，,].{0,8}正在登录|接收短信验证码|发送短信验证|请输入.{0,16}短信验证码|验证码已发送|请使用绑定手机号.{0,12}验证|请(?:先)?完成.{0,8}验证|拖动.{0,8}滑块|按住.{0,8}滑块|请依次点击/.test(
      body
    )
  )
    return null;

  const state = window[key];
  const surface = document
    .elementsFromPoint(panel.x + panel.width / 2, panel.y + panel.height / 2)
    .find((element) => state?.elements.get(element) === panel.id);
  if (!surface) return null;

  const visible = (element) => {
    const { width, height } = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      width > 5 &&
      height > 5 &&
      style.visibility === 'visible' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  };
  const headings = [...surface.querySelectorAll('h1,h2,h3,[role="heading"],button,span,div')]
    .filter((element) => element.children.length < 3 && visible(element))
    .map(compact);
  if (
    !headings.some((title) => /^(扫码登录|二维码登录|使用抖音扫码登录)$/.test(title)) ||
    headings.some((title) =>
      /^(身份验证|安全验证|手机号验证|手机验证|短信验证|输入验证码|请输入验证码)$/.test(title)
    )
  )
    return null;

  const candidates = [];
  for (const element of surface.querySelectorAll('img,canvas,svg')) {
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
    if (
      !visible(element) ||
      width < 100 ||
      height < 100 ||
      width > 450 ||
      height > 450 ||
      Math.abs(width / height - 1) > 0.12 ||
      left < panel.x ||
      top < panel.y ||
      right > panel.x + panel.width ||
      bottom > panel.y + panel.height
    )
      continue;
    candidates.push(element);
  }
  if (candidates.length !== 1) return null;
  const [element] = candidates;
  const label = (node) =>
    ['aria-label', 'alt', 'id', 'class', 'src'].map((name) => node.getAttribute(name)).join(' ');
  let marked = /二维码|qrcode|qr-code|\/qr\//i.test(label(element));
  for (
    let ancestor = element.parentElement;
    !marked && ancestor && ancestor !== surface;
    ancestor = ancestor.parentElement
  ) {
    const { width, height } = ancestor.getBoundingClientRect();
    if (width > 520 || height > 520) break;
    marked = /qrcode|qr-code|扫码登录|二维码登录|如何扫码|扫一扫/i.test(label(ancestor) + compact(ancestor));
  }
  if (!marked) return null;

  const isImage = element.tagName === 'IMG';
  if (!isImage && element.tagName !== 'CANVAS') return null;
  const source = isImage ? element.currentSrc : undefined;
  if (
    isImage &&
    (!element.complete ||
      !source ||
      (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(source) &&
        !/^https:\/\/[^?#]+\.(?:png|jpe?g|webp)(?:[?#]|$)/i.test(source)))
  )
    return null;
  const pixelWidth = isImage ? element.naturalWidth : element.width;
  const pixelHeight = isImage ? element.naturalHeight : element.height;
  const inlineQr =
    isImage &&
    /^data:image\/(?:png|jpeg|webp);base64,/i.test(source) &&
    pixelWidth === maxBitmapSize &&
    pixelHeight === maxBitmapSize;
  if (
    ![pixelWidth, pixelHeight].every(
      (size) => Number.isInteger(size) && size >= 100 && (size <= 450 || inlineQr)
    ) ||
    Math.abs(pixelWidth / pixelHeight - 1) > 0.12
  )
    return null;
  const { left, top, right, bottom } = element.getBoundingClientRect();
  const x = Math.ceil(left),
    y = Math.ceil(top);
  const width = Math.floor(right) - x,
    height = Math.floor(bottom) - y;
  // The current inline QR has rounded corners and a separate small SVG logo at its center.
  const inset = inlineQr ? Math.ceil(Math.min(width, height) / 10) : 0;
  const x1 = x + inset,
    y1 = y + inset,
    x2 = x + width - 1 - inset,
    y2 = y + height - 1 - inset;
  if (
    ![
      [x1, y1],
      [x2, y1],
      [x1, y2],
      [x2, y2]
    ].every(([a, b]) => element.contains(document.elementFromPoint(a, b)))
  )
    return null;
  const cx = x + width / 2,
    cy = y + height / 2;
  const center = document.elementFromPoint(cx, cy);
  if (!element.contains(center)) {
    const logo = inlineQr && center?.closest('svg');
    if (
      !logo ||
      !element.parentElement.contains(logo) ||
      !document.elementsFromPoint(cx, cy).includes(element)
    )
      return null;
    const rect = logo.getBoundingClientRect();
    if (
      rect.width > width / 3 ||
      rect.height > height / 3 ||
      rect.left < left ||
      rect.right > right ||
      rect.top < top ||
      rect.bottom > bottom
    )
      return null;
  }
  const regions = (state.qrRegions ??= new WeakMap());
  if (regions.get(element)?.source !== source || !regions.has(element)) {
    regions.set(element, { source, id: ++state.next });
  }
  const region = { id: regions.get(element).id, x, y, width, height, pixelWidth, pixelHeight };
  if (!encode) return region;
  // Draw the element bitmap at its native size, outside the document's compositing tree.
  try {
    const bitmap = document.createElement('canvas');
    bitmap.width = pixelWidth;
    bitmap.height = pixelHeight;
    const context = bitmap.getContext('2d');
    context.drawImage(element, 0, 0);
    // A slow component can expose its final marked canvas before its first paint.
    // Check contrast after compositing on white, without decoding any login payload.
    const pixels = context.getImageData(0, 0, pixelWidth, pixelHeight).data;
    let dark = 0,
      light = 0;
    for (let i = 0; i < pixels.length; i += 16) {
      const opacity = pixels[i + 3] / 255;
      const brightness = ((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3) * opacity + 255 * (1 - opacity);
      if (brightness < 110) dark++;
      if (brightness > 180) light++;
    }
    if (Math.min(dark, light) < (pixelWidth * pixelHeight) / 100) return null;
    const url = bitmap.toDataURL('image/png');
    const prefix = 'data:image/png;base64,';
    if (url.startsWith(prefix) && url.length <= prefix.length + 4 * Math.ceil((1024 * 1024) / 3)) {
      return { ...region, png: url.slice(prefix.length) };
    }
  } catch {
    // Tainted or unreadable bitmaps stay in the browser.
  }
  return null;
}

export { inspectLoginPanel, loginQrRegion };
