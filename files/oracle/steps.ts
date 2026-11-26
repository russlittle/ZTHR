/**
 * The requests a Nextcloud client makes, in the order it makes them, for the differential oracle. Run against a
 * real Nextcloud once to record what it answers, then against Files every build: any difference a client could
 * depend on is reported. The account must start empty (Nextcloud: occ config:system:set skeletondirectory --value='').
 */
import type { Step } from '../../intent/blocks/oracle/index.ts';

const PROPS = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/><d:getlastmodified/><oc:fileid/><oc:id/><oc:permissions/><oc:size/><oc:share-types/><nc:mount-type/><nc:is-encrypted/><nc:has-preview/></d:prop></d:propfind>';
const FILES = '/remote.php/dav/files/{user}';
const form = { 'content-type': 'application/x-www-form-urlencoded' };
const dest = (p: string) => ({ destination: `{base}${FILES}${p}` });

export const STEPS: readonly Step[] = [
  { name: 'status', method: 'GET', path: '/status.php' },
  { name: 'capabilities: chunking and undelete', method: 'GET', path: '/ocs/v2.php/cloud/capabilities?format=json' },
  { name: 'who am I', method: 'GET', path: '/ocs/v2.php/cloud/user?format=json' },
  { name: 'the empty root, one level', method: 'PROPFIND', path: `${FILES}/`, headers: { depth: '1' }, body: PROPS },
  { name: 'make a folder', method: 'MKCOL', path: `${FILES}/oracle` },
  { name: 'make it again', method: 'MKCOL', path: `${FILES}/oracle` },
  { name: 'a folder inside a missing one', method: 'MKCOL', path: `${FILES}/missing/inner` },
  { name: 'write a file', method: 'PUT', path: `${FILES}/oracle/a.txt`, headers: { 'x-oc-mtime': '1700000000' }, body: 'hello' },
  { name: 'overwrite it', method: 'PUT', path: `${FILES}/oracle/a.txt`, headers: { 'x-oc-mtime': '1700000100' }, body: 'hello again' },
  { name: 'read it', method: 'GET', path: `${FILES}/oracle/a.txt` },
  { name: 'read a range', method: 'GET', path: `${FILES}/oracle/a.txt`, headers: { range: 'bytes=6-' } },
  { name: 'the folder, one level', method: 'PROPFIND', path: `${FILES}/oracle/`, headers: { depth: '1' }, body: PROPS },
  { name: 'the file alone', method: 'PROPFIND', path: `${FILES}/oracle/a.txt`, headers: { depth: '0' }, body: PROPS },
  { name: 'something missing', method: 'PROPFIND', path: `${FILES}/oracle/none.txt`, headers: { depth: '0' }, body: PROPS },
  { name: 'rename', method: 'MOVE', path: `${FILES}/oracle/a.txt`, headers: dest('/oracle/b.txt') },
  { name: 'copy', method: 'COPY', path: `${FILES}/oracle/b.txt`, headers: dest('/oracle/c.txt') },
  { name: 'copy onto it without overwrite', method: 'COPY', path: `${FILES}/oracle/b.txt`, headers: { ...dest('/oracle/c.txt'), overwrite: 'F' } },
  { name: 'favourite it', method: 'PROPPATCH', path: `${FILES}/oracle/c.txt`, body: '<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:set><d:prop><oc:favorite>1</oc:favorite></d:prop></d:set></d:propertyupdate>' },
  { name: 'start a chunked upload', method: 'MKCOL', path: '/remote.php/dav/uploads/{user}/oracle-upload', headers: dest('/oracle/big.bin') },
  { name: 'send the last chunk first', method: 'PUT', path: '/remote.php/dav/uploads/{user}/oracle-upload/00002', headers: dest('/oracle/big.bin'), body: 'tail' },
  { name: 'assemble with a chunk too small', method: 'MOVE', path: '/remote.php/dav/uploads/{user}/oracle-upload/.file', headers: dest('/oracle/big.bin') },
  { name: 'share by link', method: 'POST', path: '/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', headers: form, body: 'path=/oracle/b.txt&shareType=3&permissions=1', capture: { share: 'ocs.data.id' } },
  { name: 'read the share back', method: 'GET', path: '/ocs/v2.php/apps/files_sharing/api/v1/shares/{share}?format=json' },
  { name: 'shares on the file', method: 'GET', path: '/ocs/v2.php/apps/files_sharing/api/v1/shares?path=/oracle/b.txt&format=json' },
  { name: 'take the share back', method: 'DELETE', path: '/ocs/v2.php/apps/files_sharing/api/v1/shares/{share}?format=json' },
  { name: 'delete a file', method: 'DELETE', path: `${FILES}/oracle/c.txt` },
  { name: 'the trash', method: 'PROPFIND', path: '/remote.php/dav/trashbin/{user}/trash/', headers: { depth: '1' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><nc:trashbin-filename/><nc:trashbin-original-location/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>' },
  { name: 'empty the trash', method: 'DELETE', path: '/remote.php/dav/trashbin/{user}/trash/' },
  { name: 'clean up', method: 'DELETE', path: `${FILES}/oracle` },
  { name: 'empty the trash again', method: 'DELETE', path: '/remote.php/dav/trashbin/{user}/trash/' },
];
