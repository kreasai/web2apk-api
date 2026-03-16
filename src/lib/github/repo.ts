export function normalizeRepoSlug(value: string) {
  const raw = value.trim().replace(/\.git$/, '');
  if (!raw) return '';

  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const url = new URL(raw);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
      return '';
    } catch {
      return '';
    }
  }

  const parts = raw.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }

  return '';
}

export function splitRepoSlug(slug: string) {
  const [owner, name] = slug.split('/');
  return { owner, name };
}
