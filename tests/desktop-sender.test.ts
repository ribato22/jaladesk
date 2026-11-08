import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { senderOf } from '../src/desktop/sender.js';
import { ipcAllowed } from '../src/protocols/rdp/owner.js';

// Who may use a channel is decided from the message: which window sent it, from which page, and whether that frame is the top one of the window (a frame inside the page that has the same address is not the page). The
// description of the sender is made in one place, so that what main.ts does with the event of Electron is reached by a test (main.ts itself is not loaded by the tests); ipcAllowed compares it with what is expected.
const URL_OF_PAGE = 'file:///app/src/desktop/settings.html';
const top = { url: URL_OF_PAGE };
const event = (over: Record<string, unknown> = {}) => ({ sender: { id: 7, mainFrame: top }, senderFrame: top, ...over });

test('the sender is described by its window, the address of its frame and whether that frame is the top one of the window', () => {
  assert.deepEqual(senderOf(event()), { senderId: 7, frameUrl: URL_OF_PAGE, isMainFrame: true });
  assert.deepEqual(senderOf(event({ senderFrame: { url: URL_OF_PAGE } })), { senderId: 7, frameUrl: URL_OF_PAGE, isMainFrame: false }, 'a frame inside the page, even at the same address, is not the top one');
  assert.deepEqual(senderOf(event({ senderFrame: null })), { senderId: 7, frameUrl: '', isMainFrame: false }, 'a frame that is gone has no address and is not the top one');
  assert.deepEqual(senderOf(event({ senderFrame: undefined })), { senderId: 7, frameUrl: '', isMainFrame: false });
  assert.deepEqual(senderOf(event({ senderFrame: {} })), { senderId: 7, frameUrl: '', isMainFrame: false }, 'a frame with no address says none');
  assert.equal(senderOf({ sender: { id: 9, mainFrame: top }, senderFrame: top }).senderId, 9);
});

test('with ipcAllowed only the top frame of the expected window, at the expected page, is let in', () => {
  assert.equal(ipcAllowed(senderOf(event()), 7, URL_OF_PAGE), true);
  assert.equal(ipcAllowed(senderOf(event()), 8, URL_OF_PAGE), false, 'another window');
  assert.equal(ipcAllowed(senderOf(event({ senderFrame: { url: URL_OF_PAGE } })), 7, URL_OF_PAGE), false, 'a frame inside the page');
  assert.equal(ipcAllowed(senderOf(event({ senderFrame: null })), 7, URL_OF_PAGE), false, 'a frame that is gone');
  assert.equal(ipcAllowed(senderOf(event()), 7, 'file:///app/src/desktop/index.html'), false, 'the page of another window');
  const moved = { url: 'file:///elsewhere/page.html' };
  assert.equal(ipcAllowed(senderOf({ sender: { id: 7, mainFrame: moved }, senderFrame: moved }), 7, URL_OF_PAGE), false, 'the window that went to another page');
});

test('every place of main.ts that decides who may use a channel describes the sender with it', async () => {
  const main = await readFile(fileURLToPath(new URL('../../src/desktop/main.ts', import.meta.url)), 'utf8');
  assert.equal([...main.matchAll(/ipcAllowed\(senderOf\(event\),/g)].length, 3, 'the channels of the window, those of the settings and the answer of the window that asks for a password');
  assert.doesNotMatch(main, /senderId:event\.sender\.id/, 'and none of them writes the description by hand');
});
