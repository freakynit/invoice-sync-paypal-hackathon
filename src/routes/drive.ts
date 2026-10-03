import { Router } from 'express';
import { z } from 'zod';
import { isGoogleConfigured } from '../config.js';
import { query } from '../db/pool.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { ensureGoogleConfigured, getConnection, getGoogleAuthUrl, listDriveFolders, listSelectedFolderFiles, validateDriveFolder } from '../services/drive.js';
import { randomToken } from '../utils/auth.js';
import pLimit from 'p-limit';

const router = Router();
const thumbnailLimit = pLimit(2);
router.use(requireAuth);

router.get('/status', async (req: AuthedRequest, res) => {
  const { isDemoUser } = await import('../services/demo.js');
  if (await isDemoUser(req.userId!).catch(() => false)) {
    res.json({ googleConfigured: true, connected: true, googleEmail: 'demo@invoice-sync.local',
      folders: [{ id: 'demo-root', name: 'Demo Invoices' }], demo: true });
    return;
  }
  const conn = await getConnection(req.userId!);
  res.json({ googleConfigured: isGoogleConfigured(), connected: Boolean(conn?.access_token || conn?.refresh_token),
    googleEmail: conn?.google_email ?? null, folders: conn?.folders ?? [], demo: false });
});

router.get('/connect-url', async (req: AuthedRequest, res) => {
  const { isDemoUser } = await import('../services/demo.js');
  if (await isDemoUser(req.userId!).catch(() => false)) {
    res.status(403).json({ error: 'Not available in Demo mode — demo uses seeded invoices. Use a real account to connect Google Drive.' });
    return;
  }
  try {
    await ensureGoogleConfigured();
    const state = randomToken(32);
    await query(`DELETE FROM drive_oauth_states WHERE expires_at < NOW()`);
    await query(`INSERT INTO drive_oauth_states (state,user_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '10 minutes')`, [state, req.userId]);
    res.json({ url: getGoogleAuthUrl(state) });
  } catch (err) {
    res.status(501).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/folders', async (req: AuthedRequest, res) => {
  const parent = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).safeParse(req.query.parentId ?? 'root');
  if (!parent.success) { res.status(400).json({ error: 'Invalid parent folder' }); return; }
  try { res.json({ folders: await listDriveFolders(req.userId!, parent.data) }); }
  catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
});

router.put('/folders', async (req: AuthedRequest, res) => {
  const { isDemoUser } = await import('../services/demo.js');
  if (await isDemoUser(req.userId!).catch(() => false)) {
    res.status(403).json({ error: 'Not available in Demo mode — demo uses seeded invoices.' });
    return;
  }
  const parsed = z.object({ folderIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/)).max(100) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Choose up to 100 Drive folders.' }); return; }
  try {
    const folders = [];
    for (const id of new Set(parsed.data.folderIds)) folders.push(await validateDriveFolder(req.userId!, id));
    await query(`UPDATE google_drive_connections SET folders=$1, folder_id=$2, folder_name=$3, updated_at=NOW() WHERE user_id=$4`,
      [JSON.stringify(folders), folders[0]?.id ?? null, folders[0]?.name ?? null, req.userId]);
    res.json({ message: 'Drive folders saved', folders });
  } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
});

router.get('/files', async (req: AuthedRequest, res) => {
  const conn = await getConnection(req.userId!);
  if (!conn?.folders.length) { res.status(400).json({ error: 'No Drive folders selected yet.' }); return; }
  try { res.json({ folders: conn.folders, files: await listSelectedFolderFiles(req.userId!, conn.folders) }); }
  catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
});

router.get('/files/:fileId/thumbnail', async (req: AuthedRequest, res) => {
  const fileId = String(req.params.fileId ?? '');
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(fileId)) { res.status(400).json({ error: 'Invalid file id' }); return; }
  try {
    const thumbnail = await thumbnailLimit(async () => {
      const { downloadDriveFile } = await import('../services/drive.js');
      const { bytes, mimeType } = await downloadDriveFile(req.userId!, fileId);
      if (mimeType === 'application/pdf') {
        const { pdfFirstPageToImage } = await import('../services/extractor.js');
        return pdfFirstPageToImage(bytes, 360);
      }
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const image = await loadImage(bytes);
      const scale = Math.min(1, 360 / Math.max(image.width, image.height));
      const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toBuffer('image/png');
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.vary('Cookie');
    res.vary('Authorization');
    res.send(thumbnail);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load thumbnail' });
  }
});

router.get('/files/:fileId/content', async (req: AuthedRequest, res) => {
  const fileId = String(req.params.fileId ?? '');
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(fileId)) {
    res.status(400).json({ error: 'Invalid file id' });
    return;
  }
  try {
    const { downloadDriveFile } = await import('../services/drive.js');
    const { bytes, mimeType } = await downloadDriveFile(req.userId!, fileId);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(bytes);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load file preview' });
  }
});

router.delete('/disconnect', async (req: AuthedRequest, res) => {
  const { isDemoUser } = await import('../services/demo.js');
  if (await isDemoUser(req.userId!).catch(() => false)) {
    res.status(403).json({ error: 'Not available in Demo mode — demo uses seeded invoices.' });
    return;
  }
  await query(`UPDATE google_drive_connections SET access_token=NULL, refresh_token=NULL, access_token_expires_at=NULL, google_email=NULL, folders='[]', folder_id=NULL, folder_name=NULL, updated_at=NOW() WHERE user_id=$1`, [req.userId]);
  await query(`DELETE FROM drive_oauth_states WHERE user_id=$1`, [req.userId]);
  res.json({ message: 'Google Drive disconnected' });
});

export default router;
