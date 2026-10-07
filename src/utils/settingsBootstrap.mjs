export function updatesMatch(left, right) {
  if (!left || !right) return left === right;
  return left.tagName === right.tagName && left.releaseUrl === right.releaseUrl;
}
