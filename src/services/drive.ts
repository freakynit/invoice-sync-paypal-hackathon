import { google } from 'googleapis';
import { config, isGoogleConfigured } from '../config.js';
import { query } from '../db/pool.js';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
}

export interface DriveFolder { id: string; name: string; }

export function isSupportedInvoiceType(mimeType: string): boolean {
  return mimeType === 'application/pdf' || mimeType.startsWith('image/');
}

export interface DriveConnection {
  folders: DriveFolder[];
  id: string;
  user_id: string;
  google_email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  access_token_expires_at: string | null;
  folder_id: string | null;
  folder_name: string | null;
}

export function googleOAuthClient() {
  return new google.auth.OAuth2(
    config.auth.google.clientId,
    config.auth.google.clientSecret,
    config.auth.google.redirectUri,
  );
}

export function getGoogleAuthUrl(state: string): string {
  const client = googleOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...config.drive.scopes, 'openid', 'email', 'profile'],
    state,
  });
}

export async function getConnection(userId: string): Promise<DriveConnection | null> {
  const { rows } = await query<DriveConnection>(`SELECT * FROM google_drive_connections WHERE user_id=$1`, [userId]);
  return rows[0] ?? null;
}

async function refreshAccessTokenIfNeeded(conn: DriveConnection): Promise<string> {
  if (conn.access_token && conn.access_token_expires_at) {
    const expiresInMs = new Date(conn.access_token_expires_at).getTime() - Date.now();
    if (expiresInMs > 60_000) return conn.access_token;
  }
  if (!conn.refresh_token) {
    if (!conn.access_token) throw new Error('Google Drive not connected. Please reconnect.');
    return conn.access_token;
  }
  const client = googleOAuthClient();
  client.setCredentials({ refresh_token: conn.refresh_token });
  const { credentials } = await client.refreshAccessToken();
  const expiresAt = credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null;
  await query(`UPDATE google_drive_connections SET access_token=$1, access_token_expires_at=$2, updated_at=NOW() WHERE id=$3`, [
    credentials.access_token ?? conn.access_token,
    expiresAt,
    conn.id,
  ]);
  if (!credentials.access_token) throw new Error('Failed to refresh Google access token');
  return credentials.access_token;
}

function authedDrive(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth });
}

export async function listFolderFiles(userId: string, folderId: string, maxFiles = 200): Promise<DriveFile[]> {
  const conn = await getConnection(userId);
  if (!conn) throw new Error('Google Drive not connected');
  const token = await refreshAccessTokenIfNeeded(conn);
  const drive = authedDrive(token);
  const files: DriveFile[] = [];
  if (maxFiles <= 0) return files;
  const folderIds = [folderId];
  const visitedFolders = new Set(folderIds);
  const seenFiles = new Set<string>();
  for (let index = 0; index < folderIds.length; index++) {
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${folderIds[index].replace(/'/g, '')}' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/pdf' or mimeType contains 'image/')`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, webViewLink)',
        pageSize: 100,
        pageToken,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      for (const f of res.data.files ?? []) {
        if (!f.id) continue;
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          if (!visitedFolders.has(f.id)) {
            visitedFolders.add(f.id);
            folderIds.push(f.id);
          }
          continue;
        }
        if (!f.name || !isSupportedInvoiceType(f.mimeType ?? '') || seenFiles.has(f.id)) continue;
        seenFiles.add(f.id);
        files.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType ?? 'application/octet-stream',
          modifiedTime: f.modifiedTime ?? undefined,
          size: f.size ?? undefined,
          webViewLink: f.webViewLink ?? undefined,
        });
        if (files.length >= maxFiles) return files;
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }
  return files;
}

export async function downloadDriveFile(userId: string, fileId: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const conn = await getConnection(userId);
  if (!conn) throw new Error('Google Drive not connected');
  const token = await refreshAccessTokenIfNeeded(conn);
  const drive = authedDrive(token);

  const meta = await drive.files.get({ fileId, fields: 'mimeType, size', supportsAllDrives: true });
  const mimeType = meta.data.mimeType ?? 'application/octet-stream';
  const size = Number(meta.data.size ?? 0);
  if (size > config.drive.maxFileBytes) throw new Error(`File too large (${size} bytes, limit ${config.drive.maxFileBytes})`);

  if (!isSupportedInvoiceType(mimeType)) throw new Error('Only images and PDFs are supported.');

  const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  const bytes = Buffer.from(res.data as ArrayBuffer);
  if (bytes.length > config.drive.maxFileBytes) throw new Error('File exceeds the download size limit');
  return { bytes, mimeType };
}

export async function ensureGoogleConfigured(): Promise<void> {
  if (!isGoogleConfigured()) throw new Error('Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
}

export async function listDriveFolders(userId: string, parentId: string): Promise<DriveFolder[]> {
  const conn = await getConnection(userId);
  if (!conn) throw new Error('Google Drive not connected');
  const drive = authedDrive(await refreshAccessTokenIfNeeded(conn));
  const folders: DriveFolder[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `${parentId === 'shared' ? 'sharedWithMe = true' : `'${parentId.replace(/'/g, '')}' in parents`} and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id,name)', pageSize: 100, pageToken, orderBy: 'name',
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    for (const f of res.data.files ?? []) if (f.id && f.name) folders.push({ id: f.id, name: f.name });
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return folders;
}

export async function validateDriveFolder(userId: string, folderId: string): Promise<DriveFolder> {
  const conn = await getConnection(userId);
  if (!conn) throw new Error('Google Drive not connected');
  const drive = authedDrive(await refreshAccessTokenIfNeeded(conn));
  const { data } = await drive.files.get({ fileId: folderId, fields: 'id,name,mimeType,trashed', supportsAllDrives: true });
  if (data.trashed || data.mimeType !== 'application/vnd.google-apps.folder' || !data.id || !data.name) throw new Error('Choose an accessible Drive folder');
  return { id: folderId === 'root' ? 'root' : data.id, name: folderId === 'root' ? 'My Drive' : data.name };
}

export async function listSelectedFolderFiles(userId: string, folders: DriveFolder[], maxFiles = 200): Promise<DriveFile[]> {
  const files = new Map<string, DriveFile>();
  for (const folder of folders) {
    for (const file of await listFolderFiles(userId, folder.id, maxFiles)) files.set(file.id, file);
  }
  return [...files.values()];
}
