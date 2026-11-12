const DICTIONARY_KEY = 'book-reader:dictionary-consent';

/** Public build switch; disabled builds never make dictionary requests. */
export const dictionaryAvailable = import.meta.env.VITE_DICTIONARY_ENABLED !== 'false';

export function dictionaryAllowed(): boolean {
  if (!dictionaryAvailable) return false;
  try {
    return localStorage.getItem(DICTIONARY_KEY) === 'allowed';
  } catch {
    return false;
  }
}

export function setDictionaryAllowed(allowed: boolean): void {
  localStorage.setItem(DICTIONARY_KEY, allowed ? 'allowed' : 'denied');
}
