import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { createCanvas, loadImage } from '@napi-rs/canvas';

function twoPagePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 29 >>\nstream\n1 0 0 rg 0 0 100 100 re f\nendstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 6 0 R >>',
    '<< /Length 29 >>\nstream\n0 0 1 rg 0 0 100 100 re f\nendstream',
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += 'xref\n0 7\n0000000000 65535 f \n' + offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

async function assertRedPage(bytes) {
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  assert.deepEqual([...context.getImageData(50, 50, 1, 1).data], [255, 0, 0, 255]);
}

test('PDF extraction sends only the first page as a PNG to the vision model', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ invoice_number: 'INV-1', amount: 42, currency: 'USD' }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { config } = await import('../dist/config.js');
  const savedVllm = { ...config.vllm };
  config.vllm.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  config.vllm.apiKey = 'local-test-key';
  try {
    const { extractInvoice, pdfFirstPageToImage } = await import('../dist/services/extractor.js');
    await assertRedPage(await pdfFirstPageToImage(twoPagePdf()));
    const result = await extractInvoice(twoPagePdf(), 'application/pdf', 'invoice.pdf');
    assert.equal(result.extracted.invoice_number, 'INV-1');
    assert.equal(result.extracted.amount, 42);
    assert.equal(requests.length, 1);
    const imageParts = requests[0].messages[1].content.filter(p => p.type === 'image_url');
    assert.equal(imageParts.length, 1);
    assert.match(imageParts[0].image_url.url, /^data:image\/png;base64,/);
    await assertRedPage(Buffer.from(imageParts[0].image_url.url.split(',')[1], 'base64'));
    await assert.rejects(extractInvoice(Buffer.from('text'), 'text/plain', 'invoice.txt'), /Only images and PDFs/);
    await assert.rejects(pdfFirstPageToImage(Buffer.from('invalid pdf')));
  } finally { Object.assign(config.vllm, savedVllm); await new Promise(resolve => server.close(resolve)); }
});
