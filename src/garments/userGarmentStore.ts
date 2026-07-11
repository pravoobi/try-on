/**
 * IndexedDB persistence for user-uploaded garments (Phase A4, see
 * docs/plan-3d-garment-assets.md §5.2) — the image Blobs live here, not the
 * schema.ts Garment objects themselves (those are built from these records
 * at load time, with Blobs converted to `blob:` object URLs — see
 * useUserGarments.ts). Uploads are single-piece only for v1 (a phone photo
 * of a shirt); lehenga-choli upload is out of scope.
 */
import type { GarmentAnchors } from '../pipeline/types';
import type { GarmentCategory, GarmentMeta } from './schema';

export interface StoredGarmentPiece {
  imageBlob: Blob;
  anchors: GarmentAnchors;
}

export interface StoredUserGarment {
  id: string;
  category: Exclude<GarmentCategory, 'lehenga-choli'>;
  front: StoredGarmentPiece;
  back?: StoredGarmentPiece;
  meta: GarmentMeta;
  createdAt: number;
}

const DB_NAME = 'try-on-user-garments';
const DB_VERSION = 1;
const STORE_NAME = 'garments';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('failed to open user-garment database'));
  });
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function saveUserGarment(garment: StoredUserGarment): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(garment);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('failed to save garment'));
    });
  } finally {
    db.close();
  }
}

export async function loadUserGarments(): Promise<StoredUserGarment[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const all = await promisifyRequest(tx.objectStore(STORE_NAME).getAll());
    return (all as StoredUserGarment[]).sort((a, b) => a.createdAt - b.createdAt);
  } finally {
    db.close();
  }
}

export async function deleteUserGarment(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('failed to delete garment'));
    });
  } finally {
    db.close();
  }
}
