const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}\u3000-\u303f\uff00-\uffef]/gu;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkChars = text.match(CJK_REGEX)?.length ?? 0;
  const nonCjkChars = text.length - cjkChars;
  return Math.ceil(cjkChars * 1.5 + nonCjkChars / 4);
}
