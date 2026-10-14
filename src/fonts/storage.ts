import type { FontRecord } from '../core/types';

const DATABASE = 'craft-studio';
const VERSION = 2;
const STORE = 'fonts';
const METADATA = 'font-metadata';
export type FontMetadata = Pick<FontRecord, 'id' | 'name'>;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Font persistence requires IndexedDB. Imported fonts are memory-only.'));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!request.result.objectStoreNames.contains(METADATA)) {
        const metadata = request.result.createObjectStore(METADATA, { keyPath: 'id' });
        const cursor = request.transaction!.objectStore(STORE).openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const font = entry.value as FontRecord;
          metadata.put({ id: font.id, name: font.name });
          entry.continue();
        };
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open font storage.'));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Font storage is blocked by another tab. Close that tab and retry.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>, storeName = STORE): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      let value: T;
      const request = operation(tx.objectStore(storeName));
      request.onsuccess = () => { value = request.result; };
      request.onerror = () => reject(request.error ?? new Error('Font storage request failed.'));
      // A successful put request is not proof of persistence until its transaction commits.
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error ?? request.error ?? new Error('Font storage transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Font storage transaction was aborted.'));
    });
  } finally {
    db.close();
  }
}

export async function saveFont(record: FontRecord): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(record.id) || typeof record.name !== 'string' || !(record.bytes instanceof ArrayBuffer)
    || record.bytes.byteLength === 0 || record.bytes.byteLength > 16 * 1024 * 1024) {
    throw new Error('Cannot save an invalid font record.');
  }
  const snapshot: FontRecord = { id: record.id, name: record.name, bytes: record.bytes.slice(0) };
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, METADATA], 'readwrite');
      tx.objectStore(STORE).put(snapshot);
      tx.objectStore(METADATA).put({ id: record.id, name: record.name });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Font storage transaction failed.'));
    });
  } finally { db.close(); }
}

export async function listFonts(): Promise<FontRecord[]> {
  return transaction<FontRecord[]>('readonly', (store) => store.getAll());
}

export async function listFontMetadata(): Promise<FontMetadata[]> {
  return transaction<FontMetadata[]>('readonly', store => store.getAll(), METADATA);
}

export async function readFont(id: string): Promise<FontRecord | undefined> {
  return transaction<FontRecord | undefined>('readonly', store => store.get(id));
}

export async function deleteFont(id: string): Promise<void> {
  await transaction('readwrite', (store) => store.delete(id));
  await transaction('readwrite', (store) => store.delete(id), METADATA);
}
