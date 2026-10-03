import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { google } from 'googleapis';
import { pool } from '../dist/db/pool.js';
import driveRoutes from '../dist/routes/drive.js';
import { signSession } from '../dist/utils/auth.js';
import { isSupportedInvoiceType, listSelectedFolderFiles } from '../dist/services/drive.js';


test('Drive folder API validates selections, paginates branches and deduplicates invoice files', async () => {
  const originalQuery = pool.query;
  const originalDrive = google.drive;
  let folders = [{id:'a',name:'A'}];
  const queries = [];
  pool.query = async (sql, params) => {
    if (sql.startsWith('SELECT * FROM google_drive_connections')) return {rows:[{id:'connection',access_token:'test-token',access_token_expires_at:new Date(Date.now()+3600000).toISOString(),folders}],rowCount:1};
    if (sql.startsWith('UPDATE google_drive_connections SET folders=')) { folders=JSON.parse(params[0]); return {rows:[],rowCount:1}; }
    throw new Error('Unexpected SQL in test');
  };
  google.drive = () => ({files:{
    get: async ({fileId}) => ({data:{id:fileId,name:fileId.toUpperCase(),mimeType:fileId==='bad'?'text/plain':'application/vnd.google-apps.folder'}}),
    list: async ({q,pageToken}) => {
      queries.push(q);
      if (!q.includes("mimeType contains 'image/'")) {
        return {data:pageToken?{files:[{id:'b',name:'B'}]}:{files:[{id:'a',name:'A'}],nextPageToken:'next'}};
      }
      return {data:{files:[{id:'same-file',name:'invoice.pdf',mimeType:'application/pdf'}]}};
    },
  }});
  const app=express();app.use(express.json());app.use('/drive',driveRoutes);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/drive`;
  const headers={Authorization:'Bearer '+signSession({userId:'user-a',email:'test@example.com'}),'Content-Type':'application/json'};
  try {
    assert.equal((await fetch(base+'/folders')).status,401);
    const branch=await (await fetch(base+'/folders?parentId=root',{headers})).json();
    assert.deepEqual(branch.folders.map(f=>f.id),['a','b']);
    const save=await fetch(base+'/folders',{method:'PUT',headers,body:JSON.stringify({folderIds:['a','b','a']})});
    assert.equal(save.status,200);assert.deepEqual((await save.json()).folders.map(f=>f.id),['a','b']);
    const invalid=await fetch(base+'/folders',{method:'PUT',headers,body:JSON.stringify({folderIds:['bad']})});
    assert.equal(invalid.status,400);assert.deepEqual(folders.map(f=>f.id),['a','b']);
    const files=await listSelectedFolderFiles('user-a',folders);
    assert.equal(files.length,1);
    assert.ok(queries.some(q=>q.includes("mimeType contains 'image/'")));
    for (const mime of ['image/png','image/jpeg','application/pdf']) assert.equal(isSupportedInvoiceType(mime),true);
    for (const mime of ['text/plain','application/vnd.google-apps.document','application/vnd.google-apps.folder']) assert.equal(isSupportedInvoiceType(mime),false);
    const clear=await fetch(base+'/folders',{method:'PUT',headers,body:JSON.stringify({folderIds:[]})});
    assert.equal(clear.status,200);assert.equal(folders.length,0);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    pool.query=originalQuery;google.drive=originalDrive;
    await pool.end();
  }
});
