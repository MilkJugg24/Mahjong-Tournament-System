/* The working copy: IndexedDB.
 *
 * Browser-only, so it is exercised by the Playwright run rather than by
 * node:test.
 *
 * Two things worth knowing about where this data lives, both measured rather
 * than assumed:
 *
 *   - Every file:// page shares one storage namespace. The origin is literally
 *     "file://", so two copies of the app in different folders see each other's
 *     data. Tournaments are therefore keyed by id, never by folder.
 *
 *   - The data belongs to the browser profile, not to the folder the app was
 *     opened from. Copy the folder to another laptop and the tournament does
 *     not come with it. That is why backup.js writes the real record to disk,
 *     and why this module is only ever the working copy.
 *
 * Directory handles live here too: the File System Access API lets a handle be
 * stored in IndexedDB and reused, so the organiser picks their backup folder
 * once rather than every time they open the app.
 */
(function () {
'use strict';

const DB_NAME = 'riichi-tournament';
const DB_VERSION = 1;
const STORE_TOURNAMENTS = 'tournaments';
const STORE_SETTINGS = 'settings';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('This browser has no IndexedDB, so nothing can be saved here.'));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_TOURNAMENTS)) {
        db.createObjectStore(STORE_TOURNAMENTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('could not open the database'));
    request.onblocked = () => reject(new Error('the database is blocked by another tab'));
  });
}

function runTx(db, storeName, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try {
      result = work(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    tx.onerror = () => reject(tx.error || new Error('the database rejected the write'));
    tx.onabort = () => reject(tx.error || new Error('the write was aborted'));
  });
}

const asPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

class Persistence {
  constructor() {
    this.db = null;
    this.available = true;
    this.reason = '';
  }

  async open() {
    if (this.db) return this.db;
    try {
      this.db = await openDb();
      return this.db;
    } catch (err) {
      this.available = false;
      this.reason = String(err && err.message ? err.message : err);
      throw err;
    }
  }

  /** True if anything can be saved at all -- private windows can refuse. */
  async check() {
    try {
      await this.open();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: this.reason };
    }
  }

  /* ------------------------------------------------------- tournaments */

  async saveTournament(doc) {
    const db = await this.open();
    return runTx(db, STORE_TOURNAMENTS, 'readwrite', (store) => store.put(doc));
  }

  async loadTournament(id) {
    const db = await this.open();
    const tx = db.transaction(STORE_TOURNAMENTS, 'readonly');
    return asPromise(tx.objectStore(STORE_TOURNAMENTS).get(id));
  }

  async listTournaments() {
    const db = await this.open();
    const tx = db.transaction(STORE_TOURNAMENTS, 'readonly');
    const all = await asPromise(tx.objectStore(STORE_TOURNAMENTS).getAll());
    return (all || [])
      .map((t) => ({
        id: t.id,
        name: t.name,
        mode: t.mode,
        status: t.status,
        players: (t.players || []).length,
        rounds: (t.rounds || []).length,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        cut: (t.config || {}).cut || {},
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async deleteTournament(id) {
    const db = await this.open();
    return runTx(db, STORE_TOURNAMENTS, 'readwrite', (store) => store.delete(id));
  }

  /* ---------------------------------------------------------- settings */

  async setSetting(key, value) {
    const db = await this.open();
    return runTx(db, STORE_SETTINGS, 'readwrite', (store) => store.put(value, key));
  }

  async getSetting(key, fallback = null) {
    const db = await this.open();
    const tx = db.transaction(STORE_SETTINGS, 'readonly');
    const value = await asPromise(tx.objectStore(STORE_SETTINGS).get(key));
    return value === undefined ? fallback : value;
  }

  async clearSetting(key) {
    const db = await this.open();
    return runTx(db, STORE_SETTINGS, 'readwrite', (store) => store.delete(key));
  }

  /* -------------------------------------------- the backup folder handle */

  /** Directory handles are structured-cloneable, so they store directly. */
  async saveFolderHandle(handle) {
    return this.setSetting('backupFolder', handle);
  }

  /* The Discord webhook and the ids of the messages it keeps updated.
   *
   * Settings, deliberately, and never the tournament document: that goes into
   * restore points and CSVs, which an organiser syncs to OneDrive or Drive. A
   * webhook URL is a credential, and anyone holding it can post to the
   * channel. */
  async saveDiscord(config) {
    return this.setSetting('discord', config);
  }

  async loadDiscord() {
    return this.getSetting('discord', null);
  }

  async loadFolderHandle() {
    return this.getSetting('backupFolder', null);
  }

  async forgetFolderHandle() {
    return this.clearSetting('backupFolder');
  }

  /* --------------------------------------------------------- housekeeping */

  /**
   * Ask the browser to keep this data rather than evicting it under pressure.
   * Chrome usually grants it silently for a site the user interacts with;
   * Safari ties it to the home-screen install. Worth asking either way.
   */
  async requestPersistence() {
    if (typeof navigator === 'undefined' || !navigator.storage) {
      return { supported: false, persisted: false };
    }
    let persisted = false;
    if (typeof navigator.storage.persisted === 'function') {
      persisted = await navigator.storage.persisted();
    }
    if (!persisted && typeof navigator.storage.persist === 'function') {
      try {
        persisted = await navigator.storage.persist();
      } catch { /* refused */ }
    }
    let estimate = null;
    if (typeof navigator.storage.estimate === 'function') {
      try {
        estimate = await navigator.storage.estimate();
      } catch { /* not available */ }
    }
    return { supported: true, persisted, estimate };
  }
}

const API = { Persistence, DB_NAME, DB_VERSION, STORE_TOURNAMENTS, STORE_SETTINGS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') {
  window.RT = window.RT || {};
  window.RT.persist = API;
}
}());
