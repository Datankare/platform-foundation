export const MAX_CHARACTERS = 100;

export function canSubmitText(text: string, isLoading: boolean): boolean {
  const charCount = text.length;
  const isEmpty = text.trim().length === 0;
  const isOverLimit = charCount > MAX_CHARACTERS;
  return !isLoading && !isOverLimit && !isEmpty;
}

export function getCharState(text: string): {
  charCount: number;
  charsLeft: number;
  isOverLimit: boolean;
  isEmpty: boolean;
} {
  const charCount = text.length;
  const charsLeft = MAX_CHARACTERS - charCount;
  const isOverLimit = charCount > MAX_CHARACTERS;
  const isEmpty = text.trim().length === 0;
  return { charCount, charsLeft, isOverLimit, isEmpty };
}

export function canClearText(text: string, isLoading: boolean): boolean {
  return text.length > 0 && !isLoading;
}
