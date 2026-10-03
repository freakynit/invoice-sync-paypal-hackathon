const previews = new WeakMap();

export function clearFilePreview(stage) {
  const previous = previews.get(stage);
  if (previous) {
    previous.controller.abort();
    if (previous.url) URL.revokeObjectURL(previous.url);
    previews.delete(stage);
  }
  stage.removeAttribute('aria-busy');
  stage.replaceChildren();
}

export async function loadFilePreview({ stage, toolbar, url, mime, name }) {
  clearFilePreview(stage);
  toolbar.hidden = true;
  const image = mime.startsWith('image/');
  const pdf = mime === 'application/pdf' || /\.pdf$/i.test(name);
  if (!image && !pdf) {
    const message = document.createElement('div');
    message.className = 'empty';
    message.textContent = 'Preview not available for this file type. ';
    const link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noopener';
    link.textContent = 'Open original';
    message.append(link); stage.append(message);
    return;
  }
  const state = { controller: new AbortController(), url: null };
  previews.set(stage, state);
  const current = () => previews.get(stage) === state;
  const loader = document.createElement('div');
  loader.className = 'viewer-loading';
  loader.setAttribute('role', 'status');
  loader.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Loading original file…</span>';
  stage.setAttribute('aria-busy', 'true');
  stage.append(loader);
  const fail = () => {
    if (!current()) return;
    clearFilePreview(stage);
    toolbar.hidden = true;
    const message = document.createElement('div');
    message.className = 'empty';
    message.textContent = 'Could not load preview. ';
    const link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noopener';
    link.textContent = 'Open original';
    message.append(link); stage.append(message);
  };
  try {
    const response = await fetch(url, { signal: state.controller.signal });
    if (!response.ok) throw new Error('File download failed');
    const blob = await response.blob();
    if (!current()) return;
    state.url = URL.createObjectURL(new Blob([blob], { type: image ? mime : 'application/pdf' }));
    const media = document.createElement(image ? 'img' : 'iframe');
    media.className = image ? 'zoom-img' : 'viewer-frame';
    if (image) media.alt = name;
    else media.title = name;
    media.style.visibility = 'hidden';
    media.onload = () => {
      if (!current()) return;
      loader.remove();
      stage.removeAttribute('aria-busy');
      media.style.visibility = '';
      toolbar.hidden = !image;
    };
    media.onerror = fail;
    media.src = state.url;
    stage.append(media);
  } catch (error) {
    if (error.name !== 'AbortError') fail();
  }
}
