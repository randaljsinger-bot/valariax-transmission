export function limitTo30Seconds(text) {
  const maxWords = 75;
  const words = text.trim().split(/\s+/);
  return words.length <= maxWords ? text : words.slice(0, maxWords).join(" ") + "…";
}
