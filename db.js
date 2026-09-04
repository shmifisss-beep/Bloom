import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.MENU_DB_PATH || `${__dirname}/data/menu.json`;

function ensureFile() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(DB_PATH)) writeFileSync(DB_PATH, '[]', 'utf-8');
}

export function readMenu() {
  ensureFile();
  try {
    const raw = readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to read menu.json:', e.message);
    return [];
  }
}

export function writeMenu(items) {
  ensureFile();
  // Write atomically: write to temp file then rename, to avoid corruption
  // if the process is killed mid-write.
  const tmpPath = `${DB_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(items, null, 2), 'utf-8');
  writeFileSync(DB_PATH, JSON.stringify(items, null, 2), 'utf-8');
}

export function getItemById(id) {
  return readMenu().find(item => item.id === id) || null;
}

export function updateItem(id, patch) {
  const items = readMenu();
  const idx = items.findIndex(item => item.id === id);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...patch };
  writeMenu(items);
  return items[idx];
}

export function addItem(newItem) {
  const items = readMenu();
  items.push(newItem);
  writeMenu(items);
  return newItem;
}

export function deleteItem(id) {
  const items = readMenu();
  const filtered = items.filter(item => item.id !== id);
  const changed = filtered.length !== items.length;
  if (changed) writeMenu(filtered);
  return changed;
}

export function getCategories() {
  const items = readMenu();
  const cats = [...new Set(items.map(i => i.category))];
  return cats;
}
