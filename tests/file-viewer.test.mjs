import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFilePreview, clearFilePreview } from '../public/file-viewer.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.attributes = {}; }
  append(...elements) { for (const element of elements) { element.parent = this; this.children.push(element); } }
  replaceChildren() { this.children = []; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
}

test('Both image and PDF previews retain loaders until load, handle failures and cancel stale requests', async () => {
  const savedFetch = globalThis.fetch, savedDocument = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag) };
  const stage = new Element('div'), toolbar = { hidden: false };
  const options = { stage, toolbar, url: '/file', name: 'Invoice', mime: 'image/png' };
  try {
    for (const mime of ['image/png', 'application/pdf']) {
      let finish;
      globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
      const task = loadFilePreview({ ...options, mime });
      assert.equal(stage.attributes['aria-busy'], 'true');
      assert.equal(stage.children[0].className, 'viewer-loading');
      assert.equal(toolbar.hidden, true);
      finish(new Response(new Blob(['file'], { type: mime })));
      await task;
      assert.equal(stage.children.length, 2);
      const media = stage.children[1];
      assert.equal(media.tagName, mime.startsWith('image/') ? 'img' : 'iframe');
      assert.equal(media.style.visibility, 'hidden');
      media.onload();
      assert.equal(stage.children.length, 1);
      assert.equal(stage.attributes['aria-busy'], undefined);
      assert.equal(media.style.visibility, '');
      assert.equal(toolbar.hidden, mime === 'application/pdf');
    }
    globalThis.fetch = async () => new Response('{}', { status: 403 });
    await loadFilePreview(options);
    assert.match(stage.children[0].textContent, /Could not load/);
    assert.equal(stage.attributes['aria-busy'], undefined);
    globalThis.fetch = async () => new Response(new Blob(['file']));
    await loadFilePreview(options);
    stage.children[1].onerror();
    assert.match(stage.children[0].textContent, /Could not load/);
    let resolveOld, oldSignal;
    globalThis.fetch = (_url, { signal }) => { oldSignal = signal; return new Promise(resolve => { resolveOld = resolve; }); };
    const oldTask = loadFilePreview(options);
    globalThis.fetch = async () => new Response(new Blob(['new file']));
    await loadFilePreview({ ...options, url: '/new-file' });
    assert.equal(oldSignal.aborted, true);
    const newMedia = stage.children[1];
    resolveOld(new Response(new Blob(['old file']))); await oldTask;
    assert.equal(stage.children[1], newMedia);
    clearFilePreview(stage);
    newMedia.onload();
    assert.equal(stage.children.length, 0);
    await loadFilePreview({ ...options, mime: 'text/plain' });
    assert.match(stage.children[0].textContent, /Preview not available/);
  } finally {
    clearFilePreview(stage); globalThis.fetch = savedFetch; globalThis.document = savedDocument;
  }
});
